/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        FlyWise — Render.com Server (Duffel Proxy)       ║
 * ║                     Node.js / Express                   ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * طريقة الرفع على Render.com:
 * ────────────────────────────
 * 1. اذهب لـ github.com وأنشئ Repo جديد اسمه flywise-server
 * 2. ارفع هذا الملف (server.js) وملف package.json
 * 3. اذهب لـ render.com → New → Web Service
 * 4. اربطه بالـ Repo
 * 5. في Environment Variables أضف:
 *      DUFFEL_TOKEN = duffel_test_...
 * 6. اضغط Deploy
 * 7. انسخ الـ URL وضعه في FlyWise_v3.html في PROXY_URL
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const DUFFEL_TOKEN = process.env.DUFFEL_TOKEN;
const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';

// ─── Stripe ───────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ─── Supabase (persistent storage) ────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supa = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (e) {
    console.error('Supabase init failed:', e.message);
  }
}

// Pending bookings, keyed by Stripe session id. Stored in Supabase so they
// survive restarts and work across instances; falls back to in-memory if
// Supabase isn't configured.
const pendingBookings = new Map(); // fallback / cache
async function rememberBooking(sessionId, payload) {
  pendingBookings.set(sessionId, { payload, at: Date.now() });
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of pendingBookings) { if (v.at < cutoff) pendingBookings.delete(k); }
  if (supa) {
    try {
      await supa.from('pending_bookings').upsert({
        session_id: sessionId, payload, status: 'pending',
      }, { onConflict: 'session_id' });
    } catch (e) { log('error', 'supa_pending_upsert_failed', { error: e.message }); }
  }
}
async function getPendingBooking(sessionId) {
  if (supa) {
    try {
      const { data } = await supa.from('pending_bookings').select('*').eq('session_id', sessionId).maybeSingle();
      if (data) {
        return {
          payload: data.payload,
          duffel_order_id: data.duffel_order_id || '',
          duffel_ref: data.duffel_ref || '',
        };
      }
    } catch (e) { log('error', 'supa_pending_get_failed', { error: e.message }); }
  }
  return pendingBookings.get(sessionId) || null;
}
async function markPendingBooked(sessionId, orderId, ref) {
  const entry = pendingBookings.get(sessionId);
  if (entry) { entry.duffel_order_id = orderId; entry.duffel_ref = ref; pendingBookings.set(sessionId, entry); }
  if (supa) {
    try {
      await supa.from('pending_bookings').update({
        status: 'booked', duffel_order_id: orderId, duffel_ref: ref,
      }).eq('session_id', sessionId);
    } catch (e) { log('error', 'supa_pending_update_failed', { error: e.message }); }
  }
}

// ─── [#4] Booking status store (pending → paid → booked / failed) ─────────
// Lets the frontend recover a booking after a refresh/closed browser via
// GET /booking-status/:sessionId. (Swap for a DB/Redis in production.)
const bookingStatus = new Map();
function setBookingStatus(sessionId, status, extra) {
  if (!sessionId) return;
  bookingStatus.set(sessionId, Object.assign({ status, at: Date.now() }, extra || {}));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of bookingStatus) { if (v.at < cutoff) bookingStatus.delete(k); }
}

// ─── [#7] Structured logging (no external deps) ───────────────────────────
function log(level, msg, meta) {
  try {
    console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), level, msg }, meta || {})));
  } catch (e) {
    console.log(level, msg);
  }
}

// ─── [#12] Environment validation (fail fast on missing critical vars) ────
(function validateEnv() {
  const missing = [];
  if (!DUFFEL_TOKEN) missing.push('DUFFEL_TOKEN');
  if (missing.length) {
    log('fatal', 'Missing required environment variables', { missing });
    console.error('❌ FATAL: Missing required env vars: ' + missing.join(', '));
    process.exit(1);
  }
  if (!STRIPE_SECRET_KEY) log('warn', 'STRIPE_SECRET_KEY not set — payments disabled');
  if (STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) log('warn', 'STRIPE_WEBHOOK_SECRET not set — webhook fallback disabled');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) log('warn', 'Supabase not set — using in-memory fallback');
  log('info', 'Environment validated', {
    duffel: !!DUFFEL_TOKEN, stripe: !!STRIPE_SECRET_KEY, supabase: !!supa,
    webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    tokenType: (DUFFEL_TOKEN || '').indexOf('live') !== -1 ? 'live' : 'test',
  });
})();

