'use strict';
/**
 * PostgreSQL Connection Pool  –  Production Grade
 * ──────────────────────────────────────────────────
 * Uses the `pg` library with Supabase's connection pooler (PgBouncer).
 *
 * Design decisions:
 *   • max: 10 – Supabase free tier allows 20 direct connections; pooler
 *     multiplexes, so 10 app-level slots is safe and leaves headroom for
 *     the migration runner and future replicas.
 *   • idleTimeoutMillis: 60 000 – Release idle clients after 60 s to avoid
 *     holding pooler slots unnecessarily.
 *   • connectionTimeoutMillis: 5 000 – Fail fast; let the app retry rather
 *     than queue indefinitely.
 *   • statement_timeout: 10 000 ms – Any query taking > 10 s is a bug;
 *     raise an error rather than hanging the event loop.
 *   • Startup connectivity check with exponential back-off (3 attempts).
 *   • Slow-query logging: any query > SLOW_QUERY_MS is logged as a warning.
 */

const { Pool } = require('pg');
const logger   = require('../utils/logger');
const config   = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// Pool configuration
// ─────────────────────────────────────────────────────────────────────────────
const SLOW_QUERY_MS = 2_000;   // warn if any query takes longer than this

function parseBooleanish(value) {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off', 'disable', 'disabled'].includes(v)) return false;
  return undefined;
}

function getDatabaseHost(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.hostname;
  } catch {
    return undefined;
  }
}

function getSslModeFromConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    return url.searchParams.get('sslmode') || undefined;
  } catch {
    return undefined;
  }
}

function resolveSslConfig() {
  const connectionString = config.database.url;
  const sslmode = getSslModeFromConnectionString(connectionString);
  if (sslmode) {
    if (sslmode === 'disable') return false;
    const rejectUnauthorized = ['verify-full', 'verify-ca'].includes(sslmode);
    return { rejectUnauthorized };
  }

  const forced = parseBooleanish(process.env.DB_SSL);
  if (forced !== undefined) {
    if (!forced) return false;
    const rejectUnauthorized = parseBooleanish(process.env.DB_SSL_REJECT_UNAUTHORIZED) ?? false;
    return { rejectUnauthorized };
  }

  // Auto mode (default): disable SSL for local databases and for known
  // non-TLS poolers; enable elsewhere.
  const host = getDatabaseHost(connectionString);
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1') return false;
  if (host.endsWith('.pooler.supabase.com')) return false;

  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString:        config.database.url,
  ssl:                     resolveSslConfig(),
  max:                     config.database.poolMax,
  idleTimeoutMillis:       config.database.idleTimeoutMs,
  connectionTimeoutMillis: config.database.connectTimeoutMs,
  // Set per-connection defaults via search_path and statement_timeout
  options:                 `--statement_timeout=${config.database.statementTimeoutMs}`,
});

// Log pool-level errors (unexpected client disconnects)
pool.on('error', (err, client) => {
  logger.error('[DB] Pool client error:', { message: err.message, code: err.code });
});

pool.on('connect', () => {
  logger.debug('[DB] New client connected to pool');
});

// ─────────────────────────────────────────────────────────────────────────────
// Core query wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a parameterised SQL query.
 * Automatically acquires and releases a pool client.
 * Logs slow queries as warnings.
 *
 * @param  {string}  text    Parameterised SQL
 * @param  {Array}   [params] Bound values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const t0     = Date.now();
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    const ms     = Date.now() - t0;
    if (ms > SLOW_QUERY_MS) {
      logger.warn('[DB] Slow query', {
        duration_ms: ms,
        rows:        result.rowCount,
        // Truncate to avoid logging sensitive WHERE clauses in full
        query:       text.slice(0, 120).replace(/\s+/g, ' '),
      });
    }
    return result;
  } catch (err) {
    logger.error('[DB] Query error', {
      message: err.message,
      code:    err.code,
      query:   text.slice(0, 120).replace(/\s+/g, ' '),
    });
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transaction helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a block inside a transaction.
 * Automatically rolls back on error.
 *
 * @param  {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 *
 * @example
 *   const result = await withTransaction(async (client) => {
 *     await client.query('UPDATE users SET is_live=true WHERE id=$1', [id]);
 *     await client.query('INSERT INTO stream_sessions …', […]);
 *     return { success: true };
 *   });
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Borrow a dedicated client (advanced use — prefer withTransaction).
 * Caller MUST call client.release() in a finally block.
 */
async function getClient() {
  return pool.connect();
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup connectivity check with retry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify that the database is reachable. Called once at server startup.
 * Retries up to `attempts` times with exponential back-off.
 *
 * @param {number} [attempts=3]
 * @param {number} [delayMs=1000]
 */
async function connect(attempts = 3, delayMs = 1_000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { rows } = await pool.query('SELECT NOW() AS ts, version() AS ver');
      logger.info('[DB] Connected to PostgreSQL', {
        server_time: rows[0].ts,
        version:     rows[0].ver.split(' ').slice(0, 2).join(' '),
        pool_max:    config.database.poolMax,
      });
      return;
    } catch (err) {
      logger.error(`[DB] Connect attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) {
        const wait = delayMs * 2 ** (attempt - 1);
        logger.info(`[DB] Retrying in ${wait} ms…`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        logger.error('[DB] Could not connect after all attempts – continuing without DB');
        throw new Error('DB connection failed after all retries');
      }
    }
  }
}

/**
 * Gracefully drain the pool. Called on SIGTERM.
 */
async function disconnect() {
  await pool.end();
  logger.info('[DB] Pool closed');
}

module.exports = { query, withTransaction, getClient, connect, disconnect, pool };
