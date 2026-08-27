// ═══════════════════════════════════════════════════════════════
// src/services/ticketPdf.js
// بيولّد PDF رسمي لتذكرة الحجز — بنفس مستوى تفصيل تذكرة Duffel
// الأصلية (تفاصيل كل رحلة بأسماء المطارات الكاملة والصالات ودرجة
// المقصورة، وقسم ركاب مجمّع لكل مسافر مع المقعد والحقائب لكل قطعة
// رحلة)، بس بهوية Airpiv. متعدّد اللغات (de/en/fr/es/it/nl/ar) حسب
// لغة المستخدم، مع دعم كامل للعربي (خط Amiri مضمّن + تشكيل/اتجاه
// يمين-يسار عبر fontkit). كله data-gated — أي معلومة مش راجعة من
// Duffel بتتحذف بدل ما تظهر فاضية. بيستخدم pdfkit (JS خالص).
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const PDFDocument = require('pdfkit');

const TEAL = '#0FB5A0';
const NAVY = '#0A1822';
const TX = '#101d2c';
const TX2 = '#46586c';
const TX3 = '#8fa4b4';
const BORDER = '#e1e7ec';
const GREEN = '#0a9384';
const RED = '#c0392b';

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

// ── i18n ──────────────────────────────────────────────────────
// One flat dictionary per supported language. `depart`/`arrive` include
// their own separator/preposition so each language reads naturally.
const T = {
  de: { bookingCode: 'BUCHUNGSCODE', flightDetails: 'Flugdetails', travelers: 'Reisende', ticketNumbers: 'Ticketnummern', priceSummary: 'Preisübersicht', outbound: 'Hinflug', return: 'Rückflug', flight: 'Flug', nonstop: 'Nonstop', stop: 'Zwischenstopp', stops: 'Zwischenstopps', multipleAirlines: 'Mehrere Airlines', depart: 'Abflug:', arrive: 'Ankunft:', duration: 'Flugdauer:', layover: 'Umstieg in', adult: 'Erwachsener', child: 'Kind', infant: 'Kleinkind', name: 'Name', dob: 'Geburtsdatum', gender: 'Geschlecht', flightInfo: 'Fluginformationen', seat: 'Sitz', bagChecked: 'Aufgabegepäck', bagCarry: 'Handgepäck', male: 'Männlich', female: 'Weiblich', pTicket: 'Flugticket', pBags: 'Gepäck', pSeats: 'Sitzplätze', pLoyalty: 'Treueguthaben verwendet', pTotal: 'Gesamtbetrag', disclaimer: 'Diese Übersicht ersetzt nicht das offizielle Ticket der Fluggesellschaft.' },
  en: { bookingCode: 'BOOKING REFERENCE', flightDetails: 'Flight details', travelers: 'Passengers', ticketNumbers: 'Ticket numbers', priceSummary: 'Price summary', outbound: 'Outbound', return: 'Return', flight: 'Flight', nonstop: 'Non-stop', stop: 'stop', stops: 'stops', multipleAirlines: 'Multiple airlines', depart: 'Depart from', arrive: 'Arrive at', duration: 'Flight duration:', layover: 'Layover in', adult: 'Adult', child: 'Child', infant: 'Infant', name: 'Name', dob: 'Date of birth', gender: 'Gender', flightInfo: 'Flight information', seat: 'Seat', bagChecked: 'Checked bag', bagCarry: 'Carry-on bag', male: 'Male', female: 'Female', pTicket: 'Flight ticket', pBags: 'Baggage', pSeats: 'Seats', pLoyalty: 'Loyalty credit applied', pTotal: 'Total', disclaimer: "This summary does not replace the airline's official ticket." },
  fr: { bookingCode: 'RÉFÉRENCE DE RÉSERVATION', flightDetails: 'Détails du vol', travelers: 'Passagers', ticketNumbers: 'Numéros de billet', priceSummary: 'Récapitulatif des prix', outbound: 'Aller', return: 'Retour', flight: 'Vol', nonstop: 'Direct', stop: 'escale', stops: 'escales', multipleAirlines: 'Plusieurs compagnies', depart: 'Départ :', arrive: 'Arrivée :', duration: 'Durée du vol :', layover: 'Escale à', adult: 'Adulte', child: 'Enfant', infant: 'Bébé', name: 'Nom', dob: 'Date de naissance', gender: 'Sexe', flightInfo: 'Informations sur le vol', seat: 'Siège', bagChecked: 'Bagage en soute', bagCarry: 'Bagage à main', male: 'Homme', female: 'Femme', pTicket: "Billet d'avion", pBags: 'Bagages', pSeats: 'Sièges', pLoyalty: 'Crédit fidélité utilisé', pTotal: 'Total', disclaimer: "Ce récapitulatif ne remplace pas le billet officiel de la compagnie aérienne." },
  es: { bookingCode: 'CÓDIGO DE RESERVA', flightDetails: 'Detalles del vuelo', travelers: 'Pasajeros', ticketNumbers: 'Números de billete', priceSummary: 'Resumen de precios', outbound: 'Ida', return: 'Vuelta', flight: 'Vuelo', nonstop: 'Directo', stop: 'escala', stops: 'escalas', multipleAirlines: 'Varias aerolíneas', depart: 'Salida:', arrive: 'Llegada:', duration: 'Duración del vuelo:', layover: 'Escala en', adult: 'Adulto', child: 'Niño', infant: 'Bebé', name: 'Nombre', dob: 'Fecha de nacimiento', gender: 'Sexo', flightInfo: 'Información del vuelo', seat: 'Asiento', bagChecked: 'Equipaje facturado', bagCarry: 'Equipaje de mano', male: 'Hombre', female: 'Mujer', pTicket: 'Billete de avión', pBags: 'Equipaje', pSeats: 'Asientos', pLoyalty: 'Crédito de fidelidad aplicado', pTotal: 'Total', disclaimer: 'Este resumen no sustituye el billete oficial de la aerolínea.' },
  it: { bookingCode: 'CODICE DI PRENOTAZIONE', flightDetails: 'Dettagli del volo', travelers: 'Passeggeri', ticketNumbers: 'Numeri di biglietto', priceSummary: 'Riepilogo prezzi', outbound: 'Andata', return: 'Ritorno', flight: 'Volo', nonstop: 'Diretto', stop: 'scalo', stops: 'scali', multipleAirlines: 'Più compagnie', depart: 'Partenza:', arrive: 'Arrivo:', duration: 'Durata del volo:', layover: 'Scalo a', adult: 'Adulto', child: 'Bambino', infant: 'Neonato', name: 'Nome', dob: 'Data di nascita', gender: 'Sesso', flightInfo: 'Informazioni sul volo', seat: 'Posto', bagChecked: 'Bagaglio da stiva', bagCarry: 'Bagaglio a mano', male: 'Uomo', female: 'Donna', pTicket: 'Biglietto aereo', pBags: 'Bagagli', pSeats: 'Posti', pLoyalty: 'Credito fedeltà applicato', pTotal: 'Totale', disclaimer: "Questo riepilogo non sostituisce il biglietto ufficiale della compagnia aerea." },
  nl: { bookingCode: 'BOEKINGSCODE', flightDetails: 'Vluchtdetails', travelers: 'Passagiers', ticketNumbers: 'Ticketnummers', priceSummary: 'Prijsoverzicht', outbound: 'Heenvlucht', return: 'Terugvlucht', flight: 'Vlucht', nonstop: 'Non-stop', stop: 'tussenstop', stops: 'tussenstops', multipleAirlines: 'Meerdere maatschappijen', depart: 'Vertrek:', arrive: 'Aankomst:', duration: 'Vluchtduur:', layover: 'Overstap in', adult: 'Volwassene', child: 'Kind', infant: 'Baby', name: 'Naam', dob: 'Geboortedatum', gender: 'Geslacht', flightInfo: 'Vluchtinformatie', seat: 'Stoel', bagChecked: 'Ruimbagage', bagCarry: 'Handbagage', male: 'Man', female: 'Vrouw', pTicket: 'Vliegticket', pBags: 'Bagage', pSeats: 'Stoelen', pLoyalty: 'Loyaliteitstegoed gebruikt', pTotal: 'Totaal', disclaimer: 'Dit overzicht vervangt niet het officiële ticket van de luchtvaartmaatschappij.' },
  ar: { bookingCode: 'رمز الحجز', flightDetails: 'تفاصيل الرحلة', travelers: 'المسافرون', ticketNumbers: 'أرقام التذاكر', priceSummary: 'ملخص الأسعار', outbound: 'رحلة الذهاب', return: 'رحلة العودة', flight: 'رحلة', nonstop: 'مباشر', stop: 'توقف', stops: 'توقفات', multipleAirlines: 'عدة شركات طيران', depart: 'المغادرة من:', arrive: 'الوصول إلى:', duration: 'مدة الرحلة:', layover: 'توقف في', adult: 'بالغ', child: 'طفل', infant: 'رضيع', name: 'الاسم', dob: 'تاريخ الميلاد', gender: 'الجنس', flightInfo: 'معلومات الرحلة', seat: 'المقعد', bagChecked: 'حقيبة مسجّلة', bagCarry: 'حقيبة يد', male: 'ذكر', female: 'أنثى', pTicket: 'تذكرة الطيران', pBags: 'الأمتعة', pSeats: 'المقاعد', pLoyalty: 'رصيد الولاء المستخدم', pTotal: 'الإجمالي', disclaimer: 'هذا الملخص لا يُغني عن التذكرة الرسمية لشركة الطيران.' },
};

