// ═══════════════════════════════════════════════════════════════
// src/services/ticketPdf.js
// [NEW] بيولّد PDF رسمي لتذكرة الحجز — نفس بنية تذكرة Duffel
// الأصلية (تفاصيل الطيران، الركاب، أرقام التذاكر) بس بتصميم
// Airpiv الخاص بينا (الألوان، الشعار، الخط). بيستخدم pdfkit —
// مكتبة JS خالصة، مفيش محتاج متصفح مخفي أو حاجة تقيلة على السيرفر.
// ═══════════════════════════════════════════════════════════════

const PDFDocument = require('pdfkit');

const TEAL = '#0FB5A0';
const TEAL_DARK = '#0A9384';
const NAVY = '#0A1822';
const NAVY2 = '#16283a';
const TX = '#101d2c';
const TX2 = '#46586c';
const TX3 = '#8fa4b4';
const BORDER = '#e1e7ec';
const BG2 = '#f6f8fa';

function fmtTime(d) {
  if (!d) return '--:--';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtDate(d) {
  if (!d) return '';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function durStr(m) {
  if (!m) return '';
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// [PDF-HEADER] شريط علوي بلون Airpiv الداكن + الشعار + كود الحجز —
// نفس الترتيب اللي شوفناه في تذكرة Duffel (الشركة على الشمال،
// Booking Reference على اليمين)، بس بألوان Airpiv.
function drawHeader(doc, bookingRef) {
  doc.rect(0, 0, doc.page.width, 70).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
    .text('Air', 40, 24, { continued: true })
    .fillColor(TEAL).text('piv', { continued: false });
  doc.fillColor(TX3).font('Helvetica').fontSize(9)
    .text('BUCHUNGSCODE', doc.page.width - 200, 20, { width: 160, align: 'right' });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16)
    .text(bookingRef || '—', doc.page.width - 200, 33, { width: 160, align: 'right' });
  doc.y = 95;
}

function sectionTitle(doc, text) {
  doc.moveDown(0.3);
  doc.fillColor(TX).font('Helvetica-Bold').fontSize(13).text(text);
  doc.moveDown(0.4);
}

// [PDF-FLIGHT-BOX] صندوق واحد لكل قطعة طيران — نفس بنية تذكرة
// Duffel (وقت المغادرة + المطار على الشمال، شركة الطيران ورقم
// الرحلة والمدة في النص، وقت الوصول + المطار على اليمين)، وتحته
// صف بالصالة ونوع الطائرة والحقائب المضمّنة لو متوفرين.
function drawFlightBox(doc, seg, x, width) {
  const boxTop = doc.y;
  const boxHeight = 70;
  doc.roundedRect(x, boxTop, width, boxHeight, 6).strokeColor(BORDER).lineWidth(1).stroke();

  const pad = 14;
  const colW = (width - pad * 2) / 3;

  // Departure
  doc.fillColor(TX).font('Helvetica-Bold').fontSize(15)
    .text(fmtTime(seg.dep), x + pad, boxTop + 12, { width: colW });
  doc.fillColor(TX2).font('Helvetica').fontSize(9)
    .text(seg.fromLabel || seg.from, x + pad, boxTop + 32, { width: colW });
  doc.fillColor(TX3).fontSize(8)
    .text(fmtDate(seg.dep), x + pad, boxTop + 46, { width: colW });

  // Middle: duration + airline + flight number
  const midX = x + pad + colW;
  doc.fillColor(TX3).font('Helvetica').fontSize(9)
    .text(durStr(seg.dur), midX, boxTop + 12, { width: colW, align: 'center' });
  doc.moveTo(midX + 10, boxTop + 27).lineTo(midX + colW - 10, boxTop + 27)
    .dash(2, { space: 2 }).strokeColor(BORDER).stroke().undash();
  doc.fillColor(TX2).font('Helvetica-Bold').fontSize(9)
    .text(`${seg.al || ''} ${seg.fn || ''}`, midX, boxTop + 32, { width: colW, align: 'center' });
  if (seg.aircraft) {
    doc.fillColor(TX3).font('Helvetica').fontSize(8)
      .text(seg.aircraft, midX, boxTop + 46, { width: colW, align: 'center' });
  }

  // Arrival
  const rightX = x + pad + colW * 2;
  doc.fillColor(TX).font('Helvetica-Bold').fontSize(15)
    .text(fmtTime(seg.arr), rightX, boxTop + 12, { width: colW - pad, align: 'right' });
  doc.fillColor(TX2).font('Helvetica').fontSize(9)
    .text(seg.toLabel || seg.to, rightX, boxTop + 32, { width: colW - pad, align: 'right' });
  doc.fillColor(TX3).fontSize(8)
    .text(fmtDate(seg.arr), rightX, boxTop + 46, { width: colW - pad, align: 'right' });

  doc.y = boxTop + boxHeight + 10;

  // Terminal + baggage line, if we have it — small print under the box.
  const extras = [];
  if (seg.fromTerminal) extras.push(`Terminal ${seg.fromTerminal} (${seg.from})`);
  if (seg.toTerminal) extras.push(`Terminal ${seg.toTerminal} (${seg.to})`);
  const baggageNames = Object.keys(seg.baggageByPax || {});
  if (baggageNames.length) {
    baggageNames.forEach((name) => {
      const parts = seg.baggageByPax[name].map((b) => {
        const label = b.type === 'checked' ? 'Aufgabegepäck' : 'Handgepäck';
        return b.quantity > 1 ? `${b.quantity}× ${label}` : label;
      });
      extras.push(`${name}: ${parts.join(', ')}`);
    });
  }
  if (extras.length) {
    doc.fillColor(TX3).font('Helvetica').fontSize(8).text(extras.join('  ·  '), x, doc.y, { width });
    doc.moveDown(0.6);
  }
}

function drawTableHeader(doc, cols, x) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(TX3);
  let cx = x;
  cols.forEach((c) => {
    doc.text(c.label.toUpperCase(), cx, doc.y, { width: c.width });
    cx += c.width;
  });
  doc.moveDown(0.9);
  doc.moveTo(x, doc.y).lineTo(x + cols.reduce((s, c) => s + c.width, 0), doc.y).strokeColor(BORDER).stroke();
  doc.moveDown(0.5);
}

function drawTableRow(doc, cols, values, x) {
  const rowTop = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor(TX);
  let cx = x;
  let maxH = 0;
  cols.forEach((c, i) => {
    const h = doc.heightOfString(String(values[i] || ''), { width: c.width });
    if (h > maxH) maxH = h;
  });
  cols.forEach((c, i) => {
    doc.text(String(values[i] || ''), cx, rowTop, { width: c.width });
    cx += c.width;
  });
  doc.y = rowTop + maxH + 8;
  doc.moveTo(x, doc.y - 4).lineTo(x + cols.reduce((s, c) => s + c.width, 0), doc.y - 4).strokeColor(BG2).stroke();
}

// [MAIN-EXPORT] بيبني PDF كامل ويرجّعه كـBuffer (عشان يترفق في
// الإيميل مباشرة). بيرجع Promise لأن pdfkit بيكتب بالـstream.
function buildTicketPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const marginX = 40;
      const contentWidth = doc.page.width - marginX * 2;

      drawHeader(doc, data.bookingRef);

      // ── Flight details ──
      sectionTitle(doc, 'Flugdetails');
      (data.legs || []).forEach((leg, legIdx) => {
        if ((data.legs || []).length > 1) {
          doc.fillColor(TX3).font('Helvetica-Bold').fontSize(9)
            .text((data.legs.length > 2 ? `Flug ${legIdx + 1}` : legIdx === 0 ? 'Hinflug' : 'Rückflug').toUpperCase(), marginX, doc.y);
          doc.moveDown(0.4);
        }
        (leg.segs || []).forEach((seg) => drawFlightBox(doc, seg, marginX, contentWidth));
      });

      // ── Passengers ──
      doc.moveDown(0.4);
      sectionTitle(doc, 'Reisende');
      const paxCols = [
        { label: 'Name', width: contentWidth * 0.45 },
        { label: 'Geburtsdatum', width: contentWidth * 0.25 },
        { label: 'Geschlecht', width: contentWidth * 0.3 },
      ];
      drawTableHeader(doc, paxCols, marginX);
      (data.passengers || []).forEach((p) => {
        drawTableRow(doc, paxCols, [p.name, p.dob || '—', p.gender || '—'], marginX);
      });

      // ── Ticket numbers (only if we actually have them) ──
      const ticketNames = Object.keys(data.ticketByPax || {});
      if (ticketNames.length) {
        doc.moveDown(0.6);
        sectionTitle(doc, 'Ticketnummern');
        const tCols = [
          { label: 'Name', width: contentWidth * 0.6 },
          { label: 'Ticketnummer', width: contentWidth * 0.4 },
        ];
        drawTableHeader(doc, tCols, marginX);
        ticketNames.forEach((name) => {
          drawTableRow(doc, tCols, [name, data.ticketByPax[name]], marginX);
        });
      }

      // ── Price summary ──
      if (data.priceRows && data.priceRows.length) {
        doc.moveDown(0.6);
        sectionTitle(doc, 'Preisübersicht');
        data.priceRows.forEach((row) => {
          doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(row.bold ? 12 : 10)
            .fillColor(row.bold ? TX : TX2);
          const y = doc.y;
          doc.text(row.label, marginX, y, { width: contentWidth * 0.7 });
          doc.text(row.value, marginX + contentWidth * 0.7, y, { width: contentWidth * 0.3, align: 'right' });
          doc.moveDown(0.5);
          if (row.bold) {
            doc.moveTo(marginX, doc.y).lineTo(marginX + contentWidth, doc.y).strokeColor(BORDER).stroke();
            doc.moveDown(0.3);
          }
        });
      }

      // ── Footer ──
      // [PDF-FOOTER-FIX] بيتبع تدفق المحتوى العادي دلوقتي، بدل ما
      // يُحسب مكانه الثابت من نهاية الصفحة — الحساب الثابت كان بيعمل
      // صفحة تانية شبه فاضية لو المحتوى مش وصل بالضبط لآخر الصفحة.
      doc.moveDown(1.2);
      doc.moveTo(marginX, doc.y).lineTo(doc.page.width - marginX, doc.y).strokeColor(BORDER).stroke();
      doc.moveDown(0.6);
      doc.fillColor(TX3).font('Helvetica').fontSize(8.5)
        .text('Airpiv · support@airpiv.com · +49 30 568 37 100', marginX, doc.y, { width: contentWidth, align: 'center' });
      doc.moveDown(0.3);
      doc.text('Diese Übersicht ersetzt nicht das offizielle Ticket der Fluggesellschaft.', marginX, doc.y, { width: contentWidth, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildTicketPdf };
