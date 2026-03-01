'use strict';
/**
 * OBS WebSocket v5 Controller
 * ────────────────────────────
 * Connects to obs-websocket running on a remote OBS VM and provides
 * a clean API for scene switching, stream control, and status queries.
 *
 * OBS WebSocket v5 Protocol:
 *   op 0  – Hello       (server → client, contains auth challenge)
 *   op 1  – Identify    (client → server, sends auth response)
 *   op 2  – Identified  (server → client, handshake complete)
 *   op 6  – Request     (client → server)
 *   op 7  – RequestResponse (server → client)
 *   op 5  – Event       (server → client, async notifications)
 *
 * Auth calculation (OBS WS v5):
 *   secret      = base64( sha256( password + salt ) )
 *   authResponse = base64( sha256( secret + challenge ) )
 */

const crypto   = require('crypto');
const { WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const logger   = require('../utils/logger');
const db       = require('../db/database');

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
class OBSConnection {
  /**
   * @param {string} ip        VM IP address
   * @param {number} port      OBS WS port (default 4455)
   * @param {string} password  OBS WS password
   */
  constructor(ip, port, password) {
    this.ip       = ip;
    this.port     = port || 4455;
    this.password = password || '';
    this.ws       = null;
    this.ready    = false;
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending  = new Map();
    this._heartbeatTimer = null;
    this._sceneCache     = null;   // Cache scenes to reduce OBS API calls
  }

  // ── Connect & authenticate ─────────────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.ip}:${this.port}`;
      logger.info(`[OBS WS] Connecting → ${url}`);

      try { this.ws = new WebSocket(url); }
      catch (err) { return reject(err); }

      const connectTimer = setTimeout(() => {
        reject(new Error(`OBS WS connection timeout (${url})`));
        this.ws?.terminate();
      }, CONNECT_TIMEOUT_MS);

      // ── Message handler ──────────────────────────────────────────────
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        const { op, d } = msg;

        if (op === 0) {
          // Hello – send Identify with optional auth
          if (d.authentication) {
            const auth = _buildAuth(this.password, d.authentication.salt, d.authentication.challenge);
            this._send({ op: 1, d: { rpcVersion: 1, authentication: auth, eventSubscriptions: 33 } });
          } else {
            this._send({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 33 } });
          }
        } else if (op === 2) {
          // Identified – ready
          clearTimeout(connectTimer);
          this.ready = true;
          this._startHeartbeat();
          logger.info(`[OBS WS] Authenticated  ${this.ip}:${this.port}`);
          resolve(this);
        } else if (op === 7) {
          // RequestResponse
          const p = this.pending.get(d.requestId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(d.requestId);
            d.requestStatus.result
              ? p.resolve(d.responseData ?? {})
              : p.reject(new Error(`OBS ${d.requestType} failed: code=${d.requestStatus.code} comment=${d.requestStatus.comment}`));
          }
        } else if (op === 5) {
          // Event – invalidate scene cache on changes
          if (['SceneCreated', 'SceneRemoved', 'SceneNameChanged',
               'CurrentProgramSceneChanged'].includes(d.eventType)) {
            this._sceneCache = null;
          }
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimer);
        reject(err);
      });

      this.ws.on('close', () => {
        this.ready = false;
        clearInterval(this._heartbeatTimer);
        // Reject all in-flight requests
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('OBS WS connection closed'));
        }
        this.pending.clear();
        this._sceneCache = null;
        logger.info(`[OBS WS] Closed  ${this.ip}:${this.port}`);
      });
    });
  }

  // ── Send a raw message ─────────────────────────────────────────────────
  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ── Keep-alive heartbeat ───────────────────────────────────────────────
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this.request('GetVersion').catch(() => {});
    }, HEARTBEAT_INTERVAL);
  }

  // ── Low-level request (op 6) ───────────────────────────────────────────
  request(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error('OBS not connected/authenticated'));

      const requestId = uuidv4();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS request timeout: ${requestType}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer });
      this._send({ op: 6, d: { requestType, requestId, requestData } });
    });
  }

  disconnect() {
    clearInterval(this._heartbeatTimer);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }
    this.ready = false;
  }

  // ── High-level OBS API ─────────────────────────────────────────────────

  /** List all scenes + current scene. Cached for 2s. */
  async getSceneList() {
    if (this._sceneCache && Date.now() - this._sceneCache.ts < 2_000)
      return this._sceneCache.data;
    const data = await this.request('GetSceneList');
    const result = {
      currentScene: data.currentProgramSceneName,
      scenes: (data.scenes || []).map(s => s.sceneName).reverse(),
    };
    this._sceneCache = { data: result, ts: Date.now() };
    return result;
  }

  async setScene(sceneName) {
    await this.request('SetCurrentProgramScene', { sceneName });
    this._sceneCache = null;
    return { ok: true, scene: sceneName };
  }

  async getStreamStatus() {
    return this.request('GetStreamStatus');
  }

  async startStream() {
    const status = await this.getStreamStatus();
    if (status.outputActive) throw new Error('OBS is already streaming');
    return this.request('StartStream');
  }

  async stopStream() {
    return this.request('StopStream');
  }

  async getCurrentScene() {
    const d = await this.request('GetCurrentProgramScene');
    return d.currentProgramSceneName;
  }

  async getStats() {
    return this.request('GetStats');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
class OBSController {
  constructor() {
    /** @type {Map<string, OBSConnection>} */
    this.connections = new Map();
  }

  /**
   * Get (or establish) a connection to the OBS on a VM.
   * @param {string} vmId  UUID from vm_instances table
   */
  async getOrConnect(vmId) {
    const existing = this.connections.get(vmId);
    if (existing?.ready) return existing;

    // Fetch VM credentials from DB
    const { rows } = await db.query(
      `SELECT ip_address, obs_port, obs_password, status
         FROM vm_instances WHERE id=$1`,
      [vmId]
    );
    if (!rows.length) throw new Error('VM not found');
    const vm = rows[0];
    if (vm.status !== 'running') throw new Error(`VM is not running (status: ${vm.status})`);
    if (!vm.ip_address) throw new Error('VM IP not assigned yet – try again in a moment');

    const conn = new OBSConnection(vm.ip_address, vm.obs_port || 4455, vm.obs_password);
    await conn.connect();
    this.connections.set(vmId, conn);

    // Auto-remove on disconnect
    conn.ws?.once('close', () => {
      if (this.connections.get(vmId) === conn) this.connections.delete(vmId);
    });

    return conn;
  }

  async listScenes(vmId)          { return (await this.getOrConnect(vmId)).getSceneList(); }
  async switchScene(vmId, name)   { return (await this.getOrConnect(vmId)).setScene(name); }
  async getStreamStatus(vmId)     { return (await this.getOrConnect(vmId)).getStreamStatus(); }
  async startStream(vmId)         { return (await this.getOrConnect(vmId)).startStream(); }
  async stopStream(vmId)          { return (await this.getOrConnect(vmId)).stopStream(); }
  async getStats(vmId)            { return (await this.getOrConnect(vmId)).getStats(); }

  disconnect(vmId) {
    this.connections.get(vmId)?.disconnect();
    this.connections.delete(vmId);
  }

  disconnectAll() {
    for (const conn of this.connections.values()) conn.disconnect();
    this.connections.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
function _buildAuth(password, salt, challenge) {
  // OBS WS v5 auth:  base64(sha256( base64(sha256(password+salt)) + challenge ))
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

module.exports = new OBSController();
