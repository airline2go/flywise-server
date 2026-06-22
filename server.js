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

// ─── [#8] Sentry error tracking ────────────────────────────
// MUST be initialized before any other require() per Sentry's own docs, so
// it can auto-instrument every module that gets loaded after it. If
// SENTRY_DSN isn't set, init() is simply skipped — Sentry.* calls below
// become harmless no-ops and the server runs exactly as before.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2, // 20% of requests get performance tracing; errors are always captured at 100%
  });
}

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const DUFFEL_TOKEN = process.env.DUFFEL_TOKEN;
const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';

// ─── Stripe ───────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

// ─── [#6] Brevo (email) — uses Brevo's REST API directly via fetch, no SDK ──
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'noreply@airpiv.com';
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Airpiv';

// Sends a transactional email via Brevo. Never throws — booking confirmation
// must succeed even if the email fails; failures are only logged.
async function sendEmail(to, subject, htmlContent) {
  if (!BREVO_API_KEY) { log('warn', 'email_not_configured', { to }); return false; }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      log('error', 'email_send_failed', { to, status: res.status, body: errBody.slice(0, 300) });
      return false;
    }
    log('info', 'email_sent', { to, subject });
    return true;
  } catch (e) {
    log('error', 'email_send_exception', { to, error: e.message });
    return false;
  }
}

// [EMAIL-FIX] Turns a live Duffel order + our own financial breakdown into
// the same structured shape the in-app confirmation screen uses — flight
// segments, selected seats (with passenger + designator), purchased bags
// (with weight), and ticket/bags/seats/discount broken out individually
// instead of one opaque total. Mirrors orderToBookingData() in index.html
// (kept in sync deliberately) so the email and the in-app screen always
// agree on what was actually booked and charged.
function buildOrderSummaryForEmail(order, money) {
  function isoMinSrv(iso) { if (!iso) return 0; const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/); return m ? (parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0)) : 0; }
  const paxById = {};
  (order.passengers || []).forEach((p) => { paxById[p.id] = `${p.given_name || ''} ${p.family_name || ''}`.trim(); });

  const seatServiceByKey = {};
  (order.services || []).forEach((svc) => {
    if (!(svc.type || '').toLowerCase().includes('seat')) return;
    (svc.passenger_ids || []).forEach((pid) => {
      (svc.segment_ids || []).forEach((sid) => { seatServiceByKey[`${sid}|${pid}`] = svc; });
    });
  });

  function mapSeg(s) {
    const seats = [];
    (s.passengers || []).forEach((sp) => {
      if (sp.seat && sp.seat.designator) {
        const svc = seatServiceByKey[`${s.id}|${sp.passenger_id}`];
        seats.push({
          passenger: paxById[sp.passenger_id] || '', designator: sp.seat.designator,
          netPrice: svc ? parseFloat(svc.total_amount || 0) : 0,
        });
      }
    });
    return {
      from: s.origin?.iata_code || '', to: s.destination?.iata_code || '',
      dep: s.departing_at ? new Date(s.departing_at) : null, arr: s.arriving_at ? new Date(s.arriving_at) : null,
      dur: isoMinSrv(s.duration), al: s.marketing_carrier?.name || '',
      fn: `${s.marketing_carrier?.iata_code || ''}${s.marketing_carrier_flight_number || ''}`,
      seats,
    };
  }
  // [MULTICITY-FIX] Previously only ever read slices[0] (outbound) and
  // slices[1] (return) — a multi-city itinerary can have 3, 4, or more
  // slices, and every one beyond the first two (including any seats
  // selected on them) was silently dropped from this summary entirely.
  // That's exactly how the email's price could come out wrong on a
  // multi-city booking: seats purchased on leg 3+ contributed their net
  // cost to nothing here, so they vanished from both the seat list AND
  // the seatsPrice/ticketPrice split below, while still being part of the
  // real total the customer paid. Every slice is now read, in order, and
  // labeled by its actual leg number — multi-city itineraries don't have
  // a real "outbound vs return", so "Hinflug/Rückflug" was already
  // semantically wrong for 3+ legs (which one is the "Rückflug" on a
  // BER→IST→DXB→BER trip?). "Flug 1 / Flug 2 / Flug 3" is correct in every
  // case, including the common round-trip (slices.length === 2).
  const slices = order.slices || [];
  const legs = slices.map((slice, i) => ({
    legNumber: i + 1,
    segs: (slice.segments || []).map(mapSeg),
  }));
  const allSeats = legs.flatMap((leg) => leg.segs).flatMap((s) => s.seats);

  const purchasedBags = (order.services || []).filter((svc) => {
    const t = (svc.type || '').toLowerCase();
    return t.includes('baggage') || t.includes('bag');
  }).map((svc) => {
    const names = (svc.passenger_ids || []).map((id) => paxById[id] || '').filter(Boolean);
    const md = svc.metadata || {};
    return {
      quantity: svc.quantity || 1, amount: parseFloat(svc.total_amount || 0),
      passengers: names, maxWeightKg: md.maximum_weight_kg != null ? Number(md.maximum_weight_kg) : null,
    };
  });

  // Same proportional-margin-split logic as orderToBookingData() in
  // index.html — see the comment there for why this is exact when bags
  // and seats share a margin tier (true today) and a clearly-derived
  // estimate if that ever changes.
  const netBagsTotal = purchasedBags.reduce((s, b) => s + (b.amount || 0), 0);
  const netSeatsTotal = allSeats.reduce((s, st) => s + (st.netPrice || 0), 0);
  const netAncillaryTotal = netBagsTotal + netSeatsTotal;
  const ancillaryMargin = money.ancillaryMargin || 0;
  const bagsPrice = netBagsTotal + (netAncillaryTotal > 0 ? ancillaryMargin * (netBagsTotal / netAncillaryTotal) : 0);
  const seatsPrice = netSeatsTotal + (netAncillaryTotal > 0 ? ancillaryMargin * (netSeatsTotal / netAncillaryTotal) : 0);
  const netTotal = parseFloat(order.total_amount || 0);
  const ticketPrice = netTotal - netAncillaryTotal + (money.ticketMargin || 0);

  return {
    legs, allSeats, purchasedBags,
    ticketPrice: Math.round(ticketPrice * 100) / 100,
    bagsPrice: Math.round(bagsPrice * 100) / 100,
    seatsPrice: Math.round(seatsPrice * 100) / 100,
    discountAmount: money.discountAmount || 0,
    loyaltyDiscount: money.loyaltyDiscount || 0,
    promoCode: money.promoCode || null,
    customerPaid: money.customerPaid,
    currency: order.total_currency || 'EUR',
  };
}