// ─── [#9] Simple in-memory rate limiter (per IP + bucket, no external deps) ─
const rlStore = new Map();
function rateLimit(bucket, max, windowMs) {
  return function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const key = bucket + ':' + ip;
    const now = Date.now();
    let e = rlStore.get(key);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; rlStore.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      log('warn', 'rate_limited', { bucket, ip });
      return res.status(429).json({ ok: false, error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
    }
    next();
  };
}
// periodic cleanup of expired rate-limit buckets
var _rlCleanup = setInterval(function () {
  const now = Date.now();
  for (const [k, v] of rlStore) { if (now > v.reset) rlStore.delete(k); }
}, 60000);
if (_rlCleanup.unref) _rlCleanup.unref();

// ─── Middleware ───────────────────────────────────────────

// [#3] Stripe webhook — MUST be registered BEFORE express.json so we get the
// raw body needed for signature verification. Stripe calls this directly, so
// the booking completes even if the customer's browser closed after paying.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    log('error', 'webhook_not_configured', {});
    return res.status(500).send('webhook not configured');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    log('warn', 'webhook_signature_invalid', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge immediately so Stripe doesn't retry while we work
  res.json({ received: true });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        if (inFlight.has(session.id)) return; // /confirm-payment is already handling it
        inFlight.add(session.id);
        try {
          const out = await bookFromSession(session.id, session);
          log('info', 'webhook_booking_done', { session: session.id, order_id: out.order_id, already: out.already });
        } finally {
          inFlight.delete(session.id);
        }
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      log('warn', 'webhook_payment_failed', { payment_intent: pi.id });
    }
  } catch (err) {
    // Booking failed after a paid webhook → log loudly for support follow-up
    log('error', 'webhook_booking_failed', { type: event.type, message: err.message, duffel_errors: err.details });
    console.error('[WEBHOOK BOOKING FAILED] ' + (err.message || '') + ' | ' + JSON.stringify(err.details || {}));
  }
});

app.use(express.json({ limit: '256kb' }));

// [#23] gzip compression for JSON responses (no external deps, uses zlib).
// Wraps res.json so large payloads (search results) transfer much smaller.
const zlib = require('zlib');
app.use((req, res, next) => {
  const accepts = (req.headers['accept-encoding'] || '');
  if (accepts.indexOf('gzip') === -1) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const str = JSON.stringify(body);
      // only worth compressing larger bodies
      if (str.length < 1024) { res.setHeader('Content-Type', 'application/json'); return res.send(str); }
      const buf = zlib.gzipSync(str);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      return res.end(buf);
    } catch (e) {
      return origJson(body);
    }
  };
  next();
});

// [#13] Security headers (helmet-lite, no external deps)
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('X-XSS-Protection', '1; mode=block');
  res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.header('X-DNS-Prefetch-Control', 'off');
  res.header('Cross-Origin-Opener-Policy', 'same-origin');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  // API returns JSON only — lock down what this origin may load/execute
  res.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.removeHeader && res.removeHeader('X-Powered-By');
  // [#23] never cache sensitive payment/booking/order endpoints
  if (/^\/(confirm-payment|create-checkout-session|order|cancel|booking-status)/.test(req.path)) {
    res.header('Cache-Control', 'no-store');
  }
  next();
});

