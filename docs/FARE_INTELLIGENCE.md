# Fare Intelligence & Baggage Engine

Airpiv turns raw Duffel offers into a **canonical, source- and confidence-scored**
offer, enriched by verified airline fare rules when Duffel's data is incomplete —
**never** by guessed defaults.

> **Core principle:** *"Better to say unknown than to show an incorrect baggage
> allowance."*

## Data flow

```
Duffel Raw Offer
      ↓  normalizeOffer()            src/services/normalizeOffer.js
Offer Normalizer
      ↓  resolveBaggage()            src/services/baggageEngine.js
      ↓  resolveFareConditions()     src/services/fareConditionsEngine.js
Fare Rule Engine (matching ladder)   src/services/fareRules.js
      ↓
Canonical Airpiv Offer  { …, baggage, fareConditions }
      ↓
Frontend (web/public/app.js)
```

The frontend never touches Duffel internals — it renders the canonical
`offer.baggage` / `offer.fareConditions` objects.

## Source hierarchy (who wins)

| Level | Source | Confidence | Notes |
|------|--------|-----------|-------|
| 1 | **Duffel** offer-specific | `HIGH` | The authority for the live offer. |
| 2 | Verified **fare-specific** rule (airline + fare family + booking/cabin) | `HIGH`/`MEDIUM` | Fills gaps Duffel leaves. |
| 3 | **General** airline/cabin policy (no fare identified) | `LOW` | Never shown as a confirmed fact. |
| — | Nothing | `UNKNOWN` | Shown as "may vary by fare". |

Duffel always wins. A rule may only *enrich* a value Duffel omitted (e.g. a
missing weight on an included bag); it can never override Duffel or change the
price.

## Matching ladder (`fareRules.matchLevel`)

```
airline + fare_family + booking_class + cabin   → HIGH   (level 4)
airline + fare_family + cabin                    → HIGH   (level 3)
airline + booking_class + cabin                  → MEDIUM (level 2)
airline + cabin  (no fare identified)            → LOW    (level 1, general)
no match                                         → UNKNOWN
```

**Golden rule:** when the fare family is *known*, a general (family-less) rule is
capped at `LOW` — a known Economy-Light fare never borrows Economy-Classic's
23 kg. Effective dating is enforced too: an expired rule is never used as
current confirmed data.

## Canonical shapes

```jsonc
offer.baggage = {
  personal_item: { type, included, pieces, weight_kg, dimensions,
                   source, confidence, matched_rule_id, confirmed, weight_confirmed, … },
  cabin:         { … },
  checked:       { … },
  additional:    { … },
  meta: { ctx: { airline, fareFamily, bookingClass, cabin }, hasAnyConfirmed }
}

offer.fareConditions = {
  change:   { allowed, fee, fee_currency, source, confidence, confirmed },
  refund:   { refundable, fee, fee_currency, source, confidence, confirmed },
  seat:     { seat_selection, source, confidence, confirmed },
  meal:     { included, … },
  priority: { included, … }
}
```

`confirmed` is `true` only at `HIGH`/`MEDIUM` — the single flag the frontend
gates "show as a fact" vs "may vary by fare" on (`config/fareIntelligence.isConfirmed`).

## The rule database (`airline_fare_rules`)

`sql/airline_fare_rules.sql` — one row per (fare context × baggage type / fare
condition), with **provenance** (`source_type`, `source_url`, `confidence`),
**versioning** (`effective_from` / `effective_until`, never destructive edits)
and **audit** (`created_by`, `updated_by`, timestamps). RLS: service-role only.

Managed from the admin CMS ("قواعد الأمتعة والتعرفات" page → `/admin/fare-rules`).

## Pilot rollout (§34)

`sql/seed_fare_rules_pilot.sql` (Lufthansa) and
`sql/seed_fare_rules_pilot_lcc_legacy.sql` (Condor, Iberia, BA, AF, KLM,
Ryanair, easyJet) seed rules **inactive** at `MEDIUM` with official source URLs.
Running them changes nothing a customer sees. An admin verifies each row against
its source, sets `last_verified`, and activates it — carrier by carrier.

## Observability (§27)

`fareRulesStore.logBaggageResolution()` emits one structured log line per offer
whose baggage was resolved from a rule (offer id, airline, fare family, booking
class, cabin, matched_rule_id, source, confidence) — so any displayed allowance
is traceable back to the exact rule behind it.

## Consistency invariants (§26)

`consistencyValidation.checkOfferBaggage()` guards that a `confirmed` value has a
real source and non-LOW/UNKNOWN confidence, `pieces >= 0`, `weight_kg > 0`, and a
weight is never "confirmed" above its own provenance.

## Tests

- `test/fareIntelligence.test.js` — spec §33 TEST 1-10, matching ladder,
  effective dates, admin validation, consistency.
- `test/fareConditions.test.js` — change/refund/seat/meal/priority resolution.
