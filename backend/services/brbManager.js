'use strict';
/**
 * BRB Manager  –  Anti-Scuff Layer
 * ─────────────────────────────────
 * Prevents platform disconnects when a streamer's 4G/5G signal drops.
 *
 * State machine per stream key:
 *
 *   [Live] ──signal drop──► [Grace ~10s] ──reconnect──► [Live]
 *                               │
 *                           grace expires
 *                               │
 *                               ▼
 *                        [BRB Active] ──reconnect──► [Live]
 *                               │
 *                           BRB timeout (default 5 min)
 *                               │
 *                               ▼
 *                          [Ended] → DB finalized
 *
 * While in Grace or BRB Active:
 *  - Platform connections are kept ALIVE via FFmpeg looping a BRB video
 *  - Viewers see a "Be Right Back" screen instead of a stream error
 *  - Streamer can reconnect and resume seamlessly
 */

const { spawn }      = require('child_process');
const EventEmitter   = require('events');
const path           = require('path');
const fs             = require('fs');
const logger         = require('../utils/logger');
const db             = require('../db/database');
const { broadcast }  = require('./websocketServer');

const GRACE_MS       = parseInt(process.env.BRB_GRACE_MS) || 10_000;   // 10 s
const BRB_UPLOADS    = path.join(__dirname, '../../uploads/brb');

// ─────────────────────────────────────────────────────────────────────────────
class BRBSession extends EventEmitter {
  constructor(streamKey, user) {
    super();
    this.streamKey       = streamKey;
    this.user            = user;
    this.state           = 'grace';   // grace | brb_active | ended
    this.brbProcess      = null;
    this.graceTimer      = null;
    this.endTimer        = null;
    this.reconnectCount  = 0;
    this.droppedAt       = Date.now();
  }

  // ── Called immediately when signal drops ───────────────────────────────────
  startGrace() {
    this.state    = 'grace';
    this.droppedAt = Date.now();
    _emit(this, 'grace');
    logger.info(`[BRB:${this.streamKey}] Grace period started (${GRACE_MS}ms)`);

    this.graceTimer = setTimeout(() => {
      if (this.state === 'grace') this._startBRB();
    }, GRACE_MS);
  }

  // ── Called when streamer reconnects ───────────────────────────────────────
  onReconnect() {
    this.reconnectCount++;
    logger.info(`[BRB:${this.streamKey}] Reconnect #${this.reconnectCount} (was in ${this.state})`);

    clearTimeout(this.graceTimer);
    clearTimeout(this.endTimer);
    this._stopBRBProcess();
    this.state = 'live';

    _emit(this, 'live', { reconnectCount: this.reconnectCount });
    this.emit('reconnected');
  }

  // ── Internal: start BRB loop ──────────────────────────────────────────────
  _startBRB() {
    const timeoutMs = (this.user.brb_timeout_seconds || 300) * 1_000;
    this.state      = 'brb_active';
    _emit(this, 'brb_active');
    logger.info(`[BRB:${this.streamKey}] BRB loop started (max ${timeoutMs / 1000}s)`);

    const dests = _buildDests(this.user);
    if (dests.length === 0) {
      logger.warn(`[BRB:${this.streamKey}] No destinations – skipping BRB loop, ending stream`);
      return this._finalizeEnd();
    }

    const args = this._buildFFmpegArgs(dests);
    logger.debug(`[BRB:${this.streamKey}] ffmpeg ${args.join(' ')}`);
    this.brbProcess = spawn('ffmpeg', args);

    this.brbProcess.stderr.on('data', chunk =>
      logger.debug(`[brb-ffmpeg:${this.streamKey}] ${chunk.toString().trim()}`)
    );

    this.brbProcess.on('exit', (code) => {
      // Auto-restart if still in BRB mode (e.g. platform momentarily rejected)
      if (this.state === 'brb_active') {
        logger.info(`[BRB:${this.streamKey}] FFmpeg exited (${code}) – restarting BRB`);
        setTimeout(() => { if (this.state === 'brb_active') this._spawnBRB(dests, args); }, 2_000);
      }
    });

    // Hard timeout – give up if streamer doesn't return
    this.endTimer = setTimeout(() => {
      logger.info(`[BRB:${this.streamKey}] BRB timeout reached – finalizing`);
      this._finalizeEnd();
    }, timeoutMs);
  }

