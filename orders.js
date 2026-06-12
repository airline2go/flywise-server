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

  // ── Step 1: Re-verify offer is still valid ────────────
  let verifiedOffer;
  try {
    const offerCheck = await duffelRequest('GET', `/air/offers/${offer_id}`, null, req.id);
    verifiedOffer = offerCheck.data;

    // Check if offer has expired
    if (verifiedOffer?.expires_at && new Date(verifiedOffer.expires_at) < new Date()) {
      return res.status(410).json({
        ok: false,
        error: 'Angebot abgelaufen. Bitte erneut suchen.',
        code: 'offer_expired',
        reqId: req.id,
      });
    }

    // Price integrity check — warn if price changed significantly
    const currentPrice = parseFloat(verifiedOffer?.total_amount || 0);
    const requestedPrice = parseFloat(total_amount || 0);
    if (currentPrice > 0 && Math.abs(currentPrice - requestedPrice) > 1) {
      // Price changed — return new price for frontend to confirm
      if (currentPrice > requestedPrice * 1.05) {
        return res.status(409).json({
          ok: false,
          error: `Preis hat sich geändert. Neuer Preis: ${currentPrice} ${verifiedOffer.total_currency}`,
          code: 'price_changed',
          new_price: currentPrice,
          currency: verifiedOffer.total_currency,
          reqId: req.id,
        });
      }
    }
  } catch (verifyErr) {
    // If offer check fails (e.g. network), proceed with booking anyway
    console.warn(`[Order] Offer pre-check failed for ${offer_id}:`, verifyErr.message);
  }

  // ── Step 2: Create order ──────────────────────────────
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
    passengers:        result.data?.passengers?.map(p => ({
      name: p.given_name + ' ' + p.family_name,
      type: p.type,
    })) || [],
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
