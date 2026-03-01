'use strict';
const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs   = require('fs');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const { combine, timestamp, colorize, printf, errors } = format;

const lineFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  let line = `${timestamp} [${level.toUpperCase().padEnd(5)}] ${stack || message}`;
  if (Object.keys(meta).length) line += ' ' + JSON.stringify(meta);
  return line;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), lineFormat),
  transports: [
    new transports.Console({
      format: combine(colorize({ all: true }), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), lineFormat),
    }),
    new transports.File({ filename: path.join(logsDir, 'error.log'),    level: 'error', maxsize: 10_485_760, maxFiles: 5 }),
    new transports.File({ filename: path.join(logsDir, 'combined.log'),              maxsize: 10_485_760, maxFiles: 10 }),
  ],
});

module.exports = logger;
