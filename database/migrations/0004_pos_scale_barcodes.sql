BEGIN;

CREATE TYPE pos.scale_measure_kind AS ENUM ('weight','price');
CREATE TYPE pos.scale_checksum_mode AS ENUM ('ean13','none');

CREATE TABLE pos.scale_barcode_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  symbology varchar(20) NOT NULL DEFAULT 'EAN13' CHECK (symbology IN ('EAN13')),
  total_length integer NOT NULL DEFAULT 13 CHECK (total_length BETWEEN 8 AND 32),
  accepted_prefixes text[] NOT NULL DEFAULT ARRAY[]::text[],
  plu_start integer NOT NULL DEFAULT 2 CHECK (plu_start >= 0),
  plu_length integer NOT NULL DEFAULT 5 CHECK (plu_length > 0),
  measure_start integer NOT NULL DEFAULT 7 CHECK (measure_start >= 0),
  measure_length integer NOT NULL DEFAULT 5 CHECK (measure_length > 0),
  measure_kind pos.scale_measure_kind NOT NULL,
  measure_decimals integer NOT NULL DEFAULT 3 CHECK (measure_decimals BETWEEN 0 AND 8),
  checksum_mode pos.scale_checksum_mode NOT NULL DEFAULT 'ean13',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid DEFAULT app.current_user_id(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid DEFAULT app.current_user_id(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  CHECK (plu_start + plu_length <= total_length),
  CHECK (measure_start + measure_length <= total_length)
);

CREATE TABLE pos.scale_plu_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  plu varchar(32) NOT NULL,
  product_id uuid NOT NULL,
  tare_weight numeric(38,8) NOT NULL DEFAULT 0 CHECK (tare_weight >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid DEFAULT app.current_user_id(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid DEFAULT app.current_user_id(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, profile_id, plu),
  UNIQUE (organization_id, profile_id, product_id),
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES pos.scale_barcode_profiles(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id)
    REFERENCES inventory.products(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE pos.terminal_scale_profiles (
  organization_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid DEFAULT app.current_user_id(),
  PRIMARY KEY (organization_id, terminal_id, profile_id),
  FOREIGN KEY (organization_id, terminal_id)
    REFERENCES pos.terminals(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, profile_id)
    REFERENCES pos.scale_barcode_profiles(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX scale_plu_product_idx
  ON pos.scale_plu_mappings(organization_id, product_id);

CREATE INDEX terminal_scale_priority_idx
  ON pos.terminal_scale_profiles(organization_id, terminal_id, priority)
  WHERE is_active;

CREATE OR REPLACE FUNCTION pos.touch_scale_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.updated_by := app.current_user_id();
  RETURN NEW;
END
$$;

CREATE TRIGGER scale_profiles_touch
BEFORE UPDATE ON pos.scale_barcode_profiles
FOR EACH ROW EXECUTE FUNCTION pos.touch_scale_config();

CREATE TRIGGER scale_plu_touch
BEFORE UPDATE ON pos.scale_plu_mappings
FOR EACH ROW EXECUTE FUNCTION pos.touch_scale_config();

ALTER TABLE pos.scale_barcode_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.scale_plu_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.terminal_scale_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY scale_profiles_tenant ON pos.scale_barcode_profiles
USING (organization_id = app.current_organization_id())
WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY scale_plu_tenant ON pos.scale_plu_mappings
USING (organization_id = app.current_organization_id())
WITH CHECK (organization_id = app.current_organization_id());

CREATE POLICY terminal_scale_tenant ON pos.terminal_scale_profiles
USING (organization_id = app.current_organization_id())
WITH CHECK (organization_id = app.current_organization_id());

CREATE OR REPLACE VIEW pos.terminal_scale_configuration
WITH (security_invoker=true) AS
SELECT
  tsp.organization_id,
  tsp.terminal_id,
  tsp.priority,
  p.id AS profile_id,
  p.code AS profile_code,
  p.name AS profile_name,
  p.symbology,
  p.total_length,
  p.accepted_prefixes,
  p.plu_start,
  p.plu_length,
  p.measure_start,
  p.measure_length,
  p.measure_kind,
  p.measure_decimals,
  p.checksum_mode,
  m.plu,
  m.product_id,
  pr.sku,
  pr.barcode AS product_barcode,
  pr.name AS product_name,
  pr.standard_sale_price,
  m.tare_weight
FROM pos.terminal_scale_profiles tsp
JOIN pos.scale_barcode_profiles p
  ON p.organization_id=tsp.organization_id
 AND p.id=tsp.profile_id
 AND p.is_active
JOIN pos.scale_plu_mappings m
  ON m.organization_id=p.organization_id
 AND m.profile_id=p.id
 AND m.is_active
JOIN inventory.products pr
  ON pr.organization_id=m.organization_id
 AND pr.id=m.product_id
 AND pr.is_active
WHERE tsp.is_active;

INSERT INTO app.permissions(code,module,description) VALUES
('pos.scale.read','pos','Read electronic scale barcode configuration'),
('pos.scale.configure','pos','Configure electronic scale barcode profiles and PLU mappings')
ON CONFLICT DO NOTHING;

COMMIT;
