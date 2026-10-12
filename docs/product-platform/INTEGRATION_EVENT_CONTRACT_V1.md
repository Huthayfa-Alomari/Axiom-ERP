# Integration event contract and inbox (v1)

This implementation adds a versioned event contract and an authenticated event-intake endpoint. It persists events for later processing; it does **not** post orders to inventory or accounting.

## API

`POST /api/v1/integrations/events`

Headers:
- `Authorization: Bearer <source-specific-token>`
- `Content-Type: application/json`

Configure `INTEGRATION_SOURCE_TOKENS_JSON` on the server as a JSON object keyed by producer source. Each token must be a distinct random secret of at least 32 characters. Example shape only:
`{"altayebat":"<replace-with-a-long-random-secret>"}`

The token source is selected from the event's `source` field. Keep secrets in a deployment secret manager, rotate them, and never expose them to browser/mobile clients. Use TLS, rate limiting, and monitoring.

## Tenant mapping

The endpoint resolves the producer identity using `integration.tenant_mappings`:
- `source`
- `external_tenant_id`
- optional `external_branch_id`
- `organization_id` (the Axiom organization)

Provision mappings only through a trusted administrative procedure. The producer cannot choose an Axiom organization by sending an organization ID in its event. Missing or inactive mappings are rejected.

## Inbox and idempotency

Accepted events are persisted to `integration.inbox_events` with status `received`. A unique key scopes each event UUID to producer + external tenant + branch. An identical retry returns the prior inbox ID and status. Reusing the same event UUID with a different body returns a conflict.

This is idempotent **intake only**. No worker currently processes these records, and no inventory or accounting effect is applied by this endpoint. A downstream worker must claim records transactionally and make each business effect idempotent before marking the inbox record processed.

## Outbox

The migration creates `integration.outbox_events` as the persistence foundation for reliable outbound events. No publisher/worker is implemented yet.

## Deployment and safety gates

- Apply migration `0009_platform_integration.sql` to a disposable/staging database first; this change has not run any migration.
- Ensure the API database role has only the required privileges on the `integration` tables. Do not grant direct access to browser/mobile roles.
- Configure separate random tokens for each source and rotate them through the deployment secret manager.
- Provision tenant mappings through a trusted operator process; no public mapping-management endpoint exists.
- Test clean migration, duplicate delivery, conflicting replay, cross-tenant mapping, concurrent inserts, rollback and recovery.
- Do not connect the Altayebat client directly to Axiom's database.
- No production database, credentials, deployment, or live migration was changed by this PR.
