'use strict';
/**
 * VM Manager
 * ──────────
 * Provisions and manages headless OBS virtual machines on
 * DigitalOcean (default) or AWS.
 *
 * Each VM is bootstrapped via cloud-init to:
 *  1. Install OBS Studio + obs-websocket + Xvfb + x11vnc + noVNC
 *  2. Configure OBS to push SRT → back to SIL ingest
 *  3. Expose OBS WebSocket (port 4455) and browser VNC (port 6080)
 *
 * The SIL dashboard lets streamers open a browser-based remote
 * desktop (noVNC) to control their OBS scene without needing
 * VNC client software.
 */

const axios  = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const db     = require('../db/database');
const config = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// cloud-init bash script – runs once on first boot
// ─────────────────────────────────────────────────────────────────────────────
function buildInitScript(srtIngestUrl, obsWsPassword, vncPassword) {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# ── 1. System update ─────────────────────────────────────────
apt-get update -y
apt-get install -y --no-install-recommends \\
  xvfb x11vnc novnc websockify obs-studio ffmpeg \\
  wget curl jq net-tools dbus-x11

# ── 2. obs-websocket plugin v5 ───────────────────────────────
OBS_WS_VER="5.3.3"
wget -qO /tmp/obs-ws.deb \\
  "https://github.com/obsproject/obs-websocket/releases/download/\${OBS_WS_VER}/obs-websocket-\${OBS_WS_VER}-ubuntu22.04_amd64.deb"
dpkg -i /tmp/obs-ws.deb || apt-get install -fy

# ── 3. Streamer user ─────────────────────────────────────────
id streamer &>/dev/null || useradd -m -s /bin/bash streamer

# ── 4. OBS config ────────────────────────────────────────────
mkdir -p /home/streamer/.config/obs-studio/plugin_config/obs-websocket

cat > /home/streamer/.config/obs-studio/global.ini <<'INI'
[General]
FirstRun=false
[BasicWindow]
SysTrayEnabled=false
INI

cat > /home/streamer/.config/obs-studio/plugin_config/obs-websocket/config.json <<JSON
{
  "alerts_enabled": false,
  "server_enabled": true,
  "server_password": "${obsWsPassword}",
  "server_port": 4455
}
JSON

# ── 5. OBS stream service (SRT → SIL) ────────────────────────
mkdir -p /home/streamer/.config/obs-studio
cat > /home/streamer/.config/obs-studio/service.json <<JSON
{
  "settings": {
    "service": "Custom...",
    "server": "${srtIngestUrl}",
    "key": ""
  },
  "type": "rtmp_custom"
}
JSON

chown -R streamer:streamer /home/streamer/.config

# ── 6. systemd: Xvfb ─────────────────────────────────────────
cat > /etc/systemd/system/xvfb.service <<'SVC'
[Unit]
Description=Virtual Framebuffer X Server
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :1 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset
Restart=always

[Install]
WantedBy=multi-user.target
SVC

# ── 7. systemd: OBS ──────────────────────────────────────────
cat > /etc/systemd/system/obs.service <<'SVC'
[Unit]
Description=OBS Studio (Headless)
After=xvfb.service
Requires=xvfb.service

[Service]
Environment="DISPLAY=:1"
ExecStart=/usr/bin/obs --startstreaming --minimize-to-tray
Restart=on-failure
User=streamer
WorkingDirectory=/home/streamer

[Install]
WantedBy=multi-user.target
SVC

# ── 8. systemd: x11vnc ───────────────────────────────────────
cat > /etc/systemd/system/x11vnc.service <<SVC
[Unit]
Description=x11vnc VNC Server
After=xvfb.service

[Service]
ExecStart=/usr/bin/x11vnc -display :1 -passwd "${vncPassword}" -forever -rfbport 5900 -shared
Restart=always

[Install]
WantedBy=multi-user.target
SVC

# ── 9. systemd: noVNC (browser VNC) ──────────────────────────
cat > /etc/systemd/system/novnc.service <<'SVC'
[Unit]
Description=noVNC Browser VNC Gateway
After=x11vnc.service

[Service]
ExecStart=/usr/share/novnc/utils/novnc_proxy --vnc localhost:5900 --listen 6080
Restart=always

[Install]
WantedBy=multi-user.target
SVC

# ── 10. Enable & start ───────────────────────────────────────
systemctl daemon-reload
systemctl enable xvfb obs x11vnc novnc
systemctl start xvfb
sleep 4
systemctl start obs x11vnc novnc

echo "SIL OBS VM bootstrap complete"
`;
}

// ─────────────────────────────────────────────────────────────────────────────
class VMManager {
  constructor() {
    this.provider = config.vm.provider;
  }

  // ── Public: provision ────────────────────────────────────────────────────
  /**
   * @param {string} userId   UUID from users table
   * @param {{ region?: string, srtIngestUrl: string }} opts
   * @returns {Promise<object>}  vm_instances row
   */
  async provision(userId, opts = {}) {
    const obsPassword = _genPassword(16);
    const vncPassword = _genPassword(12);
    const region      = opts.region || config.vm[this.provider]?.region || 'sgp1';
    const srtIngestUrl = opts.srtIngestUrl || '';

    logger.info(`[VM] Provisioning ${this.provider} VM for user=${userId} region=${region}`);

    const initScript = buildInitScript(srtIngestUrl, obsPassword, vncPassword);

    let providerVm;
    if (this.provider === 'digitalocean') {
      providerVm = await this._doProvision(initScript, region);
    } else if (this.provider === 'aws') {
      providerVm = await this._awsProvision(initScript, region);
    } else {
      throw new Error(`Unsupported VM provider: ${this.provider}`);
    }

    const { rows } = await db.query(
      `INSERT INTO vm_instances
         (user_id, provider, provider_id, status, region, size,
          obs_password, vnc_password, novnc_port, ingest_url)
       VALUES ($1,$2,$3,'provisioning',$4,$5,$6,$7,6080,$8)
       RETURNING *`,
      [userId, this.provider, providerVm.id, region, providerVm.size,
       obsPassword, vncPassword, srtIngestUrl]
    );

    const vm = rows[0];
    this._pollForIp(vm.id, providerVm.id);   // async – updates DB when ready
    return vm;
  }

  // ── Public: terminate ────────────────────────────────────────────────────
  async terminate(vmId, userId) {
    const { rows } = await db.query(
      'SELECT * FROM vm_instances WHERE id = $1 AND user_id = $2',
      [vmId, userId]
    );
    if (!rows.length) throw new Error('VM not found or not owned by user');
    const vm = rows[0];

    if (this.provider === 'digitalocean' && vm.provider_id) {
      await axios.delete(
        `https://api.digitalocean.com/v2/droplets/${vm.provider_id}`,
        { headers: { Authorization: `Bearer ${config.vm.digitalocean.token}` } }
      ).catch(err => logger.warn('[VM] DO delete error:', err.message));
    }

    await db.query(
      "UPDATE vm_instances SET status='terminated', stopped_at=NOW() WHERE id=$1",
      [vmId]
    );
    logger.info(`[VM] Terminated ${vmId}`);
  }

  // ── DigitalOcean ─────────────────────────────────────────────────────────
  async _doProvision(initScript, region) {
    const doConf = config.vm.digitalocean;
    const { data } = await axios.post(
      'https://api.digitalocean.com/v2/droplets',
      {
        name:      `sil-obs-${Date.now()}`,
        region:    region || doConf.region,
        size:      doConf.size,
        image:     doConf.image,
        user_data: initScript,
        tags:      ['sil-obs-vm'],
        monitoring: true,
      },
      { headers: { Authorization: `Bearer ${doConf.token}`, 'Content-Type': 'application/json' } }
    );
    return { id: String(data.droplet.id), size: doConf.size };
  }

  // ── AWS (via SDK) ────────────────────────────────────────────────────────
  async _awsProvision(initScript, region) {
    // Requires @aws-sdk/client-ec2 or aws-cli in PATH.
    // Using CLI for simplicity – swap out for SDK in production.
    const { execSync } = require('child_process');
    const awsConf = config.vm.aws;
    const encoded = Buffer.from(initScript).toString('base64');
    const cmd = [
      'aws ec2 run-instances',
      `--image-id ${awsConf.amiId}`,
      `--instance-type ${awsConf.instanceType}`,
      `--region ${region || awsConf.region}`,
      `--user-data "${encoded}"`,
      "--tag-specifications 'ResourceType=instance,Tags=[{Key=sil,Value=obs-vm}]'",
      '--output json',
    ].join(' ');
    const result = JSON.parse(execSync(cmd).toString());
    const id = result.Instances[0].InstanceId;
    return { id, size: awsConf.instanceType };
  }

  // ── Background IP poller ─────────────────────────────────────────────────
  _pollForIp(dbId, providerId, attempts = 0) {
    if (attempts > 24) {
      logger.error(`[VM] Timeout waiting for IP on vm=${dbId}`);
      db.query("UPDATE vm_instances SET status='error' WHERE id=$1", [dbId]);
      return;
    }

    setTimeout(async () => {
      try {
        let ip = null;

        if (this.provider === 'digitalocean') {
          const { data } = await axios.get(
            `https://api.digitalocean.com/v2/droplets/${providerId}`,
            { headers: { Authorization: `Bearer ${config.vm.digitalocean.token}` } }
          );
          const droplet = data.droplet;
          if (droplet.status === 'active') {
            ip = droplet.networks?.v4?.find(n => n.type === 'public')?.ip_address;
          }
        }

        if (ip) {
          await db.query(
            "UPDATE vm_instances SET ip_address=$1, status='running' WHERE id=$2",
            [ip, dbId]
          );
          logger.info(`[VM] ${dbId} ready at ${ip}`);
        } else {
          this._pollForIp(dbId, providerId, attempts + 1);
        }
      } catch (err) {
        logger.warn(`[VM] Poll error (attempt ${attempts}): ${err.message}`);
        this._pollForIp(dbId, providerId, attempts + 1);
      }
    }, attempts === 0 ? 45_000 : 20_000);  // first check after 45 s, then every 20 s
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function _genPassword(len = 16) {
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

module.exports = new VMManager();
