'use strict';
const jwt    = require('jsonwebtoken');
const config = require('../config');

/** JWT Bearer token middleware */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, config.jwt.secret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Admin x-admin-secret header middleware */
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== config.admin.secret)
    return res.status(401).json({ error: 'Unauthorized – invalid admin secret' });
  next();
}

module.exports = { requireAuth, requireAdmin };
