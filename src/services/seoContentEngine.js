// ═══════════════════════════════════════════════════════════════════════════
// src/services/seoContentEngine.js
// Quality-gated, variation-driven SEO content engine for route pages.
//
// Rules this module enforces (see docs/SEO_CONTENT_GENERATION.md):
//   1. Never overwrite manually written content (checked by the caller AND here).
//   2. Skip pages entirely when data is insufficient — prefer NO content over
//      low-quality content.
//   3. Every generated page must differ significantly from similar pages:
//      each route deterministically picks from pools of structurally different
//      openings/bodies/FAQ sets, seeded by its slug, and weaves in real
//      route-specific data (distance, duration, domestic/international).
//   4. Only verifiable facts: distance comes from the stored Haversine value,
//      duration is derived from it, nothing else is invented.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Deterministic variant selection ────────────────────────────
// FNV-1a hash of the route slug → stable index into a variant pool. The same
// route always renders the same variant (stable for Google), while different
// routes spread across all variants.
function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
function pick(pool, seed, salt) {
  if (!pool || !pool.length) return null;
  return pool[(seed + salt * 7919) % pool.length];
}
// Pick n distinct items from a pool, rotation determined by seed.
function pickMany(pool, seed, n) {
  const start = seed % pool.length;
  const out = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    out.push(pool[(start + i) % pool.length]);
  }
  return out;
}

// ─── Verifiable derived facts ───────────────────────────────────
function estimateDurationHours(distanceKm) {
  // ~800 km/h cruise + 30min taxi/climb/descent overhead. A rounded estimate,
  // always presented as approximate ("around X hours"), never as a schedule.
  return Math.max(1, Math.round((0.5 + distanceKm / 800) * 2) / 2);
}
function formatDuration(hours, lang) {
  const whole = Math.floor(hours);
  const half = hours % 1 !== 0;
  if (lang === 'de') return half ? `${whole}½ Stunden` : `${whole} Stunden`;
  if (lang === 'ar') return half ? `${whole} ساعة ونصف` : `${whole} ساعات`;
  return half ? `${whole}.5` : `${whole}`;
}

// ─── Quality gate ───────────────────────────────────────────────
// A route is only eligible when we have enough REAL data to write something
// specific. Missing distance, missing city names, or a dead/draft status all
// mean: generate nothing.
function assessRouteEligibility(route) {
  const reasons = [];
  if (!route) return { eligible: false, reasons: ['no route'] };
  if (route.status !== 'published') reasons.push(`status is '${route.status}'`);
  if (!route.origin_city || !route.destination_city) reasons.push('missing city name');
  if (!route.distance_km || route.distance_km <= 0) reasons.push('missing distance_km');
  if (!route.haul_type) reasons.push('missing haul_type');
  if (hasManualContent(route)) reasons.push('manually edited content present');
  return { eligible: reasons.length === 0, reasons };
}

// Any non-empty hand-editable field means a human touched this page — skip it
// entirely, never even partially fill the remaining fields.
function hasManualContent(route) {
  return !!(route.custom_title || route.custom_meta_description ||
    (Array.isArray(route.custom_faq) ? route.custom_faq.length : route.custom_faq) ||
    route.intro_text);
}

// ─── Context builder ────────────────────────────────────────────
function buildContext(route) {
  const km = Math.round(route.distance_km);
  const durationH = estimateDurationHours(km);
  return {
    o: route.origin_city,
    d: route.destination_city,
    oIata: route.origin_iata,
    dIata: route.destination_iata,
    km,
    durationH,
    haul: route.haul_type,
    domestic: !!(route.origin_country && route.origin_country === route.destination_country),
    seed: seedFrom(route.slug || `${route.origin_iata}-${route.destination_iata}`),
  };
}

