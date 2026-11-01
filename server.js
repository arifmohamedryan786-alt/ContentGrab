/**
 * ContentGrab - Local Web Server
 * Runs locally on macOS at 127.0.0.1:3000.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const mediaRoutes = require('./routes/mediaRoutes');

const app = express();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 3000;

// Security and CORS middleware
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://contentgrab.vercel.app'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// JSON body parser with strict size limit
app.use(express.json({ limit: '100kb' }));

// In-memory lightweight rate limiter
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 40;

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
  const now = Date.now();

  const record = requestCounts.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
  } else {
    record.count += 1;
  }

  requestCounts.set(ip, record);

  if (record.count > MAX_REQUESTS_PER_WINDOW && req.path.startsWith('/api/')) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Please wait a minute before making more requests.'
    });
  }

  next();
});

// Clean up old rate limit records periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of requestCounts.entries()) {
    if (now > rec.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 60000).unref();

// Serve static frontend assets from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Mount API routes
app.use('/api', mediaRoutes);

// Fallback for unmatched API routes
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Fallback for HTML5 client routing (serves index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler - never leaks technical stack traces to the user
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    success: false,
    error: 'A server error occurred. Please try again later.'
  });
});

// Start listening strictly on loopback interface when run directly
let server = null;
if (require.main === module) {
  server = app.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`  ContentGrab - Local Server Active`);
    console.log(`  Local URL: http://${HOST}:${PORT}`);
    console.log(`  Environment: Personal Local macOS Utility`);
    console.log(`  Saved Files: ${path.resolve(__dirname, 'downloads')}`);
    console.log(`======================================================\n`);
  });

  // Graceful shutdown handling
  process.on('SIGTERM', () => {
    if (server) server.close(() => console.log('Server terminated.'));
  });

  process.on('SIGINT', () => {
    if (server) server.close(() => console.log('\nServer gracefully stopped.'));
  });
}

module.exports = app;
