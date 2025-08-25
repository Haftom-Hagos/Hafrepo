import os
import io
import json
import tempfile
from typing import Optional, Dict, Any, Tuple

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.transform import Affine
from shapely.geometry import box, mapping
from pyproj import Transformer

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from pystac_client import Client
import planetary_computer as pc
import matplotlib.pyplot as plt


# ---------------------------
# FastAPI + CORS
# ---------------------------
app = FastAPI(title="NDVI Service (MPC + FastAPI)")

# Allow your site; add localhost for testing if you want
ALLOWED_ORIGINS = [
    "https://ethiosathub.com",
    # "http://localhost:5173",
    # "http://localhost:3000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------
# STAC / MPC
# ---------------------------
STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
CATALOG = Client.open(STAC_URL, modifier=pc.sign_inplace)


def _search_best_item(
    bbox: Tuple[float, float, float, float],
    start: str,
    end: str,
    cloud_first: int = 20,
) -> Optional[Any]:
    """
    Search Sentinel-2 L2A over bbox/time and return the least-cloudy item.
    If none under cloud_first, relax to 60%.
    """
    west, south, east, north = bbox
    dt = f"{start}/{end}"

    def _pick(limit_cloud: int):
        search = CATALOG.search(
            collections=["sentinel-2-l2a"],
            bbox=[west, south, east, north],
            datetime=dt,
            query={"eo:cloud_cover": {"lt": limit_cloud}},
        )
        items = list(search.get_items())
        if not items:
            return None
        # pick lowest cloud cover
        items.sort(key=lambda it: it.properties.get("eo:cloud_cover", 1000))
        return items[0]

    item = _pick(cloud_first)
    if item is None:
        item = _pick(60)
    return item


def _read_bands_ndvi(
    item: Any,
    bbox: Tuple[float, float, float, float],
    out_res: Optional[float] = None,
) -> Tuple[np.ndarray, Affine, str]:
    """
    Read B04 & B08 from a single Sentinel-2 L2A item, clipped to bbox.
    Compute NDVI. Returns (ndvi, transform, crs_wkt).
    """
    west, south, east, north = bbox
    a4 = item.assets["B04"]
    a8 = item.assets["B08"]

    href4 = a4.href
    href8 = a8.href

    # Open one band to get CRS/transform
    with rasterio.Env(AWS_NO_SIGN_REQUEST="YES"):  # MPC COGs are public
        with rasterio.open(href4) as src4:
            src_crs = src4.crs
            src_transform = src4.transform

            # Reproject bbox (EPSG:4326) to asset CRS
            transformer = Transformer.from_crs("EPSG:4326", src_crs, always_xy=True)
            x_min, y_min = transformer.transform(west, south)
            x_max, y_max = transformer.transform(east, north)

            # Optional resampling by resolution (meters). If not provided, use native.
            if out_res:
                # Create a new transform with desired pixel size
                scale_x = out_res / src_transform.a
                scale_y = out_res / abs(src_transform.e)
                # The above is an approximation. We’ll just window in native res (simpler/robust).
                pass

            # Read windows from both bands (same window)
            window = from_bounds(x_min, y_min, x_max, y_max, src_transform)
            b4 = src4.read(1, window=window, masked=True).astype("float32")

        with rasterio.open(href8) as src8:
            b8 = src8.read(1, window=window, masked=True).astype("float32")

        # Scale reflectance (Sentinel-2 L2A: /10000)
        b4 /= 10000.0
        b8 /= 10000.0

        # NDVI = (NIR - RED)/(NIR + RED)
        denom = (b8 + b4)
        ndvi = np.where(denom == 0, np.nan, (b8 - b4) / denom).astype("float32")

        # Build the new transform for the window
        row_off, col_off = window.row_off, window.col_off
        transform = src_transform * Affine.translation(col_off, row_off)

        return ndvi, transform, src_crs.to_wkt()


def _save_geotiff(ndvi: np.ndarray, transform: Affine, crs_wkt: str) -> bytes:
    """Write a single-band float32 GeoTIFF to memory and return bytes."""
    height, width = ndvi.shape
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": "float32",
        "crs": crs_wkt,
        "transform": transform,
        "compress": "deflate",
        "nodata": np.nan,
    }
    memfile = io.BytesIO()
    with rasterio.Env():
        with rasterio.MemoryFile() as mem:
            with mem.open(**profile) as dst:
                dst.write(ndvi, 1)
            memfile.write(mem.read())
    memfile.seek(0)
    return memfile.read()


def _png_from_ndvi(ndvi: np.ndarray) -> bytes:
    """Render NDVI to a PNG using a nice palette and return bytes."""
    # Clip to [-0.2, 0.8] for visual pop, then 0..1
    arr = np.clip(ndvi, -0.2, 0.8)
    arr = (arr - (-0.2)) / (0.8 - (-0.2))

    # Use a color map similar to ColorBrewer RdYlGn but reversed (bad=purple, good=green)
    fig = plt.figure(figsize=(4, 4), dpi=96)
    ax = plt.axes([0, 0, 1, 1])
    ax.axis("off")
    ax.imshow(arr, cmap="RdYlGn")  # simple, effective
    buf = io.BytesIO()
    plt.savefig(buf, format="png", dpi=96, bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ---------------------------
# API routes
# ---------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/ndvi")
async def ndvi(request: Request):
    """
    JSON body:
    {
      "bbox": {"west":..., "south":..., "east":..., "north":...},
      "startDate":"YYYY-MM-DD",
      "endDate":"YYYY-MM-DD"
    }

    Returns preview PNG as bytes (image/png).
    """
    body = await request.json()
    bbox = body.get("bbox")
    start = body.get("startDate")
    end = body.get("endDate")
    if not bbox or not start or not end:
        raise HTTPException(status_code=400, detail="Missing parameters")

    west = float(bbox["west"])
    south = float(bbox["south"])
    east = float(bbox["east"])
    north = float(bbox["north"])
    aoi = (west, south, east, north)

    item = _search_best_item(aoi, start, end)
    if item is None:
        raise HTTPException(status_code=404, detail="No imagery found for the requested time/area.")

    ndvi, transform, crs_wkt = _read_bands_ndvi(item, aoi)

    # Create a preview PNG for quick visualization
    png_bytes = _png_from_ndvi(ndvi)

    return Response(content=png_bytes, media_type="image/png")


@app.post("/ndvi/download")
async def ndvi_download(request: Request):
    """
    Same body as /ndvi. Returns GeoTIFF as attachment.
    """
    body = await request.json()
    bbox = body.get("bbox")
    start = body.get("startDate")
    end = body.get("endDate")
    if not bbox or not start or not end:
        raise HTTPException(status_code=400, detail="Missing parameters")

    west = float(bbox["west"])
    south = float(bbox["south"])
    east = float(bbox["east"])
    north = float(bbox["north"])
    aoi = (west, south, east, north)

    item = _search_best_item(aoi, start, end)
    if item is None:
        raise HTTPException(status_code=404, detail="No imagery found for the requested time/area.")

    ndvi, transform, crs_wkt = _read_bands_ndvi(item, aoi)
    gtiff = _save_geotiff(ndvi, transform, crs_wkt)

    filename = f"NDVI_{start}_{end}.tif"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(io.BytesIO(gtiff), media_type="image/tiff", headers=headers)
