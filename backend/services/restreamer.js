'use strict';
/**
 * RestreamManager
 * ───────────────
 * Manages FFmpeg child-processes that ingest a local RTMP/SRT feed
 * and simultaneously push to YouTube, Kick, and/or Twitch.
 *
 * Architecture:
 *   [OBS / IRL Encoder]
 *         │  RTMP or SRT
 *         ▼
 *   [nginx-rtmp / MediaMTX]
 *         │  pull (re-read local feed)
 *         ▼
 *   [FFmpeg tee muxer]
 *     ├─► YouTube  rtmp://a.rtmp.youtube.com/live2/<key>
 *     ├─► Kick     rtmps://.../<key>
 *     └─► Twitch   rtmp://live.twitch.tv/app/<key>
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const config = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
class RestreamSession extends EventEmitter {
  /**
   * @param {string} streamKey
   * @param {object} user  DB row with youtube_url, kick_url, twitch_url, etc.
   */
  constructor(streamKey, user) {
    super();
    this.streamKey  = streamKey;
    this.user       = user;
    this.process    = null;
    this.retries    = 0;
    this.maxRetries = 5;
    this.isActive   = true;
    this.startTime  = Date.now();
  }

  // ── Build destinations ─────────────────────────────────────────────────────
  _destinations() {
    const dests = [];
    if (this.user.stream_to_youtube && this.user.youtube_url) dests.push({ label: 'YouTube', url: this.user.youtube_url });
    if (this.user.stream_to_kick    && this.user.kick_url)    dests.push({ label: 'Kick',    url: this.user.kick_url    });
    if (this.user.stream_to_twitch  && this.user.twitch_url)  dests.push({ label: 'Twitch',  url: this.user.twitch_url  });
    return dests;
  }

  // ── Build ffmpeg args ──────────────────────────────────────────────────────
  _buildArgs(ingestType) {
    const dests = this._destinations();
    if (dests.length === 0) return null;

    // Input source: pull from local ingest server
    let inputUrl;
    let inputArgs = [];
    if (ingestType === 'srt') {
      // For SRT publishers (LiveU / TVU / Larix), pull the decoded stream from MediaMTX via RTSP.
      // This avoids assumptions about RTMP port/path mapping and works in both dev and production.
      inputUrl = `rtsp://${config.srt.server}:${config.srt.rtspPort}/${this.streamKey}`;
      inputArgs = ['-rtsp_transport', 'tcp'];
    } else {
      inputUrl = `${config.rtmp.localServer}/${this.streamKey}`;
    }

    const base = [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-i', inputUrl,
      '-c', 'copy',
    ];

    if (dests.length === 1) {
      // Single destination – simple output
      return [...base, '-f', 'flv', dests[0].url];
    }

    // Multiple destinations – use tee muxer (one encode, N pushes)
    const teeTargets = dests.map(d => `[f=flv:onfail=ignore]${d.url}`).join('|');
    return [...base, '-f', 'tee', teeTargets];
  }

  // ── Start (with auto-reconnect) ────────────────────────────────────────────
  start(ingestType = 'rtmp') {
    const args = this._buildArgs(ingestType);
    if (!args) {
      logger.warn(`[Restream:${this.streamKey}] No active destinations – skipping FFmpeg`);
      return false;
    }

    const dests = this._destinations().map(d => d.label).join(', ');
    logger.info(`[Restream:${this.streamKey}] Starting → ${dests} (retry ${this.retries})`);

    this.process = spawn('ffmpeg', args);

    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logger.warn(`[ffmpeg:${this.streamKey}] ${msg}`);
    });

    this.process.on('exit', (code, signal) => {
      logger.info(`[Restream:${this.streamKey}] FFmpeg exited  code=${code} signal=${signal}`);

      // Reconnect on any non-intentional exit (code !== 0  OR  code === 0 with no signal,
      // which can happen when the output side closes the connection cleanly, e.g. Kick
      // drops the stream but FFmpeg sees it as EOF and exits 0).
      const unintentional = this.isActive && signal == null && this.retries < this.maxRetries;
      if (unintentional) {
        this.retries++;
        const delay = Math.min(2000 * this.retries, 30_000);
        logger.info(`[Restream:${this.streamKey}] Reconnect in ${delay}ms (${this.retries}/${this.maxRetries})`);
        setTimeout(() => this.start(ingestType), delay);
      } else {
        this.emit('ended', { streamKey: this.streamKey, code });
      }
    });

    this.process.on('error', (err) => {
      logger.error(`[Restream:${this.streamKey}] Spawn error: ${err.message}`);
      this.emit('error', err);
    });

    return true;
  }

  stop() {
    this.isActive = false;
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 5_000);
    }
  }

  stats() {
    const dests = this._destinations().map(d => d.label).join(', ');
    return {
      streamKey:    this.streamKey,
      username:     this.user.username,
      uptime:       Math.floor((Date.now() - this.startTime) / 1000),
      destinations: dests || 'none',
      retries:      this.retries,
      pid:          this.process?.pid ?? null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
class RestreamManager {
  constructor() {
    /** @type {Map<string, RestreamSession>} */
    this.sessions = new Map();
  }

  /**
   * Start restreaming for a given stream key.
   * @param {string} streamKey
   * @param {object} user  DB row
   * @param {'rtmp'|'srt'} ingestType
   */
  start(streamKey, user, ingestType = 'rtmp') {
    if (this.sessions.has(streamKey)) {
      logger.warn(`[RestreamManager] Key ${streamKey} already active – stopping old session`);
      this.stop(streamKey);
    }

    const session = new RestreamSession(streamKey, user);
    session.on('ended', () => this.sessions.delete(streamKey));
    session.start(ingestType);
    this.sessions.set(streamKey, session);
    return session;
  }

  stop(streamKey) {
    const session = this.sessions.get(streamKey);
    if (session) {
      session.stop();
      this.sessions.delete(streamKey);
      logger.info(`[RestreamManager] Stopped session: ${streamKey}`);
    }
  }

  stopAll() {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    logger.info('[RestreamManager] All sessions stopped');
  }

  getSession(streamKey)  { return this.sessions.get(streamKey); }
  getAllStats()           { return [...this.sessions.values()].map(s => s.stats()); }
  get activeCount()      { return this.sessions.size; }
}

module.exports = new RestreamManager();