// [FARE-CONDITIONS] Localized labels for the fare-conditions section and the
// non-refundable service-fee note. Kept as its own dictionary so the large T
// table above stays untouched.
const FARE = {
  de: { title: 'Tarifbedingungen', changeable: 'Umbuchbar', notChangeable: 'Nicht umbuchbar', refundable: 'Erstattbar', notRefundable: 'Nicht erstattbar', fee: 'Gebühr', carryOn: 'Handgepäck inklusive', checked: 'Aufgabegepäck inklusive', serviceFeeNote: 'Airpiv-Servicegebühren sind gemäß unseren AGB nicht erstattbar.' },
  en: { title: 'Fare conditions', changeable: 'Changeable', notChangeable: 'Non-changeable', refundable: 'Refundable', notRefundable: 'Non-refundable', fee: 'fee', carryOn: 'Carry-on included', checked: 'Checked bag included', serviceFeeNote: 'Airpiv service fees are non-refundable under our Terms & Conditions.' },
  fr: { title: 'Conditions tarifaires', changeable: 'Modifiable', notChangeable: 'Non modifiable', refundable: 'Remboursable', notRefundable: 'Non remboursable', fee: 'frais', carryOn: 'Bagage à main inclus', checked: 'Bagage en soute inclus', serviceFeeNote: 'Les frais de service Airpiv ne sont pas remboursables conformément à nos CGV.' },
  es: { title: 'Condiciones de la tarifa', changeable: 'Modificable', notChangeable: 'No modificable', refundable: 'Reembolsable', notRefundable: 'No reembolsable', fee: 'tasa', carryOn: 'Equipaje de mano incluido', checked: 'Equipaje facturado incluido', serviceFeeNote: 'Las tarifas de servicio de Airpiv no son reembolsables según nuestros Términos y Condiciones.' },
  it: { title: 'Condizioni tariffarie', changeable: 'Modificabile', notChangeable: 'Non modificabile', refundable: 'Rimborsabile', notRefundable: 'Non rimborsabile', fee: 'penale', carryOn: 'Bagaglio a mano incluso', checked: 'Bagaglio da stiva incluso', serviceFeeNote: 'Le commissioni di servizio Airpiv non sono rimborsabili secondo i nostri Termini e Condizioni.' },
  nl: { title: 'Tariefvoorwaarden', changeable: 'Wijzigbaar', notChangeable: 'Niet wijzigbaar', refundable: 'Terugbetaalbaar', notRefundable: 'Niet terugbetaalbaar', fee: 'kosten', carryOn: 'Handbagage inbegrepen', checked: 'Ruimbagage inbegrepen', serviceFeeNote: 'Airpiv-servicekosten zijn niet terugbetaalbaar volgens onze voorwaarden.' },
  ar: { title: 'شروط التذكرة', changeable: 'قابلة للتغيير', notChangeable: 'غير قابلة للتغيير', refundable: 'قابلة للاسترداد', notRefundable: 'غير قابلة للاسترداد', fee: 'رسوم', carryOn: 'حقيبة يد مشمولة', checked: 'حقيبة مسجّلة مشمولة', serviceFeeNote: 'رسوم خدمة Airpiv غير قابلة للاسترداد وفقاً لسياسة الموقع.' },
};
const LOCALES = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', ar: 'ar' };
const SUPPORTED = Object.keys(T);
function normLang(lang) { return SUPPORTED.includes(lang) ? lang : 'de'; }

