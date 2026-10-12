BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;

-- Server-managed mapping. Only trusted provisioning/admin workflows may write here.
-- external_branch_id NULL represents a source tenant with no branch dimension.
CREATE TABLE integration.tenant_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source varchar(32) NOT NULL CHECK (source IN ('altayebat','axiom','external')),
  external_tenant_id varchar(200) NOT NULL,
  external_branch_id varchar(200),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX tenant_mappings_external_identity_uq
ON integration.tenant_mappings (
  source,
  external_tenant_id,
  COALESCE(external_branch_id, '')
);

CREATE INDEX tenant_mappings_organization_idx
ON integration.tenant_mappings (organization_id, source)
WHERE is_active;

-- Inbox is the durable idempotency boundary. Persisting an event is not the same
-- as applying its business effect; a separate worker must claim and process it.
CREATE TABLE integration.inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  tenant_mapping_id uuid NOT NULL,
  source varchar(32) NOT NULL CHECK (source IN ('altayebat','axiom','external')),
  external_tenant_id varchar(200) NOT NULL,
  external_branch_id varchar(200),
  event_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  occurred_at timestamptz NOT NULL,
  raw_event jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  last_error_code varchar(120),
  result jsonb,
  CONSTRAINT inbox_mapping_same_org_fk
    FOREIGN KEY (tenant_mapping_id, organization_id)
    REFERENCES integration.tenant_mappings(id, organization_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX inbox_event_idempotency_uq
ON integration.inbox_events (
  source,
  external_tenant_id,
  COALESCE(external_branch_id, ''),
  event_id
);

CREATE INDEX inbox_pending_processing_idx
ON integration.inbox_events (received_at, id)
WHERE status IN ('received','failed');

CREATE INDEX inbox_org_recent_idx
ON integration.inbox_events (organization_id, received_at DESC);

-- Outbox is prepared for reliable outbound events. Producers should insert the
-- business change and outbox record in the same transaction once that workflow exists.
CREATE TABLE integration.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type varchar(100) NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','publishing','published','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  last_error_code varchar(120),
  UNIQUE (organization_id, event_id)
);

CREATE INDEX outbox_pending_publish_idx
ON integration.outbox_events (available_at, created_at, id)
WHERE status IN ('pending','failed');

CREATE INDEX outbox_org_recent_idx
ON integration.outbox_events (organization_id, created_at DESC);

COMMIT;
