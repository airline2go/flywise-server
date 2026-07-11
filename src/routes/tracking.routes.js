// ═══════════════════════════════════════════════════════════════
// src/routes/tracking.routes.js
// [ROUTE-SCORE-4A] Public, anonymous, fire-and-forget first-party
// tracking endpoint for route-page impressions/clicks and the
// booking_start signal fired from app.js's prefillSearchFromUrl().
// Responds 202 immediately without awaiting the insert — matches
// apiLogs.js's "never slow down the real request" posture. A tighter
// rate-limit bucket than content's 1000/min since every call here is
// a DB write, not a cached read. A short user-agent deny-list blunts
// the trivial spam/bot cases without adding a new dependency.
//
// Body is sent as text/plain (not application/json) deliberately — a
// cross-origin sendBeacon/fetch(keepalive) call with a JSON content
// type triggers a CORS preflight that sendBeacon in particular can't
// reliably complete before the page unloads. text/plain is a
// CORS-safelisted content type (no preflight), so the raw body is
// read here and parsed manually instead of relying on the app-wide
// express.json() middleware, which only activates for
// application/json requests and would otherwise leave this route's
// body empty.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('../middleware/rateLimit');
const { recordRouteTrafficEvent, EVENT_TYPES } = require('../services/routeTraffic');

const BOT_UA_PATTERN = /curl|wget|bot|spider|crawl|headlesschrome|phantomjs|python-requests|scrapy/i;

module.exports = (app) => {

app.post('/track/route-page', rateLimit('track', 60, 60000), express.text({ type: () => true, limit: '4kb' }), (req, res) => {
  // Always 202 — this is fire-and-forget by design, a caller should
  // never be able to tell (or need to know) whether the write actually
  // landed.
  res.status(202).end();

  try {
    const ua = req.headers['user-agent'] || '';
    if (BOT_UA_PATTERN.test(ua)) return;

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { event_type, route_slug, origin_iata, destination_iata, language } = payload;
    if (!EVENT_TYPES.includes(event_type)) return;

    recordRouteTrafficEvent({
      eventType: event_type,
      slug: typeof route_slug === 'string' ? route_slug.slice(0, 200) : null,
      originIata: typeof origin_iata === 'string' ? origin_iata.slice(0, 3) : null,
      destinationIata: typeof destination_iata === 'string' ? destination_iata.slice(0, 3) : null,
      language: typeof language === 'string' ? language.slice(0, 5) : null,
    });
  } catch (e) {
    // Deliberately swallowed — the response is already sent, and a
    // malformed tracking payload is never worth logging loudly.
  }
});

};