function fmtTime(d) {
  if (!d) return '--:--';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtDateLong(d, locale) {
  if (!d) return '';
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function durStr(m) {
  if (!m && m !== 0) return '';
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// ── per-render context (language, direction, dictionary, fonts) ──
function makeCtx(doc, lang) {
  const L = normLang(lang);
  const rtl = L === 'ar';
  const t = T[L];
  const locale = LOCALES[L];
  const reg = rtl ? 'NotoAr' : 'Helvetica';
  const bold = rtl ? 'NotoArBold' : 'Helvetica-Bold';
  return {
    lang: L, rtl, t, locale,
    // start = leading edge for the reading direction; end = trailing edge.
    alignStart: rtl ? 'right' : 'left',
    alignEnd: rtl ? 'left' : 'right',
    font: (b) => doc.font(b ? bold : reg),
    // Bump Arabic up a touch — Amiri's x-height reads smaller than Helvetica's.
    fs: (n) => (rtl ? n + 1 : n),
  };
}

function stopsLabel(t, n) {
  if (n <= 0) return t.nonstop;
  return `${n} ${n === 1 ? t.stop : t.stops}`;
}
function bagLabel(t, b) {
  const label = b.type === 'checked' ? t.bagChecked : t.bagCarry;
  return (b.quantity > 1 ? `${b.quantity}× ` : '') + label;
}
function paxTypeLabel(ctx, type, n) {
  const base = type === 'child' ? ctx.t.child
    : (type === 'infant_without_seat' || type === 'infant') ? ctx.t.infant
      : ctx.t.adult;
  const s = `${base} ${n}`;
  return ctx.rtl ? s : s.toUpperCase();
}
// "Berlin Brandenburg Airport (BER), Terminal 2" — every piece optional.
function airportLine(ctx, name, iata, terminal) {
  let s = name || iata || '';
  if (name && iata) s = `${name} (${iata})`;
  if (terminal) s += `, Terminal ${terminal}`;
  return s;
}

function drawHeader(doc, ctx, bookingRef) {
  doc.rect(0, 0, doc.page.width, 70).fill(NAVY);
  const logoX = ctx.rtl ? doc.page.width - 90 : 40;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
    .text('Air', logoX, 24, { continued: true })
    .fillColor(TEAL).text('piv', { continued: false });
  const codeX = ctx.rtl ? 40 : doc.page.width - 200;
  const codeAlign = ctx.rtl ? 'left' : 'right';
  ctx.font(false); doc.fillColor(TX3).fontSize(9)
    .text(ctx.t.bookingCode, codeX, 20, { width: 160, align: codeAlign });
  ctx.font(true); doc.fillColor('#ffffff').fontSize(16)
    .text(bookingRef || '—', codeX, 33, { width: 160, align: codeAlign });
  doc.y = 95;
}

function sectionTitle(doc, ctx, text, x, width) {
  doc.moveDown(0.3);
  ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(13)).text(text, x, doc.y, { width, align: ctx.alignStart });
  doc.moveDown(0.5);
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

// A label/value row with the label on the reading-start edge and the value
// on the trailing edge — mirrored for RTL. Used by price summary + tickets.
function twoColRow(doc, ctx, x, width, left, right, opts) {
  const o = opts || {};
  const wL = width * 0.62;
  const wR = width * 0.38;
  const y = doc.y;
  // [ROW-OVERLAP-FIX] Measure each column's rendered height with its own
  // font/size BEFORE drawing, so we can leave doc.y at the true BOTTOM of
  // the row. Previously this reset doc.y back to the row's top (`doc.y = y`)
  // and relied on the caller's small moveDown(0.5) to advance — which is
  // less than one line of text, so every subsequent row was drawn on top of
  // the previous one (the price summary showed all lines collapsed).
  ctx.font(!!o.leftBold); doc.fontSize(ctx.fs(o.leftSize || 10));
  const hL = doc.heightOfString(String(left == null ? '' : left), { width: wL });
  ctx.font(!!o.rightBold); doc.fontSize(ctx.fs(o.rightSize || 10));
  const hR = doc.heightOfString(String(right == null ? '' : right), { width: wR });
  if (!ctx.rtl) {
    ctx.font(!!o.leftBold); doc.fontSize(ctx.fs(o.leftSize || 10)).fillColor(o.leftColor || TX2).text(left, x, y, { width: wL, align: 'left' });
    ctx.font(!!o.rightBold); doc.fontSize(ctx.fs(o.rightSize || 10)).fillColor(o.rightColor || TX).text(right, x + wL, y, { width: wR, align: 'right' });
  } else {
    ctx.font(!!o.leftBold); doc.fontSize(ctx.fs(o.leftSize || 10)).fillColor(o.leftColor || TX2).text(left, x + wR, y, { width: wL, align: 'right' });
    ctx.font(!!o.rightBold); doc.fontSize(ctx.fs(o.rightSize || 10)).fillColor(o.rightColor || TX).text(right, x, y, { width: wR, align: 'left' });
  }
  doc.y = y + Math.max(hL, hR);
}

// A single fare-condition line: a colored status dot (green = included/allowed,
// red = not allowed) on the reading-start edge, then the label. Mirrored for RTL.
function conditionLine(doc, ctx, x, width, ok, label) {
  ensureSpace(doc, 18);
  const size = 10;
  ctx.font(false); doc.fontSize(ctx.fs(size));
  const y = doc.y;
  const textW = width - 14;
  const h = doc.heightOfString(String(label == null ? '' : label), { width: textW });
  const dotR = 2.6;
  const cy = y + ctx.fs(size) * 0.5;
  if (!ctx.rtl) {
    doc.circle(x + dotR + 1, cy, dotR).fill(ok ? GREEN : RED);
    doc.fillColor(TX2).fontSize(ctx.fs(size)).text(label, x + 14, y, { width: textW, align: 'left' });
  } else {
    doc.circle(x + width - dotR - 1, cy, dotR).fill(ok ? GREEN : RED);
    doc.fillColor(TX2).fontSize(ctx.fs(size)).text(label, x, y, { width: textW, align: 'right' });
  }
  doc.y = y + Math.max(h, ctx.fs(size) + 2);
  doc.moveDown(0.15);
}

// One bordered card per LEG; the border is stroked after the inner content so
// its height wraps whatever actually rendered (variable per carrier).
function drawLegCard(doc, ctx, leg, x, width) {
  const segs = leg.segs || [];
  if (!segs.length) return;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const legDur = (first.dep && last.arr)
    ? Math.round((last.arr.getTime() - first.dep.getTime()) / 60000)
    : segs.reduce((s, sg) => s + (sg.dur || 0), 0);
  const carriers = [...new Set(segs.map((s) => s.al).filter(Boolean))];
  const airlineLabel = carriers.length === 1 ? carriers[0] : (carriers.length > 1 ? ctx.t.multipleAirlines : '');
  const stops = stopsLabel(ctx.t, segs.length - 1);

  ensureSpace(doc, 120);
  const boxTop = doc.y;
  const pad = 14;
  const innerX = x + pad;
  const innerW = width - pad * 2;
  const c1 = innerW * 0.42;
  const c2 = innerW * 0.33;
  const c3 = innerW * 0.25;
  // Mirror the three header columns for RTL (time on the right, stops on the left).
  const x1 = ctx.rtl ? innerX + c3 + c2 : innerX;
  const x2 = ctx.rtl ? innerX + c3 : innerX + c1;
  const x3 = ctx.rtl ? innerX : innerX + c1 + c2;
  const hTop = boxTop + pad;

  ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(13))
    .text(`${fmtTime(first.dep)} – ${fmtTime(last.arr)}`, x1, hTop, { width: c1, align: ctx.alignStart });
  if (airlineLabel) {
    ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(9)).text(airlineLabel, x1, hTop + 18, { width: c1, align: ctx.alignStart });
  }
  ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(11)).text(durStr(legDur), x2, hTop, { width: c2, align: ctx.alignStart });
  ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(9)).text(`${first.from} – ${last.to}`, x2, hTop + 17, { width: c2, align: ctx.alignStart });
  ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(9)).text(stops, x3, hTop, { width: c3, align: ctx.alignEnd });

  doc.y = hTop + 34;
  doc.moveTo(innerX, doc.y).lineTo(innerX + innerW, doc.y).strokeColor(BORDER).stroke();
  doc.moveDown(0.5);

  const dateW = innerW * 0.42;
  const placeW = innerW * 0.58;
  const dateX = ctx.rtl ? innerX + placeW : innerX;
  const placeX = ctx.rtl ? innerX : innerX + dateW;

  segs.forEach((seg, i) => {
    let ry = doc.y;
    ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(9.5))
      .text(fmtDateLong(seg.dep, ctx.locale) + (seg.dep ? `, ${fmtTime(seg.dep)}` : ''), dateX, ry, { width: dateW, align: ctx.alignStart });
    ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(9.5))
      .text(`${ctx.t.depart} ${airportLine(ctx, seg.fromName, seg.from, seg.fromTerminal)}`, placeX, ry, { width: placeW, align: ctx.alignStart });
    doc.y = Math.max(doc.y, ry + 4);
    doc.moveDown(0.2);

    ctx.font(false); doc.fillColor(TX3).fontSize(ctx.fs(8.5))
      .text(`${ctx.t.duration} ${durStr(seg.dur)}`, innerX, doc.y, { width: innerW, align: ctx.alignStart });
    doc.moveDown(0.2);

    ry = doc.y;
    ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(9.5))
      .text(fmtDateLong(seg.arr, ctx.locale) + (seg.arr ? `, ${fmtTime(seg.arr)}` : ''), dateX, ry, { width: dateW, align: ctx.alignStart });
    ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(9.5))
      .text(`${ctx.t.arrive} ${airportLine(ctx, seg.toName, seg.to, seg.toTerminal)}`, placeX, ry, { width: placeW, align: ctx.alignStart });
    doc.y = Math.max(doc.y, ry + 4);
    doc.moveDown(0.35);

    const foot = [seg.cabin, seg.al, seg.aircraft, seg.fn].filter(Boolean).join('  ·  ');
    if (foot) {
      ctx.font(false); doc.fillColor(TX3).fontSize(ctx.fs(8.5)).text(foot, innerX, doc.y, { width: innerW, align: ctx.alignStart });
    }
    doc.moveDown(0.4);

    if (i < segs.length - 1) {
      const nxt = segs[i + 1];
      if (seg.arr && nxt.dep) {
        const lay = Math.round((nxt.dep.getTime() - seg.arr.getTime()) / 60000);
        if (lay > 0) {
          ctx.font(false); doc.fillColor(TX3).fontSize(ctx.fs(8.5))
            .text(`${ctx.t.layover} ${seg.toCity || seg.to} · ${durStr(lay)}`, innerX, doc.y, { width: innerW, align: ctx.alignStart });
          doc.moveDown(0.4);
        }
      }
    }
  });

  const boxBottom = doc.y + 4;
  doc.roundedRect(x, boxTop, width, boxBottom - boxTop, 8).strokeColor(BORDER).lineWidth(1).stroke();
  doc.y = boxBottom + 12;
}

