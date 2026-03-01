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
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const db     = require('../db/database');
const config = require('../config');
const logger = require('../utils/logger');
const { buildSRTIngestURL } = require('../services/srtRouter');
const { requireAuth }       = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/register
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const streamKey     = crypto.randomBytes(24).toString('hex');
  const srtPassphrase = crypto.randomBytes(8).toString('hex');

  try {
    const hash = password ? await bcrypt.hash(password, 12) : null;

    await db.query(
      `INSERT INTO users (username, email, password_hash, stream_key, srt_passphrase, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [username, email || null, hash, streamKey, srtPassphrase]
    );

    res.status(201).json({
      success:    true,
      username,
      stream_key:  streamKey,
      rtmp_ingest: `rtmp://${config.serverPublicIp}/live/${streamKey}`,
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
      const ok = await bcrypt.compare(password, user.password_hash);
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
// GET /api/users/:username
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:username', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT username, email, is_live, plan, vm_enabled,
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
        kk_url || null,
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
      rtmp_ingest: `rtmp://${config.serverPublicIp}/live/${newKey}`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Key rotation failed' });
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
