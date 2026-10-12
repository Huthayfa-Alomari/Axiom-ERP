# Staging runbook: Axiom + Altayebat order integration

**Staging only. Do not run these steps against production until the integration is formally approved.** This runbook is a setup checklist; it does not provision records automatically.

## 1. Apply the migration

Run the repository's normal migration command against a disposable or staging database. Verify that migration `0009_platform_integration.sql` is recorded in `public.schema_migrations`.

## 2. Configure the producer token

Generate a random secret of at least 32 characters and store it in the API deployment's secret manager under `INTEGRATION_SOURCE_TOKENS_JSON`. Keep a separate token per source. Do not put this token in the Altayebat mobile/web client or in a committed file.

Example shape only:

```json
{
  "altayebat": "<long-random-secret>"
}
```

The Altayebat server-side integration client should send the token as a Bearer token over TLS.

## 3. Provision one tenant/branch mapping

Find the target Axiom organization UUID, warehouse UUID, and a default CRM customer UUID in the staging database. The default customer is used only when an order has no external customer reference.

```sql
INSERT INTO integration.tenant_mappings (
  source,
  external_tenant_id,
  external_branch_id,
  organization_id,
  warehouse_id,
  default_customer_id
) VALUES (
  'altayebat',
  '<ALTAYEBAT_STORE_ID>',
  '<ALTAYEBAT_BRANCH_ID>',
  '<AXIOM_ORGANIZATION_UUID>'::uuid,
  '<AXIOM_WAREHOUSE_UUID>'::uuid,
  '<AXIOM_DEFAULT_CUSTOMER_UUID>'::uuid
)
RETURNING id, organization_id;
```

If the source has no branch dimension, use SQL `NULL` for `external_branch_id`. Keep external identifiers exact and stable.

## 4. Map each product

For each external product ID used by the storefront, map it to an active Axiom stocked product in the same organization. Repeat this statement for each product after replacing the placeholders.

```sql
INSERT INTO integration.product_mappings (
  tenant_mapping_id, organization_id, external_product_id, product_id
)
SELECT tm.id, tm.organization_id,
       '<ALTAYEBAT_PRODUCT_ID>',
       '<AXIOM_PRODUCT_UUID>'::uuid
FROM integration.tenant_mappings tm
WHERE tm.source='altayebat'
  AND tm.external_tenant_id='<ALTAYEBAT_STORE_ID>'
  AND tm.external_branch_id='<ALTAYEBAT_BRANCH_ID>';
```

If orders send customer references, create a row in `integration.customer_mappings` for each external customer ID. The customer must exist in the same Axiom organization. If no customer reference is sent, configure `default_customer_id` on the tenant mapping.

## 5. Verify mapping completeness before enabling the worker

Check the tenant and product mappings manually. Verify that the selected warehouse has sufficient stock for test products and that the Axiom organization's base currency is JOD for the example below. Start with one test tenant and a small number of test products.

Only after that should the API deployment set `INTEGRATION_WORKER_ENABLED=true`. The worker polls every 5 seconds by default; `INTEGRATION_WORKER_POLL_MS` can be configured between 1,000 and 60,000 milliseconds.

## 6. Send a staging order event

```json
{
  "schemaVersion": 1,
  "eventId": "c3a1d0a6-85a0-4b8c-8d3f-3b0e0f4c5a01",
  "type": "commerce.order.created",
  "occurredAt": "2026-10-12T12:00:00Z",
  "source": "altayebat",
  "tenant": {
    "externalTenantId": "<ALTAYEBAT_STORE_ID>",
    "externalBranchId": "<ALTAYEBAT_BRANCH_ID>"
  },
  "payload": {
    "externalOrderId": "staging-order-1001",
    "currency": "JOD",
    "lines": [{
      "externalProductId": "<ALTAYEBAT_PRODUCT_ID>",
      "quantity": 2,
      "unitPriceMinor": 3500,
      "currency": "JOD"
    }]
  }
}
```

For JOD in this contract, `unitPriceMinor` is expressed in fils (1 JOD = 1,000 fils); the example price is 3.500 JOD per unit. Reuse the same `eventId` and exact body when retrying the same event.

## 7. Verify outcomes

Confirm that:
- the inbox record becomes `processed`;
- one Axiom sales order and its lines exist;
- active stock reservations exist for the sales order;
- the external order link maps the storefront order to the Axiom order;
- an outbound event exists in `integration.outbox_events`.

Then test duplicate delivery, a different payload reusing the same event UUID, insufficient stock, missing product/customer mapping, and cancellation. The worker does not issue stock, create invoices, post accounting journals, or publish outbound events yet.
