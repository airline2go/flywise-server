// ═══════════════════════════════════════════════════════════════
// src/services/email.js
// كل إرسال إيميلات الموقع (Brevo API مباشرة، من غير SDK) —
// تأكيد الحجز، تأكيد الإلغاء. أبداً مابيرميش خطأ لفوق: نجاح
// الحجز نفسه لازم يستمر حتى لو فشل الإيميل، فالفشل بيتسجل بس.
// ═══════════════════════════════════════════════════════════════

const env = require('./env');
const log = require('./log');

async function sendEmail(to, subject, htmlContent) {
  if (!env.BREVO_API_KEY) { log('warn', 'email_not_configured', { to }); return false; }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
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

  // [TICKET-NUMBER] رقم التذكرة الرسمي (نفس الظاهر في تذكرة Duffel) —
  // بيانه الحقيقية بتربط تذكرة بمسافر معيّن عن طريق passenger_id. لو
  // الشكل ده مش موجود لأي سبب، بنرجع لمطابقة بالترتيب (بافتراض إن
  // documents وpassengers بنفس الترتيب) — وأي احتمال عدم تطابق، الأسلم
  // نعرض القائمة من غير اسم بدل ما نربط اسم غلط برقم غلط.
  const ticketByPax = {};
  const tickets = (order.documents || []).filter((d) => (d.type || '').toLowerCase().includes('ticket'));
  tickets.forEach((doc, i) => {
    const name = doc.passenger_id ? paxById[doc.passenger_id] : (order.passengers && order.passengers[i] ? `${order.passengers[i].given_name || ''} ${order.passengers[i].family_name || ''}`.trim() : '');
    if (name && doc.unique_identifier) ticketByPax[name] = doc.unique_identifier;
  });

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
    // [DUFFEL-TICKET-PARITY] بيانات حقيقية من Duffel، نفس اللي ظاهر في
    // التذكرة الرسمية بتاعتهم لكل قطعة طيران (الصالة، نوع الطائرة،
    // الحقائب المضمّنة لكل راكب على هذا الطيران بالتحديد). عمدًا من
    // غير رقم التذكرة نفسه — طلب صريح إنه معلومة شخصية حساسة، مش هتظهر
    // في الإيميل.
    const baggageByPax = {};
    (s.passengers || []).forEach((sp) => {
      const name = paxById[sp.passenger_id] || '';
      const bags = (sp.baggages || []).map((b) => ({ type: b.type, quantity: b.quantity || 1 }));
      if (name && bags.length) baggageByPax[name] = bags;
    });
    return {
      from: s.origin?.iata_code || '', to: s.destination?.iata_code || '',
      fromName: s.origin?.name || '', toName: s.destination?.name || '',
      fromCity: s.origin?.city_name || (s.origin && s.origin.city && s.origin.city.name) || '',
      toCity: s.destination?.city_name || (s.destination && s.destination.city && s.destination.city.name) || '',
      fromTerminal: s.origin_terminal || null, toTerminal: s.destination_terminal || null,
      dep: s.departing_at ? new Date(s.departing_at) : null, arr: s.arriving_at ? new Date(s.arriving_at) : null,
      dur: isoMinSrv(s.duration), al: s.marketing_carrier?.name || '',
      fn: `${s.marketing_carrier?.iata_code || ''}${s.marketing_carrier_flight_number || ''}`,
      aircraft: s.aircraft?.name || null,
      seats, baggageByPax,
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
    nonStop: (slice.segments || []).length <= 1,
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

  // [MARGIN-DISPLAY-FIX] Same fix as orderToBookingData() in index.html —
  // purchasedBags/allSeats above carry Duffel's raw net service price
  // (e.g. a bag's real cost of 20€), and the email template below
  // displays b.amount/s.netPrice directly, so the email showed that raw
  // price for an individual bag/seat while the summary total a few lines
  // down already showed the margin-included total (28€) for the exact
  // same purchase. Distributes the category-level margin to each
  // INDIVIDUAL item proportionally by its own net cost share — not an
  // equal split — and mutates .amount/.netPrice in place so the email
  // template (which reads these same arrays further down) automatically
  // shows the corrected price with no template change needed.
  const bagsMarginTotal = bagsPrice - netBagsTotal;
  if (netBagsTotal > 0 && bagsMarginTotal !== 0) {
    purchasedBags.forEach((bag) => {
      bag.amount = Math.round((bag.amount + bagsMarginTotal * (bag.amount / netBagsTotal)) * 100) / 100;
    });
  }
  const seatsMarginTotal = seatsPrice - netSeatsTotal;
  if (netSeatsTotal > 0 && seatsMarginTotal !== 0) {
    allSeats.forEach((seat) => {
      if (seat.netPrice != null) {
        seat.netPrice = Math.round((seat.netPrice + seatsMarginTotal * (seat.netPrice / netSeatsTotal)) * 100) / 100;
      }
    });
  }

  return {
    legs, allSeats, purchasedBags, ticketByPax,
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
    // [DUFFEL-TICKET-PARITY] نفس معلومات "Terminal" ونوع الطائرة الظاهرة
    // في تذكرة Duffel الرسمية — بس لو Duffel رجّعهم فعليًا (بعض المطارات/
    // شركات الطيران مش دايمًا بترجع صالة محددة، فمفيش داعي نظهر "—" في
    // كل مرة لو المعلومة أصلاً غير متاحة).
    const fromCityAirport = seg.fromCity && seg.fromName ? `${seg.fromCity} · ${seg.fromName}` : (seg.fromName || '');
    const toCityAirport = seg.toCity && seg.toName ? `${seg.toCity} · ${seg.toName}` : (seg.toName || '');
    const fromLbl = seg.fromTerminal ? `${seg.from} · Terminal ${seg.fromTerminal}` : seg.from;
    const toLbl = seg.toTerminal ? `${seg.to} · Terminal ${seg.toTerminal}` : seg.to;
    const baggageLines = Object.keys(seg.baggageByPax || {}).map((name) => {
      const parts = seg.baggageByPax[name].map((b) => {
        const label = b.type === 'checked' ? 'Aufgabegepäck' : 'Handgepäck';
        return b.quantity > 1 ? `${b.quantity}× ${label}` : label;
      });
      return `<div style="font-size:11px;color:#8fa4b4;margin-top:2px">🧳 ${name}: ${parts.join(', ')}</div>`;
    }).join('');
    return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef1f4">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:100px;vertical-align:top">
            <div style="font-size:15px;font-weight:700;color:#101d2c">${fmtTime(seg.dep)}</div>
            <div style="font-size:11px;color:#8fa4b4">${fromLbl}</div>
            ${fromCityAirport ? `<div style="font-size:10px;color:#8fa4b4">${fromCityAirport}</div>` : ''}
            <div style="font-size:10px;color:#8fa4b4;margin-top:1px">${fmtDate(seg.dep)}</div>
          </td>
          <td style="text-align:center;vertical-align:top;color:#8fa4b4;font-size:11px;padding:0 8px">
            <div>${durStr(seg.dur)}</div>
            <div style="border-top:1px dashed #c8d4de;margin:4px 0"></div>
            <div>${seg.al} ${seg.fn}</div>
            ${seg.aircraft ? `<div style="font-size:10px;margin-top:1px">${seg.aircraft}</div>` : ''}
          </td>
          <td style="width:100px;text-align:right;vertical-align:top">
            <div style="font-size:15px;font-weight:700;color:#101d2c">${fmtTime(seg.arr)}</div>
            <div style="font-size:11px;color:#8fa4b4">${toLbl}</div>
            ${toCityAirport ? `<div style="font-size:10px;color:#8fa4b4">${toCityAirport}</div>` : ''}
            <div style="font-size:10px;color:#8fa4b4;margin-top:1px">${fmtDate(seg.arr)}</div>
          </td>
        </tr></table>
        ${baggageLines}
      </td>
    </tr>`;
  }

  function segsBlock(segs, label, nonStop) {
    if (!segs || !segs.length) return '';
    // [DUFFEL-TICKET-PARITY] "Non-stop" (أو عدد التوقفات) بجانب عنوان
    // القطعة — محسوبة فعليًا من عدد القطع الحقيقي عند Duffel لهذا الاتجاه،
    // مش افتراض. مسافة واحدة توقف أو أكتر بتتحسب تلقائيًا (segs.length - 1).
    const stopsLabel = nonStop === true ? 'Non-stop' : (segs.length > 1 ? `${segs.length - 1} Zwischenstopp${segs.length > 2 ? 's' : ''}` : '');
    return `
    <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px;display:flex;justify-content:space-between">
      <span>${label}</span>${stopsLabel ? `<span style="text-transform:none;letter-spacing:0">${stopsLabel}</span>` : ''}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">${segs.map(segRow).join('')}</table>`;
  }

  // [CONTACT-EMAIL-DISPLAY] Same shared booking-contact email shown under
  // each passenger's name, matching the confirmation screen/"Meine
  // Buchungen" treatment exactly.
  const paxRows = (data.passengers || [])
    .map((p) => `<tr><td style="padding:5px 0;color:#46586c;font-size:13px">
      ${(p.given_name || '')} ${(p.family_name || '')}
      ${data.contactEmail ? `<div style="font-size:12px;color:#8fa4b4;margin-top:1px">✉ ${data.contactEmail}</div>` : ''}
    </td></tr>`)
    .join('');

  let flightHtml = '';
  let bagsHtml = '';
  let seatsHtml = '';
  let ticketsHtml = '';
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
      flightHtml = legsArr.map((leg) => segsBlock(leg.segs, 'Flug ' + leg.legNumber, leg.nonStop)).join('');
    } else {
      flightHtml = segsBlock(legsArr[0] && legsArr[0].segs, legsArr[1] && legsArr[1].segs && legsArr[1].segs.length ? 'Hinflug' : 'Flug', legsArr[0] && legsArr[0].nonStop) +
                   segsBlock(legsArr[1] && legsArr[1].segs, 'Rückflug', legsArr[1] && legsArr[1].nonStop);
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

    const ticketEntries = Object.keys(summary.ticketByPax || {});
    if (ticketEntries.length) {
      ticketsHtml = `
      <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">🎫 Ticketnummern</div>
      ${ticketEntries.map((name) => `
        <div style="font-size:13px;color:#46586c;padding:4px 0;display:flex;justify-content:space-between">
          <span>${name}</span><strong style="font-family:monospace;color:#101d2c">${summary.ticketByPax[name]}</strong>
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
      ${ticketsHtml}

      <div style="font-size:11px;font-weight:700;color:#8fa4b4;letter-spacing:.05em;text-transform:uppercase;margin:14px 0 6px">💰 Preisübersicht</div>
      ${priceHtml}

      <p style="margin-top:20px;font-size:13px;color:#8fa4b4">
        Bei Fragen erreichst du uns unter <a href="mailto:support@airpiv.com" style="color:#0FB5A0">support@airpiv.com</a>.
      </p>
    </div>
  </div>`;
  return sendEmail(to, `Buchungsbestätigung ${data.bookingRef || ''} · Airpiv`, html);
}


async function sendCancellationEmail(to, data) {
  const fmtMoney = (n, cur) => `${(Number(n) || 0).toFixed(2)} ${cur || 'EUR'}`;
  const refundSection = data.stripeRefundError
    ? `<p style="color:#46586c;font-size:14px;line-height:1.6;margin:0 0 16px">
         Die Rückerstattung wird gerade bearbeitet. Falls du innerhalb von 5 Werktagen nichts auf deinem Konto siehst,
         kontaktiere bitte unseren Support — wir kümmern uns sofort darum.
       </p>`
    : (data.refundAmount > 0
      ? `<div style="background:#f0fdfa;border:1px solid #99f2e5;border-radius:10px;padding:14px 16px;margin:0 0 16px">
           <div style="font-size:12px;color:#0a9384;font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Rückerstattung</div>
           <div style="font-size:20px;font-weight:800;color:#0a1822">${fmtMoney(data.refundAmount, data.refundCurrency)}</div>
           <div style="font-size:12px;color:#46586c;margin-top:4px">Die Rückerstattung erfolgt auf dein ursprüngliches Zahlungsmittel innerhalb von 5–10 Werktagen.</div>
         </div>`
      : `<p style="color:#46586c;font-size:14px;line-height:1.6;margin:0 0 16px">
           Gemäß den Tarifbedingungen dieser Buchung ist keine Rückerstattung möglich.
         </p>`);

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#ffffff">
    <div style="background:linear-gradient(135deg,#0A1822,#16283a);padding:28px 24px;text-align:center">
      <div style="font-family:Arial,sans-serif;font-size:1.4rem;font-weight:800;color:#ffffff">
        Air<span style="color:#0FB5A0">piv</span>
      </div>
    </div>
    <div style="padding:32px 28px">
      <h2 style="color:#0A1822;font-size:1.2rem;margin:0 0 16px">✕ Buchung storniert</h2>
      <p style="color:#46586c;font-size:14px;line-height:1.6;margin:0 0 20px">
        Deine Buchung <strong>${data.bookingRef || ''}</strong>${data.routeLabel ? ` (${data.routeLabel})` : ''} wurde erfolgreich storniert.
      </p>
      ${refundSection}
      <p style="color:#8fa4b4;font-size:12.5px;line-height:1.6;margin:20px 0 0">
        Falls du Fragen hast, antworte einfach auf diese E-Mail oder kontaktiere unseren Support.
      </p>
    </div>
    <div style="background:#f6f8fa;padding:18px 24px;text-align:center;border-top:1px solid #e5eaf0">
      <p style="color:#8fa4b4;font-size:11px;margin:0">© 2026 Airpiv · Alle Rechte vorbehalten</p>
    </div>
  </div>`;

  return sendEmail(to, `Stornierung bestätigt — ${data.bookingRef || 'Airpiv'}`, html);
}

module.exports = { sendEmail, sendBookingConfirmationEmail, sendCancellationEmail, buildOrderSummaryForEmail };
