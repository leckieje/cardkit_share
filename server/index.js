require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers.
// CSP is disabled because CardKit loads fonts and CSS from external WSJ/Barron's CDNs.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*'),
}));

// Allow up to 10 MB bodies to accommodate base64-encoded images in project state.
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/projects', require('./routes/projects'));
app.use('/api/ai',       require('./routes/ai'));
app.use('/api/sheets',   require('./routes/sheets'));

// Static files: serve the cardkit-build directory (parent of server/).
const STATIC_DIR = path.join(__dirname, '..');
app.use(express.static(STATIC_DIR, {
  // Disable caching on index.html and the shim so updates reach clients immediately.
  setHeaders(res, filePath) {
    var base = path.basename(filePath);
    if (base === 'index.html' || base === 'cardkit-shim.js') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA catch-all: serve index.html for /?p=id and any other non-API path.
// This must come after static file serving.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  } else {
    next();
  }
});

app.use(require('./middleware/errorHandler'));

app.listen(PORT, () => {
  console.log(`CardKit server running at http://localhost:${PORT}`);
});
