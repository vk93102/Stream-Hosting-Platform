'use strict';
/**
 * Auth Routes  –  called by nginx-rtmp and MediaMTX webhooks
 *
 *  POST /rtmp/auth   nginx-rtmp on_publish  callback
 *  POST /rtmp/done   nginx-rtmp on_done     callback
 *  POST /srt/auth    MediaMTX   onPublish   callback
 *  POST /srt/done    MediaMTX   onUnpublish callback
 */
const router      = require('express').Router();
const db          = require('../db/database');
const restreamer  = require('../services/restreamer');
const brbManager  = require('../services/brbManager');
const { handleSRTAuth, parseStreamKey } = require('../services/srtRouter');
const { broadcast }     = require('../services/websocketServer');
const logger      = require('../utils/logger');

// Fields fetched for BRB – destination URLs must be included
const BRB_FIELDS = `username, youtube_url, twitch_url, kick_url,
              stream_to_youtube, stream_to_twitch, stream_to_kick,
              brb_enabled, brb_timeout_seconds, brb_media_path`;

// ── RTMP auth (nginx-rtmp on_publish) ────────────────────────────────────────
router.post('/rtmp/auth', async (req, res) => {
  // nginx-rtmp posts: name=<stream_key>&addr=<client_ip>&...
  const streamKey = req.body.name || req.body.key;
  const clientIp  = req.body.addr || req.ip;

  if (!streamKey) return res.sendStatus(400);

  try {
    const { rows } = await db.query(
      `SELECT ${BRB_FIELDS} FROM users WHERE stream_key=$1 AND is_active=true`,
      [streamKey]
    );

    if (!rows.length) {
      logger.warn(`[RTMP] Auth DENIED  key=${streamKey}  ip=${clientIp}`);
      return res.sendStatus(403);
    }

    const user = rows[0];

    // Cancel any active BRB session (streamer reconnected)
    brbManager.onReconnect(streamKey);

    await Promise.all([
      db.query(
        `UPDATE users SET is_live=true, last_ip=$1, stream_start_time=NOW() WHERE stream_key=$2`,
        [clientIp, streamKey]
      ),
      db.query(
        `INSERT INTO stream_sessions (user_id, stream_key, ingest_type, client_ip)
         SELECT id, $1, 'rtmp', $2 FROM users WHERE stream_key=$1`,
        [streamKey, clientIp]
      ),
    ]);

    logger.info(`[RTMP] ${user.username} LIVE  ip=${clientIp}`);
    broadcast('stream_start', { username: user.username, ingestType: 'rtmp' });

    res.sendStatus(200);   // MUST respond before spawning FFmpeg

    setTimeout(() => restreamer.start(streamKey, user, 'rtmp'), 1_500);
  } catch (err) {
    logger.error('[RTMP] Auth error:', err);
    res.sendStatus(500);
  }
});

// ── RTMP done (nginx-rtmp on_done) ───────────────────────────────────────────
router.post('/rtmp/done', async (req, res) => {
  const streamKey = req.body.name;
  res.sendStatus(200);   // ack immediately – nginx won't wait

  // Stop live restream instantly so we don't double-push to platforms
  restreamer.stop(streamKey);

  try {
    // Fetch user record (brbManager needs destination URLs + BRB settings)
    const { rows } = await db.query(
      `SELECT ${BRB_FIELDS} FROM users WHERE stream_key=$1`,
      [streamKey]
    );
    if (!rows.length) return;

    logger.info(`[RTMP] Signal drop  key=${streamKey}  brb=${rows[0].brb_enabled}`);
    // Delegate to BRB: handles grace period → BRB loop → DB finalization
    await brbManager.signalDrop(streamKey, rows[0]);
  } catch (err) {
    logger.error('[RTMP] Done error:', err);
  }
});

// ── SRT auth (MediaMTX webhook) ───────────────────────────────────────────────
router.post('/srt/auth', async (req, res) => {
  // MediaMTX sends: { "id": "<streamid>", "ip": "<client_ip>", ... }
  const streamId = req.body.id || req.body.name || req.query.id || req.query.name || '';
  const clientIp = req.body.ip || req.body.addr || req.query.ip || req.query.addr || req.ip;

  // Cancel any active BRB (this is a reconnect)
  const rawKey = parseStreamKey(streamId);
  if (rawKey) brbManager.onReconnect(rawKey);

  const { authorized } = await handleSRTAuth(streamId, clientIp);
  res.sendStatus(authorized ? 200 : 403);
});

// ── SRT done (MediaMTX webhook) ──────────────────────────────────────────────
router.post('/srt/done', async (req, res) => {
  res.sendStatus(200);
  const streamId = req.body.id || req.body.name || req.query.id || req.query.name || '';
  const rawKey   = parseStreamKey(streamId);

  // Stop live restream – BRB will take over platform connections
  if (rawKey) restreamer.stop(rawKey);

  try {
    const { rows } = await db.query(
      `SELECT ${BRB_FIELDS} FROM users WHERE stream_key=$1`,
      [rawKey]
    );
    if (!rows.length) return;
    logger.info(`[SRT] Signal drop  key=${rawKey}  brb=${rows[0].brb_enabled}`);
    await brbManager.signalDrop(rawKey, rows[0]);
  } catch (err) {
    logger.error('[SRT] Done error:', err);
  }
});

module.exports = router;
