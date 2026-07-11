// ═══════════════════════════════════════════════════════════════
// src/routes/search.routes.js
// /search (بحث الرحلات الرئيسي)، /route-price (سعر تقديري لصفحات
// SEO، كاش 6 ساعات)، /search/airports (بحث حي عن المطارات، كاش
// 5 دقائق)، /debug/raw (تشخيصي، محمي بالأدمن).
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const redis = require('../clients/redis');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const duffel = require('../services/duffel');
const { getAdminConfig, setAdminConfig, getTicketProfitTiers, computeTieredMargin } = require('../services/adminConfig');
const { normalizeOffer } = require('../services/normalizeOffer');
const { ensureAirlineExists, ensureRouteAirlineObserved } = require('../services/routePages');
const supa = require('../clients/supabase');

// [MEMORY-LEAK-FIX] كاش 5 دقائق لبحث المطارات — بينضف نفسه دوري
// كل 5 دقائق عشان مايتراكمش مصطلحات بحث قديمة للأبد.
const _apCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [k, v] of _apCache) { if (v.t < cutoff) _apCache.delete(k); }
}, 300000).unref();

// [LIVE-TRUST-SIGNAL] عدّاد حقيقي 100% — بيزيد قيمته مرة واحدة بس كل
// مرة السيرفر فعلاً بيسأل Duffel عن سعر جديد (مش عند كل طلب من
// المتصفح، وليس لما الرد جاي من الكاش). مفتاح Redis بينتهي تلقائياً
// بعد 25 ساعة (يعني بيتصفّر لوحده كل يوم من غير أي مهمة مجدولة
// منفصلة). لو Redis مش متاح، الدالة بترجع null بهدوء والواجهة
// الأمامية بتخفي القسم ده تماماً بدل ما تعرض صفر أو رقم مختلق.
async function incrementDailyPriceCheckCounter() {
  if (!redis || redis.status !== 'ready') return;
  try {
    const key = 'daily_price_checks:' + new Date().toISOString().slice(0, 10);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 60 * 60);
  } catch (e) { /* عداد تجميلي — أي فشل هنا أبداً مايوقفش السعر نفسه */ }
}
async function getDailyPriceCheckCount() {
  if (!redis || redis.status !== 'ready') return null;
  try {
    const key = 'daily_price_checks:' + new Date().toISOString().slice(0, 10);
    const v = await redis.get(key);
    return v ? parseInt(v, 10) : 0;
  } catch (e) { return null; }
}

// [ROUTE-PRICE-TIMEOUT-FIX] supplier_timeout=8000 tells Duffel itself to
// stop waiting on slow airlines after 8s and return whatever it has —
// but our OWN client-side abort timer was still the generic 20s used
// for slower operations like order creation. If Duffel took anywhere
// close to that 20s despite being told to give up at 8s, our timer
// aborted, the call got retried as "transient", and a SECOND up-to-20s
// attempt started — a real ~32.8s case seen in production logs. Passing
// a matching timeoutMs here (8s + a realistic buffer for network/
// processing overhead) keeps a single attempt's worst case close to
// what supplier_timeout already promised, and even the rare retried
// case stays well under half of what it could reach before.
const ROUTE_PRICE_DUFFEL_OPTS = { timeoutMs: 12000 };

