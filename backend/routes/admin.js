'use strict';
/**
 * Admin Routes  –  /api/admin/*  (protected by x-admin-secret header)
 *
 *  GET  /api/admin/stats               Platform overview
 *  GET  /api/admin/streams             Currently live streams
 *  GET  /api/admin/users               All users (paginated)
 *  PATCH /api/admin/users/:username    Enable/disable, change plan
 *  POST /api/admin/streams/:key/kill   Force-kill a stream
 *  GET  /api/admin/relays              Relay node status
 *  GET  /api/admin/vms                 All active VMs
 */
const router     = require('express').Router();
const db         = require('../db/database');
const restreamer = require('../services/restreamer');
const { requireAdmin } = require('../middleware/auth');
const logger     = require('../utils/logger');

router.use(requireAdmin);

// ── Stats dashboard ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [live, total, vms, sessions] = await Promise.all([
      db.query("SELECT COUNT(*) c FROM users WHERE is_live=true"),
      db.query("SELECT COUNT(*) c FROM users"),
      db.query("SELECT COUNT(*) c FROM vm_instances WHERE status='running'"),
      db.query("SELECT COUNT(*) c FROM stream_sessions WHERE started_at > NOW() - INTERVAL '24h'"),
    ]);

    res.json({
      live_streams:       parseInt(live.rows[0].c),
      total_users:        parseInt(total.rows[0].c),
      active_vms:         parseInt(vms.rows[0].c),
      sessions_24h:       parseInt(sessions.rows[0].c),
      ffmpeg_sessions:    restreamer.activeCount,
      ffmpeg_detail:      restreamer.getAllStats(),
      server_uptime_s:    Math.floor(process.uptime()),
      memory_mb:          Math.round(process.memoryUsage().heapUsed / 1_048_576),
    });
  } catch (err) {
    logger.error('[Admin] Stats error:', err);
    res.status(500).json({ error: 'Stats query failed' });
  }
});

// ── Live streams ──────────────────────────────────────────────────────────────
router.get('/streams', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT username, last_ip, stream_start_time,
              stream_to_youtube, stream_to_kick, stream_to_twitch, stream_key
         FROM users WHERE is_live=true ORDER BY stream_start_time DESC`
    );
    res.json({ count: rows.length, streams: rows, ffmpeg: restreamer.getAllStats() });
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

// ── All users ─────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  try {
    const { rows } = await db.query(
      `SELECT username, email, plan, is_active, is_live, vm_enabled, created_at, total_stream_hours
         FROM users ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, (page - 1) * limit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Query failed' });
  }
});

// ── Update user ───────────────────────────────────────────────────────────────
router.patch('/users/:username', async (req, res) => {
  const allowed = ['is_active', 'plan', 'vm_enabled'];
  const updates = [];
  const vals    = [];
  let   idx     = 1;

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key}=$${idx++}`);
      vals.push(req.body[key]);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    vals.push(req.params.username);
    await db.query(
      `UPDATE users SET ${updates.join(',')} WHERE username=$${idx}`,
      vals
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// ── Force-kill a stream ───────────────────────────────────────────────────────
router.post('/streams/:key/kill', async (req, res) => {
  try {
    restreamer.stop(req.params.key);
    await db.query(
      "UPDATE users SET is_live=false, stream_end_time=NOW() WHERE stream_key=$1",
      [req.params.key]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Kill failed' });
  }
});

// ── Relay nodes ───────────────────────────────────────────────────────────────
router.get('/relays', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM relay_nodes ORDER BY region');
  res.json(rows);
});

// ── Active VMs ────────────────────────────────────────────────────────────────
router.get('/vms', async (req, res) => {
  const { rows } = await db.query(
    `SELECT vm.*, u.username
       FROM vm_instances vm
       JOIN users u ON vm.user_id = u.id
      WHERE vm.status != 'terminated'
      ORDER BY vm.created_at DESC`
  );
  res.json(rows);
});

module.exports = router;
