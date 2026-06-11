'use strict';

const { Router }       = require('express');
const asyncHandler     = require('./asyncHandler');
const { orderSchema, cancelSchema, offerId, validate } = require('./schemas');
const { duffelRequest } = require('./duffelClient');
const { z }            = require('zod');

const router = Router();

// ── POST /order ───────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const { data, error } = validate(orderSchema, req.body);
  if (error) return res.status(400).json({ ok: false, error, reqId: req.id });

  const { offer_id, passengers, services, total_amount, currency } = data;

  const orderBody = {
    type:            'instant',
    selected_offers: [offer_id],
    passengers,
    payments: [{
      type:     'balance',
      amount:   String(total_amount),
      currency,
    }],
    ...(services.length > 0 ? { services } : {}),
  };

  const result = await duffelRequest('POST', '/air/orders', { data: orderBody }, req.id);

  res.json({
    ok:                true,
    order_id:          result.data?.id                || null,
    booking_reference: result.data?.booking_reference || null,
    total_amount:      result.data?.total_amount      || null,
    currency:          result.data?.total_currency    || null,
    reqId:             req.id,
  });
}));

// ── GET /order/:id ────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const { data, error } = validate(z.object({ id: offerId }), { id: req.params.id });
  if (error) return res.status(400).json({ ok: false, error, reqId: req.id });

  const result = await duffelRequest('GET', `/air/orders/${data.id}`, null, req.id);
  res.json({ ok: true, order: result.data || null, reqId: req.id });
}));

// ── POST /cancel ──────────────────────────────────────────
router.post('/cancel', asyncHandler(async (req, res) => {
  const { data, error } = validate(cancelSchema, req.body);
  if (error) return res.status(400).json({ ok: false, error, reqId: req.id });

  const cancelReq = await duffelRequest(
    'POST', '/air/order_cancellations',
    { data: { order_id: data.order_id } },
    req.id
  );

  const cancelId = cancelReq.data?.id;
  if (!cancelId) {
    const err  = new Error('Cancellation request returned no ID from Duffel');
    err.status = 502;
    throw err;
  }

  const confirmed = await duffelRequest(
    'POST', `/air/order_cancellations/${cancelId}/actions/confirm`,
    null, req.id
  );

  res.json({
    ok:            true,
    cancelled:     true,
    refund_amount: confirmed.data?.refund_amount || null,
    reqId:         req.id,
  });
}));

module.exports = router;
