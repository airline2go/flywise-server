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

// ─── Middleware ───────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Duffel Helper ────────────────────────────────────────
async function duffel(method, path, body = null) {
  if (!DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN غير موجود في Environment Variables');

  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${DUFFEL_TOKEN}`,
      'Content-Type': 'application/json',
      'Duffel-Version': DUFFEL_VERSION,
      Accept: 'application/json',
    },
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

// ─── Health Check ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'FlyWise Duffel Proxy',
    version: '3.0',
    tokenConfigured: !!DUFFEL_TOKEN,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ─── POST /search ─────────────────────────────────────────
app.post('/search', async (req, res) => {
  try {
    const {
      origin, destination, departure_date,
      return_date, cabin_class = 'economy',
      adults = 1, children = 0, infants = 0,
    } = req.body;

    if (!origin || !destination || !departure_date) {
      return res.status(400).json({ ok: false, error: 'origin, destination, departure_date مطلوبة' });
    }

    const passengers = [];
    for (let i = 0; i < adults; i++) passengers.push({ type: 'adult' });
    for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
    for (let i = 0; i < infants; i++) passengers.push({ type: 'infant_without_seat' });

    const slices = [{ origin, destination, departure_date }];
    if (return_date) slices.push({ origin: destination, destination: origin, departure_date: return_date });

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
    res.json({ ok: true, offer: normalizeOffer(result.data), services: result.data?.available_services || [] });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /order ──────────────────────────────────────────
app.post('/order', async (req, res) => {
  try {
    const { offer_id, passengers, services = [], total_amount, currency = 'EUR' } = req.body;

    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });
    if (!passengers?.length) return res.status(400).json({ ok: false, error: 'بيانات المسافرين مطلوبة' });

    const result = await duffel('POST', '/air/orders', {
      data: {
        type: 'instant',
        selected_offers: [offer_id],
        passengers,
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
app.post('/cancel', async (req, res) => {
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

  const bags = offer.passengers?.[0]?.baggages || [];
  const al0 = outbound?.segments?.[0];

  return {
    id: offer.id,
    isDuffel: true,
    raw_offer_id: offer.id,
    al: [al0?.marketing_carrier?.iata_code || 'XX', al0?.marketing_carrier?.name || 'Unknown'],
    price: parseFloat(offer.total_amount || 0),
    currency: offer.total_currency || 'EUR',
    hasCabin: bags.some(b => b.type === 'carry_on' && b.quantity > 0),
    hasChecked: bags.some(b => b.type === 'checked' && b.quantity > 0),
    co2: Math.round(parseFloat(offer.total_amount || 0) * 1.1),
    outbound: normSlice(outbound),
    inbound: normSlice(inbound),
    expires_at: offer.expires_at,
    conditions: offer.conditions || {},
  };
}

function isoToMin(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0) : 0;
}
