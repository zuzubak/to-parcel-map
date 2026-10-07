// Copy to config.js and fill in your CARTO key. config.js is gitignored; CI writes its own
// copy from the CARTO_API_KEY repo secret at deploy time. Without a key the map falls back
// to plain OpenStreetMap raster tiles -- CARTO's keyless endpoint now returns a watermark.
window.CARTO_API_KEY = "";
