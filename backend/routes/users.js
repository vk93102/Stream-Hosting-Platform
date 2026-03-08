'use strict';
/**
 * User Routes  –  /api/users/*
 *
 *  POST /api/users/register         Create account + stream keys
 *  POST /api/users/login            JWT login
 *  GET  /api/users/:username        Public profile
 *  PUT  /api/users/destinations     Update YouTube/Kick/Twitch URLs
 *  POST /api/users/regenerate-key   Roll stream key
 *  GET  /api/users/:username/sessions  Stream history
 */
const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const db     = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');
const { buildSRTIngestURL } = require('../services/srtRouter');
const { requireAuth }       = require('../middleware/auth');
const brbManager            = require('../services/brbManager');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/register
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const streamKey     = crypto.randomBytes(24).toString('hex');
  const srtPassphrase = crypto.randomBytes(8).toString('hex');

  try {
    const hash = password ? bcrypt.hashSync(password, 12) : null;

    await db.query(
      `INSERT INTO users (username, email, password_hash, stream_key, srt_passphrase, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [username, email || null, hash, streamKey, srtPassphrase]
    );

    res.status(201).json({
      success:    true,
      username,
      stream_key:  streamKey,
      // OBS uses a server URL + stream key field. Provide both explicitly.
      rtmp_server: `rtmp://${config.serverPublicIp}:1935/live`,
      rtmp_stream_key: streamKey,
      // Back-compat (single-url style for other encoders)
      rtmp_ingest: `rtmp://${config.serverPublicIp}:1935/live/${streamKey}`,
      srt_ingest:  buildSRTIngestURL(config.serverPublicIp, streamKey, srtPassphrase),
      srt_passphrase: srtPassphrase,
    });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Username or email already exists' });
    logger.error('[Users] Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE username=$1 AND is_active=true',
      [username]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    if (user.password_hash && password) {
      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      token,
      username:   user.username,
      stream_key: user.stream_key,
      plan:       user.plan,
    });
  } catch (err) {
    logger.error('[Users] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me  (requires auth)  –  full profile including stream keys
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, email, is_live, is_active, plan, prefer_srt,
              stream_key, srt_passphrase,
              youtube_url, twitch_url, kick_url,
              stream_to_youtube, stream_to_twitch, stream_to_kick,
              brb_enabled, brb_timeout_seconds, brb_media_path,
              last_ip, stream_start_time, total_stream_hours, created_at
         FROM users WHERE id=$1`,
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    logger.error('[Users] /me error:', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/:username
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:username', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT username, email, is_live, plan,
              stream_to_youtube, stream_to_kick, stream_to_twitch,
              created_at, total_stream_hours
         FROM users WHERE username=$1`,
      [req.params.username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a Kick stream URL/key into the canonical RTMPS ingest URL.
 *
 * Kick's ingest endpoint is:
 *   rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/<stream_key>
 *
 * Users commonly paste just the stream key, or a URL that is missing
 * the :443 port and/or the /app/ application path.  This function
 * handles all common variants and returns the correct full URL.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normaliseKickUrl(raw) {
  if (!raw) return null;
  const KICK_HOST = 'fa723fc1b171.global-contribute.live-video.net';
  const KICK_BASE = `rtmps://${KICK_HOST}:443/app/`;

  const val = raw.trim();

  // Already a full, correct URL  →  return as-is
  if (val.startsWith(KICK_BASE)) return val;

  // Full RTMPS URL but missing :443 and/or /app/
  // e.g. rtmps://fa723fc1b171.global-contribute.live-video.net/sk_...
  //      rtmps://fa723fc1b171.global-contribute.live-video.net:443/sk_...
  if (/^rtmps?:\/\//i.test(val)) {
    try {
      const u = new URL(val.replace(/^rtmps/i, 'https').replace(/^rtmp/i, 'http'));
      // Extract everything after the hostname (strip leading slash)
      let path = u.pathname.replace(/^\//, '');
      // If path starts with 'app/', keep it; otherwise add it
      if (path.startsWith('app/')) path = path.slice(4);
      // path is now just the stream key (possibly with extra segments)
      const key = path.split('/')[0];
      if (!key) return val; // can't parse — return unchanged
      return KICK_BASE + key;
    } catch {
      return val;
    }
  }

  // Plain stream key with no URL scheme (e.g. sk_us-west-2_xxxx or live_xxxx)
  return KICK_BASE + val;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/users/destinations  (requires auth)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/destinations', requireAuth, async (req, res) => {
  const { yt_url, tw_url, kk_url, yt_on, tw_on, kk_on } = req.body;
  const username = req.user.username;

  try {
    await db.query(
      `UPDATE users
          SET youtube_url=$1, twitch_url=$2, kick_url=$3,
              stream_to_youtube=$4, stream_to_twitch=$5, stream_to_kick=$6
        WHERE username=$7`,
      [
        yt_url || null,
        tw_url || null,
        normaliseKickUrl(kk_url),
        yt_on === true || yt_on === 'true',
        tw_on === true || tw_on === 'true',
        kk_on === true || kk_on === 'true',
        username,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('[Users] Destinations update error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/regenerate-key  (requires auth)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/regenerate-key', requireAuth, async (req, res) => {
  const newKey = crypto.randomBytes(24).toString('hex');
  try {
    await db.query('UPDATE users SET stream_key=$1 WHERE username=$2', [newKey, req.user.username]);
    res.json({
      stream_key:  newKey,
      rtmp_server: `rtmp://${config.serverPublicIp}:1935/live`,
      rtmp_stream_key: newKey,
      rtmp_ingest: `rtmp://${config.serverPublicIp}:1935/live/${newKey}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Key rotation failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/end-stream  (requires auth)
// Intentionally end the stream immediately (do NOT run BRB)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/end-stream', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT stream_key FROM users WHERE id=$1', [req.user.userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await brbManager.forceEnd(rows[0].stream_key);
    res.json({ success: true });
  } catch (err) {
    logger.error('[Users] end-stream error:', err);
    res.status(500).json({ error: 'End stream failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/:username/sessions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:username/sessions', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT ss.id, ss.ingest_type, ss.client_ip, ss.started_at,
              ss.ended_at, ss.duration_seconds, ss.streamed_to
         FROM stream_sessions ss
         JOIN users u ON ss.user_id = u.id
        WHERE u.username=$1
        ORDER BY ss.started_at DESC
        LIMIT 50`,
      [req.params.username]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

module.exports = router;
