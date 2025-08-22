const express = require("express");
const bodyParser = require("body-parser");
const ee = require("@google/earthengine");
const privateKey = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

const app = express();
app.use(bodyParser.json());

// Authenticate Earth Engine
ee.data.authenticateViaPrivateKey(privateKey, () => {
  ee.initialize(null, null, () => {
    console.log("Earth Engine initialized.");
  }, (err) => {
    console.error("Initialization error: " + err);
  });
});

// Example route: get NDVI mapId + token
app.get("/ndvi", (req, res) => {
  // Mekelle AOI (replace with your geometry later)
  const mekelle = ee.Geometry.Point([39.47, 13.48]).buffer(50000);

  const dataset = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
    .filterDate("2020-01-01", "2020-12-31")
    .filterBounds(mekelle)
    .median();

  const ndvi = dataset.normalizedDifference(["B8", "B4"]).rename("NDVI");

  const visParams = { min: 0, max: 1, palette: ["white","green"] };

  ndvi.getMap(visParams, (mapObj) => {
    res.json(mapObj); // {mapid, token}
  });
});

// Run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
