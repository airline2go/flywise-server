'use strict';

const { Router }        = require('express');
const asyncHandler      = require('./asyncHandler');
const { searchLimiter } = require('./rateLimiters');
const { searchSchema, validate } = require('./schemas');
const { duffelRequest } = require('./duffelClient');
const { normalizeOffer } = require('./offerNormalizer');

const router = Router();

router.post('/', searchLimiter, asyncHandler(async (req, res) => {
  // Validate and coerce the request body
  const { data, error } = validate(searchSchema, req.body);
  if (error) return res.status(400).json({ ok: false, error, reqId: req.id });

  const { origin, destination, departure_date, return_date, cabin_class,
          adults, children, infants } = data;

  const passengers = [];
  for (let i = 0; i < adults;   i++) passengers.push({ type: 'adult' });
  for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
  for (let i = 0; i < infants;  i++) passengers.push({ type: 'infant_without_seat' });

  const slices = [{ origin, destination, departure_date }];
  if (return_date) {
    slices.push({ origin: destination, destination: origin, departure_date: return_date });
  }

  const result = await duffelRequest(
    'POST', '/air/offer_requests?return_offers=true',
    { data: { slices, passengers, cabin_class } },
    req.id
  );

  const offers = (Array.isArray(result.data?.offers) ? result.data.offers : [])
    .map(normalizeOffer)
    .filter(Boolean);

  res.json({
    ok:               true,
    offer_request_id: result.data?.id || null,
    offers,
    total:            offers.length,
    reqId:            req.id,
  });
}));

module.exports = router;

// ── GET /search/airports?q=berlin ────────────────────────
// Proxy to Duffel airports autocomplete
router.get('/airports', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ ok: true, airports: [] });
  }

  const result = await duffelRequest(
    'GET',
    '/air/airports?query=' + encodeURIComponent(q) + '&suggested=false',
    null,
    req.id
  );

  const airports = (Array.isArray(result.data) ? result.data : [])
    .filter(a => a.iata_code && a.iata_code.length === 3)
    .slice(0, 8)
    .map(a => {
      // Duffel uses municipality for city name
      const city    = a.municipality || a.iata_city_code || a.iata_code;
      const country = a.iata_country_code || '';
      return {
        code:    a.iata_code,
        name:    a.name || a.iata_code,
        city,
        country,
      };
    });

  res.json({ ok: true, airports, reqId: req.id });
}));