  _spawnBRB(dests, args) {
    if (this.state !== 'brb_active') return;
    this.brbProcess = spawn('ffmpeg', args);
    this.brbProcess.stderr.on('data', chunk =>
      logger.debug(`[brb-ffmpeg:${this.streamKey}] ${chunk.toString().trim()}`)
    );
    this.brbProcess.on('exit', () => {
      if (this.state === 'brb_active')
        setTimeout(() => this._spawnBRB(dests, args), 2_000);
    });
  }

  // ── Build FFmpeg args for BRB output ─────────────────────────────────────
  _buildFFmpegArgs(dests) {
    const mediaPath = _findBRBMedia(this.user.username, this.user.brb_media_path);
    let   inputArgs = [];
    let   encArgs   = [];

    if (mediaPath && /\.(mp4|mov|webm|mkv)$/i.test(mediaPath)) {
      // Loop a video file (no re-encode needed)
      inputArgs = ['-stream_loop', '-1', '-re', '-i', mediaPath];
      encArgs   = ['-c', 'copy'];
    } else if (mediaPath && /\.(jpg|jpeg|png)$/i.test(mediaPath)) {
      // Loop still image with silent audio
      inputArgs = [
        '-loop', '1', '-framerate', '24', '-i', mediaPath,
        '-f', 'lavfi', '-i', 'aevalsrc=0:channel_layout=stereo:sample_rate=44100',
      ];
      encArgs = [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
        '-b:v', '800k', '-c:a', 'aac', '-b:a', '64k',
      ];
    } else {
      // Default: generated BRB screen via lavfi (no upload needed)
      inputArgs = [
        '-f', 'lavfi', '-i', 'color=c=0x111827:s=1920x1080:r=24',
        '-f', 'lavfi', '-i', 'aevalsrc=0:channel_layout=stereo:sample_rate=44100',
        '-vf', [
          "drawtext=text='Be Right Back':fontsize=96:fontcolor=white",
          'x=(w-text_w)/2:y=(h-text_h)/2-50',
          "drawtext=text='Stream resuming shortly...':fontsize=42:fontcolor=gray",
          'x=(w-text_w)/2:y=(h-text_h)/2+70',
        ].join(':'),
      ];
      encArgs = [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '500k',
        '-c:a', 'aac', '-b:a', '64k',
      ];
    }

    const outputArgs = dests.length === 1
      ? [...encArgs, '-f', 'flv', dests[0]]
      : [...encArgs, '-f', 'tee', dests.map(d => `[f=flv:onfail=ignore]${d}`).join('|')];

    return ['-hide_banner', '-loglevel', 'warning', ...inputArgs, ...outputArgs];
  }

