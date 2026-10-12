# Integration event contract (v1)

This contract is the first code-level boundary between commerce clients (initially Altayebat) and Axiom. It is deliberately limited to payload validation; it is **not** a running integration endpoint.

## Event envelope

Every event carries:
- `schemaVersion`: currently `1`
- `eventId`: producer-generated UUID, reused on retries
- `type`: a supported event name
- `occurredAt`: ISO-8601 timestamp with an explicit offset
- `source`: producer system
- `tenant`: producer tenant and optional branch identifiers
- `correlationId`: optional workflow trace ID
- `payload`: event-specific data

## Implemented event payloads

### `commerce.order.created`
Contains external order ID, currency, and line items. Line quantity must be positive, unit price is a non-negative integer in the currency's minor unit, and line currency must match order currency. For JOD, producers must agree on the minor-unit convention before money is mapped into Axiom; this schema intentionally does not calculate totals.

### `commerce.order.cancelled`
Contains external order ID and an optional reason. This event does not itself reverse inventory or accounting postings.

## Security and processing requirements before enabling traffic

1. Authenticate service-to-service callers (for example, rotated credentials or signed requests); do not treat a tenant ID supplied in a payload/header as authorization.
2. Resolve producer tenant and branch IDs through a server-controlled mapping to an Axiom organization/branch.
3. Persist an inbox record with a unique producer + tenant + event ID constraint in the same transaction as the business effect.
4. Return the prior outcome for a duplicate event; never repeat inventory posting or journal creation.
5. Use an outbox for outbound events and retry with backoff.
6. Add cross-tenant, replay, malformed-signature, duplicate-delivery, and rollback tests.
7. Do not connect the Altayebat client directly to Axiom's database.

## Not implemented here

No endpoint, authentication scheme, tenant mapping table, inbox/outbox persistence, stock reservation, inventory posting, accounting journal creation, or deployment is implemented by this contract commit. These must be delivered and tested separately before production use.
