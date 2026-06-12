'use strict';

const { Router }   = require('express');
const { DUFFEL_TOKEN, ALLOWED_ORIGINS, FETCH_TIMEOUT_MS, PORT } = require('../utils/config');

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

// ── GET /airline-logo/:code ───────────────────
// Proxy airline logo from Duffel CDN (bypasses CORS)
router.get('/airline-logo/:code', async (req, res) => {
  var code = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code || code.length > 4) {
    return res.status(400).json({ ok: false, error: 'Invalid airline code' });
  }

  var url = 'https://assets.duffel.com/img/airlines/for-light-background/full-color-logo/' + code + '.svg';

  try {
    var r = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + process.env.DUFFEL_TOKEN,
        'Duffel-Version': 'v2',
        'Accept': 'image/svg+xml,image/*,*/*'
      }
    });

    if (!r.ok) {
      return res.status(404).send('');
    }

    var buffer = await r.arrayBuffer();
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400'); // cache 24h
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));

  } catch (err) {
    res.status(500).send('');
  }
});
