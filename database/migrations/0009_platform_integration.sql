BEGIN;

CREATE SCHEMA IF NOT EXISTS integration;

-- Server-managed mapping. Only trusted provisioning/admin workflows may write here.
-- external_branch_id NULL represents a source tenant with no branch dimension.
CREATE TABLE integration.tenant_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source varchar(32) NOT NULL CHECK (source IN ('altayebat','axiom','external')),
  external_tenant_id varchar(200) NOT NULL CHECK (length(btrim(external_tenant_id)) > 0),
  external_branch_id varchar(200) CHECK (external_branch_id IS NULL OR length(btrim(external_branch_id)) > 0),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  default_customer_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, organization_id),
  FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES inventory.warehouses(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, default_customer_id)
    REFERENCES crm.customers(organization_id, id) ON DELETE RESTRICT
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

CREATE TABLE integration.product_mappings (
  tenant_mapping_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  external_product_id varchar(200) NOT NULL CHECK (length(btrim(external_product_id)) > 0),
  product_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_mapping_id, external_product_id),
  FOREIGN KEY (tenant_mapping_id, organization_id)
    REFERENCES integration.tenant_mappings(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, product_id)
    REFERENCES inventory.products(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX product_mappings_product_idx
ON integration.product_mappings (organization_id, product_id);

CREATE TABLE integration.customer_mappings (
  tenant_mapping_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  external_customer_id varchar(200) NOT NULL CHECK (length(btrim(external_customer_id)) > 0),
  customer_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_mapping_id, external_customer_id),
  FOREIGN KEY (tenant_mapping_id, organization_id)
    REFERENCES integration.tenant_mappings(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES crm.customers(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX customer_mappings_customer_idx
ON integration.customer_mappings (organization_id, customer_id);

CREATE TABLE integration.external_order_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_mapping_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  external_order_id varchar(200) NOT NULL CHECK (length(btrim(external_order_id)) > 0),
  sales_order_id uuid NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','cancelled','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_mapping_id, external_order_id),
  UNIQUE (organization_id, sales_order_id),
  FOREIGN KEY (tenant_mapping_id, organization_id)
    REFERENCES integration.tenant_mappings(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, sales_order_id)
    REFERENCES sales.sales_orders(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX external_order_links_org_idx
ON integration.external_order_links (organization_id, created_at DESC);

-- Inbox is the durable idempotency boundary. Persisting an event is not the same
-- as applying its business effect; a separate worker must claim and process it.
CREATE TABLE integration.inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  tenant_mapping_id uuid NOT NULL,
  source varchar(32) NOT NULL CHECK (source IN ('altayebat','axiom','external')),
  external_tenant_id varchar(200) NOT NULL CHECK (length(btrim(external_tenant_id)) > 0),
  external_branch_id varchar(200) CHECK (external_branch_id IS NULL OR length(btrim(external_branch_id)) > 0),
  event_id uuid NOT NULL,
  event_type varchar(100) NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  occurred_at timestamptz NOT NULL,
  raw_event jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','processed','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
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
ON integration.inbox_events (next_attempt_at, received_at, id)
WHERE status IN ('received','failed');

CREATE INDEX inbox_org_recent_idx
ON integration.inbox_events (organization_id, received_at DESC);

-- Extend the existing integration.outbox_events table from migration 0002.
-- Preserve its bigint primary key and existing aggregate/published/error fields.
ALTER TABLE integration.outbox_events
  ADD COLUMN event_id uuid,
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  ADD COLUMN status varchar(20),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN lease_expires_at timestamptz;

UPDATE integration.outbox_events
SET event_id = COALESCE(event_id, gen_random_uuid()),
    status = COALESCE(status, CASE WHEN published_at IS NOT NULL THEN 'published' ELSE 'pending' END);

ALTER TABLE integration.outbox_events
  ALTER COLUMN event_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN event_id SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT outbox_status_check CHECK (status IN ('pending','publishing','published','failed')),
  ADD CONSTRAINT outbox_org_event_uq UNIQUE (organization_id, event_id);

CREATE INDEX outbox_pending_publish_idx
ON integration.outbox_events (available_at, created_at, id)
WHERE status IN ('pending','failed');

CREATE INDEX outbox_org_recent_idx
ON integration.outbox_events (organization_id, created_at DESC);

COMMIT;
