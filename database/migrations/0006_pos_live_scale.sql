BEGIN;

-- A terminal stores only protocol settings. Browser permission to open a local
-- serial device is always granted by the cashier through the browser prompt.
CREATE TABLE pos.terminal_serial_scales (
  organization_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  baud_rate integer NOT NULL DEFAULT 9600 CHECK (baud_rate BETWEEN 1200 AND 115200),
  data_bits integer NOT NULL DEFAULT 8 CHECK (data_bits IN (7,8)),
  stop_bits integer NOT NULL DEFAULT 1 CHECK (stop_bits IN (1,2)),
  parity varchar(10) NOT NULL DEFAULT 'none' CHECK (parity IN ('none','even','odd')),
  flow_control varchar(10) NOT NULL DEFAULT 'none' CHECK (flow_control IN ('none','hardware')),
  default_unit varchar(2) NOT NULL DEFAULT 'kg' CHECK (default_unit IN ('kg','g')),
  reading_kind varchar(5) NOT NULL DEFAULT 'gross' CHECK (reading_kind IN ('gross','net')),
  tolerance_kg numeric(18,4) NOT NULL DEFAULT 0.002 CHECK (tolerance_kg BETWEEN 0 AND 0.1000),
  max_weight_kg numeric(18,4) NOT NULL DEFAULT 60 CHECK (max_weight_kg BETWEEN 0.001 AND 1000),
  max_age_ms integer NOT NULL DEFAULT 2000 CHECK (max_age_ms BETWEEN 250 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid DEFAULT app.current_user_id(),
  PRIMARY KEY (organization_id, terminal_id),
  FOREIGN KEY (organization_id, terminal_id)
    REFERENCES pos.terminals(organization_id, id) ON DELETE CASCADE
);

-- A weighing machine reads weight; product identity and price still come from
-- tenant-owned inventory. Packaging tare applies to gross readings only.
CREATE TABLE pos.weighable_products (
  organization_id uuid NOT NULL,
  product_id uuid NOT NULL,
  tare_weight_kg numeric(18,4) NOT NULL DEFAULT 0 CHECK (tare_weight_kg BETWEEN 0 AND 1000),
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid DEFAULT app.current_user_id(),
  PRIMARY KEY (organization_id, product_id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES inventory.products(organization_id, id) ON DELETE RESTRICT
);

ALTER TABLE pos.terminal_serial_scales ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.weighable_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY serial_scale_tenant ON pos.terminal_serial_scales
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY weighable_products_tenant ON pos.weighable_products
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

COMMIT;
