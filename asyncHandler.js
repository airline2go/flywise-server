'use strict';

/**
 * Wraps an async route handler and forwards any rejection to Express's
 * next() so the centralized error handler can process it.
 *
 * @param {Function} fn - async (req, res, next) => {}
 * @returns {Function}
 */
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
