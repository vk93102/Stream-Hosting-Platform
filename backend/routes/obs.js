'use strict';
/**
 * OBS Control Routes  –  /api/obs/:vmId/*
 * ─────────────────────────────────────────
 * All endpoints require:
 *   1. Valid JWT (requireAuth)
 *   2. vmId must belong to the authenticated user AND be in 'running' state
 *
 * Endpoints:
 *   GET  /:vmId/scenes          → list scenes + current scene
 *   POST /:vmId/scene           → switch active scene  { sceneName }
 *   GET  /:vmId/stream-status   → is OBS currently streaming?
 *   POST /:vmId/stream/start    → start OBS stream
 *   POST /:vmId/stream/stop     → stop OBS stream
 *   POST /:vmId/disconnect      → close WS pool entry (force re-auth)
 */

const router        = require('express').Router();
const obsController = require('../services/obsController');
const db            = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const logger        = require('../utils/logger');

// ── Ownership middleware ──────────────────────────────────────────────────────
async function ownedRunningVM(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT vm.id, vm.ip_address, vm.status
         FROM vm_instances vm
         JOIN users u ON u.id = vm.user_id
        WHERE vm.id = $1 AND u.username = $2`,
      [req.params.vmId, req.user.username]
    );
    if (!rows.length) return res.status(404).json({ error: 'VM not found' });
    if (rows[0].status !== 'running')
      return res.status(409).json({ error: `VM is not running (status: ${rows[0].status})` });
    req.vm = rows[0];
    next();
  } catch (err) {
    logger.error('[OBS route] VM lookup:', err);
    res.status(500).json({ error: 'VM lookup failed' });
  }
}

// ── GET /:vmId/scenes ─────────────────────────────────────────────────────────
router.get('/:vmId/scenes', requireAuth, ownedRunningVM, async (req, res) => {
  try {
    const data = await obsController.listScenes(req.params.vmId);
    res.json(data);
  } catch (err) {
    logger.error('[OBS] listScenes:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /:vmId/scene  { sceneName } ─────────────────────────────────────────
router.post('/:vmId/scene', requireAuth, ownedRunningVM, async (req, res) => {
  const { sceneName } = req.body;
  if (!sceneName) return res.status(400).json({ error: 'sceneName required' });
  try {
    const data = await obsController.switchScene(req.params.vmId, sceneName);
    logger.info(`[OBS] ${req.user.username} switched to scene "${sceneName}"`);
    res.json(data);
  } catch (err) {
    logger.error('[OBS] switchScene:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /:vmId/stream-status ──────────────────────────────────────────────────
router.get('/:vmId/stream-status', requireAuth, ownedRunningVM, async (req, res) => {
  try {
    const data = await obsController.getStreamStatus(req.params.vmId);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /:vmId/stream/start ──────────────────────────────────────────────────
router.post('/:vmId/stream/start', requireAuth, ownedRunningVM, async (req, res) => {
  try {
    await obsController.startStream(req.params.vmId);
    logger.info(`[OBS] ${req.user.username} started OBS stream on vm=${req.params.vmId}`);
    res.json({ success: true, action: 'stream_started' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /:vmId/stream/stop ───────────────────────────────────────────────────
router.post('/:vmId/stream/stop', requireAuth, ownedRunningVM, async (req, res) => {
  try {
    await obsController.stopStream(req.params.vmId);
    logger.info(`[OBS] ${req.user.username} stopped OBS stream on vm=${req.params.vmId}`);
    res.json({ success: true, action: 'stream_stopped' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /:vmId/disconnect ────────────────────────────────────────────────────
router.post('/:vmId/disconnect', requireAuth, ownedRunningVM, (req, res) => {
  obsController.disconnect(req.params.vmId);
  res.json({ success: true });
});

module.exports = router;
