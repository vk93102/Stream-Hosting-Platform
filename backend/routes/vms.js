'use strict';
/**
 * VM Routes  –  /api/vms/*
 *
 *  POST   /api/vms/provision         Spin up a new OBS VM
 *  GET    /api/vms/status/:username  Get VM status + noVNC URL
 *  DELETE /api/vms/:vmId             Terminate a VM
 */
const router    = require('express').Router();
const vmManager = require('../services/vmManager');
const db        = require('../db/database');
const logger    = require('../utils/logger');
const { buildSRTIngestURL } = require('../services/srtRouter');
const { requireAuth }       = require('../middleware/auth');
const config    = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/vms/provision
// ─────────────────────────────────────────────────────────────────────────────
router.post('/provision', requireAuth, async (req, res) => {
  const username = req.user.username;
  const { region } = req.body;

  try {
    // Fetch user record
    const { rows } = await db.query(
      'SELECT id, stream_key, srt_passphrase, vm_enabled FROM users WHERE username=$1',
      [username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const user = rows[0];

    if (!user.vm_enabled)
      return res.status(403).json({ error: 'OBS VM feature not enabled. Upgrade to Pro or Enterprise.' });

    // Prevent duplicate VMs
    const { rows: existing } = await db.query(
      `SELECT id FROM vm_instances
        WHERE user_id=$1 AND status IN ('provisioning','running')`,
      [user.id]
    );
    if (existing.length)
      return res.status(409).json({ error: 'You already have an active VM', vmId: existing[0].id });

    // SRT URL that the OBS VM will stream into SIL
    const srtIngestUrl = buildSRTIngestURL(
      config.serverPublicIp,
      user.stream_key,
      user.srt_passphrase
    );

    const vm = await vmManager.provision(user.id, { region, srtIngestUrl });

    res.status(202).json({
      success: true,
      message: 'VM provisioning started – usually ready in 2–3 minutes.',
      vm: {
        id:           vm.id,
        status:       vm.status,
        region:       vm.region,
        novnc_port:   vm.novnc_port,
        obs_password: vm.obs_password,
        srt_ingest:   srtIngestUrl,
      },
    });
  } catch (err) {
    logger.error('[VMs] Provision error:', err);
    res.status(500).json({ error: err.message || 'Provisioning failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/vms/status/:username
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:username', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT vm.id, vm.status, vm.ip_address, vm.region, vm.size,
              vm.novnc_port, vm.obs_port, vm.obs_password,
              vm.started_at, vm.ingest_url
         FROM vm_instances vm
         JOIN users u ON vm.user_id = u.id
        WHERE u.username=$1 AND vm.status != 'terminated'
        ORDER BY vm.created_at DESC
        LIMIT 1`,
      [req.params.username]
    );

    if (!rows.length) return res.json({ status: 'none' });

    const vm = rows[0];
    const novncUrl = vm.ip_address
      ? `http://${vm.ip_address}:${vm.novnc_port}/vnc.html?autoconnect=true&resize=scale`
      : null;

    res.json({ ...vm, novnc_url: novncUrl });
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/vms/:vmId
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:vmId', requireAuth, async (req, res) => {
  try {
    await vmManager.terminate(req.params.vmId, req.user.userId);
    res.json({ success: true, message: 'VM terminated' });
  } catch (err) {
    logger.error('[VMs] Terminate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