// [#7] Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log('req', req.method + ' ' + req.path, { status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// [#13] Input sanitization — strip control chars / null bytes and cap string
// length recursively on the JSON body. Defends against injection & abuse.
function sanitizeValue(v, depth) {
  if (depth > 6) return v;
  if (typeof v === 'string') {
    // remove null bytes + non-printable control chars, trim, cap length
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 2000);
  }
  if (Array.isArray(v)) {
    if (v.length > 100) v = v.slice(0, 100);
    return v.map((x) => sanitizeValue(x, depth + 1));
  }
  if (v && typeof v === 'object') {
    const out = {};
    let n = 0;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (n++ > 100) break;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue; // proto-pollution guard
      out[k] = sanitizeValue(v[k], depth + 1);
    }
    return out;
  }
  return v;
}
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    try { req.body = sanitizeValue(req.body, 0); } catch (e) {}
  }
  next();
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Duffel Helper ────────────────────────────────────────
async function duffel(method, path, body = null, extraHeaders = null) {
  if (!DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN غير موجود في Environment Variables');

  const opts = {
    method,
    headers: Object.assign({
      Authorization: `Bearer ${DUFFEL_TOKEN}`,
      'Content-Type': 'application/json',
      'Duffel-Version': DUFFEL_VERSION,
      Accept: 'application/json',
    }, extraHeaders || {}),
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${DUFFEL_BASE}${path}`, opts);
  const json = await res.json();

  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || 'Duffel API Error';
    const err = new Error(msg);
    err.status = res.status;
    err.details = json?.errors;
    throw err;
  }
  return json;
}

// ─── Health Check / Status ────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'Airpiv Server',
    version: '3.0',
    tokenConfigured: !!DUFFEL_TOKEN,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
  });
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    service: 'Airpiv Server',
    tokenConfigured: !!DUFFEL_TOKEN,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ─── POST /search ─────────────────────────────────────────
// ─── GET /debug/raw ───────────────────────────────────────
// Diagnostic: returns the RAW first offer from Duffel (no normalization)
// so you can see exactly which fields the airline actually sends.
// Usage: /debug/raw?origin=BER&destination=ORD&departure_date=2026-06-25
app.get('/debug/raw', async (req, res) => {
  try {
    const { origin, destination, departure_date, cabin_class = 'economy' } = req.query;
    if (!origin || !destination || !departure_date) {
      return res.status(400).json({ ok: false, error: 'use ?origin=BER&destination=ORD&departure_date=2026-06-25' });
    }
    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin, destination, departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class
      },
    });
    const offers = result.data?.offers || [];
    // Return the first 3 offers raw, plus a focused summary of the fare-related fields
    const summary = offers.slice(0, 5).map(o => {
      const seg0 = o.slices?.[0]?.segments?.[0];
      const pax0 = seg0?.passengers?.[0];
      return {
        total_amount: o.total_amount,
        fare_brand_name: o.fare_brand_name || null,
        slice_fare_brand: o.slices?.[0]?.fare_brand_name || null,
        seg_cabin_class: pax0?.cabin_class || null,
        seg_cabin_marketing: pax0?.cabin_class_marketing_name || null,
        cabin_amenities: pax0?.cabin?.amenities || null,
        conditions: o.conditions || null,
      };
    });
    res.json({
      ok: true,
      total_offers: offers.length,
      fare_summary: summary,
      first_offer_raw: offers[0] || null
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

app.post('/search', rateLimit('search', 30, 60000), async (req, res) => {
  try {
    const {
      origin, destination, departure_date,
      return_date, cabin_class = 'economy',
      adults = 1, children = 0, infants = 0,
      slices: bodySlices,
    } = req.body;

    const passengers = [];
    for (let i = 0; i < adults; i++) passengers.push({ type: 'adult' });
    for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
    for (let i = 0; i < infants; i++) passengers.push({ type: 'infant_without_seat' });

    // Build slices: either multi-city (slices provided) or simple one-way/return
    let slices;
    if (Array.isArray(bodySlices) && bodySlices.length) {
      // Multi-city: accept the slices the client built, keep only valid legs
      slices = bodySlices
        .filter((s) => s && s.origin && s.destination && s.departure_date)
        .map((s) => ({ origin: s.origin, destination: s.destination, departure_date: s.departure_date }));
      if (!slices.length) {
        return res.status(400).json({ ok: false, error: 'slices غير صالحة (origin/destination/departure_date مطلوبة لكل مقطع)' });
      }
    } else {
      if (!origin || !destination || !departure_date) {
        return res.status(400).json({ ok: false, error: 'origin, destination, departure_date مطلوبة' });
      }
      slices = [{ origin, destination, departure_date }];
      if (return_date) slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: { slices, passengers, cabin_class },
    });

    const offers = (result.data?.offers || []).map(normalizeOffer);

    res.json({ ok: true, offer_request_id: result.data?.id, offers, total: offers.length });

  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── GET /offer/:id ───────────────────────────────────────
app.get('/offer/:id', async (req, res) => {
  try {
    const result = await duffel('GET', `/air/offers/${req.params.id}?return_available_services=true`);
    const raw = result.data?.available_services || [];
    res.json({
      ok: true,
      offer: normalizeOffer(result.data),
      services: raw,                          // raw passthrough (compat)
      baggageServices: normalizeBaggageServices(raw)  // clean baggage list
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Turn Duffel available_services into a clean baggage list (real data only)
function normalizeBaggageServices(services) {
  if (!Array.isArray(services)) return [];
  return services
    .filter(s => s.type === 'baggage')
    .map(s => {
      const md = s.metadata || {};
      return {
        id: s.id,
        price: parseFloat(s.total_amount || 0),
        currency: s.total_currency || 'EUR',
        bagType: md.type || null,                 // e.g. "checked" | "carry_on"
        maxWeightKg: (md.maximum_weight_kg != null) ? Number(md.maximum_weight_kg) : null,
        maxQuantity: (s.maximum_quantity != null) ? Number(s.maximum_quantity) : null,
        segmentIds: s.segment_ids || [],
        passengerIds: s.passenger_ids || []
      };
    })
    // cheapest first
    .sort((a, b) => a.price - b.price);
}

// ─── POST /seatmaps ───────────────────────────────────────
// Body: { offer_id }. Returns one normalized seat map per segment.
app.post('/seatmaps', async (req, res) => {
  try {
    const { offer_id } = req.body;
    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id required' });
    const result = await duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offer_id)}`);
    const maps = Array.isArray(result.data) ? result.data : [];
    res.json({ ok: true, seatMaps: maps.map(normalizeSeatMap) });
  } catch (err) {
    // Seat maps not supported for this airline/flight -> return empty, not an error
    res.json({ ok: true, seatMaps: [], note: err.message });
  }
});