async function fetchAndCacheRoutePrice(from, to, daysAhead, cacheKey) {
  // A representative near-future date — NOT today, which would surface
  // artificially high last-minute fares that don't reflect a typical
  // "from" price for the route. (Unless days_ahead was explicitly
  // requested — then that IS the point, e.g. the Last Minute page.)
  const searchDate = new Date();
  searchDate.setDate(searchDate.getDate() + daysAhead);
  const departure_date = searchDate.toISOString().slice(0, 10);

  const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
    data: {
      slices: [{ origin: from.toUpperCase(), destination: to.toUpperCase(), departure_date }],
      passengers: [{ type: 'adult' }],
      cabin_class: 'economy',
    },
  }, null, Object.assign({}, ROUTE_PRICE_DUFFEL_OPTS, {
    // [API-COST-MONITORING] Only the two route-pricing call sites (this
    // one, reached by both warming and on-demand /route-price) tag their
    // Duffel calls with a route — every other Duffel call in the app
    // (booking, cancellation, etc.) is intentionally left untagged.
    logContext: { route_origin: from.toUpperCase(), route_destination: to.toUpperCase() },
  }));

  const offers = result.data?.offers || [];
  if (!offers.length) {
    const empty = { ok: true, price: null, currency: null, departure_date: null, insights: null };
    return empty;
  }

  function isoMinutesToHours(iso) {
    const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!m) return null;
    return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
  }

  const ticketTiers = await getTicketProfitTiers();
  // [3-OFFER-CACHE] One pass over the SAME offers already fetched for
  // pricing — never a second Duffel call — retaining price/duration/
  // stops/airline PER offer instead of only a running-minimum scalar,
  // so cheapest/fastest/best-value can all be picked from one search.
  const priced = offers.map((o) => {
    const netPrice = parseFloat(o.total_amount || 0);
    const margin = computeTieredMargin(netPrice, ticketTiers);
    const price = Math.round((netPrice + margin) * 100) / 100;
    const slice = (o.slices || [])[0];
    const durationMin = slice ? isoMinutesToHours(slice.duration) : null;
    const segs = slice ? (slice.segments || []) : [];
    const stops = slice ? Math.max(0, segs.length - 1) : null;
    const airline = (segs[0] && segs[0].marketing_carrier && segs[0].marketing_carrier.name) || null;
    return { id: o.id, price, durationMin, stops, airline };
  });
  const { cheapest, fastest, bestValue } = selectRouteOffers(priced);

  // [ROUTE-INSIGHTS] Real flight facts pulled from the SAME Duffel
  // offers already fetched above for pricing — duration, stop count,
  // and actual operating airlines for this specific route. Previously
  // every field except total_amount was discarded. These are the
  // figures the route page's new "Route Insights" section displays —
  // every one computed from real data for this exact origin/
  // destination pair, never invented or generic boilerplate.
  const durations = [];
  const stopCounts = [];
  const airlines = new Set();
  const airlinesObserved = new Map(); // iata_code -> name, for [AIRLINE-PAGES] observation below
  for (const o of offers) {
    const slice = (o.slices || [])[0];
    if (!slice) continue;
    const durMin = isoMinutesToHours(slice.duration);
    if (durMin != null) durations.push(durMin);
    const segs = slice.segments || [];
    stopCounts.push(Math.max(0, segs.length - 1));
    segs.forEach((s) => {
      if (s.marketing_carrier?.name) airlines.add(s.marketing_carrier.name);
      if (s.marketing_carrier?.iata_code) airlinesObserved.set(s.marketing_carrier.iata_code, s.marketing_carrier.name);
    });
  }
  const insights = durations.length ? {
    avgDurationMin: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    minDurationMin: Math.min(...durations),
    directAvailable: stopCounts.some((s) => s === 0),
    allDirect: stopCounts.every((s) => s === 0),
    airlines: Array.from(airlines).slice(0, 8), // cap — purely defensive, real routes rarely exceed this
  } : null;

  // [AIRLINE-PAGES] Fire-and-forget — never blocks or slows down the price
  // response. Same data already extracted above for `insights.airlines`,
  // now also persisted (via ensureAirlineExists()/ensureRouteAirlineObserved(),
  // mirroring ensureCityExists()'s auto-upsert-on-observation pattern) so
  // it accumulates into real airline pages and a real "airlines flying
  // this route" list instead of being recomputed from one live search
  // every page view.
  airlinesObserved.forEach((name, iataCode) => {
    ensureAirlineExists(iataCode, name)
      .then((airlineId) => { if (airlineId) return ensureRouteAirlineObserved(from.toUpperCase(), to.toUpperCase(), airlineId); })
      .catch(() => {});
  });

  const currency = offers[0].total_currency || 'EUR';
  const routeOffers = { cheapest, fastest, bestValue };
  await setAdminConfig(cacheKey, { price: cheapest.price, currency, departure_date, insights, offers: routeOffers, fetchedAt: new Date().toISOString() });
  await incrementDailyPriceCheckCounter();
  const checksToday = await getDailyPriceCheckCount();
  return { ok: true, price: cheapest.price, currency, departure_date, insights, offers: routeOffers, cached: false, checksToday, checkedAt: new Date().toISOString() };
}