function drawPassengerBlock(doc, ctx, pax, idx, x, width) {
  ensureSpace(doc, 90);
  const pad = 14;
  const innerX = x + pad;
  const innerW = width - pad * 2;
  const boxTop = doc.y;

  ctx.font(true); doc.fillColor(TX3).fontSize(ctx.fs(8.5))
    .text(paxTypeLabel(ctx, pax.type, idx), innerX, boxTop + pad, { width: innerW, align: ctx.alignStart });
  doc.moveDown(0.4);

  // Name / DOB / gender — three columns, mirrored for RTL.
  const w = [innerW * 0.45, innerW * 0.25, innerW * 0.3];
  const labels = [ctx.t.name, ctx.t.dob, ctx.t.gender];
  const genderStr = pax.genderCode === 'f' ? ctx.t.female : pax.genderCode === 'm' ? ctx.t.male : '—';
  const vals = [pax.name || '—', pax.dob || '—', genderStr];
  const xs = ctx.rtl
    ? [innerX + w[1] + w[2], innerX + w[2], innerX]
    : [innerX, innerX + w[0], innerX + w[0] + w[1]];
  const labY = doc.y;
  ctx.font(false); doc.fontSize(ctx.fs(8)).fillColor(TX3);
  labels.forEach((l, i) => doc.text(l, xs[i], labY, { width: w[i], align: ctx.alignStart }));
  doc.moveDown(0.15);
  const valY = doc.y;
  ctx.font(true); doc.fontSize(ctx.fs(10.5)).fillColor(TX);
  vals.forEach((v, i) => doc.text(String(v), xs[i], valY, { width: w[i], align: ctx.alignStart }));
  doc.y = valY;
  doc.moveDown(1);

  const flights = pax.flights || [];
  if (flights.length) {
    ctx.font(true); doc.fillColor(TX2).fontSize(ctx.fs(9)).text(ctx.t.flightInfo, innerX, doc.y, { width: innerW, align: ctx.alignStart });
    doc.moveDown(0.4);
    flights.forEach((f) => {
      const fTop = doc.y;
      const routeLine = `${f.from} → ${f.to}` + (f.dep ? ` · ${fmtDateLong(f.dep, ctx.locale)}, ${fmtTime(f.dep)}` : '');
      ctx.font(true); doc.fillColor(TX).fontSize(ctx.fs(9)).text(routeLine, innerX + 10, fTop + 6, { width: innerW - 20, align: ctx.alignStart });
      const extras = [];
      if (f.seat) extras.push(`${ctx.t.seat} ${f.seat}`);
      (f.bags || []).forEach((b) => extras.push(bagLabel(ctx.t, b)));
      if (extras.length) {
        ctx.font(false); doc.fillColor(TX2).fontSize(ctx.fs(8.5))
          .text(extras.join('   ·   '), innerX + 10, doc.y + 1, { width: innerW - 20, align: ctx.alignStart });
      }
      const fBottom = doc.y + 6;
      doc.roundedRect(innerX, fTop, innerW, fBottom - fTop, 5).strokeColor(BORDER).lineWidth(0.8).stroke();
      doc.y = fBottom + 6;
    });
  }

  const boxBottom = doc.y + 4;
  doc.roundedRect(x, boxTop, width, boxBottom - boxTop, 8).strokeColor(BORDER).lineWidth(1).stroke();
  doc.y = boxBottom + 12;
}