  // ── Stop FFmpeg safely ────────────────────────────────────────────────────
  _stopBRBProcess() {
    if (this.brbProcess && !this.brbProcess.killed) {
      this.brbProcess.removeAllListeners('exit');
      this.brbProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.brbProcess && !this.brbProcess.killed) this.brbProcess.kill('SIGKILL');
      }, 3_000);
      this.brbProcess = null;
    }
  }

  // ── True stream end: stop BRB + write DB ─────────────────────────────────
  async _finalizeEnd() {
    this.state = 'ended';
    this._stopBRBProcess();
    clearTimeout(this.graceTimer);
    clearTimeout(this.endTimer);
    _emit(this, 'ended');

    try {
      await Promise.all([
        db.query(
          `UPDATE users SET is_live=false, stream_end_time=NOW() WHERE stream_key=$1`,
          [this.streamKey]
        ),
        db.query(
          `UPDATE stream_sessions
              SET ended_at=NOW(),
                  duration_seconds=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER
            WHERE stream_key=$1 AND ended_at IS NULL`,
          [this.streamKey]
        ),
      ]);
      logger.info(`[BRB:${this.streamKey}] Stream finalized in DB`);
    } catch (err) {
      logger.error(`[BRB:${this.streamKey}] DB finalize error:`, err);
    }

    this.emit('ended');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
class BRBManager {
  constructor() {
    /** @type {Map<string, BRBSession>} */
    this.sessions = new Map();
  }

  /**
   * Call when signal drops (from /rtmp/done or /srt/done).
   * @param {string} streamKey
   * @param {object} user  DB row with BRB settings + destination URLs
   */
  async signalDrop(streamKey, user) {
    // BRB disabled → immediate stream end
    if (!user.brb_enabled) {
      logger.info(`[BRBMgr] BRB disabled for ${user.username} – immediate end`);
      return this._immediateEnd(streamKey);
    }

    // Re-use existing session if still in grace/BRB (double-drop scenario)
    const existing = this.sessions.get(streamKey);
    if (existing && existing.state !== 'ended') {
      existing.startGrace();
      return;
    }

    const session = new BRBSession(streamKey, user);
    session.on('ended', () => {
      this.sessions.delete(streamKey);
      broadcast('stream_end', { streamKey, username: user.username });
    });
    this.sessions.set(streamKey, session);
    session.startGrace();
  }

  /**
   * Call when streamer reconnects (from /rtmp/auth or /srt/auth).
   * @param {string} streamKey
   */
  onReconnect(streamKey) {
    const session = this.sessions.get(streamKey);
    if (session && session.state !== 'ended') {
      session.onReconnect();
      this.sessions.delete(streamKey);
    }
  }

  /**
   * Force-end a stream immediately.
   * This is useful when a streamer intentionally stops streaming and does NOT
   * want BRB to keep platforms alive.
   *
   * @param {string} streamKey
   */
  async forceEnd(streamKey) {
    const session = this.sessions.get(streamKey);
    if (session && session.state !== 'ended') {
      await session._finalizeEnd();
      return;
    }
    await this._immediateEnd(streamKey);
  }

  // Immediate end without BRB
  async _immediateEnd(streamKey) {
    const restreamer = require('./restreamer');
    restreamer.stop(streamKey);
    try {
      await Promise.all([
        db.query(`UPDATE users SET is_live=false, stream_end_time=NOW() WHERE stream_key=$1`, [streamKey]),
        db.query(`UPDATE stream_sessions SET ended_at=NOW(), duration_seconds=EXTRACT(EPOCH FROM (NOW()-started_at))::INTEGER WHERE stream_key=$1 AND ended_at IS NULL`, [streamKey]),
      ]);
    } catch {}
    broadcast('stream_end', { streamKey });
  }

  /** Returns 'grace' | 'brb_active' | 'ended' | null */
  getState(streamKey) {
    return this.sessions.get(streamKey)?.state ?? null;
  }

  getAllStats() {
    return [...this.sessions.values()].map(s => ({
      streamKey:      s.streamKey,
      username:       s.user.username,
      state:          s.state,
      reconnectCount: s.reconnectCount,
      dropAgoMs:      Date.now() - s.droppedAt,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function _emit(session, state, extra = {}) {
  broadcast('brb_state', {
    streamKey:      session.streamKey,
    username:       session.user.username,
    state,
    reconnectCount: session.reconnectCount,
    ...extra,
  });
}

function _buildDests(user) {
  const d = [];
  if (user.stream_to_youtube && user.youtube_url) d.push(user.youtube_url);
  if (user.stream_to_kick    && user.kick_url)    d.push(user.kick_url);
  if (user.stream_to_twitch  && user.twitch_url)  d.push(user.twitch_url);
  return d;
}

function _findBRBMedia(username, dbPath) {
  // 1. Check DB-stored path
  if (dbPath) {
    const full = path.join(BRB_UPLOADS, '..', dbPath);
    if (fs.existsSync(full)) return full;
  }
  // 2. Scan by username
  for (const ext of ['mp4', 'mov', 'jpg', 'jpeg', 'png']) {
    const p = path.join(BRB_UPLOADS, `${username}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  // 3. Default media
  for (const ext of ['mp4', 'jpg']) {
    const p = path.join(BRB_UPLOADS, `default.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;   // will use lavfi generated screen
}

module.exports = new BRBManager();