// Booking confirmation email template + send. Best-effort: failures are
// logged but never affect the booking itself (it already succeeded).
// [EMAIL-FIX] Completely rebuilt: previously showed only a booking
// reference, a single combined route string, and Duffel's raw NET total
// (never what the customer actually paid) — no flight times, no seats, no
// bags, no price breakdown. Now mirrors the in-app confirmation screen:
// each flight segment with real times, selected seats (passenger +
// designator), purchased bags (with weight), and the ticket/bags/seats/
// discount breakdown in the same order the customer sees in the app.
async function sendBookingConfirmationEmail(to, data) {
  const fmtMoney = (n, cur) => `${(Number(n) || 0).toFixed(2)} ${cur || 'EUR'}`;
  const fmtTime = (d) => d ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : '--:--';
  const fmtDate = (d) => d ? d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const durStr = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

  const summary = data.orderSummary || null;

  function segRow(seg) {
    return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef1f4">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:60px;vertical-align:top">
            <div style="font-size:15px;font-weight:700;color:#101d2c">${fmtTime(seg.dep)}</div>
            <div style="font-size:11px;color:#8fa4b4">${seg.from}</div>
          </td>
          <td style="text-align:center;vertical-align:top;color:#8fa4b4;font-size:11px;padding:0 8px">
            <div>${durStr(seg.dur)}</div>
            <div style="border-top:1px dashed #c8d4de;margin:4px 0"></div>
            <div>${seg.al} ${seg.fn}</div>
          </td>
          <td style="width:60px;text-align:right;vertical-align:top">
            <div style="font-size:15px;font-weight:700;color:#101d2c">${fmtTime(seg.arr)}</div>
            <div style="font-size:11px;color:#8fa4b4">${seg.to}</div>
          </td>
        </tr></table>
      </td>
    </tr>`;
  }

  function segsBlock(segs, label) {
    if (!segs || !segs.length) return '';
    return `
    <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">${label}</div>
    <table width="100%" cellpadding="0" cellspacing="0">${segs.map(segRow).join('')}</table>`;
  }

  const paxRows = (data.passengers || [])
    .map((p) => `<tr><td style="padding:5px 0;color:#46586c;font-size:13px">${(p.given_name || '')} ${(p.family_name || '')}</td></tr>`)
    .join('');

  let flightHtml = '';
  let bagsHtml = '';
  let seatsHtml = '';
  let priceHtml = '';

  if (summary) {
    // [MULTICITY-FIX] "Flug 1 / Flug 2 / Flug 3..." applies ONLY to a
    // genuine multi-city itinerary (3+ legs) — a normal round trip still
    // reads as "Hinflug/Rückflug" exactly as before. The earlier version
    // of this fix used "Flug N" for every booking including plain round
    // trips, which wasn't the intent — the actual bug being fixed here is
    // multi-city legs beyond the 2nd silently vanishing (and the wrong
    // price that caused), not the round-trip label itself.
    const legsArr = summary.legs || [];
    if (legsArr.length > 2) {
      flightHtml = legsArr.map((leg) => segsBlock(leg.segs, 'Flug ' + leg.legNumber)).join('');
    } else {
      flightHtml = segsBlock(legsArr[0] && legsArr[0].segs, legsArr[1] && legsArr[1].segs && legsArr[1].segs.length ? 'Hinflug' : 'Flug') +
                   segsBlock(legsArr[1] && legsArr[1].segs, 'Rückflug');
    }

    if (summary.purchasedBags && summary.purchasedBags.length) {
      bagsHtml = `
      <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">🧳 Gepäck</div>
      ${summary.purchasedBags.map((b) => `
        <div style="font-size:13px;color:#46586c;padding:4px 0">
          ${b.quantity > 1 ? `${b.quantity}× ` : ''}Zusatzgepäck${b.maxWeightKg ? ` · bis ${b.maxWeightKg} kg` : ''}${b.passengers.length ? ` · ${b.passengers.join(', ')}` : ''}
          <strong style="color:#0FB5A0">${fmtMoney(b.amount, summary.currency)}</strong>
        </div>`).join('')}`;
    }

    if (summary.allSeats && summary.allSeats.length) {
      seatsHtml = `
      <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">💺 Sitzplätze</div>
      ${summary.allSeats.map((s) => `
        <div style="font-size:13px;color:#46586c;padding:4px 0;display:flex;justify-content:space-between">
          <span>${s.passenger || 'Reisende/r'}</span><strong style="font-family:monospace;color:#0FB5A0">${s.designator}</strong>
        </div>`).join('')}`;
    }

    const rows = [];
    rows.push(`<tr><td style="padding:4px 0;color:#46586c;font-size:13px">Flugticket</td><td style="text-align:right;font-size:13px">${fmtMoney(summary.ticketPrice, summary.currency)}</td></tr>`);
    if (summary.bagsPrice > 0) rows.push(`<tr><td style="padding:4px 0;color:#46586c;font-size:13px">Gepäck</td><td style="text-align:right;font-size:13px">+ ${fmtMoney(summary.bagsPrice, summary.currency)}</td></tr>`);
    if (summary.seatsPrice > 0) rows.push(`<tr><td style="padding:4px 0;color:#46586c;font-size:13px">Sitzplätze</td><td style="text-align:right;font-size:13px">+ ${fmtMoney(summary.seatsPrice, summary.currency)}</td></tr>`);
    if (summary.promoCode && summary.discountAmount > 0) {
      const nonLoyalty = Math.max(0, summary.discountAmount - (summary.loyaltyDiscount || 0));
      if (nonLoyalty > 0) rows.push(`<tr><td style="padding:4px 0;color:#0f9d58;font-size:13px">Gutscheincode (${summary.promoCode})</td><td style="text-align:right;font-size:13px;color:#0f9d58">− ${fmtMoney(nonLoyalty, summary.currency)}</td></tr>`);
    }
    if (summary.loyaltyDiscount > 0) rows.push(`<tr><td style="padding:4px 0;color:#0f9d58;font-size:13px">Treueguthaben verwendet</td><td style="text-align:right;font-size:13px;color:#0f9d58">− ${fmtMoney(summary.loyaltyDiscount, summary.currency)}</td></tr>`);
    const grandTotal = Math.round((summary.ticketPrice + summary.bagsPrice + summary.seatsPrice - summary.discountAmount) * 100) / 100;
    rows.push(`<tr><td style="padding:10px 0 0;border-top:2px solid #e1e7ec;font-weight:700;color:#101d2c">Gesamtbetrag</td><td style="text-align:right;padding:10px 0 0;border-top:2px solid #e1e7ec;font-weight:700;font-size:16px;color:#0FB5A0">${fmtMoney(grandTotal, summary.currency)}</td></tr>`);
    priceHtml = `<table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
  } else if (data.totalAmount) {
    // Fallback if order details couldn't be fetched — still show SOMETHING correct.
    priceHtml = `<p style="margin:4px 0"><strong>Gesamtbetrag:</strong> ${fmtMoney(data.totalAmount, data.currency)}</p>`;
  }

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#101d2c">
    <div style="background:#101d2c;padding:20px;text-align:center;border-radius:12px 12px 0 0">
      <span style="color:#fff;font-size:20px;font-weight:bold">✈ Airpiv</span>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #e1e7ec;border-radius:0 0 12px 12px">
      <h2 style="color:#0FB5A0;margin-top:0">Buchung bestätigt!</h2>
      <p style="font-size:14px;color:#46586c">Vielen Dank für deine Buchung bei Airpiv. Hier sind deine Details:</p>
      <div style="background:#f6f8fa;border-radius:8px;padding:14px;margin:16px 0">
        <p style="margin:4px 0"><strong>Buchungscode:</strong> ${data.bookingRef || '—'}</p>
      </div>

      ${flightHtml}

      ${paxRows ? `<div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">👥 Reisende</div><table width="100%" cellpadding="0" cellspacing="0">${paxRows}</table>` : ''}

      ${bagsHtml}
      ${seatsHtml}

      <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">💰 Preisübersicht</div>
      ${priceHtml}

      <p style="margin-top:20px;font-size:13px;color:#8fa4b4">
        Bei Fragen erreichst du uns unter <a href="mailto:support@airpiv.com" style="color:#0FB5A0">support@airpiv.com</a>.
      </p>
    </div>
  </div>`;
  return sendEmail(to, `Buchungsbestätigung ${data.bookingRef || ''} · Airpiv`, html);
}


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

// ─── [ADMIN] admin_config key/value store ──────────────────────────────
// Used for ticket profit tiers, ancillary (seat/baggage) profit tiers,
// invoice numbering, etc. Read-through cache (60s TTL) so every pricing
// calculation doesn't hit Supabase — these values change rarely.
const DEFAULT_TICKET_TIERS = [
  { from: 0, to: 200, pct: 8, fixed: 5 },
  { from: 200, to: 500, pct: 6, fixed: 8 },
  { from: 500, to: null, pct: 4, fixed: 10 },
];
const DEFAULT_ANCILLARY_TIERS = [
  { from: 0, to: 100, pct: 10, fixed: 1 },
  { from: 100, to: 200, pct: 8, fixed: 2 },
  { from: 200, to: null, pct: 6, fixed: 3 },
];
const DEFAULT_INVOICE_CONFIG = { prefix: 'AIRPIV', nextNumber: 1, companyName: 'Airpiv', companyAddress: '', steuernummer: '', taxMode: 'kleinunternehmer' };

const _configCache = new Map(); // key -> { value, at }
const CONFIG_CACHE_TTL = 60000;

async function getAdminConfig(key, fallback) {
  const cached = _configCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_CACHE_TTL) return cached.value;
  if (supa) {
    try {
      const { data, error } = await supa.from('admin_config').select('value').eq('key', key).maybeSingle();
      if (!error && data && data.value != null) {
        _configCache.set(key, { value: data.value, at: Date.now() });
        return data.value;
      }
    } catch (e) {
      log('warn', 'admin_config_read_failed', { key, error: e.message });
    }
  }
  // No Supabase, or row missing, or read failed: fall back to the default
  // and cache it too (briefly) so we don't hammer Supabase on every request.
  _configCache.set(key, { value: fallback, at: Date.now() });
  return fallback;
}

async function setAdminConfig(key, value) {
  if (!supa) throw Object.assign(new Error('Datenbank nicht verfügbar'), { status: 503 });
  const { error } = await supa.from('admin_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  _configCache.set(key, { value, at: Date.now() });
}

// [CANCEL-NOTIFY-FIX] Customer-initiated cancellations the admin has no
// other way of finding out about. Stored as a capped list (newest first,
// oldest dropped past 50) in admin_config — durable across restarts,
// consistent with everything else config-driven in this file.
async function recordCancellationEvent(entry) {
  try {
    const list = await getAdminConfig('cancellation_events', []);
    const updated = [{ ...entry, at: new Date().toISOString(), read: false }, ...list].slice(0, 50);
    await setAdminConfig('cancellation_events', updated);
  } catch (e) {
    log('warn', 'cancellation_event_record_failed', { error: e.message });
  }
}
async function getUnreadCancellationCount() {
  const list = await getAdminConfig('cancellation_events', []);
  return list.filter((e) => !e.read).length;
}
async function markCancellationsRead() {
  const list = await getAdminConfig('cancellation_events', []);
  await setAdminConfig('cancellation_events', list.map((e) => ({ ...e, read: true })));
}

// Same tiered-margin math as the admin dashboard's getMarginForPrice() in
// JS, kept in lockstep deliberately: { from, to(nullable), pct, fixed }[].
// `to: null` means "no upper bound". Falls back to the last tier if price
// exceeds every defined range (mirrors the dashboard's own fallback).
function computeTieredMargin(price, tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  for (const t of tiers) {
    const inFrom = price >= Number(t.from || 0);
    const inTo = t.to === null || t.to === undefined || price < Number(t.to);
    if (inFrom && inTo) return Math.round((price * (Number(t.pct) || 0) / 100 + (Number(t.fixed) || 0)) * 100) / 100;
  }
  const last = tiers[tiers.length - 1];
  return Math.round((price * (Number(last.pct) || 0) / 100 + (Number(last.fixed) || 0)) * 100) / 100;
}

async function getTicketProfitTiers() { return getAdminConfig('ticket_profit_tiers', DEFAULT_TICKET_TIERS); }
async function getAncillaryProfitTiers() { return getAdminConfig('ancillary_profit_tiers', DEFAULT_ANCILLARY_TIERS); }

// ─── [ADMIN-LOYALTY] Server-side loyalty program ───────────────────────
// Every number here used to live hardcoded in frontend JS (and the credit
// balance itself lived in localStorage, fully editable via devtools — an
// unlimited-discount hole). Now: every number is admin-tunable via
// /admin/loyalty-config, and the actual credit balance per device lives in
// loyalty_accounts, readable/writable ONLY by the server. There is no login
// system, so "account" = one row per client-generated device_id (a UUID
// the frontend generates once and keeps in localStorage) — this isn't a
// real auth system, but it does mean a tampered localStorage value can no
// longer change what credit the server thinks is available.
const DEFAULT_LOYALTY_CONFIG = {
  welcomeCreditEur: 10.0,
  welcomePoints: 100,
  pointsPerEuro: 2,
  pointsPerEuroRedeem: 400,
  maxCreditPerBooking: 5.0,
  tiers: [
    { from: 0, to: 75, creditEur: 1 },
    { from: 75, to: 149, creditEur: 2 },
    { from: 149, to: 224, creditEur: 3 },
    { from: 224, to: 299, creditEur: 4 },
    { from: 299, to: null, creditEur: 5 },
  ],
};
async function getLoyaltyConfig() { return getAdminConfig('loyalty_config', DEFAULT_LOYALTY_CONFIG); }

// How much credit COULD be used for a given subtotal, per the admin's
// tiers — independent of how much the account actually has.
function creditUsableForSubtotal(subtotal, cfg) {
  const tiers = Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : DEFAULT_LOYALTY_CONFIG.tiers;
  for (const t of tiers) {
    const inFrom = subtotal >= Number(t.from || 0);
    const inTo = t.to === null || t.to === undefined || subtotal < Number(t.to);
    if (inFrom && inTo) return Number(t.creditEur) || 0;
  }
  const last = tiers[tiers.length - 1];
  return Number(last.creditEur) || 0;
}

// Looks up (or lazily creates) a loyalty account for either an anonymous
// device or a logged-in user. `kind` is 'device' or 'user'; `id` is the
// device_id or user_id respectively. This is the ONLY place that touches
// loyalty_accounts directly — every caller goes through here so device-
// vs-user accounts are handled identically everywhere else.
async function getOrCreateLoyaltyAccount(kind, id) {
  if (!supa || !id || (kind !== 'device' && kind !== 'user')) return null;
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    const { data } = await supa.from('loyalty_accounts').select('*').eq(column, id).maybeSingle();
    if (data) return data;
    const cfg = await getLoyaltyConfig();
    const welcomePts = Number(cfg.welcomePoints) || 0;
    const fresh = {
      [column]: id,
      points: welcomePts,
      // [TIER-DEMOTION-FIX] lifetime_points only ever increases (earned via
      // bookings) — tier is computed from this, never from the spendable
      // `points` balance, so redeeming points for credit can no longer pull
      // a customer back down a tier they already earned.
      lifetime_points: welcomePts,
      credit: Number(cfg.welcomeCreditEur) || 0,
      credit_used: 0, bookings_count: 0, tier: 'bronze',
    };
    const { data: inserted, error } = await supa.from('loyalty_accounts').insert(fresh).select().maybeSingle();
    if (error) { log('warn', 'loyalty_account_create_failed', { error: error.message }); return null; }
    return inserted;
  } catch (e) {
    log('warn', 'loyalty_account_lookup_failed', { error: e.message });
    return null;
  }
}

// [ADMIN-LOYALTY] Server-authoritative discount: never trusts a credit
// amount the browser asks for — clamps to (a) the admin's tier table for
// this subtotal, (b) the admin's absolute per-booking ceiling, and (c) the
// account's actual remaining balance. The smallest of the three wins.
async function computeLoyaltyDiscount(kind, id, subtotal) {
  if (!id) return { discount: 0, account: null };
  const account = await getOrCreateLoyaltyAccount(kind, id);
  if (!account) return { discount: 0, account: null };
  const cfg = await getLoyaltyConfig();
  const tierAllowance = creditUsableForSubtotal(subtotal, cfg);
  const ceiling = Number(cfg.maxCreditPerBooking) || 0;
  const discount = Math.round(Math.max(0, Math.min(tierAllowance, ceiling, Number(account.credit) || 0)) * 100) / 100;
  return { discount, account };
}

// Deducts used credit + awards points for a confirmed booking. Called only
// from bookFromSession, after Duffel has actually confirmed the order —
// never speculatively before payment succeeds.
async function applyLoyaltyForBooking(kind, id, creditUsed, paidAmount) {
  if (!supa || !id) return;
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    const account = await getOrCreateLoyaltyAccount(kind, id);
    if (!account) return;
    const cfg = await getLoyaltyConfig();
    const tierMultiplier = account.tier === 'gold' ? 2 : account.tier === 'silver' ? 1.5 : 1;
    const earned = Math.floor((Number(paidAmount) || 0) * (Number(cfg.pointsPerEuro) || 0) * tierMultiplier);
    const newCredit = Math.max(0, Math.round(((Number(account.credit) || 0) - (Number(creditUsed) || 0)) * 100) / 100);
    const newPoints = (Number(account.points) || 0) + earned;
    // [TIER-DEMOTION-FIX] Tier is now driven by lifetime_points (falls back
    // to the current points balance for accounts created before this
    // column existed, so nothing breaks pre-migration) — a counter that
    // only ever grows from earning, never shrinks from redeeming.
    const currentLifetime = (account.lifetime_points != null ? Number(account.lifetime_points) : Number(account.points)) || 0;
    const newLifetime = currentLifetime + earned;
    const newTier = newLifetime >= 10000 ? 'gold' : newLifetime >= 4000 ? 'silver' : 'bronze';
    await supa.from('loyalty_accounts').update({
      credit: newCredit,
      credit_used: Math.round(((Number(account.credit_used) || 0) + (Number(creditUsed) || 0)) * 100) / 100,
      points: newPoints,
      lifetime_points: newLifetime,
      bookings_count: (Number(account.bookings_count) || 0) + 1,
      tier: newTier,
    }).eq(column, id);
  } catch (e) {
    log('warn', 'loyalty_apply_failed', { error: e.message });
  }
}

// Applies the ancillary (seat/baggage) margin to a single service's net
// Duffel price. Used both when DISPLAYING a price (offer/seatmaps
// endpoints) and when CHARGING the customer (checkout session) — calling
// this same function in both places is what guarantees they always agree.
async function priceWithAncillaryMargin(netPrice) {
  const tiers = await getAncillaryProfitTiers();
  const margin = computeTieredMargin(netPrice, tiers);
  return { net: netPrice, margin, display: Math.round((netPrice + margin) * 100) / 100 };
}
async function priceWithTicketMargin(netPrice) {
  const tiers = await getTicketProfitTiers();
  const margin = computeTieredMargin(netPrice, tiers);
  return { net: netPrice, margin, display: Math.round((netPrice + margin) * 100) / 100 };
}

// ─── [ADMIN] simple bearer-token auth for /admin/* endpoints ──────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Constant-time-ish comparison isn't critical here (single static admin
  // token, not a per-user secret), but timingSafeEqual costs nothing extra.
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_TOKEN);
  const valid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ ok: false, error: 'Nicht autorisiert' });
  next();
}

// ════════════════════════════════════════════════════════════
// [USER-AUTH] Customer accounts — handled by Supabase Auth itself
// (email+password, Google OAuth, email verification, password reset all
// live in Supabase's own auth.users system), NOT custom code here. The
// frontend talks to Supabase Auth directly via the publishable key; the
// server's only job is to verify the access token Supabase issued and
// resolve it to a user id, for endpoints that need to know who's asking
// (pricing/loyalty). This avoids maintaining a second, parallel
// authentication system alongside a battle-tested one.
// ════════════════════════════════════════════════════════════

// Optional-auth middleware: if a valid Supabase access token is present,
// attaches req.userId; otherwise leaves it undefined and continues
// (booking and pricing endpoints must work for anonymous visitors too —
// this never blocks the request, it only identifies who's asking when it
// can). Verification is delegated to Supabase itself via supabase-js,
// which checks the token's signature against the project's JWT secret —
// no custom token logic to get wrong here.
async function attachUserIfPresent(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && supa) {
    try {
      const { data, error } = await supa.auth.getUser(token);
      if (!error && data && data.user) {
        req.userId = data.user.id;
        // [GUEST-LINK] The verified email straight from the auth token —
        // never trust an email the client sends in a request body for
        // anything security-sensitive like guest-booking linking. Whoever
        // owns this token is provably this email address.
        req.userEmail = data.user.email || null;
      }
    } catch (e) { /* malformed/expired token — treat as anonymous, never throw */ }
  }
  next();
}


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
  if (!BREVO_API_KEY) log('warn', 'BREVO_API_KEY not set — confirmation emails disabled');
  if (!process.env.SENTRY_DSN) log('warn', 'SENTRY_DSN not set — error tracking disabled');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) log('warn', 'Supabase not set — using in-memory fallback');
  log('info', 'Environment validated', {
    duffel: !!DUFFEL_TOKEN, stripe: !!STRIPE_SECRET_KEY, supabase: !!supa,
    webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
    email: !!BREVO_API_KEY,
    sentry: !!process.env.SENTRY_DSN,
    tokenType: (DUFFEL_TOKEN || '').indexOf('live') !== -1 ? 'live' : 'test',
  });
})();

// ─── [#9] Rate limiter — Redis-backed with automatic in-memory fallback ───
// Counters live in Redis so they survive restarts/redeploys instead of
// resetting to zero every time Render recycles the dyno. If REDIS_URL isn't
// set, or Redis is briefly unreachable, every call falls straight back to
// the original in-memory Map logic — the site never depends on Redis to
// stay up. Same bucket/max/windowMs signature as before, so every existing
// app.post(..., rateLimit('x', n, ms), ...) call site is untouched.
const rlStore = new Map(); // fallback store (also used when Redis is down)
let redis = null;
const REDIS_URL = process.env.REDIS_URL;
if (REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,   // fail fast instead of queuing requests
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: false,
    });
    redis.on('error', (e) => log('warn', 'redis_error', { msg: e.message }));
    redis.on('connect', () => log('info', 'redis_connected', {}));
  } catch (e) {
    console.error('Redis init failed:', e.message);
    redis = null;
  }
}

// In-memory fallback path — identical to the original implementation.
function rateLimitMemory(bucket, ip, max, windowMs) {
  const key = bucket + ':' + ip;
  const now = Date.now();
  let e = rlStore.get(key);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; rlStore.set(key, e); }
  e.count++;
  return { limited: e.count > max, retryAfterSec: Math.ceil((e.reset - now) / 1000) };
}

// Redis path — INCR + PEXPIRE gives us an atomic fixed-window counter
// without needing a Lua script. Falls back to memory on any error.
async function rateLimitRedis(bucket, ip, max, windowMs) {
  const key = 'rl:' + bucket + ':' + ip;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);
  if (count > max) {
    const ttl = await redis.pttl(key);
    return { limited: true, retryAfterSec: Math.ceil(Math.max(ttl, 0) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

function rateLimit(bucket, max, windowMs) {
  return async function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    let result;
    if (redis && redis.status === 'ready') {
      try {
        result = await rateLimitRedis(bucket, ip, max, windowMs);
      } catch (e) {
        log('warn', 'redis_rl_fallback', { bucket, msg: e.message });
        result = rateLimitMemory(bucket, ip, max, windowMs);
      }
    } else {
      result = rateLimitMemory(bucket, ip, max, windowMs);
    }
    if (result.limited) {
      res.set('Retry-After', String(result.retryAfterSec));
      log('warn', 'rate_limited', { bucket, ip });
      return res.status(429).json({ ok: false, error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
    }
    next();
  };
}
// periodic cleanup of expired rate-limit buckets (memory fallback only —
// Redis keys expire on their own via PEXPIRE)
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
    // [PRICE-DRIFT-PROTECTION] Already refunded in full inside
    // bookFromSession() before throwing — a handled, safe outcome, not
    // the "customer charged with no ticket" emergency the Sentry alert
    // below exists for.
    if (err.code === 'PRICE_DRIFT') {
      log('warn', 'webhook_booking_blocked_price_drift', { type: event.type, message: err.message, drift: err.priceDrift });
      return;
    }
    // Booking failed after a paid webhook → log loudly for support follow-up
    log('error', 'webhook_booking_failed', { type: event.type, message: err.message, duffel_errors: err.details });
    console.error('[WEBHOOK BOOKING FAILED] ' + (err.message || '') + ' | ' + JSON.stringify(err.details || {}));
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { critical: 'booking_failed_after_payment', source: 'webhook' },
        extra: { event_type: event.type, duffel_errors: err.details },
      });
    }
  }
});

app.use(express.json({ limit: '256kb' }));

// ─── [KILL-SWITCH] Maintenance mode ────────────────────────
// Toggled from the admin dashboard for a real emergency (e.g. a pricing
// bug that could overcharge customers, a Duffel/Stripe outage, a security
// issue) — takes the customer-facing site down immediately at the API
// level, not just by hiding the UI. Every request is rejected with 503
// EXCEPT: /admin/* (the dashboard — including the toggle to turn this back
// off — must always stay reachable), /maintenance-status (what the
// frontend polls to show the "under maintenance" screen), and basic
// health checks (so uptime monitoring doesn't also report a false outage
// on top of the deliberate one).
app.use(async (req, res, next) => {
  if (req.path.startsWith('/admin/') || req.path === '/maintenance-status' || req.path === '/health' || req.path === '/' || req.path === '/status') {
    return next();
  }
  try {
    const maint = await getAdminConfig('maintenance_mode', { enabled: false, message: '' });
    if (maint && maint.enabled) {
      return res.status(503).json({
        ok: false,
        maintenance: true,
        error: maint.message || 'Airpiv ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.',
      });
    }
  } catch (e) {
    log('warn', 'maintenance_check_failed', { error: e.message });
    // Fail OPEN — a config-read error must never itself take the whole
    // site down. Worst case, maintenance mode is briefly ineffective.
  }
  next();
});

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

// ─── GET /maintenance-status ─────────────────────────────────
// [MAINTENANCE-MODE] Public, unauthenticated — every visitor's browser
// checks this before rendering the homepage, so it must not require a
// login. Backed by admin_config (the same durable key-value store as
// profit tiers / loyalty config / etc.), not an in-memory flag — an
// in-memory flag would silently reset to "not in maintenance" on every
// server restart/redeploy, which defeats the purpose of an emergency
// kill switch the admin expects to stay on until THEY turn it off.
async function getMaintenanceConfig() {
  return getAdminConfig('maintenance_mode', { enabled: false, message: '' });
}
app.get('/maintenance-status', async (req, res) => {
  try {
    const cfg = await getMaintenanceConfig();
    res.json({ ok: true, enabled: !!cfg.enabled, message: cfg.message || '' });
  } catch (err) {
    // Fail OPEN, not closed — a config-read error must never accidentally
    // lock every visitor out of a perfectly healthy site.
    res.json({ ok: true, enabled: false, message: '' });
  }
});

// ─── GET/POST /admin/maintenance-mode ────────────────────────
app.get('/admin/maintenance-mode', requireAdmin, async (req, res) => {
  try {
    const cfg = await getMaintenanceConfig();
    res.json({ ok: true, enabled: !!cfg.enabled, message: cfg.message || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/maintenance-mode', requireAdmin, async (req, res) => {
  try {
    const enabled = !!req.body.enabled;
    const message = typeof req.body.message === 'string' ? req.body.message.slice(0, 500) : '';
    await setAdminConfig('maintenance_mode', { enabled, message });
    log('info', 'maintenance_mode_changed', { enabled });
    res.json({ ok: true, enabled, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

    // [PRICING-FIX] Fetch the tiers ONCE for this whole search response —
    // a single search can return dozens of offers, and they all share the
    // same admin-configured margin tiers at this moment in time.
    const ticketTiers = await getTicketProfitTiers();
    const offers = (result.data?.offers || []).map((o) => normalizeOffer(o, ticketTiers));

    res.json({ ok: true, offer_request_id: result.data?.id, offers, total: offers.length });

  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── GET /route-price ───────────────────────────────────────
// [ROUTE-PAGES] Lightweight cheapest-price lookup for SEO route landing
// pages. Returns just one number (+currency), not a full offer list.
// Cached per-route for 6h so many visitors hitting the same page don't
// each trigger a fresh Duffel search.
app.get('/route-price', rateLimit('route-price', 60, 60000), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from und to sind erforderlich' });

    const cacheKey = 'route_price_' + from.toUpperCase() + '_' + to.toUpperCase();
    const cached = await getAdminConfig(cacheKey, null);
    if (cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < 6 * 60 * 60 * 1000) {
      return res.json({ ok: true, price: cached.price, currency: cached.currency, cached: true });
    }

    // A representative near-future date — NOT today, which would surface
    // artificially high last-minute fares that don't reflect a typical
    // "from" price for the route.
    const searchDate = new Date();
    searchDate.setDate(searchDate.getDate() + 21);
    const departure_date = searchDate.toISOString().slice(0, 10);

    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin: from.toUpperCase(), destination: to.toUpperCase(), departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    });

    const offers = result.data?.offers || [];
    if (!offers.length) {
      return res.json({ ok: true, price: null, currency: null });
    }

    const ticketTiers = await getTicketProfitTiers();
    let cheapest = null;
    for (const o of offers) {
      const netPrice = parseFloat(o.total_amount || 0);
      const margin = computeTieredMargin(netPrice, ticketTiers);
      const customerPrice = Math.round((netPrice + margin) * 100) / 100;
      if (cheapest === null || customerPrice < cheapest) cheapest = customerPrice;
    }

    await setAdminConfig(cacheKey, { price: cheapest, currency: offers[0].total_currency || 'EUR', fetchedAt: new Date().toISOString() });
    res.json({ ok: true, price: cheapest, currency: offers[0].total_currency || 'EUR', cached: false });
  } catch (err) {
    // Fail soft — a route page should still render (without a price) if
    // Duffel is briefly unavailable, never show a broken page.
    log('warn', 'route_price_failed', { error: err.message });
    res.json({ ok: true, price: null, currency: null });
  }
});

// ─── GET /offer/:id ───────────────────────────────────────
app.get('/offer/:id', async (req, res) => {
  try {
    const result = await duffel('GET', `/air/offers/${req.params.id}?return_available_services=true`);
    const raw = result.data?.available_services || [];
    const ticketTiers = await getTicketProfitTiers();
    // [MULTI-PAX-FIX] Same passenger ordering as /seatmaps — adults, then
    // children, then infants, in Duffel's own listed order — so baggage
    // services can be tagged with a passengerIndex the frontend can match
    // against its passenger form fields (bf-fn0, bf-fn1, ...).
    const offerPaxRaw = (result.data && result.data.passengers) || [];
    const byType = (t) => offerPaxRaw.filter((p) => p && p.type === t).map((p) => p.id);
    const passengerOrder = [...byType('adult'), ...byType('child'), ...byType('infant_without_seat')];
    res.json({
      ok: true,
      offer: normalizeOffer(result.data, ticketTiers),
      services: raw,                          // raw passthrough (compat)
      baggageServices: await normalizeBaggageServices(raw, passengerOrder),  // clean baggage list, margin applied
      passengerOrder,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Turn Duffel available_services into a clean baggage list. [ADMIN-MARGIN]
// `price` is what the customer sees/pays (net Duffel price + ancillary
// margin); `netPrice` is the exact Duffel price with NOTHING added, kept
// alongside so the booking flow can send Duffel its real cost while
// charging the customer the marked-up amount via Stripe.
async function normalizeBaggageServices(services, passengerOrder) {
  if (!Array.isArray(services)) return [];
  passengerOrder = passengerOrder || [];
  const baggage = services.filter(s => s.type === 'baggage');
  const tiers = await getAncillaryProfitTiers();
  return baggage
    .map(s => {
      const md = s.metadata || {};
      const netPrice = parseFloat(s.total_amount || 0);
      const margin = computeTieredMargin(netPrice, tiers);
      const passengerIds = s.passenger_ids || [];
      // [MULTI-PAX-FIX] Resolve to a 0-based index matching the frontend's
      // passenger form fields — null if this service isn't tied to a
      // single specific passenger (some airlines return baggage services
      // without passenger_ids at all, meaning it applies regardless).
      const pid = passengerIds[0] || null;
      const passengerIndex = pid ? passengerOrder.indexOf(pid) : -1;
      return {
        id: s.id,
        price: Math.round((netPrice + margin) * 100) / 100, // customer-facing price (incl. margin)
        netPrice,                                            // exact Duffel price (no margin) — used at booking time
        margin,
        currency: s.total_currency || 'EUR',
        bagType: md.type || null,                 // e.g. "checked" | "carry_on"
        maxWeightKg: (md.maximum_weight_kg != null) ? Number(md.maximum_weight_kg) : null,
        maxQuantity: (s.maximum_quantity != null) ? Number(s.maximum_quantity) : null,
        segmentIds: s.segment_ids || [],
        passengerIds,
        passengerIndex: passengerIndex >= 0 ? passengerIndex : null,
      };
    })
    // cheapest first (by customer-facing price, matching what's displayed)
    .sort((a, b) => a.price - b.price);
}

// ─── POST /seatmaps ───────────────────────────────────────
// Body: { offer_id }. Returns one normalized seat map per segment.
app.post('/seatmaps', async (req, res) => {
  try {
    const { offer_id } = req.body;
    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id required' });
    const [result, offerRes] = await Promise.all([
      duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offer_id)}`),
      duffel('GET', `/air/offers/${encodeURIComponent(offer_id)}`).catch(() => null),
    ]);
    const maps = Array.isArray(result.data) ? result.data : [];
    // [MULTI-PAX-FIX] passengerOrder mirrors attachPassengerIds()'s own
    // grouping (adults, then children, then infants, in Duffel's listed
    // order) — the frontend's passenger form fields (bf-fn0, bf-fn1, ...)
    // are built in that exact same order, so passengerOrder[i] is
    // guaranteed to be the correct Duffel passenger id for "passenger
    // index i" everywhere: seat selection, baggage selection, and the
    // final order sent to Duffel at booking time.
    const offerPaxRaw = (offerRes && offerRes.data && offerRes.data.passengers) || [];
    const byType = (t) => offerPaxRaw.filter((p) => p && p.type === t).map((p) => p.id);
    const passengerOrder = [...byType('adult'), ...byType('child'), ...byType('infant_without_seat')];
    // [SEATMAP-DEBUG] Logs exactly what Duffel actually returned — how
    // many cabins per segment, and the lowest/highest row number in each
    // cabin — so a "the seat map only starts at row 28" report can be
    // checked against the real upstream data rather than guessed at. This
    // is read-only logging; it changes nothing about the response sent to
    // the frontend.
    maps.forEach((sm, i) => {
      const cabins = sm.cabins || [];
      const cabinSummaries = cabins.map((c) => {
        const rowNums = (c.rows || [])
          .map((row) => {
            const seatEl = (row.sections || []).flatMap((s) => s.elements || []).find((el) => el.type === 'seat' && el.designator);
            return seatEl ? parseInt(seatEl.designator.replace(/\D/g, ''), 10) : null;
          })
          .filter((n) => n != null);
        return {
          cabinClass: c.cabin_class || null,
          rowCount: (c.rows || []).length,
          firstRow: rowNums.length ? Math.min(...rowNums) : null,
          lastRow: rowNums.length ? Math.max(...rowNums) : null,
        };
      });
      log('info', 'seatmap_debug', { segmentIndex: i, segmentId: sm.segment_id, cabinCount: cabins.length, cabins: cabinSummaries });
    });
    // [ADMIN-MARGIN] Fetch tiers ONCE here (async) rather than inside the
    // nested cabin/row/section/element .map() chain below, which must stay
    // synchronous — awaiting inside a nested nested .map() would silently
    // produce arrays of unresolved Promises instead of seat objects.
    const ancillaryTiers = await getAncillaryProfitTiers();
    res.json({ ok: true, seatMaps: maps.map(sm => normalizeSeatMap(sm, ancillaryTiers, passengerOrder)), passengerOrder });
  } catch (err) {
    // Seat maps not supported for this airline/flight -> return empty, not an error
    res.json({ ok: true, seatMaps: [], passengerOrder: [], note: err.message });
  }
});