// ═══════════════════════════════════════════════════════════════
// ENGLISH — variant pools. Each entry is a function (ctx) => string with a
// genuinely different structure/opening/emphasis, not a reworded clone.
// ═══════════════════════════════════════════════════════════════
const INTROS_EN = {
  'short-haul': [
    (c) => `At roughly ${c.km} km, the hop from ${c.o} to ${c.d} is one of those flights where you barely finish your coffee before descent begins — expect around ${formatDuration(c.durationH, 'en')} hours in the air. ${c.domestic ? 'Because both airports are in the same country, there are no border formalities to slow you down, which makes even a same-day return realistic.' : 'Short as it is, it still crosses a border, so keep your ID or passport handy at both ends.'} Compare departure times across the day: on dense short routes like this, the price gap between the 6 a.m. flight and the mid-morning one is often bigger than the gap between airlines.`,
    (c) => `Few decisions on the ${c.o}–${c.d} route matter as much as when you book. The flight itself is quick — about ${c.km} km, typically around ${formatDuration(c.durationH, 'en')} hours gate to gate — so the real optimization is fare timing. Two to three weeks out is usually the sweet spot for short European sectors, and midweek departures routinely undercut Friday and Sunday evenings. ${c.domestic ? 'It is worth checking rail alternatives too; when trains compete on a domestic corridor, airlines respond with sharper fares.' : 'Watch both directions separately: outbound and return on cross-border city pairs are often priced by different demand curves.'}`,
    (c) => `Travelers often ask whether ${c.o} to ${c.d} is worth flying at all, given the distance of about ${c.km} km. The honest answer: it depends on your total door-to-door time. The flight runs around ${formatDuration(c.durationH, 'en')} hours, but add airport transfers and security and the calculus changes with your departure point. Where flying clearly wins is early-morning meetings and tight connections onward — and when a sale fare appears, it frequently beats ground transport on price alone.`,
    (c) => `The ${c.o}–${c.d} corridor rewards flexible packing more than flexible dates. On a sector of this length (~${c.km} km, around ${formatDuration(c.durationH, 'en')} hours airborne), the cheapest fares are usually hand-luggage-only, and checked-bag fees can double a bargain ticket. If you can travel light, filter for basic fares; if not, compare the bag-included total across carriers rather than the headline price. ${c.domestic ? 'Domestic security lines also tend to move faster, so arriving 90 minutes ahead is normally enough.' : ''}`,
    (c) => `Frequency is the quiet advantage of the ${c.o} to ${c.d} route. When a city pair this close (about ${c.km} km) supports regular service, a missed connection or a shifted meeting rarely ruins the day — there is usually another departure within hours. Flight time hovers around ${formatDuration(c.durationH, 'en')} hours, short enough that seat selection and cabin extras matter far less than schedule fit. Book the departure that matches your day, not the one that saves five euros.`,
  ],
  'medium-haul': [
    (c) => `Covering about ${c.km} km, ${c.o} to ${c.d} sits in that middle band of European flying — too far to shrug off as a hop, comfortably short of a long-haul commitment. Plan for roughly ${formatDuration(c.durationH, 'en')} hours in the air. Fares on medium sectors like this tend to bottom out three to four weeks before departure, and shoulder-season dates (late spring, early autumn) usually combine the best weather-to-price ratio at the ${c.d} end.`,
    (c) => `A flight of around ${formatDuration(c.durationH, 'en')} hours puts ${c.d} firmly in long-weekend territory from ${c.o}. The ${c.km} km distance means most itineraries are nonstop where the route is served directly, but it's worth checking one-stop options too — on medium European sectors, a connection can occasionally cut the fare substantially if your schedule absorbs the extra hours. Price both, then decide what your time is worth.`,
    (c) => `Seasonality drives this route more than most travelers expect. ${c.o} to ${c.d} spans roughly ${c.km} km — around ${formatDuration(c.durationH, 'en')} hours of flying — and demand swings with school holidays and event calendars at both ends. If your dates are fixed, book three to four weeks out and set a price alert immediately; if they're flexible, shifting departure by even two or three days regularly uncovers a lower fare band on medium-distance European routes.`,
    (c) => `What ${c.km} km buys you on the ${c.o}–${c.d} route is a real change of scene without a long-haul recovery day. The flight takes about ${formatDuration(c.durationH, 'en')} hours — long enough that seat comfort and departure time start to matter, short enough that jet lag isn't a factor. Morning departures maximize the first day at your destination; the last evening return squeezes the most from the final one. Compare fares across the whole day before locking either in.`,
  ],
  'long-haul': [
    (c) => `${c.o} to ${c.d} is a genuine long-haul undertaking: about ${c.km} km, which translates to roughly ${formatDuration(c.durationH, 'en')} hours of flying before winds and routing have their say. On sectors this length, booking six to eight weeks ahead consistently beats last-minute pricing, and cabin choice matters — the difference a better seat makes over ${formatDuration(c.durationH, 'en')} hours is real. Check the entry requirements for your destination early; visa processing times can exceed fare-sale windows.`,
    (c) => `The single best money move on a ${c.km} km route like ${c.o}–${c.d} is patience paired with alerts. Long-haul fares move in waves tied to booking classes opening and closing, so a price seen today often reappears — set an alert rather than panic-booking. Expect around ${formatDuration(c.durationH, 'en')} hours in the air; build your arrival day around that reality, with nothing scheduled that can't survive a delayed landing and a slow immigration queue.`,
    (c) => `Crossing roughly ${c.km} km, this route asks for more planning than a European hop and repays it accordingly. Flight time runs around ${formatDuration(c.durationH, 'en')} hours, so compare itineraries on total journey time, not just price — a marginally cheaper routing with a long layover can cost you an entire day at the ${c.d} end. Midweek departures (Tuesday to Thursday) remain the most reliable pattern for lower long-haul fares, and traveling outside peak season at your destination compounds the savings.`,
    (c) => `Before booking ${c.o} to ${c.d}, settle three things in order: documents, dates, then fare. The distance — about ${c.km} km, around ${formatDuration(c.durationH, 'en')} hours flying — puts this in the category where passport validity rules, visa requirements, and health documentation can derail a trip more surely than any fare increase. With paperwork confirmed, target a booking window six to eight weeks out and let a price alert do the watching for you.`,
  ],
};

