'use strict';
/**
 * Centralised Application Config
 * ────────────────────────────────
 * All values come from environment variables (loaded from .env by dotenv).
 * Sensitive keys (DB, JWT, admin secret) are REQUIRED in production.
 * The module throws at startup if any required key is missing so the server
 * never runs in a silently broken state.
 *
 * Third-party services consumed:
 *   • Supabase (PostgreSQL)   – DATABASE_URL
 *   • DigitalOcean            – DO_TOKEN          (OBS VM provisioning)
 *   • AWS EC2                 – AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *   • MediaMTX                – MEDIAMTX_API      (SRT ingest webhooks)
 *   • nginx-rtmp              – RTMP_LOCAL / NGINX_RTMP_API
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─────────────────────────────────────────────────────────────────────────────
// Guard: throw early for required production secrets
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_IN_PROD = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_SECRET'];
const IS_PROD          = (process.env.NODE_ENV || 'development') === 'production';

if (IS_PROD) {
  const missing = REQUIRED_IN_PROD.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[Config] Missing required production environment variables: ${missing.join(', ')}\n` +
      'Set them in your deployment environment or .env file.'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const int  = (key, fallback) => parseInt(process.env[key] ?? fallback, 10);
const bool = (key, fallback) => {
  const v = process.env[key];
  return v === undefined ? fallback : v === 'true' || v === '1';
};

// ─────────────────────────────────────────────────────────────────────────────
// Config object
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  port:           int('PORT', 3000),
  nodeEnv:        process.env.NODE_ENV   || 'development',
  logLevel:       process.env.LOG_LEVEL  || 'info',
  corsOrigin:     process.env.CORS_ORIGIN || '*',

  /** Public-facing IP / hostname of this server (used in ingest URLs). */
  serverPublicIp: (() => {
    const raw = (process.env.SERVER_PUBLIC_IP || '').trim();
    if (!raw) return 'localhost';
    if (raw === 'YOUR_SERVER_IP_OR_HOSTNAME' || raw === 'YOUR_SERVER_IP') return 'localhost';
    return raw;
  })(),

  // ── Database (Supabase / PostgreSQL) ───────────────────────────────────────
  //   Third-party service: Supabase (https://supabase.com)
  //   Required env vars:
  //     DATABASE_URL  – Full Postgres connection string including password.
  //                     Use the "Transaction" pooler URL from the Supabase
  //                     dashboard (port 5432 or 6543 for PgBouncer).
  database: {
    url:                process.env.DATABASE_URL,
    poolMax:            int('DB_POOL_MAX', 10),
    idleTimeoutMs:      int('DB_IDLE_TIMEOUT_MS', 60_000),
    connectTimeoutMs:   int('DB_CONNECT_TIMEOUT_MS', 5_000),
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 10_000),
  },

  // ── JWT authentication ─────────────────────────────────────────────────────
  //   jsonwebtoken (npm) – signs streamer session tokens.
  //   Required env vars:
  //     JWT_SECRET     – Long random string, minimum 32 chars.
  //     JWT_EXPIRES_IN – e.g. "7d", "24h" (default 7d)
  jwt: {
    secret:    process.env.JWT_SECRET    || 'CHANGE_ME_JWT_SECRET_MIN_32_CHARS',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // ── Admin panel ────────────────────────────────────────────────────────────
  //   All /api/admin/* endpoints require this header:
  //     x-admin-secret: <ADMIN_SECRET>
  admin: {
    secret: process.env.ADMIN_SECRET || 'CHANGE_ME_ADMIN_SECRET',
  },

  // ── RTMP ingest (nginx-rtmp) ───────────────────────────────────────────────
  //   Third-party: nginx with nginx-rtmp-module compiled in.
  //   nginx-rtmp calls on_publish → POST /rtmp/auth and on_done → POST /rtmp/done
  //   to this Node.js server for auth and stream-end handling.
  rtmp: {
    localServer: process.env.RTMP_LOCAL     || 'rtmp://127.0.0.1/live',
    nginxApi:    process.env.NGINX_RTMP_API || 'http://127.0.0.1:8080/control',
  },

  // ── SRT ingest (MediaMTX) ─────────────────────────────────────────────────
  //   Third-party: MediaMTX (https://github.com/bluenviron/mediamtx)
  //   MediaMTX calls onPublish/onUnpublish webhooks to this server.
  //   Also exposes a REST API at MEDIAMTX_API that streamHealth.js polls
  //   every 5 s for bitrate and packet-loss metrics.
  srt: {
    server:      process.env.SRT_SERVER    || '127.0.0.1',
    port:        int('SRT_PORT', 9999),
    mediamtxApi: process.env.MEDIAMTX_API || 'http://127.0.0.1:9997',
  },

  // ── Destination platforms ──────────────────────────────────────────────────
  //   RTMP base URLs – users append their platform stream key.
  platforms: {
    youtube: { rtmpBase: 'rtmp://a.rtmp.youtube.com/live2' },
    kick:    { rtmpBase: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app' },
    twitch:  { rtmpBase: 'rtmp://live.twitch.tv/app' },
  },

  // ── BRB / Anti-Scuff Layer ─────────────────────────────────────────────────
  //   FFmpeg (system binary) used to loop BRB media or generate a lavfi screen.
  //   No third-party API; requires FFmpeg installed on the host.
  brb: {
    graceMs: int('BRB_GRACE_MS', 10_000),
  },
};