// [3-OFFER-CACHE] bestValue is a documented, simple heuristic — a
// weighted, normalized score across price/duration/stops (each 0-1
// against this search's own min/max; stops capped at 2 for the
// normalization) — not a black box, and easily retunable via the
// weights below. Offers with no parseable slice duration are still
// eligible for "cheapest" but excluded from "fastest"/"bestValue"
// (both fall back to "cheapest" if NO offer has a usable duration).
const BEST_VALUE_WEIGHTS = { price: 0.5, duration: 0.3, stops: 0.2 };
function selectRouteOffers(priced) {
  const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
  const withDuration = priced.filter((p) => p.durationMin != null);
  if (!withDuration.length) return { cheapest, fastest: cheapest, bestValue: cheapest };

  const fastest = withDuration.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));

  const prices = withDuration.map((p) => p.price);
  const durations = withDuration.map((p) => p.durationMin);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const minD = Math.min(...durations), maxD = Math.max(...durations);
  let bestValue = withDuration[0];
  let bestScore = Infinity;
  for (const p of withDuration) {
    const normPrice = maxP === minP ? 0 : (p.price - minP) / (maxP - minP);
    const normDuration = maxD === minD ? 0 : (p.durationMin - minD) / (maxD - minD);
    const normStops = Math.min((p.stops || 0) / 2, 1);
    const score = normPrice * BEST_VALUE_WEIGHTS.price + normDuration * BEST_VALUE_WEIGHTS.duration + normStops * BEST_VALUE_WEIGHTS.stops;
    if (score < bestScore) { bestScore = score; bestValue = p; }
  }
  return { cheapest, fastest, bestValue };
}