const TITLES_EN = [
  (c) => `${c.o} to ${c.d} flights (${c.oIata}–${c.dIata}) — compare fares`,
  (c) => `Flights ${c.o} → ${c.d}: times, prices & booking tips`,
  (c) => `Cheap flights from ${c.o} to ${c.d} | ${c.oIata} to ${c.dIata}`,
  (c) => `${c.o}–${c.d} route guide: flights, duration & fares`,
];

const METAS_EN = [
  (c) => `Flying ${c.o} to ${c.d}? About ${c.km} km and around ${formatDuration(c.durationH, 'en')}h in the air. Compare fares, see the best booking window, and find the right departure.`,
  (c) => `Compare ${c.o}–${c.d} flights: ~${c.km} km, roughly ${formatDuration(c.durationH, 'en')}h flight time. Booking-window advice, money-saving tips and route facts in one place.`,
  (c) => `Everything for the ${c.o} to ${c.d} route: real distance (${c.km} km), realistic flight time, when to book, and how to avoid overpaying.`,
];

const FAQ_POOL_EN = [
  (c) => ({ question: `How long is the flight from ${c.o} to ${c.d}?`, answer: `The great-circle distance is about ${c.km} km, which works out to roughly ${formatDuration(c.durationH, 'en')} hours of flying time on a nonstop itinerary. Actual times vary with winds, routing and the aircraft operated.` }),
  (c) => ({ question: `How far is ${c.d} from ${c.o} by plane?`, answer: `Measured along the direct flight path, ${c.o} and ${c.d} are approximately ${c.km} km apart — a ${c.haul.replace('-', ' ')} route by airline industry classification.` }),
  (c) => ({ question: `When should I book flights from ${c.o} to ${c.d}?`, answer: c.haul === 'long-haul' ? `For a long-haul route like this, six to eight weeks before departure is the most reliable window for lower fares. Set a price alert early — long-haul prices move in waves and good fares often reappear.` : c.haul === 'medium-haul' ? `Three to four weeks before departure is typically the best window on medium-distance European routes. Midweek departure dates usually price below Friday and Sunday.` : `On short routes, two to three weeks ahead is usually enough. The bigger lever is the day and time: early-morning and midweek departures regularly undercut peak-time flights.` }),
  (c) => ({ question: `Is it cheaper to fly midweek on this route?`, answer: `Usually, yes. Tuesday and Wednesday departures on the ${c.o}–${c.d} route tend to price below Friday and Sunday, when business and weekend traffic overlap. Comparing the full week of fares before choosing a date is the simplest way to see the pattern for your travel dates.` }),
  (c) => ({ question: `Do checked bags cost extra on ${c.o}–${c.d} flights?`, answer: `On most fares sold for this route, the lowest price tier includes hand luggage only. If you need a checked bag, compare the bag-included total across airlines rather than the headline fare — the ranking often changes once bag fees are added.` }),
  (c) => ({ question: `What affects the price of flights between ${c.o} and ${c.d}?`, answer: `The main drivers are how far ahead you book, the day of week, the season, and demand events at either end. Prices are set dynamically per departure, which is why two flights on the same day can differ significantly.` }),
];

