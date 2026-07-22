// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/blocks.de.js
// German content blocks for programmatic route SEO.
//
// Each block:
//   applicable(ctx) → only true when the route carries the REAL data it needs.
//   weight(ctx)     → relevance, used to select/order sections per page.
//   render(ctx,rng) → { heading, body } — wording branches on the route's data
//                     buckets and rotates via the seeded rng, so no two pages
//                     read alike even when data overlaps.
//
// Nothing here invents facts: every number comes from ctx (built from the
// route row). Blocks that would need absent data simply don't render.
// ═══════════════════════════════════════════════════════════════════════════

const { pick } = require('./compose');

const EUR = (n) => `${Math.round(n)} €`;
const haulWord = (h) => (h === 'short-haul' ? 'Kurzstrecke' : h === 'medium-haul' ? 'Mittelstrecke' : 'Langstrecke');

// ─── 10 angle-based intros ──────────────────────────────────────
// The angle is chosen by the composer from the route's most distinctive fact
// (see engine.js). Each angle has several independently written openings.
const INTRO_ANGLES = {
  price: [
    (c) => `Wer die Strecke ${c.o}–${c.d} im Blick hat, schaut zuerst auf den Preis${c.priceMin != null ? `, und der beginnt hier bei rund ${EUR(c.priceMin)}` : ''}. ${c.priceB === 'budget' ? 'Für eine Verbindung dieser Art ist das günstig — die eigentliche Kunst liegt darin, den niedrigen Tarif auch zum passenden Reisedatum zu treffen.' : c.priceB === 'premium' ? 'Das liegt am oberen Ende; auf dieser Verbindung entscheidet der Buchungszeitpunkt spürbar über den Endpreis.' : 'Das ist ein solider Mittelwert; mit etwas Flexibilität lässt sich der Tarif oft noch drücken.'}`,
    (c) => `${c.priceMin != null ? `Ab etwa ${EUR(c.priceMin)} ` : 'Preislich '}bewegt sich ${c.o} nach ${c.d} in einem Bereich, der sich mit dem richtigen Timing deutlich beeinflussen lässt. ${c.priceTrend === 'down' ? 'Zuletzt zeigten die beobachteten Tarife eher nach unten — ein gutes Zeichen für Wartende.' : c.priceTrend === 'up' ? 'Zuletzt zogen die Tarife eher an, frühes Buchen zahlt sich hier also aus.' : 'Die Tarife blieben zuletzt vergleichsweise stabil, was die Planung erleichtert.'}`,
  ],
  duration: [
    (c) => `${c.fmtDur ? `Rund ${c.fmtDur} ` : ''}dauert der Flug von ${c.o} nach ${c.d} — ${c.haul === 'short-haul' ? 'kurz genug, dass die eigentliche Reisezeit eher von An- und Abfahrt zum Flughafen bestimmt wird als vom Flug selbst.' : c.haul === 'long-haul' ? 'lang genug, dass Sitzwahl, Abflugzeit und Kabinenkomfort zu echten Entscheidungen werden.' : 'überschaubar genug für ein verlängertes Wochenende, ohne dass ein Erholungstag nötig wäre.'}`,
    (c) => `Die Flugzeit ist auf ${c.o}–${c.d} das bestimmende Merkmal: ${c.fmtDur ? `mit rund ${c.fmtDur} ` : ''}${c.haul === 'long-haul' ? 'gehört diese Verbindung klar zu den langen, und die Wahl der Verbindung entscheidet über einen ganzen Reisetag.' : 'bleibt sie angenehm im Rahmen, sodass der Fokus auf Preis und Abflugzeit wandert.'}`,
  ],
  airport: [
    (c) => `Zwischen ${c.o} (${c.oIata}) und ${c.d} (${c.dIata}) beginnt die Reiseentscheidung schon am Flughafen — ${c.oIata} als Ausgangspunkt und ${c.dIata} als Ziel prägen Anfahrt, Umsteigezeiten und Anschlüsse mehr, als viele erwarten.`,
    (c) => `${c.dIata} ist der Zielflughafen für ${c.d}, doch die Anreise ab ${c.o} über ${c.oIata} lohnt einen genaueren Blick: Lage, Anbindung und Sicherheitsaufkommen unterscheiden sich je nach Terminal deutlich.`,
  ],
  airline: [
    (c) => `Auf der Verbindung ${c.o}–${c.d} ${c.airlineB === 'many' ? `konkurriert eine ganze Reihe von Fluggesellschaften — ${c.airlineCount} verschiedene wurden zuletzt gezählt` : c.airlineB === 'single' ? 'ist die Auswahl an Fluggesellschaften überschaubar' : `bewegen sich mehrere Anbieter${c.airlineCount ? ` (zuletzt ${c.airlineCount})` : ''}`}, und genau das bestimmt Preisspanne wie Servicequalität.`,
    (c) => `${c.airlineCount ? `${c.airlineCount} Fluggesellschaften ` : 'Mehrere Anbieter '}bedienen ${c.o} nach ${c.d} — ${c.airlineB === 'many' ? 'diese Dichte drückt die Preise und erweitert die Auswahl an Abflugzeiten erheblich.' : c.airlineB === 'single' ? 'bei geringer Konkurrenz lohnt der frühe Blick auf die Tarife besonders.' : 'genug für echten Wettbewerb, ohne die Suche unübersichtlich zu machen.'}`,
  ],
  destination: [
    (c) => `${c.d} zieht Reisende aus ${c.o} das ganze Jahr über an, und die Flugverbindung dorthin ist der praktische erste Schritt. ${c.domestic ? 'Da beide Städte im selben Land liegen, entfällt jede Grenzformalität.' : 'Als internationale Verbindung lohnt der frühe Blick auf Einreise- und Gepäckregeln.'}`,
    (c) => `Der Weg von ${c.o} nach ${c.d} führt zu einem Ziel mit eigenem Charakter — und die richtige Flugverbindung entscheidet mit, wie entspannt die Reise beginnt.`,
  ],
  traveler: [
    (c) => `Ob spontaner Städtetrip oder länger geplante Reise: ${c.o}–${c.d} lässt sich für sehr unterschiedliche Reisetypen buchen, und die beste Wahl hängt davon ab, was zählt — Preis, Zeit oder Komfort.`,
    (c) => `Reisende zwischen ${c.o} und ${c.d} treffen selten dieselbe Entscheidung: Für die einen zählt der günstigste Tarif, für die anderen die passende Abflugzeit. Diese Seite ordnet beides ein.`,
  ],
  business: [
    (c) => `Für Geschäftsreisende auf der Strecke ${c.o}–${c.d} zählt vor allem Verlässlichkeit: ${c.directB === 'all-direct' ? 'sämtliche beobachteten Verbindungen sind Direktflüge, was enge Terminketten planbar macht.' : c.directB === 'has-direct' || c.directB === 'mostly-direct' ? 'Direktflüge sind verfügbar und halten Anschlusstermine realistisch.' : 'die Verbindungen erfordern meist einen Umstieg — ein Puffer im Kalender ist ratsam.'}`,
  ],
  family: [
    (c) => `Wer mit der Familie von ${c.o} nach ${c.d} fliegt, plant anders: ${c.directB === 'all-direct' ? 'dass hier durchgehend direkt geflogen wird, erspart Umsteigestress mit Kindern.' : 'ein möglichst direkter Flug und passende Abflugzeiten stehen dann vor dem letzten Euro Ersparnis.'} Gepäck und Sitzplatzreservierung wollen früh bedacht sein.`,
  ],
  weekend: [
    (c) => `${c.o}–${c.d} eignet sich${c.haul === 'short-haul' ? ' bestens' : c.haul === 'medium-haul' ? ' gut' : ' nur bedingt'} für einen Wochenendtrip: ${c.fmtDur ? `bei rund ${c.fmtDur} Flugzeit ` : ''}${c.haul === 'long-haul' ? 'bleibt vom kurzen Wochenende wenig übrig — mehr Tage lohnen sich hier.' : 'bleibt genug Zeit vor Ort, wenn Hin- und Rückflug klug gelegt werden.'}`,
  ],
  seasonal: [
    (c) => `Wann man ${c.o} nach ${c.d} fliegt, macht einen Unterschied — bei Preis wie Andrang. ${c.priceTrend === 'down' ? 'Die zuletzt beobachtete Preisrichtung war eher fallend.' : c.priceTrend === 'up' ? 'Die zuletzt beobachtete Preisrichtung war eher steigend.' : 'Die Nebensaison bringt auf dieser Verbindung erfahrungsgemäß die ruhigeren Termine.'}`,
  ],
};

