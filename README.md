# ▶ SIL IRL Hosting Platform

A **production-ready**, self-hosted IRL streaming platform that provides:

- **Multi-destination restreaming** → YouTube, Kick, Twitch simultaneously
- **Dual ingest protocols** → RTMP (OBS/Streamlabs) and SRT (IRL Pro/Larix)
- **Remote OBS Virtual Machines** → browser-accessible (noVNC) cloud OBS instances
- **Real-time WebSocket dashboard** → live stream monitoring
- **JWT-authenticated API** + Admin control panel

---

## Architecture

```
[IRL Encoder / OBS on Phone]
        │
        │  SRT (UDP :9999)        or      RTMP (TCP :1935)
        ▼                                         ▼
[MediaMTX SRT Server]                   [nginx-rtmp Server]
        │                                         │
        │  webhook → /srt/auth                    │  webhook → /rtmp/auth
        ▼                                         ▼
                  [SIL Node.js Control Plane :3000]
                            │
                     validates key
                     marks user LIVE
                            │
                  [FFmpeg Restream Manager]
                    (tee muxer – 1 encode)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         YouTube         Kick          Twitch
    rtmp://…/live2   rtmps://…/app  rtmp://…/app

[OBS VM (DigitalOcean)]  ──SRT──►  [SIL SRT Ingest]
        │                               │
     noVNC :6080                  same path above
  OBS WS  :4455
```

---

## Quick Start

### 1. Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js 18+ | Control plane API |
| FFmpeg | Multi-destination restreaming |
| MediaMTX | RTMP+SRT ingest (local dev) |
| nginx + rtmp-module | RTMP ingest (production option) |
| PostgreSQL / Supabase | Database |
| Docker (optional) | Full stack deployment |

### 2. Clone & Configure

```bash
git clone <your-repo> sil-hosting
cd sil-hosting

# Copy and edit environment file
cp backend/.env.example backend/.env
nano backend/.env
```

Required `.env` values:

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=long-random-string
ADMIN_SECRET=your-admin-secret
SERVER_PUBLIC_IP=YOUR_SERVER_IP
```

### 3. Database Setup

Run the schema against your Supabase/PostgreSQL instance:

```bash
psql $DATABASE_URL < backend/db/schema.sql
```

### 4a. Run with Docker (recommended)

```bash
# Ensure Docker daemon is running first:
# - Docker Desktop: open the app
# - Colima (macOS): colima start

docker-compose up -d
```

Services started:
- `sil-api`      → http://localhost:3000
- `nginx-rtmp`   → rtmp://localhost:1935/live (RTMP ingest)
- `mediamtx`     → srt://localhost:9999 (SRT ingest)

If you only start the Node.js API (port 3000) without nginx-rtmp, OBS will show
"Failed to connect" because nothing is listening on `:1935`.

### 4b. Run locally (no Docker, recommended for dev)

This repo includes a local dev runner that starts:
- MediaMTX RTMP ingest on `:1935` using `configs/mediamtx.local-rtmp.yml`
- SIL API on `:3000`

macOS install (once):

```bash
brew install bluenviron/mediamtx/mediamtx
```

Run:

```bash
cd backend
npm install
npm run dev
```

OBS settings for local dev:
- Server: `rtmp://localhost:1935/live`
- Stream Key: the key shown in the dashboard

### 4c. Run manually (advanced)

```bash
# Terminal 1 – MediaMTX (SRT)
./mediamtx configs/mediamtx.yml

# Terminal 2 – nginx-rtmp (RTMP)
nginx -c $(pwd)/configs/nginx-rtmp.conf

# Terminal 3 – SIL API
cd backend
npm install
node server.js
```

---

## Encoder Configuration

### OBS Studio (RTMP)

| Setting | Value |
|---------|-------|
| Service | Custom… |
| Server  | `rtmp://YOUR_SERVER_IP:1935/live` |
| Stream Key | *(your stream key from dashboard)* |
| Encoder | x264 or NVENC |
| Bitrate | 4000–8000 kbps |

### IRL Pro / Larix (SRT)

| Setting | Value |
|---------|-------|
| Protocol | SRT |
| URL | `srt://YOUR_SERVER_IP:9999?streamid=stream:YOUR_KEY&latency=2000&mode=caller` |
| Passphrase | *(your SRT passphrase from dashboard)* |
| Latency | 2000 ms |

### Streamlabs / OBS Mobile (RTMP)

Same as OBS Studio above.

---

## API Reference

### Auth (called by nginx-rtmp / MediaMTX)

```
POST /rtmp/auth        nginx-rtmp on_publish callback
POST /rtmp/done        nginx-rtmp on_done     callback
POST /srt/auth         MediaMTX   onPublish   callback
POST /srt/done         MediaMTX   onUnpublish callback
```

### User API

```
POST /api/users/register           Create account
POST /api/users/login              Login → JWT token
GET  /api/users/:username          Public profile
PUT  /api/users/destinations       Update YouTube/Kick/Twitch URLs  (auth)
POST /api/users/regenerate-key     Roll stream key                   (auth)
GET  /api/users/:username/sessions Stream history
```

### VM API  (auth required)

