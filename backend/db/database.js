'use strict';
const { Pool } = require('pg');
const config   = require('../config');

const pool = new Pool({
  connectionString:     config.database.connectionString,
  ssl:                  config.database.ssl,
  max:                  config.database.max,
  idleTimeoutMillis:    config.database.idleTimeoutMillis,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
});

pool.on('error', (err) => console.error('[DB] Unexpected client error:', err));

/**
 * Run a parameterised query.
 * @param {string} text   SQL string
 * @param {Array}  params Bound parameters
 */
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

/** Borrow a dedicated client (for transactions). */
async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient, pool };