// Normalize one Duffel seat map (per segment) into a compact render-ready shape.
function normalizeSeatMap(sm) {
  if (!sm) return null;
  const cabins = (sm.cabins || []).map(cabin => {
    const rows = (cabin.rows || []).map(row => {
      const sections = (row.sections || []).map(section => {
        const elements = (section.elements || []).map(el => {
          if (el.type === 'seat') {
            // a seat is bookable only if it has available_services
            const svcs = el.available_services || [];
            const svc = svcs[0] || null;
            return {
              type: 'seat',
              designator: el.designator || null,
              available: svcs.length > 0,
              serviceId: svc ? svc.id : null,
              price: svc ? parseFloat(svc.total_amount || 0) : null,
              currency: svc ? (svc.total_currency || 'EUR') : null,
              disclosures: el.disclosures || []
            };
          }
          // non-seat elements: empty, exit_row, bassinet, lavatory, galley, etc.
          return { type: el.type };
        });
        return { elements };
      });
      return { sections };
    });
    return {
      cabinClass: cabin.cabin_class || null,
      deck: cabin.deck != null ? cabin.deck : 0,
      wingsStart: cabin.wings ? cabin.wings.first_row_index : null,
      wingsEnd: cabin.wings ? cabin.wings.last_row_index : null,
      rows
    };
  });
  return {
    segmentId: sm.segment_id || null,
    sliceId: sm.slice_id || null,
    cabins
  };
}

