'use strict';
/* ============================================================
   SIL Dashboard  –  Client-side JS
   ============================================================ */

const API  = '';  // same origin
let TOKEN    = localStorage.getItem('sil_token') || '';
let USERNAME = localStorage.getItem('sil_username') || '';
let ws       = null;
let liveTimer = null;
let currentVmId = null;

// ── Guard ─────────────────────────────────────────────────────────────────────
if (!USERNAME) { window.location.href = '/'; }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('headerUser').textContent = USERNAME;

  setupNav();
  loadProfile();
  loadDestinations();
  loadIngestInfo();
  loadVM();
  connectWS();

  // Check if redirected from registration
  const newUser = localStorage.getItem('sil_newuser');
  if (newUser) {
    const data = JSON.parse(newUser);
    localStorage.removeItem('sil_newuser');
    toast(`Welcome, ${data.username}! Your stream key is ready.`, 'success');
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item[data-section]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.section));
  });
}

function navigate(section) {
  document.querySelectorAll('.nav-item[data-section]').forEach(b =>
    b.classList.toggle('active', b.dataset.section === section));
  document.querySelectorAll('.section').forEach(s =>
    s.classList.toggle('active', s.id === `section-${section}`));

  const titles = {
    overview:     'Overview',
    destinations: 'Stream Destinations',
    ingest:       'Ingest Keys',
    'obs-vm':     'OBS Virtual Machine',
    sessions:     'Session History',
  };
  document.getElementById('pageTitle').textContent = titles[section] || section;

  if (section === 'sessions') loadSessions();
  if (section === 'obs-vm')   loadVM();
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  try {
    const u = await api('GET', `/api/users/${USERNAME}`);
    document.getElementById('statPlan').textContent  = u.plan?.toUpperCase() || 'FREE';
    document.getElementById('statHours').textContent = u.total_stream_hours
      ? `${parseFloat(u.total_stream_hours).toFixed(1)}h` : '0h';

    const isLive = u.is_live;
    document.getElementById('statStatus').textContent = isLive ? 'LIVE' : 'OFFLINE';
    document.getElementById('statStatus').style.color = isLive ? 'var(--live)' : 'var(--muted)';

    const badge = document.getElementById('liveStatusBadge');
    badge.className = `badge ${isLive ? 'badge-live' : 'badge-offline'}`;
    badge.textContent = isLive ? '● LIVE' : '● Offline';

    // Destination count
    let destCount = 0;
    if (u.stream_to_youtube) destCount++;
    if (u.stream_to_kick)    destCount++;
    if (u.stream_to_twitch)  destCount++;
    document.getElementById('statDests').textContent = destCount;

    if (isLive) renderLiveInfo(u);
    else        document.getElementById('liveInfo').innerHTML =
      '<p style="color:var(--muted);">No active stream. Connect your encoder to go live.</p>';
  } catch {}
}

function renderLiveInfo(u) {
  const dests = [];
  if (u.stream_to_youtube) dests.push(`<span class="badge badge-youtube">▶ YouTube</span>`);
  if (u.stream_to_kick)    dests.push(`<span class="badge badge-kick">⚡ Kick</span>`);
  if (u.stream_to_twitch)  dests.push(`<span class="badge badge-twitch">🟣 Twitch</span>`);

  document.getElementById('liveInfo').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
      <span class="live-dot"></span>
      <strong>You are LIVE</strong>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">${dests.join('') || '<span class="badge badge-offline">No destinations</span>'}</div>
    <div style="margin-top:10px;color:var(--muted);font-size:.8rem;">IP: ${u.last_ip || '—'}</div>
  `;
}

// ── Destinations ──────────────────────────────────────────────────────────────
async function loadDestinations() {
  try {
    const u = await api('GET', `/api/users/${USERNAME}`);
    // We need the full record with URLs – re-fetch from a full profile call
    // (public profile strips URLs, so in prod you'd have a /me endpoint)
  } catch {}
}

function toggleUrlField(id, enabled) {
  const el = document.getElementById(id);
  el.disabled = !enabled;
  if (!enabled) el.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('destForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/users/destinations', {
        yt_url: document.getElementById('ytUrl').value,
        kk_url: document.getElementById('kkUrl').value,
        tw_url: document.getElementById('twUrl').value,
        yt_on:  document.getElementById('ytOn').checked,
        kk_on:  document.getElementById('kkOn').checked,
        tw_on:  document.getElementById('twOn').checked,
      });
      toast('Destinations saved!', 'success');
      loadProfile();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ── Ingest keys ───────────────────────────────────────────────────────────────
async function loadIngestInfo() {
  try {
    const u = await api('GET', `/api/users/${USERNAME}`);
    // Stream key is in login response – stored in localStorage on register
    const storedData = JSON.parse(localStorage.getItem('sil_userdata') || '{}');

    // Fetch full info including stream_key from a privileged /me endpoint
    // For now show what we stored on login
    const key = localStorage.getItem('sil_streamkey') || '(login again to view key)';
    const host = window.location.hostname;

    document.getElementById('rtmpUrl').textContent = `rtmp://${host}/live`;
    document.getElementById('rtmpKey').textContent = key;
    document.getElementById('srtUrl').textContent  =
      `srt://${host}:9999?streamid=stream:${key}&latency=2000&mode=caller&passphrase=YOUR_SRT_PASS`;
    document.getElementById('srtPass').textContent = '(shown once at registration)';
  } catch {}
}

