'use strict';

const rateLimit = require('express-rate-limit');
const logger    = require('./logger');

const generalLimiter = rateLimit({
  windowMs:        60_000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler(req, res) {
    logger.warn({ reqId: req.id, ip: req.ip, path: req.path }, 'Rate limit exceeded');
    res.status(429).json({
      ok:    false,
      error: 'Too many requests — please slow down.',
      reqId: req.id,
    });
  },
});

/** Tighter limit for /search because each hit calls Duffel */
const searchLimiter = rateLimit({
  windowMs:        60_000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler(req, res) {
    logger.warn({ reqId: req.id, ip: req.ip }, 'Search rate limit exceeded');
    res.status(429).json({
      ok:    false,
      error: 'Too many search requests — please wait a moment.',
      reqId: req.id,
    });
  },
});

module.exports = { generalLimiter, searchLimiter };
