'use strict';

const { randomUUID } = require('crypto');

/**
 * Attach a unique request ID to req.id and expose it in X-Request-Id header.
 * Respects an incoming X-Request-Id header so callers can correlate traces.
 */
const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestId;