```
POST   /api/vms/provision          Provision OBS VM
GET    /api/vms/status/:username   VM status + noVNC URL
DELETE /api/vms/:vmId              Terminate VM
```

### Admin API  (x-admin-secret header)

```
GET   /api/admin/stats              Platform stats
GET   /api/admin/streams            Live streams + FFmpeg sessions
GET   /api/admin/users              All users (paginated)
PATCH /api/admin/users/:username    Update plan / enable VM
POST  /api/admin/streams/:key/kill  Force-kill a stream
GET   /api/admin/relays             Relay node status
GET   /api/admin/vms                All active VMs
```

### WebSocket

Connect to `ws://YOUR_SERVER/ws` for real-time events:

```json
// Server → Client (every 5s)
{ "type": "live_update", "activeStreams": 2, "streams": [...], "ffmpegSessions": [...] }

// Events
{ "type": "stream_start", "data": { "username": "alice", "ingestType": "srt" } }
{ "type": "stream_end",   "data": { "streamKey": "abc..." } }

// Client → Server
{ "type": "get_stats" }
{ "type": "ping" }
```

---

## OBS Virtual Machine

When a user provisions an OBS VM, SIL:

1. **Calls DigitalOcean (or AWS) API** to create a droplet
2. **Runs cloud-init script** that installs:
   - `xvfb` – virtual display (1920×1080)
   - `obs-studio` + `obs-websocket` (port 4455)
   - `x11vnc` – VNC server (port 5900)
   - `novnc` – browser VNC gateway (port 6080)
3. **Pre-configures OBS** to stream via SRT → SIL ingest → user's platforms
4. **Returns IP + noVNC URL** so user opens OBS in their browser

**OBS VM Access:**

| Method | URL | Notes |
|--------|-----|-------|
| Browser VNC | `http://VM_IP:6080/vnc.html` | No install needed |
| OBS WebSocket | `VM_IP:4455` | Use OBS Remote Control apps |
| x11vnc | `VM_IP:5900` | Any VNC client (TigerVNC, RealVNC) |

**Enable VM for a user (Admin):**
```bash
curl -X PATCH http://localhost:3000/api/admin/users/alice \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"vm_enabled": true, "plan": "pro"}'
```

---

## SRT Ingest Routing (Deep Dive)

SRT (Secure Reliable Transport) is the recommended protocol for IRL streaming over mobile data because:
- **Low latency** (configurable, default 2000ms)
- **Packet loss recovery** (crucial on 4G/5G)
- **Encryption** (AES-128 via passphrase)

### How SRT auth works:

1. IRL encoder connects: `srt://SERVER:9999?streamid=stream:STREAM_KEY&passphrase=PASS`
2. MediaMTX calls webhook: `POST /srt/auth  { id: "stream:KEY", ip: "x.x.x.x" }`
3. SIL queries DB, validates key, marks user live
4. SIL waits 2s for SRT to stabilise, then starts FFmpeg pulling from local RTMP
5. FFmpeg pushes to all enabled platforms simultaneously

---

## Production Deployment

### Recommended VPS specs

| Users | CPU | RAM | Bandwidth |
|-------|-----|-----|-----------|
| 1–10  | 2 vCPU | 4 GB | 100 Mbps |
| 10–50 | 4 vCPU | 8 GB | 500 Mbps |
| 50+   | 8+ vCPU | 16 GB | 1 Gbps |

### SSL/TLS (required for Kick rtmps://)

```bash
apt install certbot nginx
certbot --nginx -d yourdomain.com
```

Update nginx config to use SSL on port 443 and add:
```nginx
rtmps { listen 443; ssl_certificate ...; ssl_certificate_key ...; }
```

### Firewall

```bash
ufw allow 22      # SSH
ufw allow 80      # HTTP
ufw allow 443     # HTTPS
ufw allow 1935    # RTMP
ufw allow 9999/udp # SRT
ufw enable
```

---

## File Structure

```
SIL/
├── backend/
│   ├── server.js                 Main Express server
│   ├── package.json
│   ├── Dockerfile
│   ├── .env.example
│   ├── config/index.js           Centralised config
│   ├── db/
│   │   ├── database.js           PostgreSQL pool
│   │   └── schema.sql            Full DB schema
│   ├── middleware/auth.js        JWT + Admin auth
│   ├── utils/logger.js           Winston logger
│   ├── services/
│   │   ├── restreamer.js         FFmpeg multi-destination
│   │   ├── srtRouter.js          SRT ingest auth
│   │   ├── vmManager.js          OBS VM provisioning
│   │   └── websocketServer.js    Real-time WS events
│   └── routes/
│       ├── auth.js               RTMP/SRT webhooks
│       ├── users.js              User CRUD + auth
│       ├── vms.js                VM management
│       └── admin.js              Admin panel
├── frontend/
│   ├── index.html                Login/Register
│   ├── dashboard.html            User dashboard
│   ├── css/style.css             Dark theme styles
│   └── js/dashboard.js           Dashboard logic
├── configs/
│   ├── mediamtx.yml              SRT ingest config
│   └── nginx-rtmp.conf           RTMP ingest config
├── docker-compose.yml            Full stack deployment
└── README.md
```

---

## License

MIT – Built for the IRL streaming community.
# Stream-Hosting-Platform