async function rotateKey() {
  if (!confirm('Rotate your stream key? The old key stops working immediately.')) return;
  try {
    const data = await api('POST', '/api/users/regenerate-key', {});
    localStorage.setItem('sil_streamkey', data.stream_key);
    document.getElementById('rtmpKey').textContent = data.stream_key;
    toast('Stream key rotated!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── OBS VM ────────────────────────────────────────────────────────────────────
async function loadVM() {
  try {
    const vm = await api('GET', `/api/vms/status/${USERNAME}`);
    renderVMStatus(vm);
  } catch {}
}

function renderVMStatus(vm) {
  const dot  = document.getElementById('vmDot');
  const text = document.getElementById('vmStatusText');
  const det  = document.getElementById('vmDetails');
  const prov = document.getElementById('vmProvisionArea');

  dot.className = `vm-status-dot ${vm.status || 'none'}`;
  text.textContent = vm.status
    ? `VM Status: ${vm.status.charAt(0).toUpperCase() + vm.status.slice(1)}`
    : 'No VM provisioned';

  if (vm.status && vm.status !== 'none') {
    det.style.display = 'block';
    prov.style.display = 'none';
    currentVmId = vm.id;

    document.getElementById('vmIp').textContent     = vm.ip_address || 'Provisioning…';
    document.getElementById('vmRegion').textContent  = vm.region    || '—';
    document.getElementById('vmObsPass').textContent = vm.obs_password || '—';

    const link = document.getElementById('vmNovncLink');
    if (vm.novnc_url) {
      link.href = vm.novnc_url;
      link.textContent = 'Open noVNC →';
    } else {
      link.href = '#';
      link.textContent = 'Not ready yet…';
    }

    // Poll if still provisioning
    if (vm.status === 'provisioning') setTimeout(loadVM, 15_000);
  } else {
    det.style.display = 'none';
    prov.style.display = 'block';
    currentVmId = null;
  }
}

async function provisionVM() {
  const region = document.getElementById('vmRegion').value;
  try {
    const data = await api('POST', '/api/vms/provision', { region });
    toast(data.message, 'success');
    loadVM();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function terminateVM() {
  if (!currentVmId || !confirm('Terminate this VM? All OBS scenes will be lost.')) return;
  try {
    await api('DELETE', `/api/vms/${currentVmId}`, {});
    toast('VM terminated', 'success');
    loadVM();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function loadSessions() {
  const tbody = document.getElementById('sessionsBody');
  try {
    const rows = await api('GET', `/api/users/${USERNAME}/sessions`);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No sessions yet</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(s => `
      <tr>
        <td>${new Date(s.started_at).toLocaleString()}</td>
        <td><span class="badge badge-${s.ingest_type}">${s.ingest_type?.toUpperCase()}</span></td>
        <td>${s.duration_seconds ? fmtDuration(s.duration_seconds) : '—'}</td>
        <td>${formatPlatforms(s.streamed_to)}</td>
        <td style="font-family:monospace;font-size:.78rem;">${s.client_ip || '—'}</td>
      </tr>
    `).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--danger);">Failed to load</td></tr>';
  }
}

function formatPlatforms(obj) {
  if (!obj || !Object.keys(obj).length) return '<span style="color:var(--muted);">—</span>';
  return Object.keys(obj).map(p => `<span class="badge badge-${p}">${p}</span>`).join(' ');
}

function fmtDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  const dot    = document.getElementById('wsIndicator');
  const status = document.getElementById('wsStatus');

  ws.onopen = () => {
    dot.className = 'ws-dot connected';
    status.textContent = 'Connected';
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWSMessage(msg);
    } catch {}
  };

  ws.onclose = () => {
    dot.className = 'ws-dot disconnected';
    status.textContent = 'Disconnected – reconnecting…';
    setTimeout(connectWS, 5_000);
  };

  ws.onerror = () => ws.close();
}

function handleWSMessage(msg) {
  const feed = document.getElementById('wsFeed');

  const append = (txt) => {
    feed.innerHTML += `<div>[${new Date().toLocaleTimeString()}] ${txt}</div>`;
    feed.scrollTop = feed.scrollHeight;
  };

  switch (msg.type) {
    case 'live_update':
      append(`📡 ${msg.activeStreams} live stream(s)  |  ${msg.ffmpegSessions?.length || 0} FFmpeg session(s)`);
      if (msg.streams?.some(s => s.username === USERNAME)) {
        document.getElementById('liveStatusBadge').className = 'badge badge-live';
        document.getElementById('liveStatusBadge').textContent = '● LIVE';
      }
      break;
    case 'stream_start':
      append(`▶ ${msg.data?.username} went live (${msg.data?.ingestType})`);
      if (msg.data?.username === USERNAME) loadProfile();
      break;
    case 'stream_end':
      append(`■ Stream ended`);
      if (msg.data?.username === USERNAME) loadProfile();
      break;
    case 'pong':
      break;
    default:
      append(JSON.stringify(msg));
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function copyText(elementId) {
  const el   = document.getElementById(elementId);
  const text = el.textContent.trim();
  navigator.clipboard.writeText(text).then(() => toast('Copied!'));
}

function toast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4_000);
}

function refreshAll() {
  loadProfile();
  loadIngestInfo();
  toast('Refreshed');
}

function logout() {
  localStorage.clear();
  window.location.href = '/';
}

// Store stream key on login (called from index.html login response)
const storedKey = localStorage.getItem('sil_streamkey');
if (!storedKey) {
  // Prompt user to log in again for key display if missing
}
