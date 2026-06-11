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
