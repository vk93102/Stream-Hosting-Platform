-- ============================================================================
--  Migration 001  –  Initial Schema
--  SIL IRL Hosting Platform
--  Target: Supabase / PostgreSQL 14+
--
--  Tables created:
--    users            – streamer accounts, stream keys, destination URLs
--    stream_sessions  – full history of every stream (start→end, platforms, codecs)
--    vm_instances     – cloud OBS virtual machines per user
--    relay_nodes      – global SRT/RTMP ingest edge nodes
--    audit_log        – admin action log
--
--  Also creates:
--    uuid-ossp extension
--    GIN/BTREE indexes for hot query paths
--    _set_updated_at() trigger function + trigger on users
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Note: gen_random_uuid() is built into PostgreSQL 13+ (no extension needed).
-- We deliberately avoid uuid-ossp because CREATE EXTENSION is not available
-- through the Supabase PgBouncer transaction pooler.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: users
--
-- Stores every streamer account. Key columns:
--
--   stream_key       – 48-char hex secret used as the RTMP/SRT publish key.
--                      nginx-rtmp and MediaMTX webhook auth validate against
--                      this column. Rotatable by the user at any time.
--
--   srt_passphrase   – 16-char hex passphrase embedded in the SRT URL for
--                      AES-128 encryption of the SRT transport layer.
--
--   is_live          – flipped true by the RTMP/SRT auth webhook on publish,
--                      flipped false when stream ends (or BRB timeout expires).
--
--   youtube_url      – Full RTMP URL including stream key e.g.
--                      rtmp://a.rtmp.youtube.com/live2/<key>
--   kick_url         – Full RTMPS URL including stream key
--   twitch_url       – Full RTMP URL including stream key
--   stream_to_*      – Toggles whether FFmpeg tee muxer pushes to that platform
--
--   plan             – Feature gating: free | pro | enterprise
--   vm_enabled       – Whether user can provision an OBS cloud VM
--
--   prefer_srt       – Dashboard hint; shows SRT URL first if true
--
--   total_stream_hours – Lifetime stat, incremented on session end
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    username            VARCHAR(50)  UNIQUE NOT NULL,
    email               VARCHAR(255) UNIQUE,
    password_hash       VARCHAR(255),          -- bcrypt(12) or NULL for token-only auth

    -- ── Stream identity ──────────────────────────────────────────────────────
    stream_key          VARCHAR(64)  UNIQUE NOT NULL,
    srt_passphrase      VARCHAR(64),
    is_active           BOOLEAN      NOT NULL DEFAULT true,
    is_live             BOOLEAN      NOT NULL DEFAULT false,
    plan                VARCHAR(20)  NOT NULL DEFAULT 'free'
                            CHECK (plan IN ('free','pro','enterprise')),

    -- ── Platform destinations ────────────────────────────────────────────────
    youtube_url         TEXT,
    twitch_url          TEXT,
    kick_url            TEXT,
    stream_to_youtube   BOOLEAN      NOT NULL DEFAULT false,
    stream_to_twitch    BOOLEAN      NOT NULL DEFAULT false,
    stream_to_kick      BOOLEAN      NOT NULL DEFAULT false,

    -- ── Ingest preferences ───────────────────────────────────────────────────
    prefer_srt          BOOLEAN      NOT NULL DEFAULT false,

    -- ── Session tracking ─────────────────────────────────────────────────────
    last_ip             INET,
    stream_start_time   TIMESTAMPTZ,
    stream_end_time     TIMESTAMPTZ,
    total_stream_hours  NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- ── Feature flags ────────────────────────────────────────────────────────
    vm_enabled          BOOLEAN      NOT NULL DEFAULT false,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: stream_sessions
