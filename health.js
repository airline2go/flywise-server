'use strict';

const { Router }   = require('express');
const { DUFFEL_TOKEN, ALLOWED_ORIGINS, FETCH_TIMEOUT_MS, PORT } = require('./config');

const router = Router();

router.get('/', (req, res) => {
  res.json({
    ok:              true,
    service:         'FlyWise Duffel Proxy',
    version:         '3.4',
    tokenConfigured: true,
    reqId:           req.id,
  });
});

router.get('/health', (req, res) => {
  // Internal config checks only — no external calls
  const checks = {
    token:        !!DUFFEL_TOKEN,
    corsOrigins:  ALLOWED_ORIGINS.length > 0,
    fetchTimeout: FETCH_TIMEOUT_MS > 0,
    port:         PORT > 0,
  };
  const healthy = Object.values(checks).every(Boolean);

  res.status(healthy ? 200 : 503).json({
    ok:        healthy,
    timestamp: new Date().toISOString(),
    checks,
    reqId:     req.id,
  });
});

module.exports = router;
