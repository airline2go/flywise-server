// ═══════════════════════════════════════════════════════════════
// src/services/finance/duffelSync.js
// [F-PHASE2 · DUFFEL SYNC] Ingests OFFICIAL Duffel invoices as the
// authoritative supplier record — never the "$3 + 1%" API estimate (spec
// Phase 9, non-negotiable rule 12). Idempotent per invoice + per line. A line
// that cannot be tied to a booking/order is stored UNMATCHED and raised as a
// DUFFEL_UNMATCHED reconciliation exception rather than force-matched.
//
// `ingestInvoice(invoice, deps)` maps and persists a single invoice payload
// (from Duffel's invoices export/API or a manual upload). Amounts are converted
// to minor units via the money engine. No tax treatment is inferred here.
// ═══════════════════════════════════════════════════════════════

const { amountToMinor } = require('./moneyEngine');
const { recordEvent } = require('./financialEvents');

// Map a raw Duffel invoice payload → our duffel_invoices row.
function mapInvoice(inv) {
  const currency = (inv.currency || inv.total_currency || 'EUR').toUpperCase();
  return {
    duffel_id: inv.id || null,
    invoice_number: inv.invoice_number || inv.reference || null,
    invoice_date: inv.issued_at || inv.invoice_date || null,
    supplier: inv.supplier_name || inv.supplier || null,
    supplier_country: inv.supplier_country || null,
    supplier_tax_id: inv.supplier_tax_id || null,
    currency,
    subtotal_minor: inv.subtotal != null ? amountToMinor(inv.subtotal, currency) : null,
    tax_minor: inv.tax_amount != null ? amountToMinor(inv.tax_amount, currency) : null,
    total_minor: inv.total_amount != null ? amountToMinor(inv.total_amount, currency) : null,
    document_reference: inv.document_reference || inv.pdf_url || null,
    idempotency_key: `duffel_invoice:${inv.id || inv.invoice_number || inv.reference}`,
    payload: inv,
  };
}

async function ingestInvoice(inv, deps = {}) {
  const { supa, log } = deps;
  if (!supa) return { created: false, reason: 'no_database' };
  if (!inv || (!inv.id && !inv.invoice_number && !inv.reference)) {
    throw new Error('ingestInvoice: invoice needs an id/invoice_number/reference');
  }

  const invRow = mapInvoice(inv);
  const { data: invoiceRow, error } = await supa.from('duffel_invoices')
    .upsert(invRow, { onConflict: 'idempotency_key', ignoreDuplicates: true })
    .select().maybeSingle();
  if (error && error.code !== '23505') {
    if (log) log('error', 'duffel_invoice_upsert_failed', { error: error.message });
    throw new Error('duffel invoice upsert failed: ' + error.message);
  }
  // On a duplicate the upsert returns no row; fetch the existing one.
  let invId = invoiceRow ? invoiceRow.id : null;
  if (!invId) {
    const { data: existing } = await supa.from('duffel_invoices').select('id').eq('idempotency_key', invRow.idempotency_key).maybeSingle();
    invId = existing ? existing.id : null;
  }

  let lines = 0, unmatched = 0;
  for (const li of (inv.line_items || inv.lines || [])) {
    const currency = (li.currency || invRow.currency || 'EUR').toUpperCase();
    const orderId = li.order_id || li.metadata?.order_id || null;

    // Best-effort link: find a booking by duffel_order_id.
    let bookingId = null;
    if (orderId) {
      const { data: bk } = await supa.from('bookings').select('id').eq('duffel_order_id', orderId).maybeSingle();
      bookingId = bk ? bk.id : null;
    }
    const matchStatus = bookingId ? 'MATCHED' : 'UNMATCHED';
    const lineKey = `duffel_line:${invRow.idempotency_key}:${li.id || li.reference || lines}`;

    const { error: lineErr } = await supa.from('duffel_invoice_lines').insert({
      duffel_invoice_id: invId,
      line_reference: li.reference || li.id || null,
      description: li.description || null,
      order_id: orderId,
      booking_id: bookingId,
      quantity: li.quantity != null ? Number(li.quantity) : null,
      net_minor: li.net_amount != null ? amountToMinor(li.net_amount, currency) : null,
      tax_minor: li.tax_amount != null ? amountToMinor(li.tax_amount, currency) : null,
      gross_minor: li.total_amount != null ? amountToMinor(li.total_amount, currency) : null,
      currency,
      match_status: matchStatus,
      idempotency_key: lineKey,
    });
    if (lineErr && lineErr.code !== '23505') { if (log) log('warn', 'duffel_line_insert_failed', { error: lineErr.message }); continue; }
    lines++;

    // A supplier cost line is its own financial event (supplier_cost).
    await recordEvent({
      idempotencyKey: `duffel_cost:${lineKey}`,
      eventType: 'duffel_invoice_line',
      sourceType: 'duffel',
      sourceId: li.id || li.reference || null,
      bookingId,
      supplierId: invRow.supplier,
      amountMinor: li.total_amount != null ? amountToMinor(li.total_amount, currency) : 0,
      currency,
      payload: { invoice: invRow.invoice_number, order_id: orderId },
      createdBy: 'system:duffel_sync',
    }, deps).catch((e) => { if (log) log('warn', 'duffel_cost_event_failed', { error: e.message }); });

    // Unmatched → reconciliation exception (never force-match).
    if (matchStatus === 'UNMATCHED') {
      unmatched++;
      await supa.from('reconciliation_exceptions').insert({
        exception_type: 'DUFFEL_UNMATCHED',
        source: 'duffel', source_id: li.id || li.reference || null,
        amount_minor: li.total_amount != null ? amountToMinor(li.total_amount, currency) : null,
        currency, severity: 'REVIEW',
        details: { invoice: invRow.invoice_number, order_id: orderId },
      }).then(() => {}, () => {});
    }
  }

  if (log) log('info', 'duffel_invoice_ingested', { invoice: invRow.invoice_number, lines, unmatched });
  return { created: !!invoiceRow, invoice_id: invId, lines, unmatched };
}

module.exports = { mapInvoice, ingestInvoice };
