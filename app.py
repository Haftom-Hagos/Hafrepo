from flask import Flask, request, jsonify
from flask_cors import CORS
import ee
import json
import os
import base64
import datetime

app = Flask(__name__)
CORS(app)

# ------------------------
# Google Earth Engine Auth
# ------------------------
service_account_key_base64 = os.environ.get('GEE_SERVICE_ACCOUNT_KEY')
if not service_account_key_base64:
    raise ValueError('GEE_SERVICE_ACCOUNT_KEY environment variable not set')

service_account_key = json.loads(base64.b64decode(service_account_key_base64).decode('utf-8'))
SERVICE_ACCOUNT = service_account_key.get('client_email')
if not SERVICE_ACCOUNT:
    raise ValueError('client_email missing in GEE service account key')

KEY_FILE_CONTENT = json.dumps(service_account_key)
credentials = ee.ServiceAccountCredentials(SERVICE_ACCOUNT, key_data=KEY_FILE_CONTENT)
ee.Initialize(credentials)

# ------------------------
# Helper Functions
# ------------------------
def bbox_to_region(bbox):
    return ee.Geometry.Rectangle(
        [bbox['west'], bbox['south'], bbox['east'], bbox['north']],
        proj='EPSG:4326',
        geodesic=False
    )

def get_dates(payload):
    start = payload.get('startDate')
    end = payload.get('endDate')
    if start and end:
        return start, end
    today = datetime.date.today()
    return (today - datetime.timedelta(days=365)).strftime('%Y-%m-%d'), today.strftime('%Y-%m-%d')

def sentinel2_sr_median(region, start, end, cloud_pct=20):
    return (ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(region)
            .filterDate(start, end)
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloud_pct))
            .median()
            .clip(region))

def compute_ndvi(region, start, end, cloud_pct=20):
    median = sentinel2_sr_median(region, start, end, cloud_pct)
    return median.normalizedDifference(['B8', 'B4']).rename('NDVI').clip(region)

# ------------------------
# Routes
# ------------------------
@app.get('/health')
def health():
    return 'ok'

# --------- NDVI PNG Download ---------
@app.post('/getNDVI')
@app.post('/get_ndvi')
def get_ndvi():
    try:
        data = request.get_json(force=True)
        bbox = data.get('bbox')
        if not bbox or not all(k in bbox for k in ['west', 'south', 'east', 'north']):
            return jsonify({'error': 'Invalid bounding box provided'}), 400

        start, end = get_dates(data)
        scale = int(data.get('scale', 100))  # default 100m for smaller file

        region = bbox_to_region(bbox)
        ndvi = compute_ndvi(region, start, end)

        vis_params = {
            'min': -1,
            'max': 1,
            'palette': ['#d73027', '#f46d43', '#fdae61', '#fee08b',
                        '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850']
        }
        visualized_ndvi = ndvi.visualize(**vis_params)

        download_url = visualized_ndvi.getDownloadURL({
            'scale': scale,
            'region': region,
            'format': 'PNG',
            'crs': 'EPSG:4326'
        })

        return jsonify({'url': download_url})
    except ee.EEException as e:
        return jsonify({'error': f'Failed to generate NDVI: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected server error: {str(e)}'}), 500

# --------- NDVI Map Visualization ---------
@app.post('/viewNDVI')
@app.post('/view_ndvi')
def view_ndvi():
    try:
        data = request.get_json(force=True)
        bbox = data.get('bbox')
        if not bbox or not all(k in bbox for k in ['west', 'south', 'east', 'north']):
            return jsonify({'error': 'Invalid bounding box provided'}), 400

        start, end = get_dates(data)
        region = bbox_to_region(bbox)

        ndvi = compute_ndvi(region, start, end)
        vis_params = {
            'min': -1,
            'max': 1,
            'palette': ['#d73027', '#f46d43', '#fdae61', '#fee08b',
                        '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850']
        }
        map_id = ndvi.getMapId(vis_params)
        return jsonify({'mapId': map_id['mapid'], 'token': map_id['token']})
    except ee.EEException as e:
        return jsonify({'error': f'Failed to visualize NDVI: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected server error: {str(e)}'}), 500

# --------- Land Cover (ESA WorldCover) PNG Download ---------
@app.post('/getLandCover')
@app.post('/get_land_cover')
def get_land_cover():
    try:
        data = request.get_json(force=True)
        bbox = data.get('bbox')
        if not bbox or not all(k in bbox for k in ['west', 'south', 'east', 'north']):
            return jsonify({'error': 'Invalid bounding box provided'}), 400

        scale = int(data.get('scale', 100))
        region = bbox_to_region(bbox)

        land_cover = ee.Image('ESA/WorldCover/v200').clip(region)
        vis_params = {
            'min': 0,
            'max': 10,
            'palette': ['#006400', '#00ff00', '#ffd700', '#ff0000',
                        '#ff00ff', '#00ffff', '#808080']
        }
        visualized_lc = land_cover.visualize(**vis_params)

        download_url = visualized_lc.getDownloadURL({
            'scale': scale,
            'region': region,
            'format': 'PNG',
            'crs': 'EPSG:4326'
        })

        return jsonify({'url': download_url})
    except ee.EEException as e:
        return jsonify({'error': f'Failed to generate Land Cover: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected server error: {str(e)}'}), 500

# --------- Land Cover Map Visualization ---------
@app.post('/viewLandCover')
@app.post('/view_land_cover')
def view_land_cover():
    try:
        data = request.get_json(force=True)
        bbox = data.get('bbox')
        if not bbox or not all(k in bbox for k in ['west', 'south', 'east', 'north']):
            return jsonify({'error': 'Invalid bounding box provided'}), 400

        region = bbox_to_region(bbox)
        land_cover = ee.Image('ESA/WorldCover/v200').clip(region)

        vis_params = {
            'min': 0,
            'max': 10,
            'palette': ['#006400', '#00ff00', '#ffd700', '#ff0000',
                        '#ff00ff', '#00ffff', '#808080']
        }
        map_id = land_cover.getMapId(vis_params)

        return jsonify({'mapId': map_id['mapid'], 'token': map_id['token']})
    except ee.EEException as e:
        return jsonify({'error': f'Failed to visualize Land Cover: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': f'Unexpected server error: {str(e)}'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
