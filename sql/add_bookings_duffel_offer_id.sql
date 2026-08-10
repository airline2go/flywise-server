-- [M1-OFFER-ID] Store the Duffel offer id a confirmed order was created
-- from, directly on the bookings row (previously only on the transient
-- pending_bookings.payload). Additive + nullable so existing rows and the
-- insert path are unaffected until the app starts populating it.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS duffel_offer_id text;