// [MAIN-EXPORT] بيبني PDF كامل ويرجّعه كـBuffer. data.lang يحدّد اللغة.
function buildTicketPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Register the embedded Arabic font (Amiri) — used only when lang=ar;
      // Latin languages keep pdfkit's built-in Helvetica.
      doc.registerFont('NotoAr', path.join(FONT_DIR, 'NotoSansArabic-Regular.ttf'));
      doc.registerFont('NotoArBold', path.join(FONT_DIR, 'NotoSansArabic-Bold.ttf'));

      const ctx = makeCtx(doc, data.lang);
      const marginX = 40;
      const contentWidth = doc.page.width - marginX * 2;
      const legs = data.legs || [];

      drawHeader(doc, ctx, data.bookingRef);

      // ── Flight details ──
      sectionTitle(doc, ctx, ctx.t.flightDetails, marginX, contentWidth);
      legs.forEach((leg, legIdx) => {
        if (legs.length > 1) {
          const label = legs.length > 2 ? `${ctx.t.flight} ${legIdx + 1}` : (legIdx === 0 ? ctx.t.outbound : ctx.t.return);
          ensureSpace(doc, 130);
          ctx.font(true); doc.fillColor(TX3).fontSize(ctx.fs(9))
            .text(ctx.rtl ? label : label.toUpperCase(), marginX, doc.y, { width: contentWidth, align: ctx.alignStart });
          doc.moveDown(0.35);
        }
        drawLegCard(doc, ctx, leg, marginX, contentWidth);
      });

      // ── Passengers ──
      doc.moveDown(0.4);
      sectionTitle(doc, ctx, ctx.t.travelers, marginX, contentWidth);
      const paxByType = {};
      (data.passengers || []).forEach((p) => {
        const key = p.type || 'adult';
        paxByType[key] = (paxByType[key] || 0) + 1;
        drawPassengerBlock(doc, ctx, p, paxByType[key], marginX, contentWidth);
      });

      // ── Ticket numbers ──
      const ticketNames = Object.keys(data.ticketByPax || {});
      if (ticketNames.length) {
        doc.moveDown(0.2);
        sectionTitle(doc, ctx, ctx.t.ticketNumbers, marginX, contentWidth);
        ticketNames.forEach((name) => {
          ensureSpace(doc, 24);
          twoColRow(doc, ctx, marginX, contentWidth, name, String(data.ticketByPax[name]), { rightBold: true });
          doc.moveDown(0.6);
        });
      }

      // ── Price summary ──
      if (data.priceRows && data.priceRows.length) {
        doc.moveDown(0.4);
        sectionTitle(doc, ctx, ctx.t.priceSummary, marginX, contentWidth);
        const labelFor = { ticket: ctx.t.pTicket, bags: ctx.t.pBags, seats: ctx.t.pSeats, loyalty: ctx.t.pLoyalty, total: ctx.t.pTotal };
        data.priceRows.forEach((row) => {
          ensureSpace(doc, 24);
          const label = labelFor[row.key] || row.key;
          twoColRow(doc, ctx, marginX, contentWidth, label, row.value, {
            leftBold: !!row.bold, rightBold: !!row.bold,
            leftColor: row.bold ? TX : TX2, rightColor: row.bold ? TX : TX2,
            leftSize: row.bold ? 12 : 10, rightSize: row.bold ? 12 : 10,
          });
          doc.moveDown(0.5);
          if (row.bold) {
            doc.moveTo(marginX, doc.y).lineTo(marginX + contentWidth, doc.y).strokeColor(BORDER).stroke();
            doc.moveDown(0.3);
          }
        });
      }

      // ── Fare conditions ──
      const fc = data.conditions || null;
      const fb = data.fareBaggage || {};
      const ft = FARE[ctx.lang] || FARE.de;
      const hasCond = !!fc && (fc.changeable != null || fc.refundable != null || fb.carryOn || fb.checked);
      if (hasCond) {
        const feeMoney = (n, cur) => `${(Number(n) || 0).toFixed(2)} ${cur || 'EUR'}`;
        doc.moveDown(0.3);
        sectionTitle(doc, ctx, ft.title, marginX, contentWidth);
        if (fc.changeable != null) {
          let lbl = fc.changeable ? ft.changeable : ft.notChangeable;
          if (fc.changeable && Number(fc.changePenalty) > 0) lbl += ` (${ft.fee} ${feeMoney(fc.changePenalty, fc.penaltyCurrency)})`;
          conditionLine(doc, ctx, marginX, contentWidth, !!fc.changeable, lbl);
        }
        if (fc.refundable != null) {
          let lbl = fc.refundable ? ft.refundable : ft.notRefundable;
          if (fc.refundable && Number(fc.refundPenalty) > 0) lbl += ` (${ft.fee} ${feeMoney(fc.refundPenalty, fc.penaltyCurrency)})`;
          conditionLine(doc, ctx, marginX, contentWidth, !!fc.refundable, lbl);
        }
        if (fb.carryOn) conditionLine(doc, ctx, marginX, contentWidth, true, ft.carryOn);
        if (fb.checked) conditionLine(doc, ctx, marginX, contentWidth, true, ft.checked);
      }

      // ── Service-fee note (Airpiv fees are non-refundable per policy) ──
      if (data.serviceFeeNote) {
        doc.moveDown(0.4);
        ctx.font(false); doc.fillColor(TX3).fontSize(ctx.fs(8.5))
          .text(ft.serviceFeeNote, marginX, doc.y, { width: contentWidth, align: ctx.alignStart });
      }

      // ── Footer ──
      doc.moveDown(1.2);
      doc.moveTo(marginX, doc.y).lineTo(doc.page.width - marginX, doc.y).strokeColor(BORDER).stroke();
      doc.moveDown(0.6);
      ctx.font(false); doc.fillColor(TX3).fontSize(ctx.fs(8.5))
        .text('Airpiv · support@airpiv.com · +49 30 568 37 100', marginX, doc.y, { width: contentWidth, align: 'center' });
      doc.moveDown(0.3);
      doc.text(ctx.t.disclaimer, marginX, doc.y, { width: contentWidth, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildTicketPdf, SUPPORTED_TICKET_LANGS: SUPPORTED };
