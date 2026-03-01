'use strict';
/**
 * SRT Ingest Router
 * ─────────────────
 * Handles webhook callbacks from MediaMTX when an SRT publisher
 * connects/disconnects.  Validates the stream key, updates the DB,
 * and triggers (or tears down) the FFmpeg restream session.
 *
 * MediaMTX webhook config (mediamtx.yml):
 *   paths:
 *     all_others:
 *       runOnPublish:   "curl -s -X POST http://localhost:3000/srt/auth -d 'id=%{query}&ip=%{sourceIp}'"
 *       runOnUnpublish: "curl -s -X POST http://localhost:3000/srt/done -d 'id=%{query}'"
 *
 * OR use the native runOnPublishRestart / onPublish hooks if you run
 * MediaMTX >= 1.3 which supports HTTP callbacks natively.
 */

const logger     = require('../utils/logger');
const db         = require('../db/database');
const restreamer = require('./restreamer');
const config     = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Called when SRT publisher connects.
 * @param {string} streamId  e.g. "stream:<key>" or raw key from ?streamid= param
 * @param {string} clientIp
 */
async function handleSRTAuth(streamId, clientIp) {
  const streamKey = _parseStreamKey(streamId);

  try {
    const { rows } = await db.query(
      `SELECT id, username, youtube_url, twitch_url, kick_url,
              stream_to_youtube, stream_to_twitch, stream_to_kick
         FROM users
        WHERE stream_key = $1 AND is_active = true`,
      [streamKey]
    );

    if (rows.length === 0) {
      logger.warn(`[SRT] Auth DENIED  key=${streamKey}  ip=${clientIp}`);
      return { authorized: false };
    }

    const user = rows[0];

    await db.query(
      `UPDATE users
          SET is_live = true, last_ip = $1, stream_start_time = NOW()
        WHERE stream_key = $2`,
      [clientIp, streamKey]
    );

    await db.query(
      `INSERT INTO stream_sessions (user_id, stream_key, ingest_type, client_ip)
       VALUES ($1, $2, 'srt', $3)`,
      [user.id, streamKey, clientIp]
    );

    logger.info(`[SRT] ${user.username} CONNECTED  ip=${clientIp}`);

    // Give the SRT feed 2 s to stabilise before pulling with FFmpeg
    setTimeout(() => restreamer.start(streamKey, user, 'srt'), 2_000);

    return { authorized: true, user };
  } catch (err) {
    logger.error('[SRT] handleSRTAuth error:', err);
    return { authorized: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Called when SRT publisher disconnects.
 * @param {string} streamId
 */
async function handleSRTDone(streamId) {
  const streamKey = _parseStreamKey(streamId);

  try {
    restreamer.stop(streamKey);

    await db.query(
      `UPDATE users
          SET is_live = false, stream_end_time = NOW()
        WHERE stream_key = $1`,
      [streamKey]
    );

    await db.query(
      `UPDATE stream_sessions
          SET ended_at = NOW(),
              duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
        WHERE stream_key = $1 AND ended_at IS NULL`,
      [streamKey]
    );

    logger.info(`[SRT] Stream ended: ${streamKey}`);
  } catch (err) {
    logger.error('[SRT] handleSRTDone error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the SRT ingest URL a streamer should point their encoder at.
 *
 * SRT encoder settings (e.g. in IRL Pro / Larix):
 *   URL:        srt://<SERVER_IP>:9999
 *   streamid:   stream:<stream_key>
 *   passphrase: <srt_passphrase>   (optional but recommended)
 *   latency:    2000 ms
 *   mode:       caller
 */
function buildSRTIngestURL(serverIp, streamKey, passphrase = null) {
  const port = config.srt.port;
  let url = `srt://${serverIp}:${port}?streamid=stream:${streamKey}&latency=2000&mode=caller`;
  if (passphrase) url += `&passphrase=${passphrase}&pbkeylen=16`;
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
/** Normalise streamId → raw stream key */
function _parseStreamKey(streamId) {
  if (!streamId) return '';
  return streamId.startsWith('stream:') ? streamId.slice(7) : streamId;
}

module.exports = { handleSRTAuth, handleSRTDone, buildSRTIngestURL };
