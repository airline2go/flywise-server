const { scoreMatch } = require('../src/services/finance/reconciliation');

describe('finance/reconciliation scoreMatch (pure)', () => {
  test('shared payment intent + equal amount + same currency → MATCHED', () => {
    const r = scoreMatch(
      { payment_intent_id: 'pi_1', amount_minor: 11500, currency: 'EUR' },
      { payment_intent_id: 'pi_1', amount_minor: 11500, currency: 'EUR' });
    expect(r.status).toBe('MATCHED');
    expect(r.matchedKeys).toContain('payment_intent_id');
    expect(r.difference_minor).toBe(0);
  });

  test('shared key but different amount → PARTIALLY_MATCHED with the diff', () => {
    const r = scoreMatch(
      { booking_id: 'b1', amount_minor: 11500, currency: 'EUR' },
      { booking_id: 'b1', amount_minor: 11000, currency: 'EUR' });
    expect(r.status).toBe('PARTIALLY_MATCHED');
    expect(r.difference_minor).toBe(500);
  });

  test('equal amount but NO shared identity key → UNMATCHED (never match on amount alone)', () => {
    const r = scoreMatch(
      { payment_intent_id: 'pi_1', amount_minor: 11500, currency: 'EUR' },
      { payment_intent_id: 'pi_2', amount_minor: 11500, currency: 'EUR' });
    expect(r.status).toBe('UNMATCHED');
    expect(r.matchedKeys).toHaveLength(0);
  });

  test('shared key but incomparable currency → MANUAL_REVIEW', () => {
    const r = scoreMatch(
      { booking_id: 'b1', amount_minor: 11500, currency: 'EUR' },
      { booking_id: 'b1', amount_minor: 12500, currency: 'USD' });
    expect(r.status).toBe('MANUAL_REVIEW');
  });
});
