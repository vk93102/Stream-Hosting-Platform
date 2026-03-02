'use strict';
/**
 * WebSocket Server
 * ────────────────
 * Real-time dashboard updates pushed to connected browsers.
 *
 * Messages broadcasted every 5 s:
 *   { type: 'live_update', activeStreams, streams[], ffmpegSessions[] }
 *
 * Client can send:
 *   { type: 'get_stats' }   → immediate stats reply
 *   { type: 'ping'       }   → pong
 */

const { WebSocketServer } = require('ws');
const logger     = require('../utils/logger');
const db         = require('../db/database');
const restreamer = require('./restreamer');

let wss = null;
/** @type {Map<string, import('ws')>} */
const clients = new Map();

// ─────────────────────────────────────────────────────────────────────────────
function init(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // If the underlying HTTP server fails to bind (e.g. EADDRINUSE),
  // ws re-emits the error on wss.  Catch it here so it doesn't throw uncaught.
  wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      logger.error('[WS] Server error:', err.message);
    }
    // The http server's own error handler will do the exit/logging.
  });

  wss.on('connection', (ws, req) => {
    const id = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    clients.set(id, ws);
    logger.debug(`[WS] Connected: ${id}  total=${clients.size}`);

    ws.send(JSON.stringify({ type: 'connected', clientId: id }));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        await _handleMessage(ws, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close',  ()    => { clients.delete(id); logger.debug(`[WS] Closed: ${id}`); });
    ws.on('error',  (err) => { logger.error(`[WS] Error ${id}: ${err.message}`); clients.delete(id); });
  });

  // Broadcast live stats every 5 s
  setInterval(_broadcastStats, 5_000);

  logger.info('[WS] WebSocket server ready on /ws');
  return wss;
}

// ─────────────────────────────────────────────────────────────────────────────
async function _handleMessage(ws, msg) {
  switch (msg.type) {
    case 'get_stats': {
      const stats = restreamer.getAllStats();
      ws.send(JSON.stringify({ type: 'stats', data: stats }));
      break;
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'unknown', received: msg.type }));
  }
}

async function _broadcastStats() {
  if (clients.size === 0) return;
  try {
    const { rows } = await db.query(
      `SELECT username, last_ip, stream_start_time,
              stream_to_youtube, stream_to_kick, stream_to_twitch
         FROM users WHERE is_live = true`
    );

    const payload = JSON.stringify({
      type:           'live_update',
      timestamp:      Date.now(),
      activeStreams:   rows.length,
      streams:         rows,
      ffmpegSessions:  restreamer.getAllStats(),
    });

    for (const [, ws] of clients) {
      if (ws.readyState === 1 /* OPEN */) ws.send(payload);
    }
  } catch (err) {
    logger.error('[WS] Broadcast error:', err);
  }
}

/** Manual broadcast from route handlers (e.g. stream start/stop). */
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data, timestamp: Date.now() });
  for (const [, ws] of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

module.exports = { init, broadcast };
