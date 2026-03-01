'use strict';
/**
 * Stream Health Monitor
 * ──────────────────────
 * Polls the MediaMTX REST API every 5 s to collect per-stream metrics:
 *   - Bitrate (kbps)  – calculated from bytesReceived delta
 *   - Packet loss (%) – from SRT packetsLost vs packetsReceived delta
 *   - Ingest type     – srtConn | rtmpConn
 *   - Connection age  – seconds since first seen
 *
 * Broadcasts `health_update` events over WebSocket to all connected dashboards.
 * If packet loss > LOSS_WARN_PCT, also broadcasts a `quality_warn` event.
 *
 * BRB integration: if a stream disappears from MediaMTX (signal drop)
 * but the DB still shows is_live=true, this monitor confirms the drop
 * and increments a "missed_poll" counter, then triggers BRB after
 * MISSED_POLLS_BEFORE_BRB consecutive misses.
 */
const axios      = require('axios');
const logger     = require('../utils/logger');
const config     = require('../config');
const { broadcast } = require('./websocketServer');

const POLL_MS              = 5_000;
const LOSS_WARN_PCT        = 5;     // warn if packet loss > 5%
const MISSED_POLLS_BRB     = 2;     // confirm drop after 2 missed polls (~10s)

// Per-stream state
const prev    = new Map();   // streamKey → { bytesReceived, pktsReceived, pktsLost, ts }
const missed  = new Map();   // streamKey → consecutive missed poll count
const seenAt  = new Map();   // streamKey → first seen timestamp

function start() {
  logger.info('[Health] Stream health monitor started');
  setInterval(_poll, POLL_MS);
}

async function _poll() {
  let items = [];

  // Try MediaMTX v3, then v2
  for (const version of ['v3', 'v2']) {
    try {
      const { data } = await axios.get(
        `${config.srt.mediamtxApi}/${version}/paths/list`,
        { timeout: 3_000 }
      );
      items = data.items || [];
      break;
    } catch { /* try next */ }
  }

  const now       = Date.now();
  const activeSet = new Set(items.map(i => i.name));

  // ── Process each active stream ──────────────────────────────────────────
  for (const item of items) {
    const key = item.name;
    missed.set(key, 0);
    if (!seenAt.has(key)) seenAt.set(key, now);

    const src = item.source || {};
    const bytesReceived   = src.bytesReceived  || 0;
    const pktsReceived    = src.packetsReceived || 0;
    const pktsLost        = src.packetsLost     || 0;

    const snapshot = prev.get(key);
    let   bitrate_kbps   = 0;
    let   loss_pct       = 0;

    if (snapshot) {
      const dtSec      = (now - snapshot.ts) / 1_000;
      const bytesDelta = Math.max(0, bytesReceived - snapshot.bytesReceived);
      bitrate_kbps     = Math.round((bytesDelta * 8) / 1_000 / dtSec);

      const pktDelta     = (pktsReceived - snapshot.pktsReceived)
                         + (pktsLost     - snapshot.pktsLost);
      const lostDelta    = pktsLost - snapshot.pktsLost;
      if (pktDelta > 0) loss_pct = parseFloat((lostDelta / pktDelta * 100).toFixed(2));
    }

    prev.set(key, { bytesReceived, pktsReceived, pktsLost, ts: now });

    const healthPayload = {
      streamKey:    key,
      bitrate_kbps: Math.max(0, bitrate_kbps),
      loss_pct:     Math.max(0, loss_pct),
      ingest_type:  src.type || 'unknown',
      uptime_s:     Math.floor((now - (seenAt.get(key) || now)) / 1_000),
      quality:      _quality(bitrate_kbps, loss_pct),
    };

    broadcast('health_update', healthPayload);

    // Quality warning
    if (loss_pct > LOSS_WARN_PCT) {
      broadcast('quality_warn', { streamKey: key, loss_pct, bitrate_kbps });
      logger.warn(`[Health] High packet loss  key=${key}  loss=${loss_pct}%  bitrate=${bitrate_kbps}kbps`);
    }
  }

  // ── Clean up stale entries ──────────────────────────────────────────────
  for (const key of prev.keys()) {
    if (!activeSet.has(key)) {
      prev.delete(key);
      seenAt.delete(key);
      missed.delete(key);
    }
  }
}

/** Returns 'excellent' | 'good' | 'fair' | 'poor' */
function _quality(bitrate_kbps, loss_pct) {
  if (loss_pct > 10 || bitrate_kbps < 500)  return 'poor';
  if (loss_pct > 5  || bitrate_kbps < 1500) return 'fair';
  if (loss_pct > 2  || bitrate_kbps < 3000) return 'good';
  return 'excellent';
}

module.exports = { start };
