const {
  matchRuleVersion, isActiveVersion, selectRuleVersion, reviewRequiredResult, resultFromVersion,
} = require('../src/services/finance/taxEngine');

const baseVersion = (over = {}) => Object.assign({
  id: 'v1', tax_rule_id: 'r1', status: 'ACTIVE',
  transaction_type: null, service_type: null, supplier_type: null, customer_type: null,
  customer_country: null, supplier_country: null, origin_country: null,
  destination_country: null, route_type: null,
  vat_rate: null, taxable_percentage: null, output_vat_required: null,
  input_vat_allowed: null, reverse_charge: null, exemption_code: null,
  revenue_recognition: null, legal_basis: null, valid_from: null, valid_until: null,
}, over);

describe('finance/taxEngine matching (pure, no DB)', () => {
  test('a wildcard version matches any context with score 0', () => {
    expect(matchRuleVersion(baseVersion(), { customer_type: 'B2C' })).toBe(0);
  });

  test('a constrained dimension must equal the context (case-insensitive)', () => {
    const v = baseVersion({ customer_type: 'B2C', customer_country: 'DE' });
    expect(matchRuleVersion(v, { customer_type: 'b2c', customer_country: 'de' })).toBe(2);
    expect(matchRuleVersion(v, { customer_type: 'B2B', customer_country: 'DE' })).toBeNull();
  });

  test('a constrained dimension with a missing context value does not match', () => {
    const v = baseVersion({ supplier_country: 'US' });
    expect(matchRuleVersion(v, {})).toBeNull();
  });

  test('only ACTIVE, date-valid versions are usable', () => {
    expect(isActiveVersion(baseVersion({ status: 'APPROVED' }))).toBe(false); // approved != active
    expect(isActiveVersion(baseVersion({ status: 'ACTIVE', valid_from: '2999-01-01' }))).toBe(false);
    expect(isActiveVersion(baseVersion({ status: 'ACTIVE', valid_until: '2000-01-01' }))).toBe(false);
    expect(isActiveVersion(baseVersion({ status: 'ACTIVE' }))).toBe(true);
  });

  test('most specific matching version wins', () => {
    const generic = baseVersion({ id: 'g', customer_type: 'B2C' });
    const specific = baseVersion({ id: 's', customer_type: 'B2C', customer_country: 'DE' });
    const best = selectRuleVersion([generic, specific], { customer_type: 'B2C', customer_country: 'DE' });
    expect(best.version.id).toBe('s');
    expect(best.score).toBe(2);
  });

  test('no matching active version → null (caller emits REVIEW_REQUIRED)', () => {
    const v = baseVersion({ customer_country: 'FR' });
    expect(selectRuleVersion([v], { customer_country: 'DE' })).toBeNull();
  });

  test('REVIEW_REQUIRED result invents no numbers', () => {
    const r = reviewRequiredResult();
    expect(r.status).toBe('REVIEW_REQUIRED');
    expect(r.vat_rate).toBeNull();
    expect(r.reverse_charge).toBeNull();
    expect(r.revenue_recognition).toBe('REVIEW_REQUIRED');
  });

  test('resultFromVersion copies values verbatim and derives direction', () => {
    const rc = resultFromVersion({ id: 'r1' }, baseVersion({ reverse_charge: true, legal_basis: '§13b UStG' }), 1);
    expect(rc.direction).toBe('REVERSE_CHARGE');
    expect(rc.legal_basis).toBe('§13b UStG');

    const out = resultFromVersion({ id: 'r1' }, baseVersion({ output_vat_required: true, vat_rate: 19 }), 1);
    expect(out.direction).toBe('OUTPUT');
    expect(out.vat_rate).toBe(19);
  });
});
