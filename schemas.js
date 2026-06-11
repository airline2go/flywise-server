'use strict';

const { z } = require('zod');

// ── Shared primitives ─────────────────────────────────────

const iataCode = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter IATA airport code')
  .transform(s => s.toUpperCase());

/**
 * Validates YYYY-MM-DD format AND real calendar correctness.
 * Rejects impossible dates such as 2026-99-99, 2026-02-31, 2026-13-01.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a real calendar date in YYYY-MM-DD format')
  .refine(d => {
    const [year, month, day] = d.split('-').map(Number);
    const dt = new Date(year, month - 1, day);
    return (
      dt.getFullYear() === year &&
      dt.getMonth()    === month - 1 &&
      dt.getDate()     === day
    );
  }, 'Must be a real calendar date in YYYY-MM-DD format');

const cabinClass = z
  .enum(['economy', 'premium_economy', 'business', 'first'])
  .default('economy');

const offerId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,200}$/, 'Invalid ID format');

const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/)
  .transform(s => s.toUpperCase())
  .default('EUR');

// ── /search ───────────────────────────────────────────────

const searchSchema = z
  .object({
    origin:         iataCode,
    destination:    iataCode,
    departure_date: calendarDate,
    return_date:    calendarDate.optional(),
    cabin_class:    cabinClass,
    adults:         z.coerce.number().int().min(1).max(9).default(1),
    children:       z.coerce.number().int().min(0).max(9).default(0),
    infants:        z.coerce.number().int().min(0).max(9).default(0),
  })
  .refine(
    d => d.origin !== d.destination,
    { message: 'origin and destination must be different', path: ['destination'] }
  );

// ── Passenger (shared between /order and future endpoints) ─

const passengerTitle = z.enum(['mr', 'ms', 'mrs', 'miss', 'dr']).optional();

const passengerSchema = z.object({
  given_name:    z.string().min(1).max(100),
  family_name:   z.string().min(1).max(100),
  born_on:       calendarDate,
  gender:        z.enum(['m', 'f']),
  email:         z.string().email(),
  phone_number:  z.string().regex(/^\+?[\d\s\-().]{7,20}$/, 'Invalid phone number'),
  title:         passengerTitle,
});

// ── /order ────────────────────────────────────────────────

const orderSchema = z.object({
  offer_id:     offerId,
  passengers:   z.array(passengerSchema).min(1, 'At least one passenger is required'),
  services:     z.array(z.unknown()).default([]),
  total_amount: z.union([z.string(), z.number()])
    .refine(v => !isNaN(parseFloat(String(v))), 'total_amount must be a number')
    .optional(),
  currency:     currencyCode,
});

// ── /cancel ───────────────────────────────────────────────

const cancelSchema = z.object({
  order_id: offerId,
});

// ── Validation helper ─────────────────────────────────────

/**
 * Parse and validate a request body against a Zod schema.
 * Returns { data } on success or { error: string } on failure.
 *
 * @param {z.ZodSchema} schema
 * @param {unknown}     input
 * @returns {{ data?: unknown, error?: string }}
 */
function validate(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    const msg = result.error.errors
      .map(e => `${e.path.join('.') || 'body'}: ${e.message}`)
      .join('; ');
    return { error: msg };
  }
  return { data: result.data };
}

module.exports = {
  searchSchema,
  passengerSchema,
  orderSchema,
  cancelSchema,
  offerId,
  validate,
};
