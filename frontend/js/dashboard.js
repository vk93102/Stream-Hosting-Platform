'use strict';
/* ============================================================
   SIL Dashboard  –  Client-side JS
   ============================================================ */

const API  = '';  // same origin
let TOKEN    = localStorage.getItem('sil_token') || '';
let USERNAME = localStorage.getItem('sil_username') || '';
let ws       = null;
let liveTimer = null;

// ── Guard ─────────────────────────────────────────────────────────────────────
if (!USERNAME) { window.location.href = '/'; }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('headerUser').textContent = USERNAME;

  setupNav();
  loadProfile();
  loadDestinations();
  loadIngestInfo();
  connectWS();

  // Check if redirected from registration
  const newUser = localStorage.getItem('sil_newuser');
  if (newUser) {
    const data = JSON.parse(newUser);
    localStorage.removeItem('sil_newuser');
    toast(`Welcome ${data.username}! Check Ingest Keys for your stream URL & key.`, 'success');
    setTimeout(() => navigate('ingest'), 800);
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
    sessions:     'Session History',
    'anti-scuff': 'BRB / Stream Health',
  };
  document.getElementById('pageTitle').textContent = titles[section] || section;

  if (section === 'sessions')   loadSessions();
  if (section === 'anti-scuff') loadBRBInfo();
  if (section === 'ingest')     loadIngestInfo();
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
  if (r.status === 401) {
    // Session expired or invalid token — log out and return to login
    localStorage.clear();
    window.location.href = '/';
    return;
  }
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

    updatePlatformTiles(u);
  } catch {}
}
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

// ── Platform tiles (Overview quick-select) ───────────────────────────────────
function updatePlatformTiles(u) {
  const platforms = [
    { key: 'yt', on: !!u.stream_to_youtube, url: u.youtube_url },
    { key: 'kk', on: !!u.stream_to_kick,    url: u.kick_url    },
    { key: 'tw', on: !!u.stream_to_twitch,  url: u.twitch_url  },
  ];
  for (const { key, on, url } of platforms) {
    const tile   = document.getElementById(`tile-${key}`);
    const status = document.getElementById(`tile-${key}-status`);
    const urlEl  = document.getElementById(`tile-${key}-url`);
    if (!tile) continue;
    tile.classList.toggle('pt-on', on);
    // disable tile if no URL saved yet — user must set it in Destinations first
    tile.disabled = !url;
    status.textContent = on ? 'ON' : (url ? 'OFF' : 'No URL set');
    if (urlEl) urlEl.textContent = url ? new URL(url.startsWith('rtmp') ? url.replace(/^rtmps?/, 'https') : url).hostname : '';
  }
}

/**
 * Toggle a single platform on/off and save immediately.
 * @param {'yt'|'kk'|'tw'} key
 */
async function togglePlatform(key) {
  const tile = document.getElementById(`tile-${key}`);
  if (!tile || tile.disabled) return;

  const isOn = tile.classList.contains('pt-on');
  // Optimistic UI update
  tile.classList.toggle('pt-on', !isOn);
  document.getElementById(`tile-${key}-status`).textContent = !isOn ? 'ON' : 'OFF';
  tile.disabled = true;

  try {
    // Read the current form values so we don't accidentally wipe sibling URLs
    const current = await api('GET', '/api/users/me');
    if (!current) return;

    await api('PUT', '/api/users/destinations', {
      yt_url: current.youtube_url || '',
      kk_url: current.kick_url   || '',
      tw_url: current.twitch_url || '',
      yt_on:  key === 'yt' ? !isOn : !!current.stream_to_youtube,
      kk_on:  key === 'kk' ? !isOn : !!current.stream_to_kick,
      tw_on:  key === 'tw' ? !isOn : !!current.stream_to_twitch,
    });

    const label = { yt: 'YouTube', kk: 'Kick', tw: 'Twitch' }[key];
    toast(`${label} ${!isOn ? 'enabled ✓' : 'disabled'}`, !isOn ? 'success' : '');
    // Re-sync all tiles + profile stats
    loadProfile();
    // Sync the destinations form checkboxes too
    const chk = document.getElementById(key === 'yt' ? 'ytOn' : key === 'kk' ? 'kkOn' : 'twOn');
    if (chk) chk.checked = !isOn;
  } catch (err) {
    // Revert optimistic update
    tile.classList.toggle('pt-on', isOn);
    document.getElementById(`tile-${key}-status`).textContent = isOn ? 'ON' : 'OFF';
    toast(err.message, 'error');
  } finally {
    tile.disabled = false;
  }
}

