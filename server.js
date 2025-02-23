const express = require('express');
const cors = require('cors');
const ee = require('@google/earthengine');
const app = express();

// Configure CORS to allow requests from ethiosathub.com
const corsOptions = {
    origin: 'https://ethiosathub.com', // Allow only your website
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Allow these HTTP methods
    optionsSuccessStatus: 204 // Some legacy browsers (IE11, Safari) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json());

// GEE Service Account Authentication using environment variable
const serviceAccountKeyBase64 = process.env.GEE_SERVICE_ACCOUNT_KEY;
if (!serviceAccountKeyBase64) {
    console.error('GEE_SERVICE_ACCOUNT_KEY environment variable not set');
    process.exit(1);
}

const serviceAccount = JSON.parse(Buffer.from(serviceAccountKeyBase64, 'base64').toString('utf8'));
ee.data.authenticateViaPrivateKey(serviceAccount, () => {
    ee.initialize(null, null, () => {
        console.log('GEE initialized successfully on backend');
        // Test GEE access to confirm registration
        ee.data.getAssetRoots((roots, error) => {
            if (error) {
                console.error('GEE access test failed:', error);
            } else {
                console.log('GEE access test successful, asset roots:', roots);
            }
        });
    }, (error) => {
        console.error('GEE initialization failed:', error);
    });
});

// Endpoint for NDVI download (keep existing for potential future use)
app.post('/getNDVI', (req, res) => {
    const { bbox } = req.body;
    if (!bbox || !bbox.west || !bbox.south || !bbox.east || !bbox.north) {
        return res.status(400).json({ error: 'Invalid bounding box provided' });
    }

    const geometry = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    try {
        const sentinel2 = ee.ImageCollection('COPERNICUS/S2')
            .filterBounds(geometry)
            .filterDate('2023-01-01', '2025-02-20')
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
            .median();

        const ndvi = sentinel2.normalizedDifference(['B8', 'B4']).rename('NDVI').clip(geometry);

        const visParams = {
            min: -1,  // Minimum NDVI value
            max: 1,   // Maximum NDVI value
            palette: ['#d73027', '#f46d43', '#fdae61', '#fee08b', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850']
        };

        // Explicitly visualize the NDVI for PNG output
        const visualizedNdvi = ndvi.visualize(visParams);

        visualizedNdvi.getDownloadURL({
            scale: 100, // Increased scale to reduce request size (adjust as needed)
            region: geometry,
            format: 'PNG',
            crs: 'EPSG:4326',
            crs_transform: null
        }, (urlOrError) => {
            if (urlOrError instanceof Error) {
                console.error('NDVI generation error:', urlOrError);
                return res.status(500).json({ error: 'Failed to generate NDVI: ' + urlOrError.message });
            }
            res.json({ url: urlOrError });
        });
    } catch (error) {
        console.error('Unexpected error in NDVI endpoint:', error);
        res.status(500).json({ error: 'Unexpected server error: ' + error.message });
    }
});

// Endpoint for Land Cover download (keep existing for potential future use)
app.post('/getLandCover', (req, res) => {
    const { bbox } = req.body;
    if (!bbox || !bbox.west || !bbox.south || !bbox.east || !bbox.north) {
        return res.status(400).json({ error: 'Invalid bounding box provided' });
    }

    const geometry = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    try {
        // Use ESA WorldCover as a reliable land cover dataset
        const landCover = ee.Image('ESA/WorldCover/v200').clip(geometry);

        const visParams = {
            min: 0,
            max: 10, // Adjust based on ESA WorldCover classes
            palette: ['#006400', '#00ff00', '#ffd700', '#ff0000', '#ff00ff', '#00ffff', '#808080']
        };

        // Explicitly visualize the Land Cover for PNG output
        const visualizedLandCover = landCover.visualize(visParams);

        visualizedLandCover.getDownloadURL({
            scale: 100, // Increased scale to reduce request size (adjust as needed)
            region: geometry,
            format: 'PNG',
            crs: 'EPSG:4326',
            crs_transform: null
        }, (urlOrError) => {
            if (urlOrError instanceof Error) {
                console.error('Land Cover generation error:', urlOrError);
                return res.status(500).json({ error: 'Failed to generate Land Cover: ' + urlOrError.message });
            }
            res.json({ url: urlOrError });
        });
    } catch (error) {
        console.error('Unexpected error in Land Cover endpoint:', error);
        res.status(500).json({ error: 'Unexpected server error: ' + error.message });
    }
});

// Endpoint for NDVI visualization (new for viewing on map)
app.post('/viewNDVI', (req, res) => {
    const { bbox } = req.body;
    if (!bbox || !bbox.west || !bbox.south || !bbox.east || !bbox.north) {
        return res.status(400).json({ error: 'Invalid bounding box provided' });
    }

    const geometry = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    try {
        const sentinel2 = ee.ImageCollection('COPERNICUS/S2')
            .filterBounds(geometry)
            .filterDate('2023-01-01', '2025-02-20')
            .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
            .median();

        const ndvi = sentinel2.normalizedDifference(['B8', 'B4']).rename('NDVI');

        const visParams = {
            min: -1,  // Minimum NDVI value
            max: 1,   // Maximum NDVI value
            palette: ['#d73027', '#f46d43', '#fdae61', '#fee08b', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850']
        };

        // Get map ID for visualization
        const mapId = ndvi.getMapId(visParams);

        res.json({
            mapId: mapId.mapId,
            token: mapId.token
        });
    } catch (error) {
        console.error('Unexpected error in NDVI visualization:', error);
        res.status(500).json({ error: 'Failed to visualize NDVI: ' + error.message });
    }
});

// Endpoint for Land Cover visualization (new for viewing on map)
app.post('/viewLandCover', (req, res) => {
    const { bbox } = req.body;
    if (!bbox || !bbox.west || !bbox.south || !bbox.east || !bbox.north) {
        return res.status(400).json({ error: 'Invalid bounding box provided' });
    }

    const geometry = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    try {
        // Use ESA WorldCover as a reliable land cover dataset
        const landCover = ee.Image('ESA/WorldCover/v200').clip(geometry);

        const visParams = {
            min: 0,
            max: 10, // Adjust based on ESA WorldCover classes
            palette: ['#006400', '#00ff00', '#ffd700', '#ff0000', '#ff00ff', '#00ffff', '#808080']
        };

        // Get map ID for visualization
        const mapId = landCover.getMapId(visParams);

        res.json({
            mapId: mapId.mapId,
            token: mapId.token
        });
    } catch (error) {
        console.error('Unexpected error in Land Cover visualization:', error);
        res.status(500).json({ error: 'Failed to visualize Land Cover: ' + error.message });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});