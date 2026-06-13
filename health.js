'use strict';

const { Router } = require('express');
const { DUFFEL_TOKEN, ALLOWED_ORIGINS, FETCH_TIMEOUT_MS, PORT } = require('./config');

const router = Router();

router.get('/', (req, res) => {
  res.json({
    ok:              true,
    service:         'FlyWise Duffel Proxy',
    version:         '3.4',
    tokenConfigured: !!DUFFEL_TOKEN,
    reqId:           req.id,
  });
});

router.get('/health', (req, res) => {
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

router.get('/airline-logo/:code', async (req, res) => {
  var code = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || code.length > 4) return res.status(400).send('');
  var url = 'https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/' + code + '.svg';
  try {
    var r = await fetch(url, {
      headers: {
        'Accept': 'image/svg+xml,image/*,*/*'
      }
    });
    if (!r.ok) return res.status(404).send('');
    var buf = await r.arrayBuffer();
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).send('');
  }
});

module.exports = router;