// ── Destinations ──────────────────────────────────────────────────────────────
async function loadDestinations() {
  try {
    const u = await api('GET', '/api/users/me');
    if (!u) return; // 401 redirect already triggered
    document.getElementById('ytOn').checked = !!u.stream_to_youtube;
    document.getElementById('kkOn').checked = !!u.stream_to_kick;
    document.getElementById('twOn').checked = !!u.stream_to_twitch;
    if (u.youtube_url) document.getElementById('ytUrl').value = u.youtube_url;
    if (u.kick_url)    document.getElementById('kkUrl').value = u.kick_url;
    if (u.twitch_url)  document.getElementById('twUrl').value = u.twitch_url;
    document.getElementById('ytUrl').disabled = !u.stream_to_youtube;
    document.getElementById('kkUrl').disabled = !u.stream_to_kick;
    document.getElementById('twUrl').disabled = !u.stream_to_twitch;
    updatePlatformTiles(u);
  } catch (err) {
    console.error('loadDestinations:', err);
  }
}

function toggleUrlField(id, enabled) {
  document.getElementById(id).disabled = !enabled;
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
      loadDestinations(); // re-sync platform tiles
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ── Ingest keys ───────────────────────────────────────────────────────────────
async function loadIngestInfo() {
  try {
    const u    = await api('GET', '/api/users/me');
    if (!u) return; // api() returned undefined → 401 redirect already triggered
    const host = location.hostname;
    const rtmpServer = `rtmp://${host}/live`;
    const srtFull    = `srt://${host}:9999?streamid=stream:${u.stream_key}&latency=2000&mode=caller`
                     + (u.srt_passphrase ? `&passphrase=${u.srt_passphrase}&pbkeylen=16` : '');
    document.getElementById('rtmpUrl').textContent  = rtmpServer;
    document.getElementById('rtmpKey').textContent  = u.stream_key;
    document.getElementById('srtUrl').textContent   = srtFull;
    document.getElementById('srtPass').textContent  = u.srt_passphrase || '(not set)';
    localStorage.setItem('sil_streamkey', u.stream_key);
  } catch (err) {
    console.error('loadIngestInfo:', err);
    document.getElementById('rtmpUrl').textContent  = 'Error loading — try refreshing';
    document.getElementById('rtmpKey').textContent  = '—';
    document.getElementById('srtUrl').textContent   = 'Error loading — try refreshing';
    document.getElementById('srtPass').textContent  = '—';
    toast('Could not load ingest info: ' + err.message, 'error');
  }
}

async function rotateKey() {
  if (!confirm('Rotate your stream key? The old key stops working immediately.')) return;
  try {
    await api('POST', '/api/users/regenerate-key', {});
    toast('Stream key rotated — refreshing…', 'success');
    await loadIngestInfo();
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

// ── BRB / Anti-Scuff ──────────────────────────────────────────────────────────────
let brbFileToUpload = null;

async function loadBRBInfo() {
  try {
    const info = await api('GET', '/api/media/brb/info');
    document.getElementById('brbEnabled').checked  = info.brb_enabled !== false;
    document.getElementById('brbTimeout').value    = info.brb_timeout_seconds || 300;

    const mediaEl = document.getElementById('brbMediaInfo');
    if (info.file_exists) {
      const kb = Math.round(info.file_size / 1024);
      mediaEl.innerHTML = `✅ Custom BRB media: <strong>${info.brb_media_path?.split('/').pop()}</strong> · ${kb} KB`;
    } else {
      mediaEl.innerHTML = 'ℹ️ No custom BRB media uploaded. Using auto-generated "Be Right Back" screen.';
    }
  } catch { /* not a blocker */ }
}

async function saveBRBSettings() {
  try {
    await api('PUT', '/api/media/brb/settings', {
      brb_enabled:         document.getElementById('brbEnabled').checked,
      brb_timeout_seconds: parseInt(document.getElementById('brbTimeout').value) || 300,
    });
    toast('BRB settings saved!', 'success');
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  }
}

function previewBRBFile(input) {
  brbFileToUpload = input.files[0];
  if (!brbFileToUpload) return;
  const preview = document.getElementById('brbFilePreview');
  const mb = (brbFileToUpload.size / 1024 / 1024).toFixed(1);
  preview.textContent = `📄 ${brbFileToUpload.name} · ${mb} MB`;
}

async function uploadBRBMedia() {
  if (!brbFileToUpload) return toast('Select a file first', 'error');
  const btn = document.getElementById('uploadBrbBtn');
  btn.textContent = '⏳ Uploading…';
  btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('file', brbFileToUpload);
    const r = await fetch('/api/media/brb', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    toast(`Uploaded: ${d.filename}`, 'success');
    brbFileToUpload = null;
    document.getElementById('brbFileInput').value = '';
    document.getElementById('brbFilePreview').textContent = '';
    loadBRBInfo();
  } catch (err) {
    toast('Upload failed: ' + err.message, 'error');
  } finally {
    btn.textContent = '⬆ Upload';
    btn.disabled = false;
  }
}

async function deleteBRBMedia() {
  if (!confirm('Delete your BRB media? SIL will fall back to the auto-generated screen.')) return;
  try {
    await api('DELETE', '/api/media/brb', {});
    toast('BRB media deleted', 'success');
    loadBRBInfo();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
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
    case 'brb_state': {
      const d    = msg.data || {};
      const icon = { grace: '⏳', brb_active: '🔴', live: '📡', ended: '■' }[d.state] || '•';
      append(`${icon} BRB: ${d.username} → ${d.state}${d.reconnects ? ` (reconnect #${d.reconnects})` : ''}`);
      if (d.username === USERNAME) {
        const display = document.getElementById('brbStateDisplay');
        const sub     = document.getElementById('brbStateSub');
        const card    = document.getElementById('brbStateCard');
        if (display) {
          display.textContent = d.state === 'grace'      ? '⏳ Grace Period'
                               : d.state === 'brb_active' ? '🔴 BRB Active'
                               : d.state === 'live'        ? '📡 Live'
                               : '■ Ended';
          if (sub) sub.textContent = d.reconnects ? `${d.reconnects} reconnect(s)` : '';
          if (card) card.style.border = d.state === 'brb_active'
            ? '2px solid var(--danger)'
            : d.state === 'grace' ? '2px solid orange' : '';
        }
      }
      break;
    }
    case 'health_update': {
      const d = msg.data || {};
      // Only show stats for the current user's stream key (we match by username via is_live check)
      const bitrateEl  = document.getElementById('healthBitrate');
      const lossEl     = document.getElementById('healthLoss');
      const qualityEl  = document.getElementById('healthQuality');
      if (bitrateEl) bitrateEl.textContent  = d.bitrate_kbps !== undefined ? d.bitrate_kbps : '—';
      if (lossEl)    lossEl.textContent     = d.loss_pct     !== undefined ? `${d.loss_pct}%` : '—';
      if (qualityEl) {
        qualityEl.textContent = d.quality || '—';
        qualityEl.style.color = {
          excellent: 'var(--accent)', good: '#a3e635', fair: 'orange', poor: 'var(--danger)'
        }[d.quality] || 'var(--muted)';
      }
      break;
    }
    case 'quality_warn':
      append(`⚠️ High packet loss: ${msg.data?.loss_pct}%  bitrate=${msg.data?.bitrate_kbps}kbps`);
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