--
-- Immutable history row written on every stream start; updated on end.
-- One row = one continuous publish session (may have multiple BRB windows
-- inside it because BRB keeps is_live=true).
--
--   ingest_type      – 'rtmp' (nginx-rtmp) | 'srt' (MediaMTX)
--   streamed_to      – JSONB snapshot of which platforms were active:
--                      {"youtube": true, "kick": false, "twitch": true}
--   video_bitrate    – Detected from FFmpeg stderr parsing (future)
--   error_count      – Incremented each time FFmpeg restreamer restarts
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stream_sessions (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stream_key       VARCHAR(64) NOT NULL,
    ingest_type      VARCHAR(10) NOT NULL DEFAULT 'rtmp'
                         CHECK (ingest_type IN ('rtmp','srt')),
    client_ip        INET,

    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at         TIMESTAMPTZ,
    duration_seconds INTEGER     CHECK (duration_seconds >= 0),

    -- Platform snapshot at stream start
    streamed_to      JSONB       NOT NULL DEFAULT '{}',

    -- Media stats (populated from FFmpeg probe on reconnect, future feature)
    video_codec      VARCHAR(20),
    audio_codec      VARCHAR(20),
    video_bitrate    INTEGER,
    audio_bitrate    INTEGER,
    resolution       VARCHAR(20),
    fps              NUMERIC(5,2),

    error_count      INTEGER     NOT NULL DEFAULT 0,
    last_error       TEXT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: vm_instances
--
-- One row per provisioned OBS cloud VM. The VM runs:
--   - OBS Studio (headless)         via Xvfb virtual display
--   - obs-websocket 5.x             for remote scene switching (port 4455)
--   - x11vnc + noVNC                for browser-based VNC access (port 6080)
--
--   provider         – 'digitalocean' | 'aws' | 'vultr'
--   provider_id      – Droplet ID / EC2 instance ID from the cloud API
--   status           – lifecycle: provisioning → running → stopped → terminated
--   obs_password     – Random password set in OBS WebSocket plugin on boot
--   vnc_password     – Random password for x11vnc session
--   ingest_url       – The SRT URL this VM's OBS is configured to push into
--   hourly_rate      – Cost per hour in USD (for cost tracking)
--   total_cost       – Running total, updated when VM is terminated
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vm_instances (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         VARCHAR(20)  NOT NULL
                         CHECK (provider IN ('digitalocean','aws','vultr')),
    provider_id      VARCHAR(100) NOT NULL,
    status           VARCHAR(20)  NOT NULL DEFAULT 'provisioning'
                         CHECK (status IN ('provisioning','running','stopped','error','terminated')),

    ip_address       INET,
    region           VARCHAR(50),
    size             VARCHAR(50),

    -- OBS remote access
    obs_port         INTEGER      NOT NULL DEFAULT 4455,
    obs_password     VARCHAR(255),
    vnc_port         INTEGER      NOT NULL DEFAULT 5900,
    vnc_password     VARCHAR(255),
    novnc_port       INTEGER      NOT NULL DEFAULT 6080,

    -- What SRT URL OBS is publishing into
    ingest_url       TEXT,

    -- Cost tracking
    hourly_rate      NUMERIC(8,4),
    started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    stopped_at       TIMESTAMPTZ,
    total_cost       NUMERIC(10,2) NOT NULL DEFAULT 0,

    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: relay_nodes
--
-- Global ingest edge nodes. Each node runs MediaMTX (SRT, port 9999) and
-- nginx-rtmp (RTMP, port 1935). Streamers are directed to the nearest node.
--
--   load_percent     – Updated by health-check daemon (future)
--   current_streams  – Active publish sessions on this node
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_nodes (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name             VARCHAR(100) NOT NULL,
    region           VARCHAR(50)  NOT NULL,
    ip_address       INET         NOT NULL,
    srt_port         INTEGER      NOT NULL DEFAULT 9999,
    rtmp_port        INTEGER      NOT NULL DEFAULT 1935,
    status           VARCHAR(20)  NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','inactive','maintenance')),
    load_percent     NUMERIC(5,2) NOT NULL DEFAULT 0
                         CHECK (load_percent BETWEEN 0 AND 100),
    max_streams      INTEGER      NOT NULL DEFAULT 100,
    current_streams  INTEGER      NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: audit_log
--
-- Append-only log of significant admin and system actions.
--   action   – e.g. 'stream.kill' | 'user.disable' | 'vm.terminate'
--   details  – JSONB freeform payload for the action
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID         REFERENCES users(id) ON DELETE SET NULL,
    action     VARCHAR(100) NOT NULL,
    details    JSONB        NOT NULL DEFAULT '{}',
    ip_address INET,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: relay nodes
-- Replace 127.0.0.1 with actual IP addresses in production
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO relay_nodes (name, region, ip_address, srt_port, rtmp_port) VALUES
    ('SG-Edge-01',  'ap-southeast-1', '127.0.0.1', 9999, 1935),
    ('US-West-01',  'us-west-2',      '127.0.0.1', 9999, 1935),
    ('EU-West-01',  'eu-west-1',      '127.0.0.1', 9999, 1935),
    ('JP-East-01',  'ap-northeast-1', '127.0.0.1', 9999, 1935),
    ('AU-East-01',  'ap-southeast-2', '127.0.0.1', 9999, 1935)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes  – tuned for the hottest query paths
-- ─────────────────────────────────────────────────────────────────────────────

-- Auth webhook hot path: look up user by stream_key (called on every stream start)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stream_key
    ON users (stream_key);

-- Admin / dashboard: filter live users
CREATE INDEX IF NOT EXISTS idx_users_is_live
    ON users (is_live) WHERE is_live = true;

-- Session queries: per-user DESC time order (dashboard history)
CREATE INDEX IF NOT EXISTS idx_sessions_user_id_time
    ON stream_sessions (user_id, started_at DESC);

-- Admin: sessions in last N hours
CREATE INDEX IF NOT EXISTS idx_sessions_started_at
    ON stream_sessions (started_at DESC);

-- VM queries: per-user, per-status
CREATE INDEX IF NOT EXISTS idx_vms_user_id
    ON vm_instances (user_id);
CREATE INDEX IF NOT EXISTS idx_vms_status
    ON vm_instances (status) WHERE status != 'terminated';

-- Audit log: per-user queries
CREATE INDEX IF NOT EXISTS idx_audit_user_id
    ON audit_log (user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger: auto-update users.updated_at on any row change
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION _set_updated_at();