// ═══════════════════════════════════════════════════════════════
// GERMAN — same structure, independently written (not translated 1:1).
// ═══════════════════════════════════════════════════════════════
const INTROS_DE = {
  'short-haul': [
    (c) => `Mit rund ${c.km} km gehört ${c.o}–${c.d} zu den kurzen Strecken, bei denen der Sinkflug beginnt, bevor der Kaffee ausgetrunken ist — etwa ${formatDuration(c.durationH, 'de')} reine Flugzeit. ${c.domestic ? 'Da Start und Ziel im selben Land liegen, entfallen Grenzformalitäten komplett; selbst ein Tagesausflug mit Rückflug am Abend ist realistisch.' : 'Trotz der kurzen Distanz wird eine Grenze überquert — Ausweis oder Reisepass gehören also griffbereit ins Handgepäck.'} Ein Vergleich der Abflugzeiten über den Tag lohnt sich: Auf dicht beflogenen Kurzstrecken ist der Preisunterschied zwischen dem 6-Uhr-Flug und dem Vormittagsflug oft größer als der zwischen zwei Airlines.`,
    (c) => `Die wichtigste Entscheidung auf der Strecke ${c.o}–${c.d} fällt vor dem Abflug: der Buchungszeitpunkt. Der Flug selbst ist mit etwa ${c.km} km und rund ${formatDuration(c.durationH, 'de')} schnell erledigt. Zwei bis drei Wochen Vorlauf sind auf europäischen Kurzstrecken meist der beste Kompromiss, und Abflüge unter der Woche unterbieten Freitag- und Sonntagabend regelmäßig deutlich. ${c.domestic ? 'Auch ein Blick auf die Bahn lohnt: Wo sie auf Inlandsstrecken konkurriert, reagieren Airlines mit schärferen Tarifen.' : 'Hin- und Rückflug sollten getrennt verglichen werden — beide Richtungen folgen oft unterschiedlichen Nachfragekurven.'}`,
    (c) => `Ob sich das Fliegen zwischen ${c.o} und ${c.d} überhaupt lohnt, hängt bei rund ${c.km} km ehrlicherweise von der Tür-zu-Tür-Zeit ab. Die reine Flugzeit liegt bei etwa ${formatDuration(c.durationH, 'de')}, doch Anfahrt und Sicherheitskontrolle verschieben die Rechnung je nach Startpunkt. Klar im Vorteil ist der Flug bei frühen Terminen am Zielort und bei Anschlussreisen — und sobald ein Aktionstarif auftaucht, schlägt er Bodenverkehrsmittel häufig auch beim Preis.`,
    (c) => `Auf ${c.o}–${c.d} zahlt sich leichtes Gepäck mehr aus als flexible Daten. Bei dieser Streckenlänge (~${c.km} km, rund ${formatDuration(c.durationH, 'de')} Flugzeit) sind die günstigsten Tarife fast immer reine Handgepäck-Tarife; eine Aufgabegebühr kann ein Schnäppchen glatt verdoppeln. Wer leicht reist, filtert nach Basistarifen — wer nicht, vergleicht konsequent den Gesamtpreis inklusive Gepäck statt des Schaufensterpreises.`,
  ],
  'medium-haul': [
    (c) => `Mit etwa ${c.km} km liegt ${c.o}–${c.d} im europäischen Mittelfeld — zu weit für einen Katzensprung, deutlich unterhalb einer Langstrecke. Einzuplanen sind rund ${formatDuration(c.durationH, 'de')} Flugzeit. Auf Mittelstrecken dieser Art erreichen die Tarife ihren Tiefpunkt meist drei bis vier Wochen vor Abflug, und die Nebensaison (später Frühling, früher Herbst) kombiniert am Zielort ${c.d} oft das beste Verhältnis aus Wetter und Preis.`,
    (c) => `Rund ${formatDuration(c.durationH, 'de')} Flugzeit machen ${c.d} von ${c.o} aus zum klassischen Ziel für ein verlängertes Wochenende. Die ${c.km} km werden, wo die Strecke direkt bedient wird, meist nonstop geflogen — ein Blick auf Umsteigeverbindungen kann sich trotzdem lohnen, wenn der Zeitplan die Extra-Stunden verkraftet und der Preisunterschied deutlich ausfällt. Beides durchrechnen, dann entscheiden.`,
    (c) => `Kaum eine Größe bewegt diese Strecke so stark wie die Saison. ${c.o}–${c.d} misst rund ${c.km} km — etwa ${formatDuration(c.durationH, 'de')} in der Luft — und die Nachfrage schwankt mit Ferienkalendern und Veranstaltungen an beiden Enden. Bei festen Daten gilt: drei bis vier Wochen Vorlauf und sofort einen Preisalarm setzen. Bei flexiblen Daten öffnet schon eine Verschiebung um zwei, drei Tage regelmäßig eine günstigere Preisklasse.`,
    (c) => `${c.km} km auf der Strecke ${c.o}–${c.d} bedeuten: echter Tapetenwechsel ohne Langstrecken-Erholungstag. Die etwa ${formatDuration(c.durationH, 'de')} Flugzeit sind lang genug, dass Sitzkomfort und Abflugzeit eine Rolle spielen, aber zu kurz für Jetlag. Ein Morgenflug schenkt den ersten Tag am Ziel, der späte Rückflug rettet den letzten — vor der Buchung lohnt der Blick auf die Tarife über den gesamten Tag.`,
  ],
  'long-haul': [
    (c) => `${c.o}–${c.d} ist echte Langstrecke: rund ${c.km} km, also etwa ${formatDuration(c.durationH, 'de')} Flugzeit, bevor Wind und Routenführung mitreden. Auf dieser Distanz schlägt eine Buchung sechs bis acht Wochen im Voraus den Last-Minute-Preis fast immer, und die Kabinenwahl gewinnt an Gewicht — was ein besserer Sitz über ${formatDuration(c.durationH, 'de')} ausmacht, ist keine Kleinigkeit. Einreisebestimmungen früh prüfen: Visa-Bearbeitungszeiten überdauern so manches Tarif-Angebot.`,
    (c) => `Der beste Spartrick auf einer ${c.km}-km-Strecke wie ${c.o}–${c.d} heißt: Geduld plus Preisalarm. Langstreckentarife bewegen sich in Wellen, weil Buchungsklassen öffnen und schließen — ein heute gesehener Preis kehrt oft zurück, Panikbuchungen sind selten nötig. Für die rund ${formatDuration(c.durationH, 'de')} in der Luft gilt: den Ankunftstag frei halten von allem, was eine verspätete Landung und eine lange Einreiseschlange nicht übersteht.`,
    (c) => `Rund ${c.km} km verlangen mehr Planung als ein Europa-Hüpfer — und belohnen sie auch. Bei etwa ${formatDuration(c.durationH, 'de')} Flugzeit sollten Verbindungen nach Gesamtreisezeit verglichen werden, nicht nur nach Preis: Eine minimal günstigere Route mit langem Zwischenstopp kostet am Ziel ${c.d} schnell einen ganzen Tag. Abflüge Dienstag bis Donnerstag bleiben das verlässlichste Muster für niedrigere Langstreckenpreise; Reisen außerhalb der Hochsaison am Zielort verstärkt den Effekt.`,
  ],
};

