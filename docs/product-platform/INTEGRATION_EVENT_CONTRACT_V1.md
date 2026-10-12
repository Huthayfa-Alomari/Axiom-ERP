# Integration event contract and processing (v1)

This implementation adds a versioned event contract, authenticated intake endpoint, durable inbox, and an opt-in worker that converts supported commerce order events into Axiom sales orders and stock reservations. It does **not** issue stock or post accounting journals.

## API intake

`POST /api/v1/integrations/events`

Headers:
- `Authorization: Bearer <source-specific-token>`
- `Content-Type: application/json`

Configure `INTEGRATION_SOURCE_TOKENS_JSON` on the server as a JSON object keyed by producer source. Each token must be a distinct random secret of at least 32 characters. Example shape only:
`{"altayebat":"<replace-with-a-long-random-secret>"}`

Keep secrets in a deployment secret manager, rotate them, and never expose them to browser/mobile clients. Use TLS, rate limiting, and monitoring.

## Required tenant and data mappings

Provision mappings only through a trusted administrative process. The producer cannot choose an Axiom organization by sending an organization ID in its event.

- `integration.tenant_mappings`: source + external tenant + optional branch → Axiom organization + warehouse; optional default customer for guest/anonymous orders.
- `integration.product_mappings`: external product ID → active Axiom stocked product.
- `integration.customer_mappings`: external customer reference → Axiom CRM customer.
- `integration.external_order_links`: external order ID → Axiom sales order.

An order with a customer reference requires an explicit customer mapping. An order without a customer reference requires a configured default customer. Each mapped branch requires a warehouse. Product mappings must reference stocked products. The first processor version requires the order currency to equal the Axiom organization's base currency; FX conversion is not implemented.

## Processing

Set `INTEGRATION_WORKER_ENABLED=true` to enable the in-process inbox worker. Optional `INTEGRATION_WORKER_POLL_MS` controls polling (bounded to 1–60 seconds; default 5 seconds). The worker is disabled unless explicitly enabled.

For `commerce.order.created`, the worker:
1. Resolves the tenant mapping and verifies it still matches the event source/tenant/branch.
2. Resolves customer and products from server-managed mappings.
3. Verifies available stock and reserves it under the sales order source key.
4. Creates the Axiom sales order and lines, then marks the order `reserved`.
5. Writes an outbound event to the existing Axiom outbox in the same transaction.
6. Marks the inbox event processed.

For `commerce.order.cancelled`, it releases active reservations and cancels an order that has not been delivered/closed, then writes an outbound event. Unknown orders and already-fulfilled orders are not silently cancelled.

## Idempotency, retries, and transaction boundaries

The inbox has a unique key scoped to producer + external tenant + branch + event UUID. Identical retries return the prior inbox ID/status. Reusing the same event UUID with a different body returns a conflict. The worker uses row locking with `SKIP LOCKED`; order creation, stock reservations, order links, outbound events, and inbox status changes are transactional. Failed events are recorded with a bounded exponential retry delay.

This is still a first integration slice, not a production certification. Inventory is reserved but not issued; no delivery workflow, payment capture/refund, sales invoice, or accounting journal is created by this worker. The outbox publisher is not implemented yet.

## Deployment and safety gates

- Apply migration `0009_platform_integration.sql` to a disposable/staging database first; this change has not run any migration against production.
- Ensure the API database role has appropriately restricted access to integration tables. Do not grant direct access to browser/mobile roles.
- Provision and verify tenant, warehouse, default customer, product, and customer mappings before enabling the worker.
- Keep the worker disabled until those mappings are complete and staging orders have been tested.
- Test clean migration, duplicate delivery, conflicting replay, insufficient stock, cancellation, cross-tenant mapping, concurrent events, rollback, and retry recovery.
- Do not connect the Altayebat client directly to Axiom's database.
