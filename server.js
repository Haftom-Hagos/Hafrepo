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

ee.data.authenticateViaPrivateKey(
    serviceAccount,
    () => {
        ee.initialize(null, null,
            () => {
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
    },
    (error) => {
        console.error('Authentication failed:', error);
    }
);
// Endpoint for NDVI
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
        ndvi.visualize(visParams).getDownloadURL({
            scale: 30,
            region: geometry,
            format: 'PNG'
        }, (url, error) => {
            if (error) {
                console.error('NDVI generation error:', error);
                return res.status(500).json({ error: 'NDVI generation error: ' + error });
            }
            res.json({ url: url });
        });
    } catch (error) {
        console.error('Unexpected error in NDVI endpoint:', error);
        res.status(500).json({ error: 'Unexpected server error: ' + error.message });
    }
});

// Endpoint for Land Cover (using COPERNICUS/S2_LC as an example)
app.post('/getLandCover', (req, res) => {
    const { bbox } = req.body;
    if (!bbox || !bbox.west || !bbox.south || !bbox.east || !bbox.north) {
        return res.status(400).json({ error: 'Invalid bounding box provided' });
    }

    const geometry = ee.Geometry.Rectangle([bbox.west, bbox.south, bbox.east, bbox.north]);

    try {
        const landCover = ee.Image('COPERNICUS/S2_LC').clip(geometry);

        const visParams = {
            min: 0,
            max: 11, // Adjust based on land cover classes
            palette: ['#006400', '#00ff00', '#ffd700', '#ff0000', '#ff00ff', '#00ffff', '#808080', '#000080', '#800000', '#008000', '#0000ff', '#ff4500']
        };
        landCover.visualize(visParams).getDownloadURL({
            scale: 30,
            region: geometry,
            format: 'PNG'
        }, (url, error) => {
            if (error) {
                console.error('Land Cover generation error:', error);
                return res.status(500).json({ error: 'Land Cover generation error: ' + error });
            }
            res.json({ url: url });
        });
    } catch (error) {
        console.error('Unexpected error in Land Cover endpoint:', error);
        res.status(500).json({ error: 'Unexpected server error: ' + error.message });
    }
});

// Define a route handler for the root path
app.get('/', (req, res) => {
    res.send('Welcome to the Ethiosat GEE Backend!');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