// Normalize one Duffel seat map (per segment) into a compact render-ready
// shape. [ADMIN-MARGIN] `price` is the customer-facing price (net Duffel
// price + ancillary margin); `netPrice` is the untouched Duffel price,
// carried alongside for the booking flow to charge Duffel its real cost.
function normalizeSeatMap(sm, ancillaryTiers, offerPassengerOrder) {
  if (!sm) return null;
  offerPassengerOrder = offerPassengerOrder || [];
  const cabins = (sm.cabins || []).map(cabin => {
    const rows = (cabin.rows || []).map(row => {
      const sections = (row.sections || []).map(section => {
        const elements = (section.elements || []).map(el => {
          if (el.type === 'seat') {
            // [MULTI-PAX-FIX] A seat is bookable only if it has
            // available_services — but Duffel gives ONE service per
            // PASSENGER for the same physical seat (different id, same
            // designator/price), not one service total. Build a lookup by
            // passenger_id so the frontend can pick the right service id
            // for whichever passenger is currently selecting a seat.
            //
            // [SEAT-EMPTY-PAXIDS-FIX] Confirmed via live diagnostic
            // logging: some airlines return the correct number of
            // per-passenger services (one each) but leave passenger_ids
            // EMPTY on every single one — instead of the explicit
            // passenger_ids Duffel's docs describe. Relying on
            // passenger_ids alone in that case meant servicesByPassenger
            // stayed empty for this airline, so every passenger fell back
            // to the same svcs[0] — sending the IDENTICAL service id
            // twice, which Duffel correctly rejects as "expected one seat
            // service per passenger and segments". Fix: when NONE of a
            // seat's services carry a passenger_id, fall back to
            // POSITIONAL order — the Nth service in available_services
            // corresponds to the Nth passenger in offerPassengerOrder
            // (same adults-then-children-then-infants order used
            // everywhere else). This is a safe assumption specifically
            // because Duffel's own docs guarantee one service per
            // passenger per seat — the only thing missing was which one
            // belongs to whom, and array position is the only information
            // left to infer it from.
            const svcs = el.available_services || [];
            const servicesByPassenger = {};
            const anyRealPassengerId = svcs.some((svc) => svc.passenger_ids && svc.passenger_ids[0]);
            svcs.forEach((svc, svcIdx) => {
              const netPriceSvc = parseFloat(svc.total_amount || 0);
              const marginSvc = computeTieredMargin(netPriceSvc, ancillaryTiers);
              let pid = (svc.passenger_ids && svc.passenger_ids[0]) || null;
              if (!pid && !anyRealPassengerId) {
                pid = offerPassengerOrder[svcIdx] || null;
              }
              if (pid) {
                servicesByPassenger[pid] = {
                  serviceId: svc.id,
                  price: Math.round((netPriceSvc + marginSvc) * 100) / 100,
                  netPrice: netPriceSvc,
                  margin: marginSvc,
                  currency: svc.total_currency || 'EUR',
                };
              }
            });
            const svc = svcs[0] || null;
            const netPrice = svc ? parseFloat(svc.total_amount || 0) : null;
            const margin = netPrice != null ? computeTieredMargin(netPrice, ancillaryTiers) : 0;
            return {
              type: 'seat',
              designator: el.designator || null,
              available: svcs.length > 0,
              // Kept for backward compatibility — same values as before,
              // now explicitly documented as "first available passenger's
              // pricing", not "the only price". New code should use
              // servicesByPassenger instead.
              serviceId: svc ? svc.id : null,
              price: netPrice != null ? Math.round((netPrice + margin) * 100) / 100 : null,
              netPrice,
              margin,
              currency: svc ? (svc.total_currency || 'EUR') : null,
              servicesByPassenger,
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
//
// [PRICE-CHECK + ADMIN-MARGIN] The server NEVER trusts amounts the browser
// sends. computeAuthoritativePricing() re-derives everything from Duffel's
// live offer + the admin's own margin tiers + the server's own promo_codes
// table: the exact net amount Duffel must be paid, the ticket/ancillary
// margins, any promo discount, and the final customer charge. The
// browser's duffel_amount is used ONLY to detect fare drift (so we can
// show the customer a "price changed" prompt) — it never affects what
// actually gets charged or booked.
app.post('/create-checkout-session', rateLimit('pay', 15, 60000), attachUserIfPresent, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });

    const {
      offer_id, passengers, services = [],
      duffel_amount, customer_amount, currency = 'EUR', promo_code, device_id,
      route_label, success_url, cancel_url,
    } = req.body;

    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });
    if (!passengers?.length) return res.status(400).json({ ok: false, error: 'بيانات المسافرين مطلوبة' });

    let pricing;
    try {
      // [LOYALTY-TIMING-FIX] true — this IS the actual checkout/payment
      // step, the only point where a loyalty discount should ever apply.
      pricing = await computeAuthoritativePricing(offer_id, services, promo_code, device_id, req.userId, true);
    } catch (e) {
      log('warn', 'pricing_compute_failed', { offer_id, error: e.message });
      return res.status(409).json({ ok: false, code: 'OFFER_UNAVAILABLE', error: 'Dieses Angebot ist nicht mehr verfügbar. Bitte erneut suchen.' });
    }

    // [PRICE-CHECK] Compare the server's fresh net Duffel cost against what
    // the browser last showed, to detect fare drift BEFORE any money moves.
    // [PRICE-DISPLAY-BUG-FIX] The trigger condition used to compare only
    // the raw NET Duffel amounts (duffel_amount old vs. pricing.duffelAmount
    // fresh) — a real screenshot showed "Vorheriger Preis: 1.208€" and
    // "Neuer Preis: 1.208€", the exact same customer-facing number, with
    // the "price changed" sheet still popping up. That's because a net
    // price move of just a few cents (enough to cross the old >= 0.5
    // threshold) can land on a margin tier boundary or simply round away
    // to nothing once margin is added and the result is rounded to the
    // nearest cent for display — the number actually shown to the
    // customer never moved at all, but the dialog interrupting their
    // checkout fired anyway based on an internal figure they never see.
    // The trigger now checks the REAL customer-facing difference
    // (customerAmount, including margin/discount) instead — if that
    // number is identical (or differs by less than half a cent, i.e.
    // would format to the same value), nothing is shown and checkout
    // proceeds normally, regardless of how much the underlying net cost
    // moved internally.
    if (duffel_amount != null && customer_amount != null) {
      const oldCustomerAmount = Math.round(Number(customer_amount) * 100) / 100;
      const customerDiff = Math.round((pricing.customerAmount - oldCustomerAmount) * 100) / 100;
      if (Math.abs(customerDiff) >= 0.01) {
        const oldAmount = Math.round(Number(duffel_amount) * 100) / 100;
        const diff = Math.round((pricing.duffelAmount - oldAmount) * 100) / 100;
        log('info', 'price_changed_before_checkout', { offer_id, old: oldAmount, fresh: pricing.duffelAmount, diff, old_customer: oldCustomerAmount, new_customer: pricing.customerAmount, customer_diff: customerDiff });
        return res.status(409).json({
          ok: false,
          code: 'PRICE_CHANGED',
          error: 'Der Preis hat sich geändert',
          old_amount: oldAmount,
          new_amount: pricing.duffelAmount,
          old_customer_amount: oldCustomerAmount,
          new_customer_amount: pricing.customerAmount,
          currency: pricing.currency,
          diff,
        });
      }
    }

    if (pricing.customerAmount <= 0) return res.status(400).json({ ok: false, error: 'Betrag ungültig' });
    if (promo_code && pricing.promoStatus && pricing.promoStatus !== 'applied') {
      // Customer typed a code but it isn't valid — fail loudly so the
      // frontend can tell them, instead of silently charging full price.
      return res.status(400).json({ ok: false, code: 'PROMO_INVALID', error: 'Aktionscode ungültig oder abgelaufen', promo_status: pricing.promoStatus });
    }

    // Stripe wants the amount in the smallest currency unit (cents)
    const amountCents = Math.round(pricing.customerAmount * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: pricing.currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: route_label ? ('Flug ' + route_label) : 'Flugbuchung (FlyWise)' },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { flywise: '1' },
    });

    // Store booking payload server-side, keyed by session id. Only a small
    // marker goes into Stripe metadata. Everything needed to both book with
    // Duffel (offer_id, services) and record accurate financials later
    // (margins, discount, promo, loyalty) is persisted here — never
    // recomputed from browser input again after this point.
    await rememberBooking(session.id, {
      offer_id,
      passengers,
      services: pricing.safeServices,
      duffel_amount: String(pricing.duffelAmount),
      currency: pricing.currency,
      route_label,
      ticket_margin: pricing.ticketMargin,
      ancillary_margin: pricing.servicesMargin,
      discount_amount: pricing.discount,
      promo_code: pricing.promo ? pricing.promo.code : null,
      promo_id: pricing.promo ? pricing.promo.id : null,
      loyalty_discount: pricing.loyaltyDiscount,
      device_id: device_id || null,
      user_id: req.userId || null,
      customer_amount: pricing.customerAmount,
    });
    setBookingStatus(session.id, 'pending');
    log('info', 'checkout_created', { session: session.id, duffel_amount: pricing.duffelAmount, customer_amount: pricing.customerAmount, promo: pricing.promo ? pricing.promo.code : null, loyalty_discount: pricing.loyaltyDiscount });


    res.json({ ok: true, session_id: session.id, url: session.url, customer_amount: pricing.customerAmount, currency: pricing.currency });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /price-preview ───────────────────────────────────
// [PRICE-SYNC-FIX] Read-only preview of the EXACT amount the customer would
// be charged right now, using the same computeAuthoritativePricing() used
// by /create-checkout-session — never a separately-maintained calculation.
// Why this exists: the booking flow shows prices pulled from three
// independent calls (/offer, /seatmaps, then checkout), each hitting
// Duffel separately. Duffel's net price can drift between those calls
// (normal for live fares), so the margin computed on slightly different
// net prices can round into a different tier and produce a few extra
// euros the customer never agreed to. Calling this endpoint right before
// showing any "final" number (seat step running total, summary, payment
// screen) collapses that drift window to effectively zero — the frontend
// always displays what the server would actually charge, instead of
// recomputing locally from possibly-stale per-step prices.
// Does NOT create a Stripe session or touch Duffel order state — purely a
// price quote, safe to call as often as the UI needs.
app.post('/price-preview', rateLimit('pay', 30, 60000), attachUserIfPresent, async (req, res) => {
  try {
    const { offer_id, services = [], promo_code, device_id, duffel_amount, apply_loyalty } = req.body;
    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });

    let pricing;
    try {
      // [LOYALTY-TIMING-FIX] false by default — /price-preview is normally
      // called from the baggage/seat steps (syncPriceWithServer in the
      // frontend) to keep the running total in sync with the server while
      // the customer is still browsing extras; a loyalty discount must not
      // appear there.
      // [LOYALTY-PREVIEW-FIX] The payment step (step 5) now explicitly
      // passes apply_loyalty:true to get the REAL server-side discount
      // before showing any price to the customer — never the frontend's
      // own loyaltyData.credit, which lives in localStorage and can go
      // stale (e.g. a previous device sync failed silently, or the credit
      // was already spent/changed server-side since the last successful
      // sync). Without this, the payment screen showed a discount the
      // server didn't actually have, and /create-checkout-session's own
      // (correct) recomputation kept disagreeing with it — surfacing as
      // the same "Der Preis hat sich geändert" dialog on every booking.
      pricing = await computeAuthoritativePricing(offer_id, services, promo_code, device_id, req.userId, !!apply_loyalty);
    } catch (e) {
      log('warn', 'price_preview_failed', { offer_id, error: e.message });
      return res.status(409).json({ ok: false, code: 'OFFER_UNAVAILABLE', error: 'Dieses Angebot ist nicht mehr verfügbar. Bitte erneut suchen.' });
    }

    // Optional drift flag: if the caller passed the price it last showed,
    // tell it whether that figure is still accurate (>= 0.5 unit diff —
    // same threshold as /create-checkout-session — counts as "changed").
    let changed = false, diff = 0;
    if (duffel_amount != null) {
      const oldAmount = Math.round(Number(duffel_amount) * 100) / 100;
      diff = Math.round((pricing.duffelAmount - oldAmount) * 100) / 100;
      changed = Math.abs(diff) >= 0.5;
    }

    res.json({
      ok: true,
      currency: pricing.currency,
      duffel_amount: pricing.duffelAmount,
      customer_amount: pricing.customerAmount,
      ticket_margin: pricing.ticketMargin,
      services_margin: pricing.servicesMargin,
      discount: pricing.discount,
      loyalty_discount: pricing.loyaltyDiscount,
      loyalty_account: pricing.loyaltyAccount,
      promo_status: pricing.promoStatus,
      changed, diff,
    });
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

// ─── GET /booking-confirmation ──────────────────────────────
// [CONFIRMATION-FIX] The single source of truth for any "booking
// confirmation" screen — used identically right after checkout AND from
// "Meine Buchungen". Accepts either ?session_id= (right after Stripe
// redirects back) or ?order_id= (viewing a past booking).
//
// Two previously-separate, inconsistent paths fed the confirmation screen:
//   - checkStripeReturn() rebuilt a sparse offer object from sessionStorage
//     (no flight times/airline/seats/bags — set before the customer even
//     paid) and showed order.total_amount (Duffel's NET price) as the total.
//   - openBookingDetail() fetched live from Duffel only, also showing the
//     net amount, with no margin/discount/loyalty breakdown at all.
// Neither one showed what the customer actually paid (with margin, minus
// any promo/loyalty discount) — only Duffel's net cost. This endpoint
// fixes that by joining our own `bookings` record (the real money: 
// customer_paid, discount_amount, loyalty_discount, margins) with Duffel's
// live order (the real flight: segments, baggage, seat selections),
// so every confirmation screen — immediate or revisited later — shows
// the exact same numbers and details.
app.get('/booking-confirmation', async (req, res) => {
  try {
    const { session_id, order_id } = req.query;
    if (!session_id && !order_id) return res.status(400).json({ ok: false, error: 'session_id oder order_id erforderlich' });

    // 1) Our own financial record — the real customer_paid/discount/margin.
    let bookingRow = null;
    if (supa) {
      let q = supa.from('bookings').select('*');
      q = session_id ? q.eq('stripe_session_id', session_id) : q.eq('duffel_order_id', order_id);
      const { data } = await q.maybeSingle();
      bookingRow = data || null;
    }

    // 2) Resolve the Duffel order id (from our record, or directly if the
    // caller already has it) and fetch the live order for flight/seat/bag
    // details — Duffel is the only source for those.
    const resolvedOrderId = (bookingRow && bookingRow.duffel_order_id) || order_id || null;
    let order = null;
    if (resolvedOrderId) {
      try {
        const result = await duffel('GET', `/air/orders/${resolvedOrderId}`);
        order = result.data;
      } catch (e) {
        log('warn', 'booking_confirmation_duffel_fetch_failed', { resolvedOrderId, error: e.message });
      }
    }

    if (!bookingRow && !order) {
      return res.status(404).json({ ok: false, error: 'Buchung nicht gefunden' });
    }

    res.json({
      ok: true,
      order,
      booking: bookingRow ? {
        reference: bookingRow.booking_reference,
        orderId: bookingRow.duffel_order_id,
        status: bookingRow.status,
        currency: bookingRow.currency,
        duffelAmount: Number(bookingRow.duffel_amount) || 0,
        ticketMargin: Number(bookingRow.ticket_margin) || 0,
        ancillaryMargin: Number(bookingRow.ancillary_margin) || 0,
        discountAmount: Number(bookingRow.discount_amount) || 0,
        promoCode: bookingRow.promo_code || null,
        loyaltyDiscount: Number(bookingRow.loyalty_discount) || 0,
        customerPaid: Number(bookingRow.customer_paid) || 0,
        createdAt: bookingRow.created_at,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

// ─── [FIX] Contact form — was previously fake (cleared fields, sent nothing).
// Now actually delivers the message to support via Brevo.
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@airpiv.com';
app.post('/contact', rateLimit('contact', 5, 60000), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Name, E-Mail und Nachricht sind erforderlich' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Ungültige E-Mail-Adresse' });
    }
    const safeName = String(name).slice(0, 200);
    const safeSubject = String(subject || 'Kontaktformular').slice(0, 200);
    const safeMessage = String(message).slice(0, 5000);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0FB5A0">📩 Neue Nachricht über das Kontaktformular</h2>
        <p><strong>Von:</strong> ${escapeHtml(safeName)} (${escapeHtml(email)})</p>
        <p><strong>Betreff:</strong> ${escapeHtml(safeSubject)}</p>
        <div style="background:#f6f8fa;border-radius:8px;padding:14px;margin-top:10px;white-space:pre-wrap">${escapeHtml(safeMessage)}</div>
      </div>`;

    const sent = await sendEmail(SUPPORT_EMAIL, `Kontaktformular: ${safeSubject}`, html);
    if (!sent) return res.status(502).json({ ok: false, error: 'Nachricht konnte nicht gesendet werden' });
    log('info', 'contact_form_sent', { from: email });
    res.json({ ok: true });
  } catch (err) {
    log('error', 'contact_form_failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'Interner Fehler' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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
async function validateServices(offerId, services, preFetchedAvailable) {
  if (!Array.isArray(services) || !services.length) return [];
  let available = preFetchedAvailable;
  if (!available) {
    try {
      const r = await duffel('GET', `/air/offers/${offerId}?return_available_services=true`);
      available = (r.data && r.data.available_services) || [];
    } catch (e) {
      log('warn', 'validateServices_fetch_failed', { error: e.message });
      return services; // fall through; Duffel will be the final judge
    }
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

// ─── [ADMIN-MARGIN] Promo code lookup + validation (server-authoritative) ──
// Replaces the old hardcoded PROMO_CODES object that used to live in the
// frontend (visible to anyone via devtools, no real usage cap). The server
// is now the only place a code is checked or applied.
async function lookupPromoCode(code) {
  if (!code || !supa) return null;
  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return null;
  try {
    const { data, error } = await supa.from('promo_codes').select('*').eq('code', normalized).maybeSingle();
    if (error || !data) return null;
    if (!data.active) return { valid: false, reason: 'inactive' };
    if (data.expires_at && new Date(data.expires_at) < new Date()) return { valid: false, reason: 'expired' };
    if (data.max_uses != null && data.used_count >= data.max_uses) return { valid: false, reason: 'max_uses_reached' };
    return { valid: true, row: data };
  } catch (e) {
    log('warn', 'promo_lookup_failed', { code: normalized, error: e.message });
    return null;
  }
}

function computePromoDiscount(promoRow, subtotal) {
  if (!promoRow) return 0;
  const raw = promoRow.type === 'percent' ? subtotal * (Number(promoRow.value) || 0) / 100 : Number(promoRow.value) || 0;
  // Never discount more than the subtotal itself (no negative totals).
  return Math.round(Math.min(Math.max(raw, 0), subtotal) * 100) / 100;
}

async function incrementPromoUsage(promoId) {
  if (!supa || !promoId) return;
  try {
    // Atomic increment via Postgres RPC would be ideal; a plain update is
    // fine here since usage races are low-stakes (worst case: max_uses is
    // off by one in a rare concurrent-checkout edge case).
    const { data } = await supa.from('promo_codes').select('used_count').eq('id', promoId).maybeSingle();
    const next = ((data && data.used_count) || 0) + 1;
    await supa.from('promo_codes').update({ used_count: next }).eq('id', promoId);
  } catch (e) {
    log('warn', 'promo_increment_failed', { promoId, error: e.message });
  }
}

// ─── [ADMIN-MARGIN] Server-authoritative full price computation ───────────
// THE single source of truth for what Duffel gets paid vs. what the
// customer is charged. Never trusts amounts the browser sends — re-derives
// everything from Duffel's live offer + the server's own margin tiers +
// the server's own promo_codes table. Used by BOTH /create-checkout-session
// (before payment) and bookFromSession (right before booking), so the two
// can never disagree.
async function computeAuthoritativePricing(offerId, requestedServices, promoCode, deviceId, userId, applyLoyalty) {
  // [SEAT-PRICING-FIX] Per Duffel's own seat-maps docs: "A seat is a
  // special kind of service in that they're NOT shown when getting an
  // individual offer with return_available_services set to true. They're
  // only available through [the seat maps] endpoint." available_services
  // on the offer endpoint only ever contains baggage. Before this fix,
  // validateServices() checked every requested service (seats AND bags)
  // against available_services alone — so a chosen seat could never be
  // found there, got silently dropped ("service_dropped_unavailable"),
  // and contributed exactly 0 to both the net Duffel cost and the margin.
  // That's precisely how a customer could pick a seat, see its real price
  // appear for a moment (computed client-side from /seatmaps data), and
  // then watch it vanish moments later once syncPriceWithServer() replaced
  // the total with the server's recomputed (seat-less) figure — the seat
  // was never actually being charged for or reliably booked. Fetching
  // seat maps here too and merging their priced seat services into the
  // same lookup table available_services uses fixes both the live total
  // AND what's actually validated/charged at checkout.
  const [offerCheck, seatMapsResult] = await Promise.all([
    duffel('GET', `/air/offers/${offerId}?return_available_services=true`),
    duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`).catch(() => ({ data: [] })),
  ]);
  const baggageServices = (offerCheck.data && offerCheck.data.available_services) || [];
  const seatServices = [];
  for (const sm of (seatMapsResult.data || [])) {
    for (const cabin of (sm.cabins || [])) {
      for (const row of (cabin.rows || [])) {
        for (const section of (row.sections || [])) {
          for (const el of (section.elements || [])) {
            if (el.type === 'seat' && Array.isArray(el.available_services)) {
              for (const svc of el.available_services) seatServices.push(svc);
            }
          }
        }
      }
    }
  }
  const avail = baggageServices.concat(seatServices);
  const safeServices = await validateServices(offerId, requestedServices || [], avail);

  const netTicketPrice = parseFloat(offerCheck.data && offerCheck.data.total_amount || 0);
  const currency = (offerCheck.data && offerCheck.data.total_currency) || 'EUR';

  const ticketTiers = await getTicketProfitTiers();
  const ancillaryTiers = await getAncillaryProfitTiers();
  // [PRICING-FIX] Same per-passenger margin logic as normalizeOffer() —
  // the fixed-amount part of a tier (e.g. "+500€") is meant to apply once
  // PER PASSENGER, not once for the whole multi-passenger booking. Duffel
  // only gives us one combined total_amount, never a per-passenger
  // breakdown, so we split it evenly across passengers as the best
  // available approximation, apply the tier to that per-passenger share,
  // then sum back up. This is the number actually charged at checkout, so
  // it must match normalizeOffer()'s math exactly or the price a customer
  // sees while searching will drift from what they're charged.
  const ticketPassengerCount = Math.max(1, (offerCheck.data && offerCheck.data.passengers || []).length);
  const netPerPassenger = netTicketPrice / ticketPassengerCount;
  const marginPerPassenger = computeTieredMargin(netPerPassenger, ticketTiers);
  const ticketMargin = Math.round(marginPerPassenger * ticketPassengerCount * 100) / 100;

  const byId = new Map(avail.map((s) => [s.id, s]));
  let netServicesTotal = 0, servicesMargin = 0;
  for (const svc of safeServices) {
    const av = byId.get(svc.id);
    if (!av || !av.total_amount) continue;
    const qty = svc.quantity || 1;
    const netUnit = parseFloat(av.total_amount);
    netServicesTotal += netUnit * qty;
    servicesMargin += computeTieredMargin(netUnit, ancillaryTiers) * qty;
  }
  netServicesTotal = Math.round(netServicesTotal * 100) / 100;
  servicesMargin = Math.round(servicesMargin * 100) / 100;

  // What Duffel must be paid: its exact net price, margin NEVER included.
  const duffelAmount = Math.round((netTicketPrice + netServicesTotal) * 100) / 100;
  // What the customer would pay before any promo/loyalty discount.
  const preDiscountTotal = Math.round((netTicketPrice + ticketMargin + netServicesTotal + servicesMargin) * 100) / 100;

  let promoRow = null, promoDiscount = 0, promoStatus = null;
  if (promoCode) {
    const lookup = await lookupPromoCode(promoCode);
    if (lookup && lookup.valid) {
      promoRow = lookup.row;
      promoDiscount = computePromoDiscount(promoRow, preDiscountTotal);
      promoStatus = 'applied';
    } else {
      promoStatus = (lookup && lookup.reason) || 'invalid';
    }
  }

  // [LOYALTY-TIMING-FIX] The loyalty discount must only ever be COMPUTED
  // (and therefore shown as a price reduction) at the actual checkout
  // step — not while the customer is still browsing baggage/seat options.
  // Before this, /price-preview (called after every bag/seat toggle, to
  // keep the running total in sync with the server) used this exact same
  // function with no way to say "don't apply loyalty yet", so a logged-in
  // user with credit saw the discount kick in the moment they picked a
  // bag — long before they'd reached payment. We still look up the
  // account (loyaltyAccount) so its balance/tier can be shown for
  // informational purposes, but loyaltyDiscount itself stays 0 unless the
  // caller explicitly passes applyLoyalty=true.
  let loyaltyDiscount = 0, loyaltyAccount = null;
  if (userId) {
    const result = await computeLoyaltyDiscount('user', userId, preDiscountTotal);
    loyaltyAccount = result.account;
    if (applyLoyalty) loyaltyDiscount = result.discount;
  }

  const totalDiscount = Math.min(promoDiscount + loyaltyDiscount, preDiscountTotal);
  const customerAmount = Math.round((preDiscountTotal - totalDiscount) * 100) / 100;

  return {
    currency, safeServices,
    netTicketPrice, ticketMargin, netServicesTotal, servicesMargin,
    duffelAmount, preDiscountTotal, discount: totalDiscount, customerAmount,
    promo: promoRow ? { id: promoRow.id, code: promoRow.code, type: promoRow.type, value: promoRow.value } : null,
    promoStatus, promoDiscount,
    loyaltyKind: userId ? 'user' : null, loyaltyId: userId || null,
    loyaltyDiscount, loyaltyAccount: loyaltyAccount ? { credit: loyaltyAccount.credit, points: loyaltyAccount.points, tier: loyaltyAccount.tier } : null,
  };
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

  // [ADMIN-MARGIN] Re-derive pricing from scratch, exactly as
  // /create-checkout-session did — never trust the stored payload's
  // amounts blindly, since the offer/services could theoretically have
  // changed between checkout-session creation and the customer actually
  // paying. payAmount (sent to Duffel) is ALWAYS the net price with no
  // margin; customerAmount is for our own bookings record only (Stripe
  // already charged this at checkout-session time).
  let payAmount = booking.duffel_amount;
  let payCurrency = booking.currency || 'EUR';
  let safeServices = booking.services || [];
  let pricing = null;
  try {
    // [LOYALTY-TIMING-FIX] true — this runs right after Duffel actually
    // confirms the order, recomputing the same authoritative pricing used
    // at checkout-session creation. The loyalty discount the customer saw
    // (and was charged via Stripe) at the payment step must be re-applied
    // identically here so applyLoyaltyForBooking() below deducts the
    // correct amount from their real balance.
    pricing = await computeAuthoritativePricing(booking.offer_id, booking.services || [], booking.promo_code || null, booking.device_id || null, booking.user_id || null, true);
    payAmount = String(pricing.duffelAmount);
    payCurrency = pricing.currency;
    safeServices = pricing.safeServices;
  } catch (e) {
    log('warn', 'offer_revalidate_failed', { error: e.message });
    // [SEAT-PRICING-FIX] Same fix as computeAuthoritativePricing() — this
    // rare fallback path (only reached if that function itself threw) must
    // also check requested seat services against /seat_maps, not just
    // available_services (baggage-only), or a chosen seat would silently
    // get dropped here too and never actually get booked with Duffel.
    let fallbackAvail = [];
    try {
      const [offerRes, seatMapsRes] = await Promise.all([
        duffel('GET', `/air/offers/${booking.offer_id}?return_available_services=true`),
        duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(booking.offer_id)}`).catch(() => ({ data: [] })),
      ]);
      fallbackAvail = (offerRes.data && offerRes.data.available_services) || [];
      for (const sm of (seatMapsRes.data || [])) {
        for (const cabin of (sm.cabins || [])) {
          for (const row of (cabin.rows || [])) {
            for (const section of (row.sections || [])) {
              for (const el of (section.elements || [])) {
                if (el.type === 'seat' && Array.isArray(el.available_services)) {
                  for (const svc of el.available_services) fallbackAvail.push(svc);
                }
              }
            }
          }
        }
      }
    } catch (e2) { log('warn', 'fallback_avail_fetch_failed', { error: e2.message }); }
    safeServices = await validateServices(booking.offer_id, booking.services || [], fallbackAvail.length ? fallbackAvail : undefined);
    // fall through with the stored payload's amount; Duffel will be the final judge
  }

  // [PRICE-DRIFT-PROTECTION] The fare can genuinely change between the
  // customer reaching Stripe's hosted payment page and actually entering
  // their card details — Duffel's own docs note the price "can change
  // between booking and payment" when an offer has no price guarantee.
  // Stripe already charged the customer a FIXED amount (booking.customer_amount,
  // set at checkout-session creation — a Stripe Checkout Session's price
  // cannot be changed after creation). The pricing recomputed just above
  // is the CURRENT real fare, used to pay Duffel.
  //
  // Business rule (explicit, by design): only an INCREASE matters. If the
  // fare dropped, the customer simply paid a bit more than the new lower
  // price — that's accepted as-is, no refund, no interruption. If the
  // fare rose by more than 5 (currency units, e.g. €5), the booking is
  // stopped BEFORE any money moves to Duffel, the customer's card is
  // refunded in full, and the failure is logged clearly — instead of
  // paying Duffel the new higher amount while Stripe already collected
  // the old, lower one (a direct, silent loss to the company). No
  // percentage threshold is applied on top of the flat €5 — a €6 jump on
  // a €1000 booking (0.6%) is just as much a real fare increase as a €6
  // jump on a €50 booking, and both must be caught.
  const expectedCustomerAmount = Number(booking.customer_amount) || 0;
  const recomputedCustomerAmount = pricing ? pricing.customerAmount : expectedCustomerAmount;
  const priceDrift = Math.round((recomputedCustomerAmount - expectedCustomerAmount) * 100) / 100;
  if (expectedCustomerAmount > 0 && priceDrift > 5) {
    log('error', 'price_drift_blocked_booking', {
      session_id, offer_id: booking.offer_id,
      expected: expectedCustomerAmount, recomputed: recomputedCustomerAmount, drift: priceDrift,
    });
    if (stripe && session && session.payment_intent) {
      try {
        await stripe.refunds.create({ payment_intent: session.payment_intent });
        log('info', 'price_drift_refund_issued', { session_id, payment_intent: session.payment_intent });
      } catch (refundErr) {
        log('error', 'price_drift_refund_failed', { session_id, error: refundErr.message });
      }
    }
    setBookingStatus(session_id, 'failed_price_drift', { drift: priceDrift, expected: expectedCustomerAmount, recomputed: recomputedCustomerAmount });
    const e = new Error('Der Flugpreis hat sich vor der Bezahlung erheblich geändert. Deine Zahlung wurde vollständig zurückerstattet.');
    e.code = 'PRICE_DRIFT';
    e.priceDrift = priceDrift;
    throw e;
  }

  const result = await duffel('POST', '/air/orders', {
    data: {
      type: 'instant',
      selected_offers: [booking.offer_id],
      passengers: paxWithIds,
      payments: [{ type: 'balance', amount: String(payAmount), currency: payCurrency }],
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

    // [ADMIN-MARGIN] Persist the financial breakdown for the admin
    // dashboard (revenue/profit reporting) — separate from pending_bookings,
    // which only tracks the technical checkout-session lifecycle.
    // [ADMIN-DASHBOARD-FIX] discountAmount previously only ever read
    // booking.discount_amount — the value stored in the checkout-session
    // payload BEFORE payment. Every other figure here (ticketMargin,
    // ancillaryMargin, loyaltyUsed) already preferred the freshly
    // recomputed `pricing` object from computeAuthoritativePricing() just
    // above, which re-derives the discount from the live offer at booking
    // time. If the fare or services drifted between checkout-session
    // creation and actual payment, the admin dashboard's discount figure
    // could silently disagree with the other recomputed figures right
    // next to it — same inconsistency bug as the others, just on this
    // one field. Now matches the same "prefer fresh pricing" pattern.
    const ticketMargin = (pricing && pricing.ticketMargin) != null ? pricing.ticketMargin : (booking.ticket_margin || 0);
    const ancillaryMargin = (pricing && pricing.servicesMargin) != null ? pricing.servicesMargin : (booking.ancillary_margin || 0);
    const discountAmount = (pricing && pricing.discount) != null ? pricing.discount : (booking.discount_amount || 0);
    const loyaltyUsed = (pricing && pricing.loyaltyDiscount) || booking.loyalty_discount || 0;
    const customerPaid = booking.customer_amount != null ? Number(booking.customer_amount) : (pricing ? pricing.customerAmount : null);
    // [RACE-CONDITION-FIX] This was previously fire-and-forget
    // (.then(noop, logError), no await) — bookFromSession() returned to
    // the caller (and from there, the HTTP response went back to the
    // browser) WITHOUT waiting for this insert to actually land in
    // Supabase. The browser then immediately calls GET
    // /booking-confirmation?session_id=... to render the confirmation
    // screen — and that endpoint looks up this exact row by
    // stripe_session_id. With real network latency to Supabase, the
    // confirmation request could easily arrive before this insert had
    // finished, finding nothing and returning 404 — even though the
    // booking had genuinely succeeded seconds earlier (Duffel confirmed
    // it, the email had already sent) and the row would show up correctly
    // a moment later on a manual refresh. Awaiting this insert guarantees
    // the row exists by the time the customer's "payment succeeded"
    // response — and the confirmation-screen fetch that follows it — ever
    // reach the browser.
    try {
      const primaryPax = (booking.passengers && booking.passengers[0]) || {};
      const { error: bookingInsertError } = await supa.from('bookings').insert({
        stripe_session_id: session_id,
        duffel_order_id: orderId || null,
        booking_reference: bookingRef || null,
        route_label: booking.route_label || null,
        status: 'confirmed',
        passenger_count: (booking.passengers || []).length || 1,
        customer_email: primaryPax.email || null,
        // [ADMIN-CUSTOMER-INFO] Primary passenger's contact/identity
        // details — already present on every booking payload (Duffel and
        // Stripe both require them), just not previously saved anywhere
        // queryable. Lets the admin dashboard show who actually booked,
        // not just their email.
        customer_name: `${primaryPax.given_name || ''} ${primaryPax.family_name || ''}`.trim() || null,
        customer_phone: primaryPax.phone_number || null,
        customer_dob: primaryPax.born_on || null,
        // [GUEST-LINK] If this customer was already logged in at checkout,
        // record it now — no need to wait for the retroactive-linking flow
        // at all. Stays null for a true guest checkout, exactly as before.
        user_id: booking.user_id || null,
        currency: payCurrency,
        duffel_amount: Number(payAmount),
        ticket_margin: ticketMargin,
        ancillary_margin: ancillaryMargin,
        discount_amount: discountAmount,
        promo_code: booking.promo_code || null,
        loyalty_discount: loyaltyUsed,
        customer_paid: customerPaid,
      });
      if (bookingInsertError) log('error', 'supa_booking_insert_failed', { error: bookingInsertError.message });
    } catch (e) {
      log('error', 'supa_booking_insert_failed', { error: e.message });
    }

    // [ADMIN-MARGIN] Bump the promo code's usage counter now that the
    // booking is actually confirmed (not at checkout-session creation,
    // when the customer might still abandon payment).
    if (booking.promo_id) incrementPromoUsage(booking.promo_id).then(function(){}, function(){});

    // [LOYALTY-FIX] Only a real logged-in user has a loyalty account to
    // credit/debit at all now — computeAuthoritativePricing() never
    // computes a device-scoped discount or creates a device account
    // anymore, so loyaltyUsed is always 0 here for an anonymous booking.
    // The old device_id fallback is removed rather than left as dead code
    // that could silently start working again if loyaltyUsed were ever
    // populated some other way.
    if (booking.user_id) applyLoyaltyForBooking('user', booking.user_id, loyaltyUsed, customerPaid).then(function(){}, function(){});
  }

  // [EMAIL-SEAT-FIX] The order data we just got back from POST
  // /air/orders may not yet include full passenger/seat detail — Duffel's
  // own docs note "there may be cases when the reservation is confirmed
  // but order information is not immediately available" for the create
  // response. Fetch the order fresh via GET before building anything the
  // email needs seat data for; retry briefly if the first fetch still
  // comes back without seats, since this whole block runs after the
  // customer's HTTP response has already gone out (the email send is
  // fire-and-forget) so a short delay here is invisible to them.
  let freshOrderData = result.data;
  if (orderId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fresh = await duffel('GET', `/air/orders/${orderId}`);
        if (fresh && fresh.data) {
          freshOrderData = fresh.data;
          const hasAnySeat = (fresh.data.slices || []).some((sl) =>
            (sl.segments || []).some((sg) => (sg.passengers || []).some((p) => p.seat && p.seat.designator))
          );
          // Only the FIRST attempt is unconditional — if any services were
          // requested at all (seats or bags) but no seat shows up yet,
          // retrying twice more (with a short pause) gives Duffel's sync a
          // little more time without noticeably delaying the email. If
          // nothing was requested, there's nothing to wait for.
          const anyServicesRequested = (safeServices || []).length > 0;
          if (hasAnySeat || !anyServicesRequested) break;
        }
      } catch (e) {
        log('warn', 'order_refetch_for_email_failed', { attempt, error: e.message });
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // 7) Send a real booking confirmation email (best-effort, never blocks the response)
  const recipientEmail = (booking.passengers && booking.passengers[0] && booking.passengers[0].email) || null;
  if (recipientEmail && bookingRef) {
    // [EMAIL-FIX] Build the same structured summary the in-app confirmation
    // screen uses (flight segments, seats, bags, real ticket/bags/seats/
    // discount breakdown) — freshOrderData is the just-refetched live
    // Duffel order (see [EMAIL-SEAT-FIX] above), and the margin/discount
    // figures were already computed moments ago by
    // computeAuthoritativePricing() above. Wrapped in try/catch since this
    // is purely cosmetic for the email — a failure here must never stop
    // the email from sending with at least the basic reference + total it
    // had before.
    let orderSummary = null;
    try {
      orderSummary = buildOrderSummaryForEmail(freshOrderData, {
        ticketMargin: (pricing && pricing.ticketMargin) != null ? pricing.ticketMargin : (booking.ticket_margin || 0),
        ancillaryMargin: (pricing && pricing.servicesMargin) != null ? pricing.servicesMargin : (booking.ancillary_margin || 0),
        discountAmount: booking.discount_amount || 0,
        loyaltyDiscount: (pricing && pricing.loyaltyDiscount) || booking.loyalty_discount || 0,
        promoCode: booking.promo_code || null,
        customerPaid: booking.customer_amount != null ? Number(booking.customer_amount) : (pricing ? pricing.customerAmount : null),
      });
    } catch (e) {
      log('warn', 'order_summary_for_email_failed', { error: e.message });
    }
    sendBookingConfirmationEmail(recipientEmail, {
      bookingRef,
      orderId,
      route: booking.route_label || '',
      passengers: booking.passengers || [],
      totalAmount: result.data?.total_amount,
      currency: result.data?.total_currency,
      orderSummary,
    }).then(function(){}, function(){});
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
    // [PRICE-DRIFT-PROTECTION] This case already refunded the customer in
    // full inside bookFromSession() before throwing — it's a handled,
    // safe outcome (no money is stuck anywhere), not the "customer was
    // charged with no ticket and no refund" emergency the Sentry alert
    // below exists for. Logged normally, but skips the critical-alert path.
    if (err.code === 'PRICE_DRIFT') {
      log('warn', 'booking_blocked_price_drift', { message: err.message, drift: err.priceDrift });
      return res.status(409).json({
        ok: false, error: err.message, code: 'PRICE_DRIFT',
        booking_failed_after_payment: true, refunded: true,
      });
    }
    // Payment succeeded but booking failed → surface clearly so support can refund/retry
    setBookingStatus(req.body && req.body.session_id, 'failed', { error: err.message });
    log('error', 'booking_failed_after_payment', { message: err.message, status: err.status, duffel_errors: err.details });
    console.error('[BOOKING FAILED AFTER PAYMENT] message=' + (err.message || '') +
      ' | status=' + (err.status || '') +
      ' | duffel_errors=' + JSON.stringify(err.details || {}));
    // [#8] This is the single most important error in the whole app — a
    // customer was charged but has no ticket. Send it to Sentry with full
    // context so it's impossible to miss (Sentry can alert by email/Slack).
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { critical: 'booking_failed_after_payment' },
        extra: { session_id: req.body && req.body.session_id, duffel_errors: err.details },
      });
    }
    res.status(err.status || 500).json({
      ok: false,
      error: err.message,
      details: err.details,
      duffel_errors: err.details,
      booking_failed_after_payment: true,
    });
  }
});

// ─── POST /add-services ───────────────────────────────────
// Adds seats or baggage to an EXISTING confirmed order via Duffel's
// order_change API. Applies the ancillary margin (same tiers as checkout)
// and charges the customer the marked-up amount via a new Stripe session.
// The net Duffel price (without margin) is what actually goes to Duffel.
app.post('/add-services', rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { order_id, services, success_url, cancel_url, route_label } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });
    if (!Array.isArray(services) || !services.length) return res.status(400).json({ ok: false, error: 'services مطلوب' });

    // 1) Fetch the order to get offer_id and available services
    const orderRes = await duffel('GET', `/air/orders/${order_id}`);
    const order = orderRes.data;
    if (!order) return res.status(404).json({ ok: false, error: 'الحجز غير موجود' });

    // 2) Fetch available services for this order's offer
    const offerRes = await duffel('GET', `/air/offers/${order.offer_id}?return_available_services=true`).catch(() => null);
    const available = (offerRes && offerRes.data && offerRes.data.available_services) || [];
    const byId = new Map(available.map(s => [s.id, s]));

    // 3) Compute the net Duffel cost + our ancillary margin for requested services
    const ancillaryTiers = await getAncillaryProfitTiers();
    let netTotal = 0, marginTotal = 0;
    const validServices = [];
    for (const svc of services) {
      const av = byId.get(svc.id);
      if (!av) { log('warn', 'add_service_not_available', { id: svc.id, order_id }); continue; }
      const qty = Math.max(1, Math.min(Number(svc.quantity) || 1, Number(av.maximum_quantity) || 1));
      const netUnit = parseFloat(av.total_amount || 0);
      const margin = computeTieredMargin(netUnit, ancillaryTiers);
      netTotal += netUnit * qty;
      marginTotal += margin * qty;
      validServices.push({ id: svc.id, quantity: qty, netUnit, margin });
    }
    netTotal = Math.round(netTotal * 100) / 100;
    marginTotal = Math.round(marginTotal * 100) / 100;
    const customerAmount = Math.round((netTotal + marginTotal) * 100) / 100;

    if (!validServices.length) return res.status(400).json({ ok: false, error: 'لا توجد خدمات صالحة' });
    if (customerAmount <= 0) return res.status(400).json({ ok: false, error: 'المبلغ غير صالح' });

    const currency = (available[0] && available[0].total_currency) || 'EUR';

    // 4) Create Stripe session for the customer-facing amount (net + margin)
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: Math.round(customerAmount * 100),
          product_data: { name: route_label ? ('Zusatzleistungen · ' + route_label) : 'Zusatzleistungen' },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?add_session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { airpiv_add_services: '1', order_id },
    });

    // 5) Store payload server-side so confirm can book with Duffel at net price
    await rememberBooking('add_' + session.id, {
      type: 'add_services',
      order_id,
      services: validServices.map(s => ({ id: s.id, quantity: s.quantity })),
      net_amount: netTotal,
      ancillary_margin: marginTotal,
      customer_amount: customerAmount,
      currency,
      route_label: route_label || null,
    });

    log('info', 'add_services_checkout_created', { order_id, session: session.id, net: netTotal, customer: customerAmount });
    res.json({ ok: true, session_id: session.id, url: session.url, customer_amount: customerAmount, currency });
  } catch (err) {
    log('error', 'add_services_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /confirm-add-services ───────────────────────────
// Called after Stripe confirms payment for post-booking service addition.
// Submits the order change to Duffel at the NET price (no margin).
app.post('/confirm-add-services', rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, error: 'session_id مطلوب' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      return res.status(402).json({ ok: false, error: 'الدفع لم يتم تأكيده' });
    }

    const entry = await getPendingBooking('add_' + session_id);
    if (!entry) return res.status(400).json({ ok: false, error: 'بيانات الطلب غير موجودة' });
    const payload = entry.payload;

    // Submit order change to Duffel at NET price (our margin stays with us)
    const changeReq = await duffel('POST', '/air/order_change_requests', {
      data: {
        order_id: payload.order_id,
        services: payload.services,
      },
    });
    const changeId = changeReq.data && changeReq.data.id;
    if (!changeId) throw new Error('Duffel order_change_request fehlgeschlagen');

    // Confirm the change
    await duffel('POST', `/air/order_change_requests/${changeId}/actions/confirm`, {
      data: { payment: { type: 'balance', amount: String(payload.net_amount), currency: payload.currency } },
    });

    // Record ancillary margin in bookings table (best-effort)
    if (supa) {
      supa.from('bookings').update({
        ancillary_margin: supa.rpc ? undefined : null, // can't do += in REST easily; log separately
      }).eq('duffel_order_id', payload.order_id).then(function(){}, function(){});

      supa.from('payments').insert({
        stripe_session_id: session_id,
        stripe_payment_id: session.payment_intent || null,
        amount: payload.customer_amount,
        currency: payload.currency,
        status: 'paid',
        note: 'add_services · order ' + payload.order_id,
      }).then(function(){}, function(e){ log('error', 'supa_add_services_payment_failed', { error: e.message }); });
    }

    log('info', 'add_services_confirmed', { order_id: payload.order_id, change_id: changeId });
    res.json({ ok: true, change_id: changeId, order_id: payload.order_id });
  } catch (err) {
    log('error', 'confirm_add_services_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});


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

    // [ADMIN-CANCEL-SYNC-FIX] Reflect the real cancellation in our own
    // bookings table — previously this only happened via a client-side
    // Supabase update with a wrong column name (order_id instead of
    // duffel_order_id), which silently matched nothing every time, AND ran
    // with the browser's anon key rather than server-side. The admin
    // dashboard showed every customer-cancelled booking as still
    // "confirmed" forever, with a real refund already issued, until
    // someone happened to notice and fix it manually.
    if (supa) {
      supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', order_id)
        .then(({ data, error }) => {
          if (error) { log('error', 'admin_cancel_sync_failed', { order_id, error: error.message }); return; }
          // [CANCEL-NOTIFY-FIX] This is a CUSTOMER cancelling their own
          // booking (via this public /cancel endpoint), not the admin
          // cancelling something from the dashboard — the admin has no
          // other way to find out this happened unless they happen to
          // check the bookings table. Record it so the dashboard can show
          // an unread-count badge.
          recordCancellationEvent({ order_id, refund_amount: confirmed.data?.refund_amount || null });
        });
    }

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
    const { cancellation_id, order_id } = req.body;
    if (!cancellation_id) return res.status(400).json({ ok: false, error: 'cancellation_id مطلوب' });
    const confirmed = await duffel('POST', `/air/order_cancellations/${cancellation_id}/actions/confirm`, {});

    // [ADMIN-CANCEL-SYNC-FIX] Same fix as /cancel above — keep the admin
    // dashboard's bookings table in sync with a real, confirmed
    // cancellation. order_id isn't always known to the frontend at this
    // point in the quote→confirm flow, so this is best-effort: if it's
    // missing, the booking stays marked confirmed here and relies on
    // whatever other reconciliation exists, rather than guessing at a
    // lookup that could match the wrong row.
    if (supa && order_id) {
      supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', order_id)
        .then(({ error }) => { if (error) log('error', 'admin_cancel_sync_failed', { order_id, error: error.message }); });
    }

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

// ════════════════════════════════════════════════════════════
// [USER-AUTH] Customer account endpoint
// Registration, login, Google OAuth, email verification, and password
// reset are all handled directly by Supabase Auth from the frontend (via
// the publishable key) — not by this server. This endpoint exists purely
// to hand the frontend a combined "who is this + what's their loyalty
// balance" view in one call, using the access token Supabase already
// issued.
// ════════════════════════════════════════════════════════════

// ─── GET /auth/me ───────────────────────────────────────────────
// Returns the logged-in user's profile + loyalty balance in one call, so
// the frontend can render the account badge right after page load.
app.get('/auth/me', attachUserIfPresent, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const account = await getOrCreateLoyaltyAccount('user', req.userId);
    // [TIER-PROGRESS-FIX] lifetime_points falls back to points for accounts
    // created before that column existed, so this never returns undefined.
    res.json({ ok: true, userId: req.userId, loyalty: account ? {
      credit: account.credit,
      points: account.points,
      lifetime_points: account.lifetime_points != null ? account.lifetime_points : account.points,
      tier: account.tier,
    } : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /loyalty/redeem ─────────────────────────────────────
// [TIER-DEMOTION-FIX / POINTS-RESET-FIX] Converts points to euro credit
// entirely server-side, against the real loyalty_accounts row — the
// frontend used to do this conversion locally (loyaltyConvertPoints()),
// only ever writing the result to localStorage. That had two bugs: (1) the
// server's own balance never changed, so the very next sync (e.g. after
// logging back in) overwrote the "converted" state with the original,
// untouched numbers — points appeared to silently come back; and (2)
// because the frontend derived tier from the now-lower points balance,
// redeeming enough points could drop a customer who'd already reached
// Silver/Gold back down a tier. Both are fixed by making this the only
// place redemption happens: it updates `points` (spendable) but never
// touches `lifetime_points` (tier-determining), and the new balance is
// read back from the database, not computed by the client.
app.post('/loyalty/redeem', attachUserIfPresent, rateLimit('loyalty-redeem', 20, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

    const pointsToRedeem = Math.floor(Number(req.body && req.body.points));
    if (!pointsToRedeem || pointsToRedeem <= 0) {
      return res.status(400).json({ ok: false, error: 'Ungültige Punktezahl' });
    }

    const cfg = await getLoyaltyConfig();
    const pointsPerEuro = Number(cfg.pointsPerEuroRedeem) || 400;
    if (pointsToRedeem % pointsPerEuro !== 0) {
      return res.status(400).json({ ok: false, error: 'Punktezahl muss ein Vielfaches von ' + pointsPerEuro + ' sein' });
    }

    const account = await getOrCreateLoyaltyAccount('user', req.userId);
    if (!account) return res.status(500).json({ ok: false, error: 'Konto nicht gefunden' });

    const currentPoints = Number(account.points) || 0;
    if (pointsToRedeem > currentPoints) {
      return res.status(400).json({ ok: false, error: 'Nicht genug Punkte', available_points: currentPoints });
    }

    const euros = Math.round((pointsToRedeem / pointsPerEuro) * 100) / 100;
    const newPoints = currentPoints - pointsToRedeem;
    const newCredit = Math.round(((Number(account.credit) || 0) + euros) * 100) / 100;

    const { data: updated, error } = await supa.from('loyalty_accounts')
      .update({ points: newPoints, credit: newCredit })
      .eq('user_id', req.userId)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);

    log('info', 'loyalty_points_redeemed', { userId: req.userId, points: pointsToRedeem, euros, newPoints, newCredit });
    res.json({
      ok: true,
      redeemed_points: pointsToRedeem,
      redeemed_euros: euros,
      loyalty: {
        credit: updated.credit,
        points: updated.points,
        lifetime_points: updated.lifetime_points != null ? updated.lifetime_points : updated.points,
        tier: updated.tier,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /auth/link-guest-bookings ──────────────────────────
// [GUEST-LINK] "Book as guest, link to your account later." Call this
// once right after sign-up (and it's safe to call again on every login —
// it's a no-op once everything's already linked). It finds every
// CONFIRMED booking made with this exact account's verified email that
// has no user_id yet, and attaches it to this account.
//
// Security: the email used for matching is ALWAYS req.userEmail — the
// verified address straight from the Supabase auth token attachUserIfPresent
// already validated. It is never taken from the request body. Without
// this, anyone could call this endpoint with someone else's email and
// claim their bookings; with it, you can only ever link bookings made
// under the email address you yourself just proved ownership of by
// logging in.
app.post('/auth/link-guest-bookings', attachUserIfPresent, rateLimit('link-bookings', 10, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!req.userEmail) return res.json({ ok: true, linked: [] }); // no verified email on the account — nothing to match
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

    const { data, error } = await supa.rpc('link_guest_bookings_to_user', {
      p_user_id: req.userId,
      p_email: req.userEmail,
    });
    if (error) throw new Error(error.message);

    const linked = (data || []).map((b) => ({
      bookingReference: b.booking_reference,
      routeLabel: b.route_label,
      createdAt: b.created_at,
      customerPaid: Number(b.customer_paid) || 0,
      currency: b.currency,
    }));
    if (linked.length) log('info', 'guest_bookings_linked', { userId: req.userId, count: linked.length });
    res.json({ ok: true, linked });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /my-bookings ─────────────────────────────────────────
// [SECURITY-FIX] Replaces a frontend call that queried Supabase's
// `bookings` table DIRECTLY from the browser (_sb.from('bookings')...) —
// two serious problems with that: (1) it used column names that don't
// exist on this table at all (booking_ref/origin/destination/order_id/
// total_amount — the real columns are booking_reference/route_label/
// duffel_order_id/customer_paid), so every result silently came back
// empty or broken; and (2) with no RLS policy defined anywhere in this
// schema, a browser-side query filtered by .eq('user_id', ...) is a
// courtesy, not a security boundary — a user could edit the request and
// read every customer's bookings. This endpoint runs server-side with the
// service key, uses req.userId from the verified auth token (never
// anything the client claims), and returns only that user's own rows with
// the actual column names.
app.get('/my-bookings', attachUserIfPresent, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('bookings')
      .select('booking_reference, duffel_order_id, route_label, status, currency, customer_paid, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({
      ok: true,
      bookings: (data || []).map((b) => ({
        bookingReference: b.booking_reference,
        orderId: b.duffel_order_id,
        routeLabel: b.route_label,
        status: b.status,
        currency: b.currency,
        customerPaid: Number(b.customer_paid) || 0,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /promo/check ───────────────────────────────────────
// [ADMIN-MARGIN] Public-facing promo validation, used while the customer
// is still editing the booking form (before any offer/passenger data is
// finalized). This is a PREVIEW only — the actual discount that gets
// charged is always re-derived inside computeAuthoritativePricing() at
// /create-checkout-session, never trusted from this earlier check. Lets
// the UI show "✓ code applied, -10%" without letting the browser decide
// what a code is worth.
app.get('/promo/check', rateLimit('promo', 30, 60000), async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ ok: false, error: 'code erforderlich' });
    const lookup = await lookupPromoCode(code);
    if (!lookup || !lookup.valid) {
      return res.json({ ok: true, valid: false, reason: (lookup && lookup.reason) || 'invalid' });
    }
    res.json({ ok: true, valid: true, code: lookup.row.code, type: lookup.row.type, value: Number(lookup.row.value) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// [LOYALTY-FIX] /loyalty/account/:deviceId removed entirely — it auto-
// created a device-scoped loyalty account (with the admin's welcome
// bonus) for any visitor, logged in or not, which is exactly the
// behavior the welcome credit/points system must never have. No frontend
// code calls this anymore (see loyaltySyncFromServerByDevice() in
// index.html), and leaving the route in place would just be a live way
// for it — or some future code — to start silently working again.


// ─── GET /loyalty/config ──────────────────────────────────────
// Public-facing read of the admin-tunable loyalty numbers, so the frontend
// can show accurate tier breakpoints/credit amounts instead of its own
// hardcoded copy. Writing is admin-only (see /admin/loyalty-config below).
app.get('/loyalty/config', rateLimit('loyalty', 60, 60000), async (req, res) => {
  try {
    const cfg = await getLoyaltyConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// [ADMIN] Admin dashboard API — every route below requires a valid
// `Authorization: Bearer <ADMIN_TOKEN>` header (see requireAdmin above).
// The admin dashboard talks ONLY to these endpoints — never directly to
// Supabase from the browser, so the service_role key never leaves the
// server.
// ════════════════════════════════════════════════════════════

// ─── POST /admin/login ─────────────────────────────────────
// The dashboard exchanges a password for the same ADMIN_TOKEN it will use
// on every subsequent request. Rate-limited hard against brute-forcing.
app.post('/admin/login', rateLimit('admin_login', 10, 60000), (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  const { password } = req.body || {};
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  const valid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!valid) { log('warn', 'admin_login_failed', { ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress }); return res.status(401).json({ ok: false, error: 'Falsches Passwort' }); }
  res.json({ ok: true, token: ADMIN_TOKEN });
});

// ─── GET /admin/stats ───────────────────────────────────────
// ─── [KILL-SWITCH] Maintenance mode ────────────────────────
// GET/POST /admin/maintenance — read/toggle from the dashboard.
// GET /maintenance-status — public, polled by the frontend.
app.get('/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const maint = await getAdminConfig('maintenance_mode', { enabled: false, message: '' });
    res.json({ ok: true, enabled: !!maint.enabled, message: maint.message || '' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/maintenance', requireAdmin, async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const message = (req.body && typeof req.body.message === 'string') ? req.body.message.slice(0, 500) : '';
    await setAdminConfig('maintenance_mode', { enabled, message });
    log('info', 'maintenance_mode_toggled', { enabled });
    res.json({ ok: true, enabled, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/maintenance-status', async (req, res) => {
  try {
    const maint = await getAdminConfig('maintenance_mode', { enabled: false, message: '' });
    res.json({ ok: true, enabled: !!maint.enabled, message: maint.message || '' });
  } catch (err) {
    res.json({ ok: true, enabled: false, message: '' }); // fail open
  }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    // [PROFIT-PERIOD-FIX] Optional date-range filter on created_at —
    // 'from'/'to' are ISO date strings (YYYY-MM-DD). Omitting both keeps
    // the original all-time behavior unchanged for any existing caller.
    let query = supa.from('bookings').select('*').eq('status', 'confirmed');
    if (req.query.from) query = query.gte('created_at', req.query.from);
    if (req.query.to) {
      // 'to' is a day boundary, not a timestamp — make it inclusive of the
      // entire day by treating it as start-of-NEXT-day exclusive.
      const toDate = new Date(req.query.to + 'T00:00:00Z');
      toDate.setUTCDate(toDate.getUTCDate() + 1);
      query = query.lt('created_at', toDate.toISOString());
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data || [];
    const revenue = rows.reduce((s, b) => s + (Number(b.customer_paid) || 0), 0);
    const profit = rows.reduce((s, b) => s + (Number(b.profit_margin) || 0), 0);
    const discounts = rows.reduce((s, b) => s + (Number(b.discount_amount) || 0), 0);
    res.json({
      ok: true,
      revenue: Math.round(revenue * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      discounts: Math.round(discounts * 100) / 100,
      bookingsCount: rows.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// [BLOG-SYSTEM] Self-serve blog admin API
// ════════════════════════════════════════════════════════════
function slugify(title) {
  const umlautMap = { 'ä':'ae','ö':'oe','ü':'ue','Ä':'Ae','Ö':'Oe','Ü':'Ue','ß':'ss' };
  let s = String(title || '').replace(/[äöüÄÖÜß]/g, (c) => umlautMap[c] || c);
  s = s.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip remaining accents
    .replace(/[^a-z0-9\s-]/g, '')   // drop anything non-ASCII (incl. Arabic) — slug must stay URL-safe
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // A title that's entirely non-Latin (e.g. fully Arabic) collapses to ''
  // here — fall back to a short random id so the post still gets a valid,
  // unique-enough slug instead of failing to save.
  return s || ('post-' + Math.random().toString(36).slice(2, 8));
}

// ─── GET /admin/blog-posts ────────────────────────────────────
// Returns every post regardless of status (draft + published) — the admin
// dashboard's own list view, not the public-facing one.
app.get('/admin/blog-posts', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('blog_posts').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /admin/blog-posts ───────────────────────────────────
// Creates a new post. slug is auto-generated from the title if not given;
// if the generated/given slug collides with an existing one, a numeric
// suffix is appended (-2, -3, ...) until it's unique, rather than failing
// outright on a duplicate-title post.
app.post('/admin/blog-posts', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { title, meta_description, excerpt, content, cover_image_url, author, status } = req.body;
    if (!title || !content) return res.status(400).json({ ok: false, error: 'Titel und Inhalt sind erforderlich' });

    let baseSlug = slugify(req.body.slug || title);
    let slug = baseSlug;
    for (let attempt = 2; attempt <= 21; attempt++) {
      const { data: existing } = await supa.from('blog_posts').select('id').eq('slug', slug).maybeSingle();
      if (!existing) break;
      slug = baseSlug + '-' + attempt;
    }

    const isPublishing = status === 'published';
    const { data, error } = await supa.from('blog_posts').insert({
      slug, title,
      meta_description: meta_description || null,
      excerpt: excerpt || null,
      content,
      cover_image_url: cover_image_url || null,
      author: author || 'Airpiv Team',
      status: isPublishing ? 'published' : 'draft',
      published_at: isPublishing ? new Date().toISOString() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PUT /admin/blog-posts/:id ─────────────────────────────────
// Updates a post. If this is the transition from draft -> published for
// the first time, published_at is stamped now (never overwritten on
// subsequent edits to an already-published post, so the displayed publish
// date stays stable across later corrections/typo fixes).
app.put('/admin/blog-posts/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: existing, error: fetchErr } = await supa.from('blog_posts').select('*').eq('id', req.params.id).maybeSingle();
    if (fetchErr) throw new Error(fetchErr.message);
    if (!existing) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });

    const { title, meta_description, excerpt, content, cover_image_url, author, status } = req.body;
    const update = {
      updated_at: new Date().toISOString(),
    };
    if (title != null) update.title = title;
    if (meta_description != null) update.meta_description = meta_description;
    if (excerpt != null) update.excerpt = excerpt;
    if (content != null) update.content = content;
    if (cover_image_url != null) update.cover_image_url = cover_image_url;
    if (author != null) update.author = author;
    if (status != null) {
      update.status = status;
      if (status === 'published' && existing.status !== 'published') {
        update.published_at = new Date().toISOString();
      }
    }
    // Slug is intentionally NOT editable after creation — changing it
    // would break any link already shared/indexed by Google for this post.
    const { data, error } = await supa.from('blog_posts').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /admin/blog-posts/:id ──────────────────────────────
app.delete('/admin/blog-posts/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('blog_posts').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// [BLOG-SYSTEM] Public blog API — no auth, read-only, published only
// ════════════════════════════════════════════════════════════

// ─── GET /blog-posts ───────────────────────────────────────────
// List published posts for the public blog index page. Lightweight
// fields only (no full content) — the index page doesn't need it, and
// keeping payload small matters more here since this is unauthenticated
// and could be hit by anyone/anything.
app.get('/blog-posts', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { data, error } = await supa.from('blog_posts')
      .select('slug,title,excerpt,cover_image_url,author,published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /blog-posts/:slug ──────────────────────────────────────
// Single published post by slug, for the public post-detail page.
// Increments views_count best-effort (fire-and-forget — a failed view
// count update must never block the post from rendering for the reader).
app.get('/blog-posts/:slug', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('blog_posts').select('*').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });
    supa.from('blog_posts').update({ views_count: (data.views_count || 0) + 1 }).eq('id', data.id)
      .then(({ error: e }) => { if (e) log('warn', 'blog_view_count_failed', { error: e.message }); });
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// [ROUTE-PAGES] Self-serve SEO route landing pages admin + public API
// ════════════════════════════════════════════════════════════

// ─── GET /admin/route-pages ────────────────────────────────────
app.get('/admin/route-pages', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, routes: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /admin/route-pages ───────────────────────────────────
app.post('/admin/route-pages', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { origin_iata, destination_iata, origin_city, destination_city, intro_text, status } = req.body;
    if (!origin_iata || !destination_iata || !origin_city || !destination_city) {
      return res.status(400).json({ ok: false, error: 'IATA-Codes und Stadtnamen sind erforderlich' });
    }

    // [ROUTE-PAGES] Reuses the exact same slugify() used for blog posts —
    // same umlaut-transliteration and non-Latin fallback behavior, just
    // seeded from the city names instead of a post title.
    let baseSlug = slugify(origin_city + '-' + destination_city);
    let slug = baseSlug;
    for (let attempt = 2; attempt <= 21; attempt++) {
      const { data: existing } = await supa.from('route_pages').select('id').eq('slug', slug).maybeSingle();
      if (!existing) break;
      slug = baseSlug + '-' + attempt;
    }

    const { data, error } = await supa.from('route_pages').insert({
      slug,
      origin_iata: origin_iata.toUpperCase(),
      destination_iata: destination_iata.toUpperCase(),
      origin_city, destination_city,
      intro_text: intro_text || null,
      status: status === 'published' ? 'published' : 'draft',
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PUT /admin/route-pages/:id ─────────────────────────────────
app.put('/admin/route-pages/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { origin_iata, destination_iata, origin_city, destination_city, intro_text, status } = req.body;
    const update = { updated_at: new Date().toISOString() };
    if (origin_iata != null) update.origin_iata = origin_iata.toUpperCase();
    if (destination_iata != null) update.destination_iata = destination_iata.toUpperCase();
    if (origin_city != null) update.origin_city = origin_city;
    if (destination_city != null) update.destination_city = destination_city;
    if (intro_text != null) update.intro_text = intro_text;
    if (status != null) update.status = status;
    // Slug is intentionally NOT editable after creation — same reasoning
    // as blog posts: changing it breaks any already-shared/indexed link.
    const { data, error } = await supa.from('route_pages').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /admin/route-pages/:id ──────────────────────────────
app.delete('/admin/route-pages/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('route_pages').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /route-pages ───────────────────────────────────────────
// Public list of published routes — for a route-index page / internal
// linking from the blog ("see flights for this route").
app.get('/route-pages', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city')
      .eq('status', 'published')
      .order('origin_city', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, routes: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /route-pages/:slug ──────────────────────────────────────
app.get('/route-pages/:slug', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages').select('*').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/bookings ────────────────────────────────────
// Query params: limit (default 100), status (optional filter)
// ─── GET /admin/cancellations ────────────────────────────────
// [CANCEL-NOTIFY-FIX] Returns the cancellation event log plus the unread
// count for the sidebar badge. Joins in booking details (route, customer,
// amount) where the order_id still matches a row, so the dashboard can
// show something more useful than a bare order ID.
app.get('/admin/cancellations', requireAdmin, async (req, res) => {
  try {
    const events = await getAdminConfig('cancellation_events', []);
    let bookingsByOrderId = {};
    if (supa && events.length) {
      const orderIds = events.map((e) => e.order_id).filter(Boolean);
      const { data } = await supa.from('bookings').select('duffel_order_id,booking_reference,route_label,customer_email,customer_name,customer_paid').in('duffel_order_id', orderIds);
      (data || []).forEach((b) => { bookingsByOrderId[b.duffel_order_id] = b; });
    }
    const enriched = events.map((e) => ({ ...e, booking: bookingsByOrderId[e.order_id] || null }));
    res.json({ ok: true, events: enriched, unreadCount: events.filter((e) => !e.read).length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/cancellations/mark-read', requireAdmin, async (req, res) => {
  try {
    await markCancellationsRead();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/bookings', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let query = supa.from('bookings').select('*').order('created_at', { ascending: false }).limit(limit);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ ok: true, bookings: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /admin/bookings/:id/cancel ────────────────────────
// Marks a booking cancelled in our records. Does NOT call Duffel's
// cancellation API automatically — that involves a real refund decision
// best made deliberately via the existing POST /cancel flow. This just
// keeps the dashboard's reporting accurate after a manual cancellation.
app.post('/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('bookings').update({ status: 'cancelled' }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET/POST /admin/profit-tiers ───────────────────────────
// Ticket profit margin tiers — { from, to(nullable), pct, fixed }[]
app.get('/admin/profit-tiers', requireAdmin, async (req, res) => {
  try {
    const tiers = await getAdminConfig('ticket_profit_tiers', DEFAULT_TICKET_TIERS);
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/profit-tiers', requireAdmin, async (req, res) => {
  try {
    const tiers = validateTiersPayload(req.body && req.body.tiers);
    await setAdminConfig('ticket_profit_tiers', tiers);
    log('info', 'admin_ticket_tiers_updated', { count: tiers.length });
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

// ─── GET/POST /admin/ancillary-margin ───────────────────────
// Seat/baggage profit margin tiers — same shape as ticket tiers, but
// applied to each individual seat/bag's NET Duffel price (not the ticket).
app.get('/admin/ancillary-margin', requireAdmin, async (req, res) => {
  try {
    const tiers = await getAdminConfig('ancillary_profit_tiers', DEFAULT_ANCILLARY_TIERS);
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/ancillary-margin', requireAdmin, async (req, res) => {
  try {
    const tiers = validateTiersPayload(req.body && req.body.tiers);
    await setAdminConfig('ancillary_profit_tiers', tiers);
    log('info', 'admin_ancillary_tiers_updated', { count: tiers.length });
    res.json({ ok: true, tiers });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

// Shared validation for both tier endpoints — rejects malformed shapes
// before they ever reach Supabase or get used in a price calculation.
function validateTiersPayload(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) {
    throw Object.assign(new Error('tiers muss ein nicht-leeres Array sein'), { status: 400 });
  }
  return tiers.map((t, i) => {
    const from = Number(t.from);
    const to = (t.to === null || t.to === undefined || t.to === '') ? null : Number(t.to);
    const pct = Number(t.pct);
    const fixed = Number(t.fixed);
    if (!Number.isFinite(from) || from < 0) throw Object.assign(new Error(`Tier ${i + 1}: "von" ungültig`), { status: 400 });
    if (to !== null && (!Number.isFinite(to) || to <= from)) throw Object.assign(new Error(`Tier ${i + 1}: "bis" muss größer als "von" sein`), { status: 400 });
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw Object.assign(new Error(`Tier ${i + 1}: Prozentsatz muss zwischen 0 und 100 liegen`), { status: 400 });
    if (!Number.isFinite(fixed) || fixed < 0) throw Object.assign(new Error(`Tier ${i + 1}: Fixbetrag ungültig`), { status: 400 });
    return { from, to, pct, fixed };
  });
}

// ─── GET/POST/DELETE /admin/promos ──────────────────────────
app.get('/admin/promos', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('promo_codes').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, promos: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/promos/usage-log ─────────────────────────────
// [ADMIN-DASHBOARD-FIX] The dashboard's "سجل الاستخدام" (usage log) table
// existed in the HTML/CSS but was never wired to any data — promo_codes
// only ever tracked a simple used_count integer, with no per-use detail
// (which booking, when, how much was discounted) stored anywhere. Rather
// than adding a new table, this derives the log directly from bookings
// rows that have a promo_code set — that data already exists, just never
// had a query exposing it.
app.get('/admin/promos/usage-log', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { data, error } = await supa.from('bookings')
      .select('booking_reference, promo_code, discount_amount, customer_email, created_at')
      .not('promo_code', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, usage: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/promos', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { code, type, value, max_uses, expires_at } = req.body || {};
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) return res.status(400).json({ ok: false, error: 'Code erforderlich' });
    if (!['percent', 'fixed'].includes(type)) return res.status(400).json({ ok: false, error: 'type muss "percent" oder "fixed" sein' });
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) return res.status(400).json({ ok: false, error: 'value ungültig' });
    if (type === 'percent' && numValue > 100) return res.status(400).json({ ok: false, error: 'Prozentsatz darf 100 nicht überschreiten' });
    const { data, error } = await supa.from('promo_codes').insert({
      code: normalized, type, value: numValue,
      max_uses: max_uses != null && max_uses !== '' ? Number(max_uses) : null,
      expires_at: expires_at || null,
      active: true,
    }).select().maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ ok: false, error: 'Dieser Code existiert bereits' });
      throw new Error(error.message);
    }
    log('info', 'admin_promo_created', { code: normalized });
    res.json({ ok: true, promo: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/promos/:id/toggle', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: row } = await supa.from('promo_codes').select('active').eq('id', req.params.id).maybeSingle();
    if (!row) return res.status(404).json({ ok: false, error: 'Code nicht gefunden' });
    const { error } = await supa.from('promo_codes').update({ active: !row.active }).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true, active: !row.active });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.delete('/admin/promos/:id', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('promo_codes').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET/POST /admin/invoice-config ─────────────────────────
app.get('/admin/invoice-config', requireAdmin, async (req, res) => {
  try {
    const cfg = await getAdminConfig('invoice_config', DEFAULT_INVOICE_CONFIG);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/invoice-config', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body || {};
    const cfg = {
      prefix: String(incoming.prefix || DEFAULT_INVOICE_CONFIG.prefix).slice(0, 20),
      nextNumber: Number.isFinite(Number(incoming.nextNumber)) ? Math.max(1, parseInt(incoming.nextNumber, 10)) : DEFAULT_INVOICE_CONFIG.nextNumber,
      companyName: String(incoming.companyName || '').slice(0, 200),
      companyAddress: String(incoming.companyAddress || '').slice(0, 500),
      steuernummer: String(incoming.steuernummer || '').slice(0, 50),
      taxMode: ['kleinunternehmer', 'regular'].includes(incoming.taxMode) ? incoming.taxMode : DEFAULT_INVOICE_CONFIG.taxMode,
    };
    await setAdminConfig('invoice_config', cfg);
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /admin/invoices/issue ─────────────────────────────
// [ADMIN-INVOICE] The ONLY way an invoice number is ever created. Calls
// the issue_invoice() Postgres function (see schema_admin.sql), which
// atomically reserves the next sequence value AND writes the invoice row
// in a single round-trip — no "get a number, then save it" gap where a
// crash could leak a number with nothing behind it. This is what makes
// numbering actually gap-free and duplicate-free under concurrent admins,
// not just "usually fine" like a localStorage counter was.
app.post('/admin/invoices/issue', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { booking_id, booking_reference, customer_name, customer_address, amount, currency, fields } = req.body || {};
    if (!customer_name) return res.status(400).json({ ok: false, error: 'customer_name erforderlich' });
    const cfg = await getAdminConfig('invoice_config', DEFAULT_INVOICE_CONFIG);
    const { data, error } = await supa.rpc('issue_invoice', {
      p_prefix: cfg.prefix || 'AIRPIV',
      p_booking_id: booking_id || null,
      p_booking_reference: booking_reference || null,
      p_customer_name: customer_name,
      p_customer_address: customer_address || '',
      p_amount: Number(amount) || 0,
      p_currency: currency || 'EUR',
      p_fields: fields || {},
    });
    if (error) throw new Error(error.message);
    log('info', 'admin_invoice_issued', { invoice_number: data.invoice_number });
    res.json({ ok: true, invoice: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/invoices ─────────────────────────────────────
app.get('/admin/invoices', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const { data, error } = await supa.from('invoices').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, invoices: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/invoices/:invoiceNumber ──────────────────────
// Used to re-fetch a single invoice's stored fields for re-downloading
// its PDF later, without trusting a client-side cache of the record.
app.get('/admin/invoices/:invoiceNumber', requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('invoices').select('*').eq('invoice_number', req.params.invoiceNumber).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Rechnung nicht gefunden' });
    res.json({ ok: true, invoice: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET/POST /admin/loyalty-config ─────────────────────────
// Every loyalty number (welcome bonus, points rate, per-booking discount
// ceiling, tier breakpoints) lives here instead of hardcoded in frontend
// JS. The actual per-device balance lives in loyalty_accounts — this
// config only controls the RULES, not any individual customer's balance.
app.get('/admin/loyalty-config', requireAdmin, async (req, res) => {
  try {
    const cfg = await getLoyaltyConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/admin/loyalty-config', requireAdmin, async (req, res) => {
  try {
    const incoming = req.body || {};
    const welcomeCreditEur = Number(incoming.welcomeCreditEur);
    const welcomePoints = Number(incoming.welcomePoints);
    const pointsPerEuro = Number(incoming.pointsPerEuro);
    const maxCreditPerBooking = Number(incoming.maxCreditPerBooking);
    if (!Number.isFinite(welcomeCreditEur) || welcomeCreditEur < 0) return res.status(400).json({ ok: false, error: 'welcomeCreditEur ungültig' });
    if (!Number.isFinite(welcomePoints) || welcomePoints < 0) return res.status(400).json({ ok: false, error: 'welcomePoints ungültig' });
    if (!Number.isFinite(pointsPerEuro) || pointsPerEuro < 0) return res.status(400).json({ ok: false, error: 'pointsPerEuro ungültig' });
    if (!Number.isFinite(maxCreditPerBooking) || maxCreditPerBooking < 0) return res.status(400).json({ ok: false, error: 'maxCreditPerBooking ungültig' });
    // Reuse the same tier validator as profit tiers, but tiers here use
    // `creditEur` instead of `pct`/`fixed` — validate shape separately.
    const tiersIn = incoming.tiers;
    if (!Array.isArray(tiersIn) || !tiersIn.length) return res.status(400).json({ ok: false, error: 'tiers muss ein nicht-leeres Array sein' });
    const tiers = tiersIn.map((t, i) => {
      const from = Number(t.from);
      const to = (t.to === null || t.to === undefined || t.to === '') ? null : Number(t.to);
      const creditEur = Number(t.creditEur);
      if (!Number.isFinite(from) || from < 0) throw Object.assign(new Error(`Tier ${i + 1}: "von" ungültig`), { status: 400 });
      if (to !== null && (!Number.isFinite(to) || to <= from)) throw Object.assign(new Error(`Tier ${i + 1}: "bis" muss größer als "von" sein`), { status: 400 });
      if (!Number.isFinite(creditEur) || creditEur < 0) throw Object.assign(new Error(`Tier ${i + 1}: Guthaben ungültig`), { status: 400 });
      return { from, to, creditEur };
    });
    const cfg = { welcomeCreditEur, welcomePoints, pointsPerEuro, maxCreditPerBooking, tiers };
    await setAdminConfig('loyalty_config', cfg);
    log('info', 'admin_loyalty_config_updated', {});
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── GET /admin/pricing-preview ─────────────────────────────
// Lets the dashboard's "test calculator" show EXACTLY what the live
// server would charge for a given net price, using the real saved tiers
// (not a reimplementation in the dashboard's own JS that could drift out
// of sync with the server).
app.get('/admin/pricing-preview', requireAdmin, async (req, res) => {
  try {
    const price = Number(req.query.price) || 0;
    const kind = req.query.kind === 'ancillary' ? 'ancillary' : 'ticket';
    const tiers = kind === 'ancillary' ? await getAncillaryProfitTiers() : await getTicketProfitTiers();
    const margin = computeTieredMargin(price, tiers);
    res.json({ ok: true, price, margin, total: Math.round((price + margin) * 100) / 100 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── [#8] Sentry error handler ─────────────────────────────
// Must be registered AFTER all routes/app.use() calls but BEFORE app.listen,
// so it can catch errors from every route above. setupExpressErrorHandler is
// the current (v8+) API — older Sentry.Handlers.errorHandler() no longer
// exists and will throw if used with this SDK version.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ FlyWise Server running on port ${PORT}`));

// ─── Normalize Offer ──────────────────────────────────────
// [PRICING-FIX] normalizeOffer applies the admin's ticket profit margin to
// the price shown in search results — previously this returned Duffel's
// raw net total_amount untouched, so customers saw one price while
// browsing and a completely different (correct, margin-included) price
// only at checkout. ticketTiers is fetched ONCE by the caller and passed
// in here (not re-fetched per offer) since a single search can normalize
// dozens of offers — same computeTieredMargin() math used by
// computeAuthoritativePricing() at payment time, so the number a customer
// sees while searching and the number they're actually charged always
// agree from the very first look.
function normalizeOffer(offer, ticketTiers) {
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
        id: s.id,
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

  // [PRICING-FIX] netPrice is Duffel's real, unmodified total for ALL
  // passengers combined — Duffel never breaks total_amount down per
  // passenger, so this is the only number available. The fixed-amount
  // part of a tier (e.g. "+500€") is a per-passenger fee in this
  // business's pricing model, not a flat one-time charge on the whole
  // booking — a 3-passenger booking should add the fixed fee 3 times,
  // matching what 3 separate solo bookings would each pay. We approximate
  // each passenger's net share as netPrice / passengerCount (Duffel
  // doesn't expose individual passenger prices when types/ages differ,
  // so an equal split is the best available approximation), compute the
  // tiered margin per passenger on that share, then sum across all
  // passengers. This margin is for DISPLAY ONLY — kept alongside the net
  // price never sent to Duffel — but it directly drives the bottom line,
  // so getting the per-passenger math right here matters as much as it
  // does in computeAuthoritativePricing() at checkout.
  const netPrice = parseFloat(offer.total_amount || 0);
  const passengerCount = Math.max(1, (offer.passengers || []).length);
  const netPerPassenger = netPrice / passengerCount;
  const marginPerPassenger = computeTieredMargin(netPerPassenger, ticketTiers);
  const ticketMargin = Math.round(marginPerPassenger * passengerCount * 100) / 100;
  const displayPrice = Math.round((netPrice + ticketMargin) * 100) / 100;

  return {
    id: offer.id,
    isDuffel: true,
    raw_offer_id: offer.id,
    al: [al0?.marketing_carrier?.iata_code || 'XX', al0?.marketing_carrier?.name || 'Unknown'],
    price: displayPrice,
    netPrice: netPrice,
    margin: ticketMargin,
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
    // [FIX] Multi-city support: expose EVERY slice of the offer (not just
    // the first two). A multi-city offer is one combined itinerary with one
    // total price — it must be rendered as a single card with N legs, never
    // split into N separate "offers" (Duffel doesn't price legs separately).
    allSlices: slices.map(normSlice),
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
