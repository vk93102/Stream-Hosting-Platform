'use strict';
/**
 * Media Routes  –  /api/media/*
 * ──────────────────────────────
 * Handles BRB (Be Right Back) media uploads and settings.
 *
 * Endpoints:
 *   POST   /brb              → upload BRB media file (mp4/mov/jpg/png, max 100MB)
 *   DELETE /brb              → delete current BRB media
 *   GET    /brb/info         → current BRB settings + media info
 *   PUT    /brb/settings     → update brb_enabled / brb_timeout_seconds
 *
 * Files are stored in:  <project_root>/uploads/brb/<username>.<ext>
 * The DB column brb_media_path stores the relative path: "brb/<username>.mp4"
 */

const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db/database');
const logger  = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');

const UPLOADS_DIR = path.join(__dirname, '../../uploads/brb');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_EXTS = /\.(mp4|mov|webm|jpg|jpeg|png)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;   // 100 MB

// ── Multer storage ────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.username}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    ALLOWED_EXTS.test(file.originalname)
      ? cb(null, true)
      : cb(new Error('Only MP4, MOV, WEBM, JPG, PNG files are allowed'));
  },
});

// ── POST /api/media/brb  (upload BRB file) ───────────────────────────────────
router.post('/brb', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Delete any previous file for this user (different extension)
  try {
    const { rows } = await db.query(
      'SELECT brb_media_path FROM users WHERE username=$1',
      [req.user.username]
    );
    if (rows[0]?.brb_media_path) {
      const old = path.join(UPLOADS_DIR, '..', rows[0].brb_media_path);
      if (fs.existsSync(old) && old !== path.join(UPLOADS_DIR, req.file.filename)) {
        fs.unlinkSync(old);
      }
    }
  } catch { /* ignore cleanup errors */ }

  const mediaPath = `brb/${req.file.filename}`;

  try {
    await db.query(
      'UPDATE users SET brb_media_path=$1 WHERE username=$2',
      [mediaPath, req.user.username]
    );
    logger.info(`[Media] BRB upload  user=${req.user.username}  file=${req.file.filename}  size=${req.file.size}`);
    res.json({
      success:    true,
      filename:   req.file.filename,
      size_bytes: req.file.size,
      media_path: mediaPath,
    });
  } catch (err) {
    logger.error('[Media] DB update error:', err);
    res.status(500).json({ error: 'Failed to save media path' });
  }
});

// ── DELETE /api/media/brb ────────────────────────────────────────────────────
router.delete('/brb', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT brb_media_path FROM users WHERE username=$1',
      [req.user.username]
    );
    if (rows[0]?.brb_media_path) {
      const full = path.join(UPLOADS_DIR, '..', rows[0].brb_media_path);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
    await db.query('UPDATE users SET brb_media_path=NULL WHERE username=$1', [req.user.username]);
    res.json({ success: true });
  } catch (err) {
    logger.error('[Media] Delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── GET /api/media/brb/info ──────────────────────────────────────────────────
router.get('/brb/info', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT brb_enabled, brb_timeout_seconds, brb_media_path FROM users WHERE username=$1',
      [req.user.username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const info = rows[0];

    // Check if the file actually exists on disk
    let file_exists = false;
    let file_size   = 0;
    if (info.brb_media_path) {
      const full = path.join(UPLOADS_DIR, '..', info.brb_media_path);
      if (fs.existsSync(full)) {
        file_exists = true;
        file_size   = fs.statSync(full).size;
      }
    }

    res.json({ ...info, file_exists, file_size });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ── PUT /api/media/brb/settings ──────────────────────────────────────────────
router.put('/brb/settings', requireAuth, async (req, res) => {
  const { brb_enabled, brb_timeout_seconds } = req.body;
  try {
    await db.query(
      `UPDATE users
          SET brb_enabled          = $1,
              brb_timeout_seconds  = $2
        WHERE username = $3`,
      [
        brb_enabled !== undefined ? Boolean(brb_enabled) : true,
        Math.min(1800, Math.max(30, parseInt(brb_timeout_seconds) || 300)),
        req.user.username,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error('[Media] Settings error:', err);
    res.status(500).json({ error: 'Settings update failed' });
  }
});

// ── Multer error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: 'Upload error' });
});

module.exports = router;
