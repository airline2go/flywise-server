// [MULTI-DATE-AIRLINE-BACKFILL]
// Controlled admin-only recovery path for published routes that still have
// no observed carriers. Unlike the legacy one-date backfill, each route gets
// up to three representative future departure dates and stops at the first
// date that returns an offer. Empty results are never treated as proof that
// the route is dead.

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const duffel = require('../services/duffel');
const { ensureAirlineExists, ensureRouteAirlineObserved } = require('../services/routePages');
const { isExcludedCarrier } = require('../services/carrierFilter');
const triggerRebuild = require('../utils/triggerRebuild');
const { routeEntities, dedupeEntities } = require('../utils/routeEntities');

const BATCH_SIZE = 10;
const DATE_OFFSETS = (process.env.ROUTE_AIRLINE_BACKFILL_DATE_OFFSETS || '21,60,135').split(',')
  .map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 5);

function pad2(value) { return String(value).padStart(2, '0'); }
function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}
function futureDates() {
  return DATE_OFFSETS.map((offset) => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return formatUtcDate(d);
  });
}
function inspectOffers(offers) {
  let excludedCarrierOffers = 0;
  let missingCarrierOffers = 0;
  const carrierSamples = new Map();
  for (const offer of offers || []) {
    const segments = (offer.slices && offer.slices[0] && offer.slices[0].segments) || [];
    let hasCarrier = false;
    for (const segment of segments) {
      const iata = segment.marketing_carrier && segment.marketing_carrier.iata_code;
      const name = segment.marketing_carrier && segment.marketing_carrier.name;
      if (!iata && !name) continue;
      hasCarrier = true;
      const key = `${iata || ''}|${name || ''}`;
      carrierSamples.set(key, { iata: iata || null, name: name || null, excluded: isExcludedCarrier(iata, name) });
    }
    if (!hasCarrier) missingCarrierOffers++;
    else if ([...carrierSamples.values()].every((carrier) => carrier.excluded)) excludedCarrierOffers++;
  }
  return { totalOffers: (offers || []).length, excludedCarrierOffers, missingCarrierOffers, carrierSamples: [...carrierSamples.values()].slice(0, 10) };
}
function extractCarriers(offers) {
  const observed = new Map();
  for (const offer of offers || []) {
    const segments = (offer.slices && offer.slices[0] && offer.slices[0].segments) || [];
    for (const segment of segments) {
      const iata = segment.marketing_carrier && segment.marketing_carrier.iata_code;
      const name = segment.marketing_carrier && segment.marketing_carrier.name;
      if (isExcludedCarrier(iata, name)) continue;
      if (iata) observed.set(iata, name || iata);
    }
  }
  return observed;
}

module.exports = (app) => {
  app.post('/admin/route-pages/backfill-airlines-multi-date-batch', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { data: batch, error: fetchErr } = await supa.from('route_pages')
        .select('id, slug, origin_iata, destination_iata, origin_city_slug, destination_city_slug, origin_country, destination_country')
        .eq('status', 'published').or('airline_count.is.null,airline_count.eq.0')
        .order('updated_at', { ascending: true }).limit(BATCH_SIZE);
      if (fetchErr) throw new Error(fetchErr.message);
      if (!batch || !batch.length) return res.json({ ok: true, checked: 0, backfilled: 0, offersFound: 0, probes: 0, remaining: 0 });

      const dates = futureDates();
      if (!dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error('Generated departure date is not valid YYYY-MM-DD');
      const results = [];
      const changedEntities = [];

      const probeRoute = async (route) => {
        let probes = 0; let found = 0; let matchedDate = null;
        let totalOffers = 0; let excludedCarrierOffers = 0; let missingCarrierOffers = 0;
        const carrierSamples = [];
        try {
          for (const departure_date of dates) {
            probes++;
            const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
              data: { slices: [{ origin: route.origin_iata, destination: route.destination_iata, departure_date }], passengers: [{ type: 'adult' }], cabin_class: 'economy' },
            }, null, { source: 'admin', logContext: { route_origin: route.origin_iata, route_destination: route.destination_iata } });
            const offers = (result.data && result.data.offers) || [];
            const inspection = inspectOffers(offers);
            totalOffers += inspection.totalOffers;
            excludedCarrierOffers += inspection.excludedCarrierOffers;
            missingCarrierOffers += inspection.missingCarrierOffers;
            for (const sample of inspection.carrierSamples) {
              if (carrierSamples.length >= 10) break;
              if (!carrierSamples.some((existing) => existing.iata === sample.iata && existing.name === sample.name)) carrierSamples.push(sample);
            }
            const observed = extractCarriers(offers);
            if (observed.size) {
              for (const [iata, name] of observed) {
                const airlineId = await ensureAirlineExists(iata, name);
                if (airlineId) await ensureRouteAirlineObserved(route.origin_iata, route.destination_iata, airlineId);
              }
              found = observed.size; matchedDate = departure_date; break;
            }
          }
        } catch (e) {
          log('warn', 'multidate_backfill_airlines_error', {
            route_id: route.id, route_origin: route.origin_iata, route_destination: route.destination_iata,
            error: e.message, code: e.code || null, status: e.status || null, probes, totalOffers,
            excludedCarrierOffers, missingCarrierOffers, carrierSamples,
          });
          return { id: route.id, found: null, probes, matchedDate: null, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples };
        }
        log('info', 'multidate_backfill_airlines_probe', {
          route_id: route.id, route_origin: route.origin_iata, route_destination: route.destination_iata,
          probes, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples,
          found, matchedDate,
        });
        return { id: route.id, origin_iata: route.origin_iata, destination_iata: route.destination_iata, found, probes, matchedDate, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples };
      };

      for (let i = 0; i < batch.length; i += 2) {
        results.push(...await Promise.all(batch.slice(i, i + 2).map(probeRoute)));
        if (i + 2 < batch.length) await new Promise((resolve) => setTimeout(resolve, 500));
      }

      let backfilled = 0; let offersFound = 0; let probes = 0;
      const now = new Date().toISOString();
      const byId = new Map(batch.map((route) => [route.id, route]));
      for (const result of results) {
        probes += result.probes || 0;
        if (result.found === null) continue;
        offersFound += result.found;
        const update = { updated_at: now };
        if (result.found > 0) {
          const { count } = await supa.from('route_airlines').select('id', { count: 'exact', head: true })
            .eq('route_origin_iata', result.origin_iata).eq('route_destination_iata', result.destination_iata);
          update.airline_count = count || result.found; backfilled++;
          const full = byId.get(result.id); if (full) changedEntities.push(routeEntities(full));
        }
        await supa.from('route_pages').update(update).eq('id', result.id);
      }
      if (changedEntities.length) triggerRebuild(dedupeEntities(changedEntities));
      const { count: remaining } = await supa.from('route_pages').select('id', { count: 'exact', head: true })
        .eq('status', 'published').or('airline_count.is.null,airline_count.eq.0');
      log('info', 'route_backfill_airlines_multidate_batch', {
        checked: results.length, backfilled, offersFound, probes, dates,
        diagnostics: results.map(({ id, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples, matchedDate }) => ({
          id, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples, matchedDate,
        })),
      });
      res.json({
        ok: true, checked: results.length, backfilled, offersFound, probes, dates, remaining: remaining || 0,
        diagnostics: results.map(({ id, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples, matchedDate }) => ({
          id, totalOffers, excludedCarrierOffers, missingCarrierOffers, carrierSamples, matchedDate,
        })),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
};
