-- ============================================================
--  SIL IRL Hosting Platform  –  Database Schema
--  Run against Supabase / PostgreSQL 14+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────────────────────────────
-- USERS
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    username         VARCHAR(50) UNIQUE NOT NULL,
    email            VARCHAR(255) UNIQUE,
    password_hash    VARCHAR(255),

    -- Stream identity
    stream_key       VARCHAR(64) UNIQUE NOT NULL,
    srt_passphrase   VARCHAR(64),
    is_active        BOOLEAN     DEFAULT true,
    is_live          BOOLEAN     DEFAULT false,
    plan             VARCHAR(20) DEFAULT 'free',   -- free | pro | enterprise

    -- Destinations
    youtube_url      TEXT,
    twitch_url       TEXT,
    kick_url         TEXT,
    stream_to_youtube  BOOLEAN   DEFAULT false,
    stream_to_twitch   BOOLEAN   DEFAULT false,
    stream_to_kick     BOOLEAN   DEFAULT false,

    -- SRT preference
    prefer_srt       BOOLEAN     DEFAULT false,

    -- Session info
    last_ip          INET,
    stream_start_time TIMESTAMPTZ,
    stream_end_time   TIMESTAMPTZ,
    total_stream_hours NUMERIC(10,2) DEFAULT 0,

    -- VM access
    vm_enabled       BOOLEAN     DEFAULT false,

    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
-- STREAM SESSIONS  (full history)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stream_sessions (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
    stream_key       VARCHAR(64) NOT NULL,
    ingest_type      VARCHAR(10) DEFAULT 'rtmp',   -- rtmp | srt
    client_ip        INET,

    started_at       TIMESTAMPTZ DEFAULT NOW(),
    ended_at         TIMESTAMPTZ,
    duration_seconds INTEGER,

    -- What platforms were live
    streamed_to      JSONB       DEFAULT '{}',

    -- Media info (populated from FFmpeg probe)
    video_codec      VARCHAR(20),
    audio_codec      VARCHAR(20),
    video_bitrate    INTEGER,
    audio_bitrate    INTEGER,
    resolution       VARCHAR(20),
    fps              NUMERIC(5,2),

    error_count      INTEGER     DEFAULT 0,
    last_error       TEXT
);

-- ──────────────────────────────────────────────────────────────
-- OBS VIRTUAL MACHINES
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vm_instances (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
    provider         VARCHAR(20) NOT NULL,         -- digitalocean | aws | vultr
    provider_id      VARCHAR(100) NOT NULL,
    status           VARCHAR(20) DEFAULT 'provisioning',
                     -- provisioning | running | stopped | error | terminated

    ip_address       INET,
    region           VARCHAR(50),
    size             VARCHAR(50),

    -- OBS access
    obs_port         INTEGER     DEFAULT 4455,
    obs_password     VARCHAR(255),
    vnc_port         INTEGER     DEFAULT 5900,
    vnc_password     VARCHAR(255),
    novnc_port       INTEGER     DEFAULT 6080,

    -- SRT URL this VM streams INTO SIL
    ingest_url       TEXT,

    -- Cost tracking
    hourly_rate      NUMERIC(8,4),
    started_at       TIMESTAMPTZ DEFAULT NOW(),
    stopped_at       TIMESTAMPTZ,
    total_cost       NUMERIC(10,2) DEFAULT 0,

    created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
-- RELAY / INGEST EDGE NODES
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relay_nodes (
    id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name             VARCHAR(100) NOT NULL,
    region           VARCHAR(50)  NOT NULL,
    ip_address       INET         NOT NULL,
    srt_port         INTEGER      DEFAULT 9999,
    rtmp_port        INTEGER      DEFAULT 1935,
    status           VARCHAR(20)  DEFAULT 'active',  -- active | inactive | maintenance
    load_percent     NUMERIC(5,2) DEFAULT 0,
    max_streams      INTEGER      DEFAULT 100,
    current_streams  INTEGER      DEFAULT 0,
    created_at       TIMESTAMPTZ  DEFAULT NOW()
);

-- Seed global relay nodes
INSERT INTO relay_nodes (name, region, ip_address, srt_port, rtmp_port) VALUES
    ('SG-Edge-01',   'ap-southeast-1', '127.0.0.1', 9999, 1935),
    ('US-West-01',   'us-west-2',      '127.0.0.1', 9999, 1935),
    ('EU-West-01',   'eu-west-1',      '127.0.0.1', 9999, 1935),
    ('JP-East-01',   'ap-northeast-1', '127.0.0.1', 9999, 1935),
    ('AU-East-01',   'ap-southeast-2', '127.0.0.1', 9999, 1935)
ON CONFLICT DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- AUDIT LOG
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
    action     VARCHAR(100) NOT NULL,
    details    JSONB        DEFAULT '{}',
    ip_address INET,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────
-- INDEXES
-- ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_stream_key        ON users(stream_key);
CREATE INDEX IF NOT EXISTS idx_users_is_live           ON users(is_live);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id        ON stream_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at     ON stream_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_vms_user_id             ON vm_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_vms_status              ON vm_instances(status);
CREATE INDEX IF NOT EXISTS idx_audit_user_id           ON audit_log(user_id);

-- ──────────────────────────────────────────────────────────────
-- AUTO-UPDATE updated_at
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION _set_updated_at();
