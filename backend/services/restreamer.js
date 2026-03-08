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
 *   [One FFmpeg per destination – fully isolated]
 *     ├─► YouTube  rtmp://a.rtmp.youtube.com/live2/<key>
 *     ├─► Kick     rtmps://fa723fc1b171.global-contribute.live-video.net:443/app/<key>
 *     └─► Twitch   rtmp://live.twitch.tv/app/<key>
 *
 * Key design decisions:
 *  - One FFmpeg process per destination so a single platform failure never
 *    affects the others (replaces the fragile tee-muxer approach).
 *  - Unlimited retries while the parent session is active; delay caps at 30 s.
 *  - All FFmpeg stderr is logged at WARN so errors are always visible.
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const config = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// DestinationPusher – one FFmpeg process → one platform
// ─────────────────────────────────────────────────────────────────────────────
class DestinationPusher extends EventEmitter {
  /**
   * @param {string} streamKey
   * @param {string} label      e.g. 'Kick', 'Twitch', 'YouTube'
   * @param {string} url        full RTMP(S) ingest URL including stream key
   * @param {string} ingestType 'rtmp' | 'srt'
   */
  constructor(streamKey, label, url, ingestType) {
    super();
    this.streamKey  = streamKey;
    this.label      = label;
    this.url        = url;
    this.ingestType = ingestType;
    this.process    = null;
    this.retries    = 0;
    this.isActive   = true;
    this._retryTimer = null;
  }

  _buildArgs() {
    let inputUrl, inputArgs = [];
    if (this.ingestType === 'srt') {
      inputUrl  = `rtsp://${config.srt.server}:${config.srt.rtspPort}/${this.streamKey}`;
      inputArgs = ['-rtsp_transport', 'tcp'];
    } else {
      inputUrl = `${config.rtmp.localServer}/${this.streamKey}`;
    }

    return [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-i', inputUrl,
      '-c', 'copy',
      '-f', 'flv', this.url,
    ];
  }

  start() {
    if (!this.isActive) return;

    this.retries++;
    logger.info(`[Restream:${this.streamKey}] [${this.label}] Starting (attempt ${this.retries})`);

    this.process = spawn('ffmpeg', this._buildArgs());

    this.process.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logger.warn(`[ffmpeg:${this.label}] ${msg}`);
    });

    this.process.on('exit', (code, signal) => {
      logger.info(`[Restream:${this.streamKey}] [${this.label}] FFmpeg exited code=${code} signal=${signal}`);

      if (!this.isActive || signal != null) {
        // Intentionally stopped – do not reconnect
        this.emit('stopped', { label: this.label, code });
        return;
      }

      // Retry indefinitely while the stream is active; cap delay at 30 s
      const delay = Math.min(2000 * Math.min(this.retries, 10), 30_000);
      logger.info(`[Restream:${this.streamKey}] [${this.label}] Reconnect in ${delay}ms (retry ${this.retries})`);
      this._retryTimer = setTimeout(() => this.start(), delay);
    });

    this.process.on('error', (err) => {
      logger.error(`[Restream:${this.streamKey}] [${this.label}] Spawn error: ${err.message}`);
    });
  }

  stop() {
    this.isActive = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 5_000);
    }
    this.emit('stopped', { label: this.label, code: null });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RestreamSession – one per active stream key, owns N DestinationPushers
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
    this.pushers    = new Map();   // label → DestinationPusher
    this.isActive   = true;
    this.startTime  = Date.now();
    this.ingestType = 'rtmp';
  }

  _getDestinations() {
    const dests = [];
    if (this.user.stream_to_youtube && this.user.youtube_url)
      dests.push({ label: 'YouTube', url: this.user.youtube_url });
    if (this.user.stream_to_kick    && this.user.kick_url)
      dests.push({ label: 'Kick',    url: this.user.kick_url    });
    if (this.user.stream_to_twitch  && this.user.twitch_url)
      dests.push({ label: 'Twitch',  url: this.user.twitch_url  });
    return dests;
  }

  start(ingestType = 'rtmp') {
    this.ingestType = ingestType;
    const dests = this._getDestinations();
    if (dests.length === 0) {
      logger.warn(`[Restream:${this.streamKey}] No active destinations – skipping`);
      return false;
    }

    const labels = dests.map(d => d.label).join(', ');
    logger.info(`[Restream:${this.streamKey}] Session starting → ${labels}`);

    for (const { label, url } of dests) {
      const pusher = new DestinationPusher(this.streamKey, label, url, ingestType);
      this.pushers.set(label, pusher);
      pusher.start();
    }

    return true;
  }

  stop() {
    this.isActive = false;
    for (const pusher of this.pushers.values()) pusher.stop();
    this.pushers.clear();
  }

  stats() {
    const destStats = [...this.pushers.values()].map(p => ({
      label:   p.label,
      retries: p.retries,
      pid:     p.process?.pid ?? null,
      active:  p.isActive,
    }));
    return {
      streamKey:    this.streamKey,
      username:     this.user.username,
      uptime:       Math.floor((Date.now() - this.startTime) / 1000),
      destinations: destStats,
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