// ─── POST /create-checkout-session ────────────────────────
// Creates a Stripe Checkout Session. The actual flight booking happens
// ONLY after Stripe confirms the payment (see /confirm-payment).
app.post('/create-checkout-session', rateLimit('pay', 15, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });

    const {
      offer_id, passengers, services = [],
      duffel_amount, customer_amount, currency = 'EUR',
      route_label, success_url, cancel_url,
    } = req.body;

    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });
    if (!passengers?.length) return res.status(400).json({ ok: false, error: 'بيانات المسافرين مطلوبة' });
    if (!customer_amount || Number(customer_amount) <= 0) return res.status(400).json({ ok: false, error: 'Betrag ungültig' });

    // Stripe wants the amount in the smallest currency unit (cents)
    const amountCents = Math.round(Number(customer_amount) * 100);

    // Store booking payload server-side, keyed by session id. Only a small
    // marker goes into Stripe metadata.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: route_label ? ('Flug ' + route_label) : 'Flugbuchung (FlyWise)' },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { flywise: '1' },
    });

    await rememberBooking(session.id, {
      offer_id,
      passengers,
      services,
      duffel_amount: String(duffel_amount),
      currency,
    });
    setBookingStatus(session.id, 'pending');
    log('info', 'checkout_created', { session: session.id, amount: String(duffel_amount) });

    res.json({ ok: true, session_id: session.id, url: session.url });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ─── [#4] GET /booking-status/:sessionId ──────────────────
// Lets the frontend recover state after a refresh / reopened browser.
app.get('/booking-status/:sessionId', (req, res) => {
  const s = bookingStatus.get(req.params.sessionId);
  if (!s) return res.json({ ok: true, status: 'unknown' });
  res.json({ ok: true, status: s.status, order_id: s.order_id || null, booking_reference: s.booking_reference || null });
});

// ─── [#18] Price Alerts (saved_trips) ─────────────────────
// Users save a route + target price; a scheduled job (later) checks prices
// and emails them. For now we provide full CRUD + a live price check.

// Save a route to watch
app.post('/alerts', rateLimit('alerts', 20, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { user_id, origin, destination, departure_date, target_price } = req.body;
    if (!user_id || !origin || !destination) return res.status(400).json({ ok: false, error: 'user_id, origin, destination مطلوبة' });
    const { data, error } = await supa.from('saved_trips').insert({
      user_id, origin, destination,
      departure_date: departure_date || null,
      target_price: target_price ? Number(target_price) : null,
      active: true,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    log('info', 'alert_created', { user_id, origin, destination });
    res.json({ ok: true, alert: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List a user's saved routes
app.get('/alerts/:userId', rateLimit('alerts', 60, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('saved_trips')
      .select('*').eq('user_id', req.params.userId).eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, alerts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delete / deactivate a saved route
app.post('/alerts/:id/delete', rateLimit('alerts', 30, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ ok: false, error: 'user_id مطلوب' });
    const { error } = await supa.from('saved_trips').delete()
      .eq('id', req.params.id).eq('user_id', user_id);
    if (error) throw new Error(error.message);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live cheapest-price check for a saved route (also updates last_price)
app.post('/alerts/:id/check', rateLimit('alerts', 20, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: trip, error } = await supa.from('saved_trips').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!trip) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });

    const offerReq = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin: trip.origin, destination: trip.destination, departure_date: trip.departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    });
    const offers = (offerReq.data && offerReq.data.offers) || [];
    let cheapest = null;
    offers.forEach((o) => { const p = parseFloat(o.total_amount); if (cheapest === null || p < cheapest) cheapest = p; });

    if (cheapest !== null) {
      supa.from('saved_trips').update({ last_price: cheapest }).eq('id', trip.id).then(function(){}, function(){});
    }
    const hitTarget = (trip.target_price && cheapest !== null) ? cheapest <= Number(trip.target_price) : false;
    res.json({ ok: true, cheapest_price: cheapest, currency: 'EUR', target_price: trip.target_price, target_reached: hitTarget });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── Helper: attach Duffel passenger ids ──────────────────
// Duffel's /air/orders requires every passenger to carry the `id` that came
// from the original offer. The frontend doesn't know these ids, so we fetch
// the offer and map them by passenger type (adult/child/infant), in order.
async function attachPassengerIds(offerId, passengers) {
  const offerRes = await duffel('GET', `/air/offers/${offerId}`);
  const offerPax = (offerRes.data && offerRes.data.passengers ? offerRes.data.passengers : []).slice();
  const mapped = (passengers || []).map((p) => {
    let idx = offerPax.findIndex((op) => op && op.type === p.type);
    if (idx === -1) idx = offerPax.findIndex((op) => !!op); // fallback: any remaining
    let id = null;
    if (idx !== -1) { id = offerPax[idx].id; offerPax[idx] = null; }
    return id ? Object.assign({}, p, { id }) : Object.assign({}, p);
  });
  // Duffel rule: every infant (infant_without_seat) must be assigned to a UNIQUE
  // responsible adult via infant_passenger_id, otherwise the order is rejected.
  const adults = mapped.filter((p) => p.type === 'adult');
  const infants = mapped.filter((p) => p.type === 'infant_without_seat');
  for (let i = 0; i < infants.length && i < adults.length; i++) {
    if (infants[i].id) adults[i].infant_passenger_id = infants[i].id;
  }
  return mapped;
}

// ─── Helper: validate baggage/seat services against the live offer ────────
// Duffel rejects an order if a service id isn't actually available for it
// (e.g. expired offer, wrong segment). To avoid "paid but booking failed",
// we drop any service the current offer no longer offers, and clamp quantity.
async function validateServices(offerId, services) {
  if (!Array.isArray(services) || !services.length) return [];
  let available = [];
  try {
    const r = await duffel('GET', `/air/offers/${offerId}?return_available_services=true`);
    available = (r.data && r.data.available_services) || [];
  } catch (e) {
    log('warn', 'validateServices_fetch_failed', { error: e.message });
    return services; // fall through; Duffel will be the final judge
  }
  const byId = new Map(available.map((s) => [s.id, s]));
  const clean = [];
  for (const svc of services) {
    const av = byId.get(svc.id);
    if (!av) { log('warn', 'service_dropped_unavailable', { id: svc.id }); continue; }
    const maxQ = (av.maximum_quantity != null) ? Number(av.maximum_quantity) : 1;
    clean.push({ id: svc.id, quantity: Math.max(1, Math.min(Number(svc.quantity) || 1, maxQ)) });
  }
  return clean;
}
// session from both booking (double-click / double-tab race). ───────────
const inFlight = new Set();

// ─── POST /confirm-payment ────────────────────────────────
// Verifies the Stripe payment succeeded, THEN books the flight with Duffel.
// This ordering guarantees we never ticket without a confirmed payment.
// ─── Shared booking logic (used by /confirm-payment AND the Stripe webhook) ──
// Books the flight for a paid session, idempotently. Returns a result object.
// Throws on a real booking failure so callers can mark status + log.
async function bookFromSession(session_id, session) {
  // 2) Recover the booking payload stored at session creation
  const entry = await getPendingBooking(session_id);
  if (!entry) { const e = new Error('Buchungsdaten nicht gefunden oder abgelaufen'); e.code = 'NO_ENTRY'; throw e; }

  // 3) Idempotency — already booked for this session
  if (entry.duffel_order_id) {
    return { already: true, order_id: entry.duffel_order_id, booking_reference: entry.duffel_ref || null };
  }

  setBookingStatus(session_id, 'paid');
  const booking = entry.payload;

  // 4) Book with Duffel (attach passenger ids + drop unavailable services)
  const paxWithIds = await attachPassengerIds(booking.offer_id, booking.passengers);
  const safeServices = await validateServices(booking.offer_id, booking.services || []);
  const result = await duffel('POST', '/air/orders', {
    data: {
      type: 'instant',
      selected_offers: [booking.offer_id],
      passengers: paxWithIds,
      payments: [{ type: 'balance', amount: String(booking.duffel_amount), currency: booking.currency || 'EUR' }],
      ...(safeServices.length > 0 ? { services: safeServices } : {}),
    },
  }, { 'Idempotency-Key': 'order_' + session_id });

  const orderId = result.data?.id;
  const bookingRef = result.data?.booking_reference;

  // 5) Mark booked so retries/refresh can't double-book
  await markPendingBooked(session_id, orderId || '', bookingRef || '');
  setBookingStatus(session_id, 'booked', { order_id: orderId, booking_reference: bookingRef });
  log('info', 'booking_confirmed', { order_id: orderId, ref: bookingRef });

  // 6) Persist a payment record (best-effort)
  if (supa) {
    supa.from('payments').insert({
      stripe_session_id: session_id,
      stripe_payment_id: (session && session.payment_intent) || null,
      amount: booking.duffel_amount ? Number(booking.duffel_amount) : null,
      currency: booking.currency || 'EUR',
      status: 'paid',
    }).then(function(){}, function(e){ log('error', 'supa_payment_insert_failed', { error: e.message }); });
  }

  return {
    already: false,
    order_id: orderId,
    booking_reference: bookingRef,
    total_amount: result.data?.total_amount,
    currency: result.data?.total_currency,
  };
}

app.post('/confirm-payment', rateLimit('pay', 20, 60000), async (req, res) => {
  const _sid = req.body && req.body.session_id;
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, error: 'session_id مطلوب' });

    // [#14] Reject a second concurrent attempt while the first is still booking
    if (inFlight.has(session_id)) {
      return res.status(409).json({ ok: false, error: 'Buchung wird bereits verarbeitet', processing: true });
    }
    inFlight.add(session_id);

    // 1) Retrieve the session and verify payment really succeeded
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      inFlight.delete(session_id);
      return res.status(402).json({ ok: false, error: 'Zahlung nicht bestätigt', payment_status: session ? session.payment_status : 'unknown' });
    }

    const out = await bookFromSession(session_id, session);
    inFlight.delete(session_id);
    if (out.already) return res.json({ ok: true, already: true, order_id: out.order_id, booking_reference: out.booking_reference });
    res.json({ ok: true, order_id: out.order_id, booking_reference: out.booking_reference, total_amount: out.total_amount, currency: out.currency });
  } catch (err) {
    inFlight.delete(_sid);
    if (err.code === 'NO_ENTRY') return res.status(400).json({ ok: false, error: err.message });
    // Payment succeeded but booking failed → surface clearly so support can refund/retry
    setBookingStatus(req.body && req.body.session_id, 'failed', { error: err.message });
    log('error', 'booking_failed_after_payment', { message: err.message, status: err.status, duffel_errors: err.details });
    console.error('[BOOKING FAILED AFTER PAYMENT] message=' + (err.message || '') +
      ' | status=' + (err.status || '') +
      ' | duffel_errors=' + JSON.stringify(err.details || {}));
    res.status(err.status || 500).json({
      ok: false,
      error: err.message,
      details: err.details,
      duffel_errors: err.details,
      booking_failed_after_payment: true,
    });
  }
});

// ─── POST /order ──────────────────────────────────────────
app.post('/order', rateLimit('order', 15, 60000), async (req, res) => {
  try {
    const { offer_id, passengers, services = [], total_amount, currency = 'EUR' } = req.body;

    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });
    if (!passengers?.length) return res.status(400).json({ ok: false, error: 'بيانات المسافرين مطلوبة' });

    const paxWithIds = await attachPassengerIds(offer_id, passengers);
    const result = await duffel('POST', '/air/orders', {
      data: {
        type: 'instant',
        selected_offers: [offer_id],
        passengers: paxWithIds,
        payments: [{ type: 'balance', amount: String(total_amount), currency }],
        ...(services.length > 0 ? { services } : {}),
      },
    });

    res.json({
      ok: true,
      order_id: result.data?.id,
      booking_reference: result.data?.booking_reference,
      total_amount: result.data?.total_amount,
      currency: result.data?.total_currency,
    });

  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── GET /order/:id ───────────────────────────────────────
app.get('/order/:id', async (req, res) => {
  try {
    const result = await duffel('GET', `/air/orders/${req.params.id}`);
    res.json({ ok: true, order: result.data });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /cancel ─────────────────────────────────────────
app.post('/cancel', rateLimit('cancel', 10, 60000), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });

    const cancelReq = await duffel('POST', '/air/order_cancellations', { data: { order_id } });
    const confirmed = await duffel('POST', `/air/order_cancellations/${cancelReq.data?.id}/actions/confirm`, {});

    res.json({ ok: true, cancelled: true, refund_amount: confirmed.data?.refund_amount });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /cancel-quote ───────────────────────────────────
// Duffel step 1: create a pending cancellation → returns the REAL refund amount
// and conditions for this order, WITHOUT actually cancelling yet.
app.post('/cancel-quote', async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });
    const cancelReq = await duffel('POST', '/air/order_cancellations', { data: { order_id } });
    const d = cancelReq.data || {};
    res.json({
      ok: true,
      cancellation_id: d.id,
      refund_amount: d.refund_amount,
      refund_currency: d.refund_currency,
      expires_at: d.expires_at,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── POST /cancel-confirm ─────────────────────────────────
// Duffel step 2: confirm the pending cancellation (executes refund).
app.post('/cancel-confirm', async (req, res) => {
  try {
    const { cancellation_id } = req.body;
    if (!cancellation_id) return res.status(400).json({ ok: false, error: 'cancellation_id مطلوب' });
    const confirmed = await duffel('POST', `/air/order_cancellations/${cancellation_id}/actions/confirm`, {});
    res.json({ ok: true, cancelled: true, refund_amount: confirmed.data?.refund_amount });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── GET /search/airports?q=... (بحث المدن/المطارات الحي من Duffel) ──
const _apCache = new Map(); // كاش 5 دقائق لتخفيف الطلبات على Duffel
app.get('/search/airports', rateLimit('airports', 60, 60000), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json({ ok: true, airports: [] });

    const key = q.toLowerCase();
    const hit = _apCache.get(key);
    if (hit && (Date.now() - hit.t) < 300000) {
      return res.json({ ok: true, airports: hit.data });
    }

    const result = await duffel('GET', '/places/suggestions?query=' + encodeURIComponent(q));

    const out = [];
    const seen = new Set();
    const push = (o) => { if (o.code && !seen.has(o.code)) { seen.add(o.code); out.push(o); } };
    (result.data || []).forEach((p) => {
      if (p.type === 'city') {
        push({ type: 'city', code: p.iata_code, name: p.name, city: p.name, country: p.iata_country_code });
        (p.airports || []).forEach((ap) => push({
          type: 'airport', code: ap.iata_code, name: ap.name,
          city: ap.city_name || p.name, country: ap.iata_country_code || p.iata_country_code,
        }));
      } else {
        push({
          type: 'airport', code: p.iata_code, name: p.name,
          city: p.city_name || (p.city && p.city.name) || p.name, country: p.iata_country_code,
        });
      }
    });

    _apCache.set(key, { t: Date.now(), data: out });
    res.set('Cache-Control', 'public, max-age=3600'); // المتصفح يخزّن نتائج المطارات ساعة
    res.json({ ok: true, airports: out });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, airports: [] });
  }
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ FlyWise Server running on port ${PORT}`));

// ─── Normalize Offer ──────────────────────────────────────
function normalizeOffer(offer) {
  if (!offer) return null;
  const slices = offer.slices || [];
  const outbound = slices[0];
  const inbound = slices[1] || null;

  function normSlice(sl) {
    if (!sl) return null;
    const segs = sl.segments || [];
    return {
      orig: sl.origin?.iata_code || segs[0]?.origin?.iata_code,
      dest: sl.destination?.iata_code || segs[segs.length - 1]?.destination?.iata_code,
      dep: segs[0]?.departing_at,
      arr: segs[segs.length - 1]?.arriving_at,
      dur: isoToMin(sl.duration),
      stops: segs.length - 1,
      segs: segs.map(s => ({
        from: s.origin?.iata_code,
        to: s.destination?.iata_code,
        dep: s.departing_at,
        arr: s.arriving_at,
        dur: isoToMin(s.duration),
        fn: s.marketing_carrier_flight_number,
        al: [s.marketing_carrier?.iata_code || 'XX', s.marketing_carrier?.name || 'Unknown'],
      })),
    };
  }

  // Baggages live on the segment's passenger entry (Duffel puts them there),
  // with a fallback to the offer-level passenger if present.
  const segPaxBags = outbound?.segments?.[0]?.passengers?.[0]?.baggages;
  const bags = (Array.isArray(segPaxBags) && segPaxBags.length)
    ? segPaxBags
    : (offer.passengers?.[0]?.baggages || []);
  const al0 = outbound?.segments?.[0];

  // ── Real fare/brand data from Duffel (only what the airline actually sends) ──
  // Fare info lives on each segment's passenger entry. We read it from the
  // first segment of the outbound slice for the first passenger.
  const firstSegPax = outbound?.segments?.[0]?.passengers?.[0] || null;
  const cabin = firstSegPax?.cabin || null;

  // fare_brand_name can appear at offer level, slice level, or on the segment passenger.
  // Duffel commonly puts it on the SLICE, so check there too.
  const fareBrand = offer.fare_brand_name
    || outbound?.fare_brand_name
    || firstSegPax?.fare_brand_name
    || null;

  const cabinMarketingName = firstSegPax?.cabin_class_marketing_name
    || cabin?.marketing_name
    || null;

  const cabinClass = firstSegPax?.cabin_class || cabin?.name || null;

  // Amenities (wifi / seat / power) — only if the airline provides them
  let amenities = null;
  if (cabin?.amenities) {
    amenities = {};
    const am = cabin.amenities;
    if (am.wifi) amenities.wifi = { available: am.wifi.available === true || am.wifi.available === 'true', cost: am.wifi.cost || null };
    if (am.power) amenities.power = { available: am.power.available === true || am.power.available === 'true' };
    if (am.seat) amenities.seat = { type: am.seat.type || null, pitch: am.seat.pitch || null, legroom: am.seat.legroom || null };
    if (Object.keys(amenities).length === 0) amenities = null;
  }

  // Per-passenger baggage detail (counts) — real numbers only
  const cabinBag = bags.find(b => b.type === 'carry_on');
  const checkedBag = bags.find(b => b.type === 'checked');
  // Included-baggage weight, if the airline provides it (null otherwise)
  function bagWeight(bag) {
    if (!bag) return null;
    if (bag.weight != null) return Number(bag.weight);
    if (bag.maximum_weight_kg != null) return Number(bag.maximum_weight_kg);
    return null;
  }

  return {
    id: offer.id,
    isDuffel: true,
    raw_offer_id: offer.id,
    al: [al0?.marketing_carrier?.iata_code || 'XX', al0?.marketing_carrier?.name || 'Unknown'],
    price: parseFloat(offer.total_amount || 0),
    currency: offer.total_currency || 'EUR',
    hasCabin: bags.some(b => b.type === 'carry_on' && b.quantity > 0),
    hasChecked: bags.some(b => b.type === 'checked' && b.quantity > 0),
    cabinBagQty: cabinBag ? cabinBag.quantity : null,
    checkedBagQty: checkedBag ? checkedBag.quantity : null,
    cabinBagWeightKg: bagWeight(cabinBag),
    checkedBagWeightKg: bagWeight(checkedBag),
    co2: (offer.total_emissions_kg != null) ? Math.round(Number(offer.total_emissions_kg)) : Math.round(parseFloat(offer.total_amount || 0) * 1.1),
    outbound: normSlice(outbound),
    inbound: normSlice(inbound),
    expires_at: offer.expires_at,
    conditions: offer.conditions || {},
    // ── Real fare brand data (null when the airline doesn't provide it) ──
    fare_brand_name: fareBrand,
    cabin_marketing_name: cabinMarketingName,
    cabin_class: cabinClass,
    amenities: amenities,
    // Hold price/space: airline lets you book without instant payment
    holdSpace: offer.payment_requirements ? (offer.payment_requirements.requires_instant_payment === false) : false,
    priceGuaranteeExpiresAt: offer.payment_requirements?.price_guarantee_expires_at || null,
    paymentRequiredBy: offer.payment_requirements?.payment_required_by || null,
    // Whether the airline requires passenger passport/identity documents for this offer
    identityDocsRequired: offer.passenger_identity_documents_required === true,
  };
}

function isoToMin(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0) : 0;
}
