'use strict';

const logger    = require('./logger');
const { IS_PROD } = require('./config');

/**
 * Centralized Express error handler.
 * Must have 4 parameters so Express recognises it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const status  = err.status || 500;
  const message = status >= 500 && IS_PROD ? 'Internal server error' : err.message;

  if (status >= 500) {
    logger.error({
      reqId:  req.id,
      method: req.method,
      path:   req.path,
      status,
      err:    { message: err.message, stack: err.stack },
    }, 'Unhandled server error');
  }

  res.status(status).json({
    ok:    false,
    error: message,
    reqId: req.id,
    ...(err.details ? { details: err.details } : {}),
  });
};

module.exports = errorHandler;
