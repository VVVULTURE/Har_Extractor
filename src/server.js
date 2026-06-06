const express = require("express");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// Serve the single-page app — all HAR processing happens in the browser.
// The server never touches file data, so memory usage stays flat no matter
// how large the uploaded HAR or how many concurrent users there are.
app.use(express.static(path.join(__dirname, "../public")));

app.listen(PORT, () => {
  console.log(`HAR Extractor running on http://localhost:${PORT}`);
});