// ─── Section blocks ─────────────────────────────────────────────
const BLOCKS = [
  {
    id: 'overview',
    applicable: () => true,
    weight: () => 1.0,
    render: (c, rng) => ({
      heading: pick(rng, ['Die Verbindung im Überblick', `${c.o} nach ${c.d} auf einen Blick`, 'Das Wichtigste zur Strecke']),
      body: [
        c.km ? pick(rng, [
          `${c.o} und ${c.d} trennen rund ${c.km} km Luftlinie — eine ${haulWord(c.haul)} nach Branchenmaßstab.`,
          `Mit etwa ${c.km} km Distanz zählt ${c.o}–${c.d} zur Kategorie ${haulWord(c.haul)}.`,
          `Die direkte Flugroute misst ungefähr ${c.km} km; das macht die Verbindung zu einer ${haulWord(c.haul)}.`,
        ]) : `${c.o}–${c.d} ist eine ${haulWord(c.haul)}.`,
        c.fmtDur ? pick(rng, [
          `Ein Flug dauert im Schnitt rund ${c.fmtDur}.`,
          `Die typische reine Flugzeit liegt bei etwa ${c.fmtDur}.`,
        ]) : '',
        c.domestic ? 'Beide Flughäfen liegen im selben Land, Grenzformalitäten entfallen.' : 'Es handelt sich um eine internationale Verbindung.',
      ].filter(Boolean).join(' '),
    }),
  },
  {
    id: 'price-analysis',
    applicable: (c) => c.facts.has('price'),
    weight: (c) => (c.priceB === 'budget' || c.priceB === 'premium' ? 0.95 : 0.7),
    render: (c, rng) => {
      const range = c.priceMax && c.priceMax > c.priceMin
        ? pick(rng, [
            `Die beobachtete Spanne reicht von etwa ${EUR(c.priceMin)} bis ${EUR(c.priceMax)}.`,
            `Zwischen rund ${EUR(c.priceMin)} und ${EUR(c.priceMax)} bewegten sich zuletzt die Tarife.`,
          ])
        : `Tarife starten bei etwa ${EUR(c.priceMin)}.`;
      const trend = c.priceTrend === 'down' ? pick(rng, ['Die Richtung wies zuletzt nach unten.', 'Zuletzt gaben die Preise eher nach.'])
        : c.priceTrend === 'up' ? pick(rng, ['Zuletzt zogen die Preise an.', 'Die Richtung wies zuletzt nach oben.'])
        : c.priceTrend === 'stable' ? 'Die Preise blieben zuletzt weitgehend stabil.' : '';
      const advice = c.priceB === 'budget'
        ? 'Auf diesem günstigen Niveau lohnt es sich, nicht auf ein noch niedrigeres zu warten, sondern einen guten Tarif direkt zu sichern.'
        : c.priceB === 'premium'
        ? 'In diesem Preissegment macht früheres Buchen und Flexibilität beim Wochentag den größten Unterschied.'
        : 'Wer ein bis zwei Tage flexibel ist, findet hier regelmäßig einen spürbar besseren Tarif.';
      return {
        heading: pick(rng, ['Preisanalyse', 'Was die Strecke kostet', 'Preisniveau und Timing']),
        body: [range, trend, advice].filter(Boolean).join(' '),
      };
    },
  },
  {
    id: 'airline-analysis',
    applicable: (c) => c.facts.has('airlines'),
    weight: (c) => (c.airlineB === 'many' || c.airlineB === 'single' ? 0.85 : 0.6),
    render: (c, rng) => {
      const lead = c.airlineB === 'many'
        ? pick(rng, [
            `Mit ${c.airlineCount} konkurrierenden Fluggesellschaften herrscht auf ${c.o}–${c.d} echter Wettbewerb.`,
            `${c.airlineCount} Anbieter teilen sich diese Verbindung — ungewöhnlich viel Auswahl.`,
          ])
        : c.airlineB === 'single'
        ? `Die Strecke wird von nur einer nennenswerten Fluggesellschaft bedient, was die Auswahl klar begrenzt.`
        : pick(rng, [
            `${c.airlineCount} Fluggesellschaften bedienen die Verbindung.`,
            `Zuletzt waren ${c.airlineCount} Anbieter auf dieser Strecke aktiv.`,
          ]);
      const impl = c.airlineB === 'many'
        ? 'Diese Dichte weitet die Auswahl an Abflugzeiten und drückt tendenziell die Tarife — der Preisvergleich lohnt hier besonders.'
        : c.airlineB === 'single'
        ? 'Bei geringer Konkurrenz schwanken die Preise weniger; ein früher Buchungszeitpunkt ist die verlässlichere Ersparnis.'
        : 'Genug Auswahl für Wettbewerb, ohne die Suche unübersichtlich werden zu lassen.';
      return { heading: pick(rng, ['Fluggesellschaften auf der Strecke', 'Wer diese Verbindung fliegt', 'Airline-Auswahl']), body: `${lead} ${impl}` };
    },
  },
  {
    id: 'direct-analysis',
    applicable: (c) => c.facts.has('directness'),
    weight: (c) => (c.directB === 'connections-only' || c.directB === 'all-direct' ? 0.9 : 0.65),
    render: (c, rng) => {
      let body;
      if (c.directB === 'all-direct') {
        body = pick(rng, [
          `Auf ${c.o}–${c.d} sind alle beobachteten Verbindungen Direktflüge — kein Umstieg, keine Anschlusssorge.`,
          `Diese Strecke wird durchgehend direkt geflogen; ein verpasster Anschluss ist damit kein Thema.`,
        ]) + ' Für Zeitkritisches ist das die komfortabelste Ausgangslage.';
      } else if (c.directB === 'connections-only') {
        body = pick(rng, [
          `Direktflüge sind auf ${c.o}–${c.d} die Ausnahme; die meisten Reisenden steigen einmal um.`,
          `Für diese Verbindung ist in der Regel ein Umstieg einzuplanen.`,
        ]) + ' Ein Zeitpuffer bei Anschlüssen und eine bewusste Wahl der Umsteigezeit zahlen sich aus.';
      } else if (c.directB === 'mostly-direct' || c.directB === 'has-direct') {
        body = `Direktflüge sind verfügbar, daneben gibt es günstigere Verbindungen mit Umstieg. ${pick(rng, ['Wer Zeit sparen will, greift zum Nonstop; wer Geld sparen will, prüft die Umsteigeoption.', 'Die Wahl zwischen Nonstop und Umstieg ist hier eine echte Abwägung zwischen Zeit und Preis.'])}`;
      } else {
        body = 'Direkte wie umsteigende Verbindungen kommen vor — ein Vergleich beider Varianten lohnt sich.';
      }
      return { heading: pick(rng, ['Direktflug oder Umstieg?', 'Direktverbindungen', 'Nonstop-Analyse']), body };
    },
  },
  {
    id: 'booking-strategy',
    applicable: () => true,
    weight: (c) => (c.facts.has('price') || c.facts.has('priceTrend') ? 0.8 : 0.55),
    render: (c, rng) => {
      const window = c.haul === 'long-haul' ? 'sechs bis acht Wochen' : c.haul === 'medium-haul' ? 'drei bis vier Wochen' : 'zwei bis drei Wochen';
      const base = pick(rng, [
        `Als Faustregel gilt für diese ${haulWord(c.haul)} ein Vorlauf von ${window} vor Abflug.`,
        `Für eine ${haulWord(c.haul)} wie ${c.o}–${c.d} liegt das günstigste Fenster meist ${window} vor dem Reisetag.`,
      ]);
      const trendHint = c.priceTrend === 'up' ? ' Da die Tarife zuletzt anzogen, spricht viel für frühes Buchen.'
        : c.priceTrend === 'down' ? ' Weil die Preise zuletzt nachgaben, kann sich bei flexiblen Daten kurzes Abwarten mit Preisalarm lohnen.' : '';
      const day = pick(rng, ['Abflüge unter der Woche liegen preislich meist unter Freitag und Sonntag.', 'Dienstag und Mittwoch sind erfahrungsgemäß die günstigeren Abflugtage.']);
      return { heading: pick(rng, ['Wann buchen?', 'Buchungsstrategie', 'Der beste Zeitpunkt']), body: base + trendHint + ' ' + day };
    },
  },
  {
    id: 'seasonal',
    applicable: (c) => c.facts.has('priceTrend') || c.facts.has('popularity'),
    weight: () => 0.5,
    render: (c, rng) => {
      const parts = [];
      if (c.popB === 'high') parts.push(pick(rng, [`${c.d} ist ein stark nachgefragtes Ziel, was sich in den Hauptreisezeiten auf die Preise legt.`, `Die hohe Nachfrage auf ${c.o}–${c.d} macht Nebensaison-Termine besonders wertvoll.`]));
      else if (c.popB === 'niche') parts.push('Als weniger überlaufene Verbindung bleibt die Preisspreizung über das Jahr hier meist moderat.');
      if (c.priceTrend) parts.push(c.priceTrend === 'down' ? 'Die zuletzt beobachtete Preisrichtung war fallend.' : c.priceTrend === 'up' ? 'Die zuletzt beobachtete Preisrichtung war steigend.' : 'Die Preise zeigten sich zuletzt saisonal stabil.');
      parts.push('Wer zeitlich flexibel ist, verschiebt Abflug oder Rückkehr um wenige Tage und trifft oft eine günstigere Preisklasse.');
      return { heading: pick(rng, ['Saisonale Hinweise', 'Reisezeit und Preis', 'Wann ist es günstiger?']), body: parts.join(' ') };
    },
  },
  {
    id: 'popularity',
    applicable: (c) => c.facts.has('popularity'),
    weight: (c) => (c.popB === 'high' ? 0.7 : 0.45),
    render: (c, rng) => {
      const body = c.popB === 'high'
        ? pick(rng, [`${c.o}–${c.d} gehört zu den gefragteren Verbindungen — regelmäßiges Angebot und viele Alternativen bei Umbuchungen sind die Folge.`, `Diese Strecke wird viel geflogen; entsprechend dicht ist der Flugplan und entsprechend flexibel bleibt man bei Planänderungen.`])
        : c.popB === 'niche'
        ? `${c.o}–${c.d} ist eine ruhigere Verbindung. Das bedeutet weniger Gedränge, aber auch, dass ein passender Tarif früher gesichert werden sollte.`
        : `Die Verbindung ${c.o}–${c.d} wird solide nachgefragt, mit verlässlichem Angebot über die Woche.`;
      return { heading: pick(rng, ['Wie beliebt ist diese Strecke?', 'Nachfrage und Angebot', 'Beliebtheit der Route']), body };
    },
  },
  {
    id: 'airport-detail',
    applicable: (c) => !!(c.oIata && c.dIata),
    weight: () => 0.5,
    render: (c, rng) => ({
      heading: pick(rng, ['Flughäfen im Detail', `Von ${c.oIata} nach ${c.dIata}`, 'Abflug und Ankunft']),
      body: pick(rng, [
        `Der Abflug erfolgt ab ${c.o} (${c.oIata}), die Ankunft in ${c.d} (${c.dIata}). Prüfen Sie vorab die Anbindung beider Flughäfen an das jeweilige Stadtzentrum — Transferzeit und -kosten unterscheiden sich oft deutlich.`,
        `${c.oIata} in ${c.o} ist der Ausgangspunkt, ${c.dIata} in ${c.d} das Ziel. Ein Blick auf die Bodenanbindung am Zielflughafen spart bei der Ankunft Zeit und Nerven.`,
      ]) + (c.domestic ? ' Bei einem Inlandsflug fallen die Wege durch die Kontrolle meist kürzer aus.' : ''),
    }),
  },
];

