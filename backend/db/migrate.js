#!/usr/bin/env node
'use strict';
/**
 * SIL Database Migration Runner
 * ──────────────────────────────
 * Usage:
 *   node db/migrate.js           → run all pending migrations
 *   node db/migrate.js status    → show migration status table
 *   node db/migrate.js rollback  → (no-op: SQL migrations are forward-only)
 *
 * How it works:
 *   1. Creates a `schema_migrations` table on first run (idempotent).
 *   2. Reads every *.sql file from db/migrations/ in lexicographic order.
 *   3. Skips any file already recorded in schema_migrations.
 *   4. Runs each pending migration inside a transaction.
 *   5. Records success (or rolls back + rethrows on error).
 *
 * Each migration file name must follow the pattern:
 *   NNN_description.sql   e.g.  001_initial_schema.sql
 *
 * The runner is idempotent: re-running it after partial failure is safe.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────────────────────
// Connection  (standalone – does NOT use the app's pool so it can be run
//             before the app starts and with a higher statement timeout)
// ─────────────────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set. Check your .env file.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },       // required by Supabase pooler
  max: 1,                                   // single connection for migrations
  statement_timeout: 30_000,               // 30 s max per statement
  connectionTimeoutMillis: 10_000,
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure the migrations tracking table exists. */
async function ensureMetaTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(255) PRIMARY KEY,
      applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      checksum    VARCHAR(64)  NOT NULL,
      duration_ms INTEGER      NOT NULL
    )
  `);
}

/** Return a sorted list of *.sql filenames in the migrations directory. */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌  Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();                              // lexicographic ≡ version order
}

/** Simple non-cryptographic checksum (enough to detect accidental edits). */
function checksum(content) {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Return Set of already-applied migration versions. */
async function getAppliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map(r => r.version));
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMetaTable(client);

    const files   = getMigrationFiles();
    const applied = await getAppliedVersions(client);
    const pending = files.filter(f => !applied.has(f));

    if (!pending.length) {
      console.log('✅  All migrations are up to date.');
      return;
    }

    console.log(`\n📦  Running ${pending.length} pending migration(s)…\n`);

    for (const file of pending) {
      const sqlPath = path.join(MIGRATIONS_DIR, file);
      const sql     = fs.readFileSync(sqlPath, 'utf8');
      const cs      = checksum(sql);
      const t0      = Date.now();

      console.log(`  ▶  ${file}`);

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [file, cs, Date.now() - t0]
        );
        await client.query('COMMIT');
        console.log(`  ✓  ${file}  (${Date.now() - t0} ms)\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`\n  ✗  ${file}  FAILED:\n     ${err.message}\n`);
        console.error('Migration stopped. Fix the error and re-run.');
        process.exit(1);
      }
    }

    console.log('✅  All migrations applied successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

async function showStatus() {
  const client = await pool.connect();
  try {
    await ensureMetaTable(client);

    const files    = getMigrationFiles();
    const { rows } = await client.query(
      'SELECT version, applied_at, duration_ms FROM schema_migrations ORDER BY applied_at'
    );
    const appliedMap = new Map(rows.map(r => [r.version, r]));

    console.log('\n  Migration Status\n  ─────────────────────────────────────────────────');
    console.log('  STATUS   VERSION                            APPLIED AT');
    console.log('  ─────────────────────────────────────────────────────');

    for (const file of files) {
      if (appliedMap.has(file)) {
        const r = appliedMap.get(file);
        const ts = new Date(r.applied_at).toISOString().slice(0, 19).replace('T', ' ');
        console.log(`  ✓ DONE   ${file.padEnd(40)} ${ts}  (${r.duration_ms}ms)`);
      } else {
        console.log(`  ○ PENDING  ${file}`);
      }
    }
    console.log('');
  } finally {
    client.release();
    await pool.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
const command = process.argv[2] || 'up';

(async () => {
  console.log(`\n🔌  Connecting to Supabase PostgreSQL…`);
  try {
    await pool.query('SELECT 1');
    console.log('   Connected.\n');
  } catch (err) {
    console.error(`❌  Cannot connect to database: ${err.message}`);
    process.exit(1);
  }

  if (command === 'status') {
    await showStatus();
  } else {
    await runMigrations();
  }
})();
