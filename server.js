const express = require("express");
const bodyParser = require("body-parser");
const ee = require("@google/earthengine");
const cors = require("cors");

const app = express();
app.use(cors());

// Handle preflight
app.options("*", cors());

app.use(bodyParser.json());

// Allow only your frontend domain
app.use(cors({
  origin: ["https://ethiosathub.com"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// Authenticate with Earth Engine
const privateKey = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

ee.data.authenticateViaPrivateKey(privateKey, () => {
  ee.initialize(null, null, () => {
    console.log("Earth Engine initialized.");
  }, (err) => {
    console.error("EE initialization error:", err);
  });
});

// Helper: mask clouds
function maskS2clouds(image) {
  const qa = image.select('QA60');
  const cloudBitMask = 1 << 10;
  const cirrusBitMask = 1 << 11;
  const mask = qa.bitwiseAnd(cloudBitMask).eq(0)
    .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask).divide(10000);
}

// Endpoint: /ndvi for visualization
app.post("/ndvi", (req, res) => {
  try {
    const { bbox, startDate, endDate } = req.body;
    if (!bbox || !startDate || !endDate) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const roi = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    const s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(roi)
      .filterDate(startDate, endDate)
      .map(maskS2clouds)
      .median();

    const ndvi = s2.normalizedDifference(["B8", "B4"]).rename("NDVI");

    const visParams = { min: 0, max: 1, palette: ["white", "yellow", "green"] };

    ndvi.getMap(visParams, (mapObj) => {
      res.json(mapObj); // {mapid, token}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: /downloadNDVI for Google Drive export
app.post("/downloadNDVI", async (req, res) => {
  try {
    const { bbox, startDate, endDate } = req.body;
    if (!bbox || !startDate || !endDate) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const roi = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    const s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(roi)
      .filterDate(startDate, endDate)
      .map(maskS2clouds)
      .median();

    const ndvi = s2.normalizedDifference(["B8", "B4"]).rename("NDVI");

    const exportName = `NDVI_${Date.now()}`;

    // Export to Google Drive (Earth Engine > My Drive > Earth Engine folder)
    const task = ee.batch.Export.image.toDrive({
      image: ndvi.clip(roi),
      description: exportName,
      fileNamePrefix: exportName,
      scale: 10,
      region: roi,
      fileFormat: "GeoTIFF",
    });

    task.start();

    // ✅ Return clear message, not fake URL
    res.json({
      message: `Export started. Check your Google Drive (Earth Engine folder) for file: ${exportName}.tif`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