// FAQ candidates — the composer selects a subset and their answers branch on data.
const FAQ_CANDIDATES = [
  { id: 'duration', applicable: (c) => c.facts.has('duration') || c.km, q: (c) => `Wie lange dauert der Flug von ${c.o} nach ${c.d}?`,
    a: (c) => c.fmtDur ? `Die typische reine Flugzeit liegt bei rund ${c.fmtDur}${c.km ? ` bei etwa ${c.km} km Distanz` : ''}. Die genaue Dauer hängt von Wind, Route und Flugzeugtyp ab.` : `Bei rund ${c.km} km Distanz ist mit einer für eine ${haulWord(c.haul)} üblichen Flugzeit zu rechnen.` },
  { id: 'book-when', applicable: () => true, q: (c) => `Wann sollte ich Flüge von ${c.o} nach ${c.d} buchen?`,
    a: (c) => { const w = c.haul === 'long-haul' ? 'sechs bis acht Wochen' : c.haul === 'medium-haul' ? 'drei bis vier Wochen' : 'zwei bis drei Wochen'; return `Für diese ${haulWord(c.haul)} ist ein Vorlauf von ${w} meist ideal.${c.priceTrend === 'up' ? ' Da die Tarife zuletzt anzogen, lohnt frühes Buchen zusätzlich.' : c.priceTrend === 'down' ? ' Weil die Preise zuletzt nachgaben, kann ein Preisalarm bei flexiblen Daten helfen.' : ''} Abflüge unter der Woche sind in der Regel günstiger.`; } },
  { id: 'direct', applicable: (c) => c.facts.has('directness'), q: (c) => `Gibt es Direktflüge von ${c.o} nach ${c.d}?`,
    a: (c) => c.directB === 'all-direct' ? 'Ja — alle zuletzt beobachteten Verbindungen sind Direktflüge.' : c.directB === 'connections-only' ? 'Direktflüge sind selten; in der Regel ist ein Umstieg einzuplanen.' : 'Ja, Direktflüge sind verfügbar; daneben gibt es meist günstigere Verbindungen mit Umstieg.' },
  { id: 'airlines', applicable: (c) => c.facts.has('airlines'), q: (c) => `Welche Fluggesellschaften fliegen ${c.o}–${c.d}?`,
    a: (c) => c.airlineB === 'many' ? `Auf dieser Strecke waren zuletzt ${c.airlineCount} Fluggesellschaften aktiv — der Preisvergleich lohnt sich dadurch besonders.` : c.airlineB === 'single' ? 'Die Verbindung wird von nur einer nennenswerten Fluggesellschaft bedient.' : `Zuletzt bedienten ${c.airlineCount} Fluggesellschaften die Strecke.` },
  { id: 'cheaper-months', applicable: (c) => c.facts.has('price') || c.facts.has('priceTrend'), q: (c) => `Ist die Strecke ${c.o}–${c.d} zu bestimmten Zeiten günstiger?`,
    a: (c) => `Ja. ${c.priceTrend === 'down' ? 'Die zuletzt beobachtete Preisrichtung war fallend. ' : c.priceTrend === 'up' ? 'Die zuletzt beobachtete Preisrichtung war steigend. ' : ''}Wer Abflug oder Rückkehr um wenige Tage verschiebt und die Nebensaison nutzt, trifft regelmäßig eine günstigere Preisklasse.` },
  { id: 'weekend', applicable: (c) => c.haul !== 'long-haul', q: (c) => `Eignet sich ${c.o}–${c.d} für einen Wochenendtrip?`,
    a: (c) => c.haul === 'short-haul' ? `Sehr gut. ${c.fmtDur ? `Bei rund ${c.fmtDur} Flugzeit ` : ''}bleibt vor Ort genug Zeit, wenn Hin- und Rückflug klug gelegt werden.` : `Bedingt. ${c.fmtDur ? `Mit rund ${c.fmtDur} je Richtung ` : ''}lohnt sich eher ein langes Wochenende als ein kurzer Zwei-Tage-Trip.` },
  { id: 'price-from', applicable: (c) => c.facts.has('price'), q: (c) => `Was kostet ein Flug von ${c.o} nach ${c.d}?`,
    a: (c) => `Die zuletzt beobachteten Tarife begannen bei etwa ${EUR(c.priceMin)}${c.priceMax && c.priceMax > c.priceMin ? ` und reichten bis rund ${EUR(c.priceMax)}` : ''}. Preise werden pro Abflug dynamisch gebildet und ändern sich laufend.` },
];