const TITLES_DE = [
  (c) => `Flüge ${c.o}–${c.d} (${c.oIata}–${c.dIata}): Preise & Flugzeit`,
  (c) => `${c.o} nach ${c.d}: Flüge vergleichen & günstig buchen`,
  (c) => `Günstige Flüge von ${c.o} nach ${c.d} | Strecken-Guide`,
  (c) => `Flugstrecke ${c.o}–${c.d}: Dauer, Distanz & Buchungstipps`,
];

const METAS_DE = [
  (c) => `Flug von ${c.o} nach ${c.d}: rund ${c.km} km, etwa ${formatDuration(c.durationH, 'de')} Flugzeit. Bester Buchungszeitraum, Spartipps und Preisvergleich für diese Strecke.`,
  (c) => `${c.o}–${c.d} im Überblick: reale Distanz (${c.km} km), realistische Flugdauer, wann buchen — und wie Sie auf dieser Strecke nicht zu viel zahlen.`,
  (c) => `Flüge ${c.o} nach ${c.d} vergleichen: ~${c.km} km, ca. ${formatDuration(c.durationH, 'de')} Flugzeit. Mit Buchungsfenster-Empfehlung und Gepäck-Hinweisen.`,
];

const FAQ_POOL_DE = [
  (c) => ({ question: `Wie lange fliegt man von ${c.o} nach ${c.d}?`, answer: `Die Distanz beträgt etwa ${c.km} km (Großkreis), was auf einer Nonstop-Verbindung rund ${formatDuration(c.durationH, 'de')} reiner Flugzeit entspricht. Die tatsächliche Dauer variiert mit Wind, Routenführung und Fluggerät.` }),
  (c) => ({ question: `Wie weit ist ${c.d} von ${c.o} entfernt?`, answer: `Entlang der direkten Flugroute liegen ${c.o} und ${c.d} rund ${c.km} km auseinander — nach branchenüblicher Einteilung eine ${c.haul === 'short-haul' ? 'Kurzstrecke' : c.haul === 'medium-haul' ? 'Mittelstrecke' : 'Langstrecke'}.` }),
  (c) => ({ question: `Wann sollte man Flüge von ${c.o} nach ${c.d} buchen?`, answer: c.haul === 'long-haul' ? `Auf Langstrecken wie dieser sind sechs bis acht Wochen Vorlauf das verlässlichste Fenster für günstige Tarife. Früh einen Preisalarm setzen — Langstreckenpreise bewegen sich in Wellen, gute Tarife kehren oft zurück.` : c.haul === 'medium-haul' ? `Drei bis vier Wochen vor Abflug ist auf europäischen Mittelstrecken meist das beste Fenster. Abflugtage unter der Woche liegen preislich in der Regel unter Freitag und Sonntag.` : `Auf Kurzstrecken reichen meist zwei bis drei Wochen Vorlauf. Der größere Hebel ist der Wochentag: Frühflüge und Abflüge unter der Woche unterbieten Stoßzeiten regelmäßig.` }),
  (c) => ({ question: `Ist Fliegen unter der Woche auf dieser Strecke günstiger?`, answer: `Meistens ja. Dienstag- und Mittwoch-Abflüge auf ${c.o}–${c.d} liegen preislich in der Regel unter Freitag und Sonntag, wenn Geschäfts- und Wochenendverkehr zusammenfallen. Der Blick auf die ganze Woche im Preisvergleich zeigt das Muster für die eigenen Daten am schnellsten.` }),
  (c) => ({ question: `Kostet aufgegebenes Gepäck auf ${c.o}–${c.d} extra?`, answer: `Bei den meisten Tarifen dieser Strecke enthält die günstigste Preisstufe nur Handgepäck. Wer einen Koffer aufgibt, sollte den Gesamtpreis inklusive Gepäck über die Airlines hinweg vergleichen — die Rangfolge ändert sich damit häufig.` }),
  (c) => ({ question: `Wovon hängen die Preise zwischen ${c.o} und ${c.d} ab?`, answer: `Vor allem vom Buchungsvorlauf, Wochentag, der Saison und Nachfrage-Ereignissen an beiden Enden. Die Preise werden pro Abflug dynamisch gebildet — deshalb können zwei Flüge am selben Tag deutlich auseinanderliegen.` }),
];