// [ROUTE-PRICE-WARMING] Proactively keeps the price cache full so a
// customer clicking a route-page link — even the very first person ever
// to visit that specific route — finds a price already there, instead
// of being the unlucky one who triggers a live ~8-11s Duffel call.
// Runs entirely in the background, independent of customer traffic:
// walks the published route list, finds routes whose cached price is
// missing or older than their OWN configured refresh_frequency, and
// refreshes a small batch of them one at a time with a deliberate pause
// between each — so warming the catalog never bursts Duffel with
// concurrent requests or burns the whole rate-limit budget in one
// sweep. Safe to run indefinitely: once the catalog is fully warm, a
// cycle finds nothing due and does almost nothing, only picking up
// again as routes naturally cross their own threshold.
//
// [ROUTE-REFRESH-TIER] refresh_frequency='none' (SEO-only) routes are
// excluded from this query entirely — this is the actual Duffel-cost
// control mechanism the whole route-tiering system exists for. A
// visitor to an SEO-only route page can still trigger an on-demand
// price via GET /route-price below; it's just never proactively kept
// warm by this background cycle.
const ROUTE_PRICE_WARM_BATCH_SIZE = 25; // routes refreshed per cycle — deliberately modest
const ROUTE_PRICE_WARM_DELAY_MS = 2000; // pause between each Duffel call inside a cycle
const ROUTE_PRICE_WARM_INTERVAL_MS = 15 * 60 * 1000; // how often a new cycle starts
const REFRESH_FREQUENCY_MS = { '6h': 6 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

async function warmRoutePricesOnce() {
  if (!supa) return;
  try {
    const { data: routes, error } = await supa.from('route_pages')
      .select('origin_iata,destination_iata,refresh_frequency')
      .eq('status', 'published')
      .neq('refresh_frequency', 'none');
    if (error || !routes || !routes.length) return;

    // De-dupe origin/destination pairs — multiple route_pages rows can
    // share the same IATA pair via different slugs/languages, possibly
    // at different refresh_frequency values; keep the shortest interval
    // among duplicates so no row's chosen cadence is ever under-served.
    const byPair = new Map();
    for (const r of routes) {
      if (!r.origin_iata || !r.destination_iata) continue;
      const thresholdMs = REFRESH_FREQUENCY_MS[r.refresh_frequency];
      if (!thresholdMs) continue; // unrecognized value — skip rather than guess
      const key = r.origin_iata.toUpperCase() + '_' + r.destination_iata.toUpperCase();
      const existing = byPair.get(key);
      if (!existing || thresholdMs < existing.thresholdMs) {
        byPair.set(key, { from: r.origin_iata, to: r.destination_iata, cacheKey: 'route_price_' + key, thresholdMs });
      }
    }
    const pairs = Array.from(byPair.values());

    let warmedThisCycle = 0;
    for (const p of pairs) {
      if (warmedThisCycle >= ROUTE_PRICE_WARM_BATCH_SIZE) break;
      let due = true;
      try {
        const cached = await getAdminConfig(p.cacheKey, null);
        if (cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < p.thresholdMs) due = false;
      } catch (e) { /* any read error → treat as due, safe default */ }
      if (!due) continue;

      try {
        await fetchAndCacheRoutePrice(p.from, p.to, 21, p.cacheKey);
        log('info', 'route_price_warmed', { from: p.from, to: p.to });
      } catch (e) {
        log('warn', 'route_price_warm_failed', { from: p.from, to: p.to, error: e.message });
      }
      warmedThisCycle++;
      await new Promise((r) => setTimeout(r, ROUTE_PRICE_WARM_DELAY_MS));
    }
  } catch (e) {
    log('warn', 'route_price_warm_cycle_failed', { error: e.message });
  }
}

// Starts ~30s after boot (lets the server finish starting up first),
// then repeats on a fixed interval. .unref() so these timers never keep
// the process alive on their own during shutdown.
setTimeout(() => { warmRoutePricesOnce(); }, 30000).unref();
setInterval(() => { warmRoutePricesOnce(); }, ROUTE_PRICE_WARM_INTERVAL_MS).unref();

module.exports = (app) => {
app.get('/debug/raw', requireAdmin, rateLimit('pay', 10, 60000), async (req, res) => {
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

// [SEARCH-CACHE] كاش قصير جداً (90 ثانية بس) لنفس البحث بالظبط —
// بيحمي من حالات زي دبل كليك على زرار البحث، أو أكتر من مستخدم
// بيدوّر على نفس المسار/التاريخ في نفس اللحظة تقريباً، من غير ما
// يضربوا Duffel مرتين لنفس الحاجة بالظبط. المدة قصيرة جداً عمداً —
// عروض Duffel بتتغيّر وبتنتهي صلاحيتها، فمكانش آمن نخليها كاش
// طويل زي أسعار route-price التقديرية.
const _searchCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 90000;
  for (const [k, v] of _searchCache) { if (v.t < cutoff) _searchCache.delete(k); }
}, 90000).unref();

app.post('/search', rateLimit('search', 30, 60000), async (req, res) => {
  try {
    const {
      origin, destination, departure_date,
      return_date, cabin_class = 'economy',
      adults = 1, children = 0, infants = 0,
      slices: bodySlices,
    } = req.body;

    const searchCacheKey = JSON.stringify({ origin, destination, departure_date, return_date, cabin_class, adults, children, infants, bodySlices });
    const cachedSearch = _searchCache.get(searchCacheKey);
    if (cachedSearch && (Date.now() - cachedSearch.t) < 90000) {
      return res.json(cachedSearch.data);
    }

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

    const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
      data: { slices, passengers, cabin_class },
    }, null, ROUTE_PRICE_DUFFEL_OPTS);

    // [PRICING-FIX] Fetch the tiers ONCE for this whole search response —
    // a single search can return dozens of offers, and they all share the
    // same admin-configured margin tiers at this moment in time.
    const ticketTiers = await getTicketProfitTiers();
    const offers = (result.data?.offers || []).map((o) => normalizeOffer(o, ticketTiers));

    const responseData = { ok: true, offer_request_id: result.data?.id, offers, total: offers.length };
    _searchCache.set(searchCacheKey, { t: Date.now(), data: responseData });
    res.json(responseData);
    incrementDailyPriceCheckCounter(); // بعد إرسال الرد — أبداً ميأخرش وقت استجابة البحث نفسه

  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get('/route-price', rateLimit('route-price', 60, 60000), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from und to sind erforderlich' });

    // [LAST-MINUTE-SUPPORT] اختياري تماماً — لو ماتبعتش days_ahead، السلوك
    // زي ما كان بالظبط (21 يوم). لو اتبعت (زي صفحة Last Minute اللي
    // بتحتاج تاريخ قريب حقيقي فعلاً، مش تقديري بعيد)، بيتقيّد بين يوم
    // واحد و90 يوم عشان مايتستخدمش لإرهاق Duffel بتواريخ عشوائية.
    // مفتاح كاش منفصل تماماً — سعر تاريخ قريب مختلف فعلياً عن السعر
    // التقديري العادي، مش بديل له.
    const daysAhead = req.query.days_ahead ? Math.max(1, Math.min(90, parseInt(req.query.days_ahead, 10) || 21)) : 21;
    const cacheKey = 'route_price_' + from.toUpperCase() + '_' + to.toUpperCase() + (daysAhead !== 21 ? '_d' + daysAhead : '');
    const cached = await getAdminConfig(cacheKey, null);
    const cacheAgeMs = cached && cached.fetchedAt ? (Date.now() - new Date(cached.fetchedAt).getTime()) : Infinity;

    // [PRICE-CACHE-STALE-WHILE-REVALIDATE] Fresh cache (<12h): return
    // immediately, unchanged fast path. Stale cache (cached but ≥12h
    // old): respond immediately with the stale price so the visitor
    // never waits, then refresh it in the background for next time.
    // Only a route that has NEVER been priced before falls through to a
    // true blocking live call — a one-time cost per route, ever.
    if (cached && cacheAgeMs < 12 * 60 * 60 * 1000) {
      const checksToday = await getDailyPriceCheckCount();
      return res.json({ ok: true, price: cached.price, currency: cached.currency, departure_date: cached.departure_date, insights: cached.insights || null, offers: cached.offers || null, cached: true, checksToday, checkedAt: cached.fetchedAt });
    }
    if (cached) {
      const checksToday = await getDailyPriceCheckCount();
      res.json({ ok: true, price: cached.price, currency: cached.currency, departure_date: cached.departure_date, insights: cached.insights || null, offers: cached.offers || null, cached: true, stale: true, checksToday, checkedAt: cached.fetchedAt });
      fetchAndCacheRoutePrice(from, to, daysAhead, cacheKey).catch((e) => log('warn', 'route_price_revalidate_failed', { error: e.message }));
      return;
    }

    const fresh = await fetchAndCacheRoutePrice(from, to, daysAhead, cacheKey);
    res.json(fresh);
  } catch (err) {
    // Fail soft — a route page should still render (without a price) if
    // Duffel is briefly unavailable, never show a broken page.
    log('warn', 'route_price_failed', { error: err.message });
    res.json({ ok: true, price: null, currency: null, departure_date: null });
  }
});

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
    // [DEDUP-TYPE-FIX] Was keyed by `o.code` alone — a city entry from
    // Duffel shares the exact same IATA code as its own main airport
    // (e.g. city "MUC" and airport "MUC" for Munich). Since the city
    // entry got pushed first, the real airport entry (with real lat/lng)
    // was silently rejected as a "duplicate" — this is exactly why
    // searching "Munich" or "Berlin" could return the city placeholder
    // with no usable coordinates instead of the real airport. Keying by
    // `type + ':' + code` lets a city and an airport with the same code
    // coexist as two distinct, valid results.
    const push = (o) => { const k = o.type + ':' + o.code; if (o.code && !seen.has(k)) { seen.add(k); out.push(o); } };
    (result.data || []).forEach((p) => {
      if (p.type === 'city') {
        // [ROUTE-PAGES] Cities deliberately get no lat/lng — a city can
        // span multiple airports at different points, so there's no
        // single coordinate that accurately represents it. Only
        // individual airports (below) carry coordinates, which is what
        // route-distance calculations actually need anyway (search is by
        // airport code, never by city code).
        push({ type: 'city', code: p.iata_code, name: p.name, city: p.name, country: p.iata_country_code });
        (p.airports || []).forEach((ap) => push({
          type: 'airport', code: ap.iata_code, name: ap.name,
          city: ap.city_name || p.name, country: ap.iata_country_code || p.iata_country_code,
          lat: ap.latitude != null ? Number(ap.latitude) : null,
          lng: ap.longitude != null ? Number(ap.longitude) : null,
        }));
      } else {
        push({
          type: 'airport', code: p.iata_code, name: p.name,
          city: p.city_name || (p.city && p.city.name) || p.name, country: p.iata_country_code,
          lat: p.latitude != null ? Number(p.latitude) : null,
          lng: p.longitude != null ? Number(p.longitude) : null,
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
};
module.exports.warmRoutePricesOnce = warmRoutePricesOnce;
module.exports.selectRouteOffers = selectRouteOffers;
