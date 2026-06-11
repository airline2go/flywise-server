'use strict';

const logger = require('./logger');

/**
 * Log every request on response finish.
 * Uses error/warn/info based on HTTP status code.
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms    = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'info';
    logger[level]({
      reqId:  req.id,
      method: req.method,
      path:   req.path,
      status: res.statusCode,
      ms,
    }, `${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
};

module.exports = requestLogger;