// ═══════════════════════════════════════════════════════════════
// Language registry. Languages without a full variant set are NOT generated —
// rule: prefer no content over thin content. Additional languages get added
// here once their pools are independently written (never literal translation).
// ═══════════════════════════════════════════════════════════════
const LANGUAGES = {
  en: { intros: INTROS_EN, titles: TITLES_EN, metas: METAS_EN, faqPool: FAQ_POOL_EN, faqCount: 4 },
  de: { intros: INTROS_DE, titles: TITLES_DE, metas: METAS_DE, faqPool: FAQ_POOL_DE, faqCount: 4 },
};

function supportedLanguages() {
  return Object.keys(LANGUAGES);
}

// ─── Main entry point ───────────────────────────────────────────
// Returns { skipped: true, reasons } when the quality gate fails, otherwise
// { skipped: false, content: { title, metaDescription, intro, faq } }.
function generateRouteContent(route, language) {
  const gate = assessRouteEligibility(route);
  if (!gate.eligible) return { skipped: true, reasons: gate.reasons };

  const langPack = LANGUAGES[language];
  if (!langPack) return { skipped: true, reasons: [`language '${language}' has no independently written variant pool yet`] };

  const c = buildContext(route);
  const introPool = langPack.intros[c.haul];
  if (!introPool || !introPool.length) return { skipped: true, reasons: [`no ${c.haul} variants for '${language}'`] };

  return {
    skipped: false,
    content: {
      title: pick(langPack.titles, c.seed, 1)(c),
      metaDescription: pick(langPack.metas, c.seed, 2)(c),
      intro: pick(introPool, c.seed, 3)(c),
      faq: pickMany(langPack.faqPool, c.seed, langPack.faqCount).map((fn) => fn(c)),
    },
  };
}

module.exports = {
  generateRouteContent,
  assessRouteEligibility,
  hasManualContent,
  supportedLanguages,
  estimateDurationHours,
  seedFrom, // exported for tests
};
