'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const mediamtxConfig = path.join(backendDir, '..', 'configs', 'mediamtx.local-rtmp.yml');

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

function spawnChild(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error(`[dev] Missing binary: ${command}. Is it installed and on PATH?`);
    } else {
      // eslint-disable-next-line no-console
      console.error(`[dev] Failed to start ${command}:`, err);
    }
  });
  return child;
}

(async () => {
  // Prevent crashes when stdin disappears (EIO on macOS).
  try { process.stdin.on('error', () => {}); } catch {}

  const children = [];

  const rtmpAlreadyRunning = await isPortOpen(1935);
  if (!rtmpAlreadyRunning) {
    // eslint-disable-next-line no-console
    console.log(`[dev] Starting MediaMTX RTMP ingest on :1935 using ${mediamtxConfig}`);
    children.push(spawnChild('mediamtx', [mediamtxConfig]));
  } else {
    // eslint-disable-next-line no-console
    console.log('[dev] Port 1935 already in use; skipping MediaMTX start');
  }

  const nodemonBin = path.join(backendDir, 'node_modules', '.bin', 'nodemon');
  // eslint-disable-next-line no-console
  console.log('[dev] Starting SIL API with nodemon on :3000');
  children.push(spawnChild(nodemonBin, ['server.js'], { cwd: backendDir }));

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n[dev] ${signal} received, shutting down...`);
    for (const child of children) {
      if (child && child.pid) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