const TITLES = [
  (c) => `${c.o} nach ${c.d}: Flüge, ${c.fmtDur ? 'Flugzeit' : 'Distanz'} & Preise`,
  (c) => `Flüge ${c.o}–${c.d} (${c.oIata}–${c.dIata}) vergleichen`,
  (c) => c.priceMin != null ? `Flug ${c.o} → ${c.d} ab ${EUR(c.priceMin)} | Vergleich` : `Günstige Flüge ${c.o} → ${c.d}`,
  (c) => c.directB === 'all-direct' ? `Direktflüge ${c.o} nach ${c.d} im Vergleich` : `${c.o}–${c.d}: Flüge, Airlines & Buchungstipps`,
  (c) => `Flug ${c.o} nach ${c.d}: ${haulWord(c.haul)}-Guide`,
];

const METAS = [
  (c) => `${c.o} nach ${c.d}${c.km ? ` (~${c.km} km` : ''}${c.fmtDur ? `, ${c.fmtDur}` : ''}${c.km ? ')' : ''}: ${c.priceMin != null ? `Tarife ab ${EUR(c.priceMin)}, ` : ''}Airlines, Direktflug-Check und der beste Buchungszeitpunkt im Überblick.`,
  (c) => `${c.directB === 'all-direct' ? 'Direktflüge' : 'Flüge'} ${c.o}–${c.d} vergleichen: ${c.airlineCount ? `${c.airlineCount} Airlines, ` : ''}${c.fmtDur ? `${c.fmtDur} Flugzeit, ` : ''}Preisanalyse und Reisezeit-Tipps.`,
  (c) => `Alles zur Strecke ${c.o} → ${c.d}: ${c.km ? `${c.km} km, ` : ''}${c.priceMin != null ? `ab ${EUR(c.priceMin)}, ` : ''}wann buchen, welcher Flug sich lohnt und wie Sie sparen.`,
];

module.exports = { INTRO_ANGLES, BLOCKS, FAQ_CANDIDATES, TITLES, METAS, haulWord };
