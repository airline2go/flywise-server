'use strict';

const { Router }         = require('express');
const asyncHandler       = require('./asyncHandler');
const { offerId, validate } = require('./schemas');
const { duffelRequest }  = require('./duffelClient');
const { normalizeOffer } = require('./offerNormalizer');
const { z }              = require('zod');

const router = Router();

router.get('/:id', asyncHandler(async (req, res) => {
  const { data, error } = validate(z.object({ id: offerId }), { id: req.params.id });
  if (error) return res.status(400).json({ ok: false, error, reqId: req.id });

  const result = await duffelRequest(
    'GET', `/air/offers/${data.id}?return_available_services=true`,
    null, req.id
  );

  res.json({
    ok:       true,
    offer:    normalizeOffer(result.data),
    services: Array.isArray(result.data?.available_services)
      ? result.data.available_services : [],
    reqId:    req.id,
  });
}));

module.exports = router;
