const { validate, validateField, PASSENGER_SCHEMA } = require('../src/utils/validate');

describe('validateField', () => {
  test('required field missing returns error', () => {
    expect(validateField(undefined, { type: 'string', required: true }, 'name')).toBe('name ist erforderlich');
  });

  test('optional field absent returns null', () => {
    expect(validateField(undefined, { type: 'string', required: false }, 'name')).toBeNull();
  });

  test('string too short', () => {
    expect(validateField('a', { type: 'string', required: true, min: 2 }, 'name')).toBe('name ist zu kurz');
  });

  test('string too long', () => {
    expect(validateField('aaa', { type: 'string', required: true, max: 2 }, 'name')).toBe('name ist zu lang');
  });

  test('valid email passes', () => {
    expect(validateField('a@b.com', { type: 'email', required: true }, 'email')).toBeNull();
  });

  test('invalid email fails', () => {
    expect(validateField('not-an-email', { type: 'email', required: true }, 'email')).toBe('email ist keine gültige E-Mail-Adresse');
  });

  test('valid date passes', () => {
    expect(validateField('2026-01-01', { type: 'date', required: true }, 'born_on')).toBeNull();
  });

  test('invalid date format fails', () => {
    expect(validateField('01-01-2026', { type: 'date', required: true }, 'born_on')).toBe('born_on muss das Format JJJJ-MM-TT haben');
  });

  test('number out of range fails', () => {
    expect(validateField(5, { type: 'number', required: true, min: 10 }, 'age')).toBe('age ist zu klein');
  });

  test('array below minimum length fails', () => {
    expect(validateField([1], { type: 'array', required: true, min: 2 }, 'items')).toBe('items: mindestens 2 Einträge erforderlich');
  });
});

describe('validate (PASSENGER_SCHEMA)', () => {
  test('valid passenger passes', () => {
    const err = validate({ given_name: 'John', family_name: 'Doe', born_on: '1990-01-01' }, PASSENGER_SCHEMA);
    expect(err).toBeNull();
  });

  test('missing given_name fails with first schema-order error', () => {
    const err = validate({ family_name: 'Doe', born_on: '1990-01-01' }, PASSENGER_SCHEMA);
    expect(err).toBe('given_name ist erforderlich');
  });

  test('invalid born_on fails', () => {
    const err = validate({ given_name: 'John', family_name: 'Doe', born_on: 'not-a-date' }, PASSENGER_SCHEMA);
    expect(err).toBe('born_on muss das Format JJJJ-MM-TT haben');
  });

  test('non-object data rejected', () => {
    expect(validate(null, PASSENGER_SCHEMA)).toBe('Daten müssen ein Objekt sein');
  });
});
