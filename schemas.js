'use strict';

const { z } = require('zod');

// ── Shared primitives ─────────────────────────────────────

const iataCode = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter IATA airport code')
  .transform(s => s.toUpperCase());

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
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

// ── Passenger Schema ──────────────────────────────────────
// Aligned with Duffel API requirements:
// https://duffel.com/docs/api/v2/orders/create-order

const passengerTitle = z
  .enum(['mr', 'ms', 'mrs', 'miss', 'dr'])
  .optional();

// Phone: Duffel requires E.164 format (+[country][number])
// Accept common formats and normalize
const phoneNumber = z
  .string()
  .transform(s => {
    // Remove all spaces, dashes, parentheses
    const cleaned = s.replace(/[\s\-().]/g, '');
    // Add + if missing
    return cleaned.startsWith('+') ? cleaned : '+' + cleaned;
  })
  .refine(s => /^\+[1-9]\d{6,14}$/.test(s), {
    message: 'Telefonnummer muss im internationalen Format sein (z.B. +4915112345678)',
  });

// Name: allow compound names, hyphens, apostrophes, unicode
const nameField = z
  .string()
  .min(1, 'Name ist erforderlich')
  .max(100, 'Name zu lang')
  .transform(s => s.trim())
  .refine(s => s.length > 0, 'Name darf nicht leer sein');

// Gender: Duffel accepts 'm' or 'f' only
const gender = z.enum(['m', 'f'], {
  errorMap: () => ({ message: 'Geschlecht muss m oder f sein' }),
});

// Nationality: ISO 3166-1 alpha-2 (2 letters)
const nationalityCode = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Muss ein 2-buchstabiger Ländercode sein (z.B. DE, US)')
  .transform(s => s.toUpperCase())
  .optional()
  .default('DE');

const passengerSchema = z.object({
  // Required by Duffel
  given_name:   nameField,
  family_name:  nameField,
  born_on:      calendarDate,
  gender:       gender,
  email:        z.string().email('Ungültige E-Mail-Adresse'),
  phone_number: phoneNumber,
  title:        passengerTitle,

  // Passenger type: Duffel requires explicit type
  type: z
    .enum(['adult', 'child', 'infant_without_seat'])
    .default('adult'),

  // Optional: identity document (passport)
  identity_documents: z.array(z.object({
    type:                 z.enum(['passport', 'tax_id', 'known_traveler_number', 'passenger_redress_number']),
    unique_identifier:    z.string().min(1).max(30),
    issuing_country_code: nationalityCode,
    expires_on:           calendarDate.optional(),
  })).optional(),
});

// ── /order ────────────────────────────────────────────────

const orderSchema = z.object({
  offer_id:     offerId,
  passengers:   z.array(passengerSchema).min(1, 'Mindestens ein Reisender erforderlich').max(9),
  services:     z.array(z.unknown()).default([]),
  total_amount: z.union([z.string(), z.number()])
    .refine(v => !isNaN(parseFloat(String(v))), 'total_amount muss eine Zahl sein')
    .optional(),
  currency:     currencyCode,
});

// ── /cancel ───────────────────────────────────────────────

const cancelSchema = z.object({
  order_id: offerId,
});

// ── Validation helper ─────────────────────────────────────

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
