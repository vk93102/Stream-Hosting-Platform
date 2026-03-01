'use strict';
/**
 * SIL IRL Hosting Platform  –  Control Plane v4.0
 * ──────────────────────────────────────────────────
 *
 * Architecture overview:
 *
 *  [IRL Encoder / OBS]
 *       │  SRT (port 9999) or RTMP (port 1935)
 *       ▼
 *  [MediaMTX / nginx-rtmp]  ←── webhook ──► [This Server :3000]
 *       │  local RTMP re-publish
 *       ▼
 *  [FFmpeg RestreamManager]
 *    ├── YouTube  rtmp://a.rtmp.youtube.com/live2/<key>
 *    ├── Kick     rtmps://…/<key>
 *    └── Twitch   rtmp://live.twitch.tv/app/<key>
 *
 *  [Admin / Streamer] ──WS──► /ws  (real-time dashboard)
 *  [Streamer Dashboard]         /api/users/*
 *  [Admin Panel]                /api/admin/*  (x-admin-secret)
 *  [OBS VM Control]             /api/vms/*
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const config     = require('./config');
const logger     = require('./utils/logger');
const db         = require('./db/database');
const wsServer   = require('./services/websocketServer');

// Routes
const authRoutes   = require('./routes/auth');
const userRoutes   = require('./routes/users');
const adminRoutes  = require('./routes/admin');
const mediaRoutes  = require('./routes/media');

// Services
const streamHealth = require('./services/streamHealth');

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// ── Rate limiting (API only) ──────────────────────────────────────────────────
app.use('/api', rateLimit({ windowMs: 15 * 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/',           authRoutes);   // POST /rtmp/auth  /rtmp/done  /srt/auth  /srt/done
app.use('/api/users',  userRoutes);   // POST /register /login  GET /:username  etc.
app.use('/api/admin',  adminRoutes);  // GET /stats /streams /users  PATCH /users/:u  …
app.use('/api/media',  mediaRoutes);  // POST|DELETE|GET /api/media/brb

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'online', version: '4.1.0', uptime: Math.floor(process.uptime()) })
);

// ── SPA catch-all ─────────────────────────────────────────────────────────────
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '../frontend/index.html'))
);

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── WebSocket (real-time dashboard) ──────────────────────────────────────────
wsServer.init(server);

// ── Stream health monitor (MediaMTX polling → WS broadcasts) ────────────────
streamHealth.start();

// ── Start ─────────────────────────────────────────────────────────────────────
// Listen immediately so the frontend is always accessible.
// Then connect to the database; a failure is non-fatal in development.
(async () => {
  await new Promise(resolve =>
    server.listen(config.port, '0.0.0.0', () => {
      logger.info(`╔══════════════════════════════════════════════╗`);
      logger.info(`║  SIL IRL Hosting Platform v4.1  ONLINE       ║`);
      logger.info(`║  Port: ${String(config.port).padEnd(5)}  Env: ${config.nodeEnv.padEnd(15)}       ║`);
      logger.info(`╚══════════════════════════════════════════════╝`);
      logger.info(`  → Open http://localhost:${config.port} in your browser`);
      resolve();
    })
  );

  try {
    await db.connect();
  } catch (err) {
    if (config.nodeEnv === 'production') {
      logger.error('[DB] Cannot connect in production – shutting down');
      process.exit(1);
    }
    logger.warn('[DB] Database unavailable – API routes will fail, but frontend is served');
    logger.warn('[DB] Check DATABASE_URL in backend/.env then restart');
  }
})();

process.on('SIGTERM', () => {
  logger.info('SIGTERM – shutting down gracefully');
  server.close(async () => {
    await db.disconnect();
    process.exit(0);
  });
});

module.exports = app;