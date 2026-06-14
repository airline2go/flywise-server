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

  // ── Real fare/brand data from Duffel (only what the airline actually sends) ──
  // Fare info lives on each segment's passenger entry. We read it from the
  // first segment of the outbound slice for the first passenger.
  const firstSegPax = outbound?.segments?.[0]?.passengers?.[0] || null;
  const cabin = firstSegPax?.cabin || null;

  // fare_brand_name can appear at offer level or on the segment passenger
  const fareBrand = offer.fare_brand_name
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
    co2: Math.round(parseFloat(offer.total_amount || 0) * 1.1),
    outbound: normSlice(outbound),
    inbound: normSlice(inbound),
    expires_at: offer.expires_at,
    conditions: offer.conditions || {},
    // ── Real fare brand data (null when the airline doesn't provide it) ──
    fare_brand_name: fareBrand,
    cabin_marketing_name: cabinMarketingName,
    cabin_class: cabinClass,
    amenities: amenities,
  };
}

function isoToMin(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0) : 0;
}
