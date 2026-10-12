# Altayebat ↔ Axiom Integration Architecture

Date: 2026-10-12
Status: Proposed contract; no live integration is enabled by this document.

## Decision

Keep the systems as separate deployable applications initially. Use authenticated, versioned API contracts and an outbox/inbox pattern. Do not allow Altayebat clients to connect directly to Axiom's PostgreSQL database, and do not merge the Supabase schema with Axiom's PostgreSQL schema as a first step.

## System ownership

| Data / action | Authoritative system (proposed) | Notes |
|---|---|---|
| Customer-facing catalog presentation, storefront branding and delivery UI | Altayebat | Catalog changes may originate from ERP and be synchronized; define ownership per field |
| SKU, barcode, base unit, costing method and warehouse stock ledger | Axiom | Altayebat must not independently post stock movements once ERP inventory is authoritative |
| Online order capture and customer-visible order status | Altayebat | Each order receives an immutable external ID and tenant/branch mapping |
| Reservation and final stock issue | Axiom inventory API | Define reservation timing and cancellation/release semantics before enabling sales |
| Posted financial journal and subledgers | Axiom accounting | Only trusted server-side posting operations may create journals |
| Delivery assignment, tracking and proof of delivery | Altayebat / delivery partner integration | Delivery completion is an event, not permission to directly edit ERP stock or journals |
| Tenant subscription, storefront domain and platform entitlement | Altayebat platform initially | Keep platform control-plane identity distinct from ERP organization identity |

## Tenant mapping

Create a reviewed mapping record in a trusted backend, not in client-controlled metadata:

- `platform_tenant_id`: Altayebat tenant/store identifier
- `erp_organization_id`: Axiom organization UUID
- `branch_id`: mapped ERP location/warehouse and storefront branch
- `status`: pending / active / suspended / disconnected
- `created_at`, `updated_at`, `created_by`

Mapping constraints:
- One active mapping per intended tenant/ERP organization pair.
- Explicit branch-to-warehouse mapping.
- No client may choose an arbitrary ERP organization ID to gain access.
- Every API request derives its permitted organization from authenticated service identity and verified mapping.
- Cross-tenant references are rejected even if a referenced UUID is valid.

## Proposed event envelope

All events should be versioned, signed/authenticated between services, and idempotent.

```json
{
  "event_id": "uuid",
  "event_type": "commerce.order.accepted",
  "schema_version": 1,
  "occurred_at": "RFC3339 timestamp",
  "platform_tenant_id": "uuid",
  "branch_id": "uuid",
  "external_entity_id": "string",
  "idempotency_key": "string",
  "correlation_id": "uuid",
  "payload": {}
}
```

This is an illustrative contract; no production credentials or real tenant identifiers belong in examples.

## Initial event contract

### Altayebat → Axiom

- `commerce.order.accepted.v1`: accepted order and normalized lines; must not imply payment settled unless verified payment state is included.
- `commerce.order.cancelled.v1`: cancellation request; ERP determines whether reservations can be released or compensating documents are needed.
- `commerce.refund.requested.v1`: refund request with original order/payment references; requires authorized approval and payment-provider confirmation.
- `commerce.delivery.completed.v1`: delivery evidence for reconciliation; must not itself create a duplicate sale or inventory issue.

### Axiom → Altayebat

- `catalog.product.upserted.v1`: SKU, display name, barcode, base unit, active state and version.
- `catalog.price.changed.v1`: price list, currency, effective time and version.
- `inventory.availability.changed.v1`: sellable availability per mapped branch; distinguish on-hand, reserved and available.
- `erp.document.posted.v1`: source reference, document ID, posting status and correlation ID; never expose internal accounting data to unauthorized storefront users.

## Processing rules

1. Validate event schema and service identity.
2. Resolve tenant and branch from server-side mapping.
3. Persist event ID/idempotency key in an inbox table with a unique constraint.
4. Process domain transaction and write all required inventory/accounting documents atomically inside Axiom.
5. Return the prior result for duplicate delivery; do not post twice.
6. Publish outbound events from a transactional outbox only after commit.
7. Retry transient failures with bounded backoff; quarantine poison messages for operator review.
8. Record correlation ID, source event, resulting ERP document IDs and safe error code in audit logs.
9. Never treat a browser return URL as proof of payment. Verify provider callbacks server-side and reconcile settlements.
10. Do not deduct stock in both Altayebat and Axiom. Select one authoritative posting path and test every checkout, cancellation, refund and admin adjustment path.

## API shape (proposed)

- `POST /api/v1/integrations/commerce/orders`
- `POST /api/v1/integrations/commerce/orders/{externalId}/cancel`
- `POST /api/v1/integrations/commerce/refunds`
- `GET /api/v1/integrations/catalog/products?updatedSince=...`
- `GET /api/v1/integrations/inventory/availability?branchId=...`
- `GET /api/v1/integrations/events/{eventId}`

These endpoints are proposals, not claims that the routes already exist.

## Rollout stages

1. Read-only catalog and stock availability synchronization in staging.
2. Synthetic orders and idempotency/replay testing.
3. Inventory reservation and release lifecycle.
4. Accounting posting and reconciliation.
5. Refunds, returns, payment settlement and delivery reconciliation.
6. One consenting pilot tenant with monitoring and a tested rollback.
7. Enable more tenants only after tenant-isolation and restore gates pass.
