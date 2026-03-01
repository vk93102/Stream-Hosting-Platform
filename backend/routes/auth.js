'use strict';
/**
 * Auth Routes  –  called by nginx-rtmp and MediaMTX webhooks
 *
 *  POST /rtmp/auth   nginx-rtmp on_publish  callback
 *  POST /rtmp/done   nginx-rtmp on_done     callback
 *  POST /srt/auth    MediaMTX   onPublish   callback
 *  POST /srt/done    MediaMTX   onUnpublish callback
 */
const router     = require('express').Router();
const db         = require('../db/database');
const restreamer = require('../services/restreamer');
const { handleSRTAuth, handleSRTDone } = require('../services/srtRouter');
const { broadcast } = require('../services/websocketServer');
const logger     = require('../utils/logger');

// ── RTMP auth (nginx-rtmp on_publish) ────────────────────────────────────────
router.post('/rtmp/auth', async (req, res) => {
  // nginx-rtmp posts: name=<stream_key>&addr=<client_ip>&...
  const streamKey = req.body.name || req.body.key;
  const clientIp  = req.body.addr || req.ip;

  if (!streamKey) return res.sendStatus(400);

  try {
    const { rows } = await db.query(
      `SELECT username, youtube_url, twitch_url, kick_url,
              stream_to_youtube, stream_to_twitch, stream_to_kick
         FROM users
        WHERE stream_key = $1 AND is_active = true`,
      [streamKey]
    );

    if (!rows.length) {
      logger.warn(`[RTMP] Auth DENIED  key=${streamKey}  ip=${clientIp}`);
      return res.sendStatus(403);
    }

    const user = rows[0];

    await Promise.all([
      db.query(
        `UPDATE users SET is_live=true, last_ip=$1, stream_start_time=NOW()
          WHERE stream_key=$2`,
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
  res.sendStatus(200);   // ack immediately

  try {
    restreamer.stop(streamKey);
    broadcast('stream_end', { streamKey });

    await Promise.all([
      db.query(
        `UPDATE users SET is_live=false, stream_end_time=NOW()
          WHERE stream_key=$1`,
        [streamKey]
      ),
      db.query(
        `UPDATE stream_sessions
            SET ended_at=NOW(),
                duration_seconds=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
          WHERE stream_key=$1 AND ended_at IS NULL`,
        [streamKey]
      ),
    ]);

    logger.info(`[RTMP] Stream ended: ${streamKey}`);
  } catch (err) {
    logger.error('[RTMP] Done error:', err);
  }
});

// ── SRT auth (MediaMTX webhook) ───────────────────────────────────────────────
router.post('/srt/auth', async (req, res) => {
  // MediaMTX sends: { "id": "<streamid>", "ip": "<client_ip>", ... }
  const streamId = req.body.id   || req.body.name   || '';
  const clientIp = req.body.ip   || req.body.addr   || req.ip;

  const { authorized } = await handleSRTAuth(streamId, clientIp);
  res.sendStatus(authorized ? 200 : 403);
});

// ── SRT done (MediaMTX webhook) ───────────────────────────────────────────────
router.post('/srt/done', async (req, res) => {
  await handleSRTDone(req.body.id || req.body.name || '');
  res.sendStatus(200);
});

module.exports = router;
