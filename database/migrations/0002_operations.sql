BEGIN;

CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS purchasing;
CREATE SCHEMA IF NOT EXISTS sales;
CREATE SCHEMA IF NOT EXISTS treasury;
CREATE SCHEMA IF NOT EXISTS fixed_assets;
CREATE SCHEMA IF NOT EXISTS hr;
CREATE SCHEMA IF NOT EXISTS payroll;
CREATE SCHEMA IF NOT EXISTS manufacturing;
CREATE SCHEMA IF NOT EXISTS pos;
CREATE SCHEMA IF NOT EXISTS integration;

CREATE TYPE inventory.product_type AS ENUM ('stocked','non_stock','service');
CREATE TYPE inventory.costing_method AS ENUM ('fifo','moving_average');
CREATE TYPE inventory.tracking_method AS ENUM ('none','lot','serial');
CREATE TYPE inventory.document_type AS ENUM ('receipt','issue','transfer','adjustment_in','adjustment_out','purchase_receipt','purchase_return','sale_issue','sales_return','production_issue','production_receipt');
CREATE TYPE inventory.document_status AS ENUM ('draft','posted','void');
CREATE TYPE inventory.stock_direction AS ENUM ('in','out');
CREATE TYPE inventory.reservation_status AS ENUM ('active','consumed','released','expired');

CREATE TABLE inventory.units_of_measure (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), code varchar(32) NOT NULL, name varchar(100) NOT NULL,
 decimal_precision int NOT NULL DEFAULT 3, is_active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE inventory.warehouses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), code varchar(64) NOT NULL, name varchar(180) NOT NULL,
 is_active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE inventory.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), sku varchar(100) NOT NULL, barcode varchar(100), name varchar(220) NOT NULL,
 product_type inventory.product_type NOT NULL DEFAULT 'stocked', costing_method inventory.costing_method NOT NULL DEFAULT 'fifo', tracking_method inventory.tracking_method NOT NULL DEFAULT 'none',
 base_uom_id uuid NOT NULL, inventory_asset_account_id uuid, cogs_account_id uuid, default_revenue_account_id uuid, default_purchase_account_id uuid,
 standard_sale_price numeric(38,8), is_active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,sku),
 FOREIGN KEY(organization_id,base_uom_id) REFERENCES inventory.units_of_measure(organization_id,id),
 FOREIGN KEY(organization_id,inventory_asset_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id),
 FOREIGN KEY(organization_id,cogs_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id),
 FOREIGN KEY(organization_id,default_revenue_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE UNIQUE INDEX products_barcode_uq ON inventory.products(organization_id,barcode) WHERE barcode IS NOT NULL;

CREATE TABLE inventory.inventory_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), document_number bigint GENERATED ALWAYS AS IDENTITY,
 document_type inventory.document_type NOT NULL, status inventory.document_status NOT NULL DEFAULT 'draft', document_date date NOT NULL,
 from_warehouse_id uuid, to_warehouse_id uuid, currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
 source_type varchar(100), source_id varchar(200), idempotency_key varchar(200), offset_account_id uuid, journal_entry_id uuid,
 posted_at timestamptz, posted_by uuid, UNIQUE(organization_id,id), UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,from_warehouse_id) REFERENCES inventory.warehouses(organization_id,id),
 FOREIGN KEY(organization_id,to_warehouse_id) REFERENCES inventory.warehouses(organization_id,id),
 FOREIGN KEY(organization_id,offset_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE inventory.inventory_document_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, document_id uuid NOT NULL, line_number int NOT NULL, product_id uuid NOT NULL,
 quantity numeric(38,8) NOT NULL CHECK(quantity>0), unit_cost numeric(38,8), description text,
 UNIQUE(organization_id,document_id,line_number), FOREIGN KEY(organization_id,document_id) REFERENCES inventory.inventory_documents(organization_id,id),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id)
);
CREATE TABLE inventory.stock_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sequence_number bigint GENERATED ALWAYS AS IDENTITY, organization_id uuid NOT NULL, inventory_document_id uuid NOT NULL,
 inventory_document_line_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL, direction inventory.stock_direction NOT NULL,
 quantity numeric(38,8) NOT NULL CHECK(quantity>0), signed_quantity numeric(38,8) GENERATED ALWAYS AS (CASE WHEN direction='in' THEN quantity ELSE -quantity END) STORED,
 unit_cost_base numeric(38,8) NOT NULL CHECK(unit_cost_base>=0), total_cost_base numeric(38,8) NOT NULL CHECK(total_cost_base>=0), occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,inventory_document_id) REFERENCES inventory.inventory_documents(organization_id,id),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES inventory.warehouses(organization_id,id)
);
CREATE OR REPLACE FUNCTION inventory.immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'STOCK_LEDGER_IMMUTABLE'; END $$;
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON inventory.stock_ledger FOR EACH ROW EXECUTE FUNCTION inventory.immutable_ledger();
CREATE OR REPLACE VIEW inventory.stock_on_hand WITH (security_invoker=true) AS
SELECT organization_id,product_id,warehouse_id,SUM(signed_quantity) quantity_on_hand,SUM(CASE WHEN direction='in' THEN total_cost_base ELSE -total_cost_base END) inventory_value
FROM inventory.stock_ledger GROUP BY organization_id,product_id,warehouse_id;

CREATE TABLE inventory.stock_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 quantity numeric(38,8) NOT NULL CHECK(quantity>0), consumed_quantity numeric(38,8) NOT NULL DEFAULT 0 CHECK(consumed_quantity>=0), status inventory.reservation_status NOT NULL DEFAULT 'active',
 source_type varchar(100) NOT NULL, source_id varchar(200) NOT NULL, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES inventory.warehouses(organization_id,id), CHECK(consumed_quantity<=quantity)
);
CREATE OR REPLACE VIEW inventory.available_stock WITH (security_invoker=true) AS
SELECT oh.organization_id,oh.product_id,oh.warehouse_id,oh.quantity_on_hand,
 COALESCE(r.reserved_quantity,0) reserved_quantity,oh.quantity_on_hand-COALESCE(r.reserved_quantity,0) available_quantity
FROM inventory.stock_on_hand oh LEFT JOIN (
 SELECT organization_id,product_id,warehouse_id,SUM(quantity-consumed_quantity) reserved_quantity FROM inventory.stock_reservations
 WHERE status='active' AND (expires_at IS NULL OR expires_at>clock_timestamp()) GROUP BY organization_id,product_id,warehouse_id
) r ON r.organization_id=oh.organization_id AND r.product_id=oh.product_id AND r.warehouse_id=oh.warehouse_id;

CREATE OR REPLACE FUNCTION inventory.reserve_stock(p_product uuid,p_warehouse uuid,p_qty numeric,p_source_type text,p_source_id text,p_expires timestamptz DEFAULT NULL)
RETURNS inventory.stock_reservations LANGUAGE plpgsql AS $$
DECLARE a numeric; r inventory.stock_reservations%ROWTYPE; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(app.require_organization_id()::text||':'||p_product::text||':'||p_warehouse::text,0));
 SELECT COALESCE(available_quantity,0) INTO a FROM inventory.available_stock WHERE organization_id=app.require_organization_id() AND product_id=p_product AND warehouse_id=p_warehouse;
 IF a<p_qty THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
 INSERT INTO inventory.stock_reservations(organization_id,product_id,warehouse_id,quantity,source_type,source_id,expires_at)
 VALUES(app.require_organization_id(),p_product,p_warehouse,p_qty,p_source_type,p_source_id,p_expires) RETURNING * INTO r; RETURN r;
END $$;

CREATE TYPE purchasing.po_status AS ENUM ('draft','approved','partially_received','received','closed','cancelled');
CREATE TABLE purchasing.purchase_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, po_number bigint GENERATED ALWAYS AS IDENTITY, vendor_id uuid NOT NULL, order_date date NOT NULL,
 expected_date date, status purchasing.po_status NOT NULL DEFAULT 'draft', currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
 UNIQUE(organization_id,id), UNIQUE(organization_id,po_number), FOREIGN KEY(organization_id,vendor_id) REFERENCES crm.vendors(organization_id,id)
);
CREATE TABLE purchasing.purchase_order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, purchase_order_id uuid NOT NULL, line_number int NOT NULL, product_id uuid NOT NULL,
 warehouse_id uuid NOT NULL, quantity numeric(38,8) NOT NULL, unit_price numeric(38,8) NOT NULL, received_quantity numeric(38,8) NOT NULL DEFAULT 0,
 UNIQUE(organization_id,purchase_order_id,line_number), FOREIGN KEY(organization_id,purchase_order_id) REFERENCES purchasing.purchase_orders(organization_id,id),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES inventory.warehouses(organization_id,id)
);
CREATE TABLE purchasing.goods_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, purchase_order_id uuid NOT NULL, receipt_date date NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft',
 inventory_document_id uuid, UNIQUE(organization_id,id), FOREIGN KEY(organization_id,purchase_order_id) REFERENCES purchasing.purchase_orders(organization_id,id)
);

CREATE TYPE sales.order_status AS ENUM ('draft','approved','reserved','partially_delivered','delivered','closed','cancelled');
CREATE TABLE sales.sales_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, order_number bigint GENERATED ALWAYS AS IDENTITY, customer_id uuid NOT NULL, order_date date NOT NULL,
 status sales.order_status NOT NULL DEFAULT 'draft', currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
 UNIQUE(organization_id,id), UNIQUE(organization_id,order_number), FOREIGN KEY(organization_id,customer_id) REFERENCES crm.customers(organization_id,id)
);
CREATE TABLE sales.sales_order_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, sales_order_id uuid NOT NULL, line_number int NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 quantity numeric(38,8) NOT NULL, unit_price numeric(38,8) NOT NULL, delivered_quantity numeric(38,8) NOT NULL DEFAULT 0, reservation_id uuid,
 UNIQUE(organization_id,sales_order_id,line_number), FOREIGN KEY(organization_id,sales_order_id) REFERENCES sales.sales_orders(organization_id,id),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id), FOREIGN KEY(reservation_id) REFERENCES inventory.stock_reservations(id)
);
CREATE TABLE sales.deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, sales_order_id uuid NOT NULL, delivery_date date NOT NULL, status varchar(20) NOT NULL DEFAULT 'draft', inventory_document_id uuid,
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,sales_order_id) REFERENCES sales.sales_orders(organization_id,id)
);

CREATE TABLE treasury.bank_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, code varchar(64) NOT NULL, name varchar(180) NOT NULL, currency_code varchar(3) NOT NULL, gl_account_id uuid NOT NULL,
 is_active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,code), FOREIGN KEY(organization_id,gl_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE treasury.bank_statements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, bank_account_id uuid NOT NULL, statement_number varchar(100), period_start date NOT NULL, period_end date NOT NULL,
 opening_balance numeric(38,8) NOT NULL, closing_balance numeric(38,8) NOT NULL, status varchar(30) NOT NULL DEFAULT 'imported', UNIQUE(organization_id,id), FOREIGN KEY(organization_id,bank_account_id) REFERENCES treasury.bank_accounts(organization_id,id)
);
CREATE TABLE treasury.bank_statement_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, statement_id uuid NOT NULL, line_number int NOT NULL, transaction_date date NOT NULL, amount numeric(38,8) NOT NULL CHECK(amount<>0), description text,
 bank_reference varchar(200), UNIQUE(organization_id,id), UNIQUE(organization_id,statement_id,line_number), FOREIGN KEY(organization_id,statement_id) REFERENCES treasury.bank_statements(organization_id,id)
);

CREATE TYPE fixed_assets.asset_status AS ENUM ('draft','active','fully_depreciated','disposed');
CREATE TABLE fixed_assets.asset_classes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, code varchar(64) NOT NULL, name varchar(160) NOT NULL,
 asset_account_id uuid NOT NULL, accumulated_depreciation_account_id uuid NOT NULL, depreciation_expense_account_id uuid NOT NULL,
 useful_life_months int NOT NULL CHECK(useful_life_months>0), UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE fixed_assets.assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, asset_class_id uuid NOT NULL, asset_number bigint GENERATED ALWAYS AS IDENTITY,
 code varchar(100) NOT NULL, name varchar(220) NOT NULL, status fixed_assets.asset_status NOT NULL DEFAULT 'draft', acquisition_date date NOT NULL, in_service_date date NOT NULL,
 cost_base numeric(38,8) NOT NULL, salvage_value_base numeric(38,8) NOT NULL DEFAULT 0, accumulated_depreciation_base numeric(38,8) NOT NULL DEFAULT 0,
 net_book_value_base numeric(38,8) NOT NULL, UNIQUE(organization_id,id), UNIQUE(organization_id,code), FOREIGN KEY(organization_id,asset_class_id) REFERENCES fixed_assets.asset_classes(organization_id,id)
);

CREATE TYPE hr.employee_status AS ENUM ('draft','active','suspended','terminated');
CREATE TABLE hr.departments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, code varchar(50) NOT NULL, name varchar(160) NOT NULL, UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE hr.employees (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, employee_number bigint GENERATED ALWAYS AS IDENTITY, code varchar(64) NOT NULL, full_name varchar(220) NOT NULL,
 status hr.employee_status NOT NULL DEFAULT 'draft', department_id uuid, hire_date date NOT NULL, payroll_currency varchar(3) NOT NULL, payroll_payable_account_id uuid NOT NULL, expense_account_id uuid NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,code), FOREIGN KEY(organization_id,department_id) REFERENCES hr.departments(organization_id,id)
);
CREATE TABLE payroll.payroll_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, code varchar(50) NOT NULL, start_date date NOT NULL, end_date date NOT NULL, payment_date date NOT NULL,
 is_closed boolean NOT NULL DEFAULT false, UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE payroll.payroll_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, payroll_period_id uuid NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft', currency_code varchar(3) NOT NULL,
 journal_entry_id uuid, payment_journal_entry_id uuid, UNIQUE(organization_id,id), UNIQUE(organization_id,payroll_period_id), FOREIGN KEY(organization_id,payroll_period_id) REFERENCES payroll.payroll_periods(organization_id,id)
);

CREATE TYPE manufacturing.production_status AS ENUM ('draft','released','in_process','completed','closed','cancelled');
CREATE TABLE manufacturing.boms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, product_id uuid NOT NULL, version int NOT NULL, output_quantity numeric(38,8) NOT NULL DEFAULT 1,
 status varchar(20) NOT NULL DEFAULT 'draft', UNIQUE(organization_id,id), UNIQUE(organization_id,product_id,version), FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id)
);
CREATE TABLE manufacturing.bom_components (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, bom_id uuid NOT NULL, line_number int NOT NULL, component_product_id uuid NOT NULL, quantity numeric(38,8) NOT NULL,
 UNIQUE(organization_id,bom_id,line_number), FOREIGN KEY(organization_id,bom_id) REFERENCES manufacturing.boms(organization_id,id), FOREIGN KEY(organization_id,component_product_id) REFERENCES inventory.products(organization_id,id)
);
CREATE TABLE manufacturing.production_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, production_order_number bigint GENERATED ALWAYS AS IDENTITY, product_id uuid NOT NULL, bom_id uuid NOT NULL,
 status manufacturing.production_status NOT NULL DEFAULT 'draft', planned_quantity numeric(38,8) NOT NULL, completed_quantity numeric(38,8) NOT NULL DEFAULT 0,
 source_warehouse_id uuid NOT NULL, destination_warehouse_id uuid NOT NULL, wip_account_id uuid NOT NULL, UNIQUE(organization_id,id), UNIQUE(organization_id,production_order_number),
 FOREIGN KEY(organization_id,product_id) REFERENCES inventory.products(organization_id,id), FOREIGN KEY(organization_id,bom_id) REFERENCES manufacturing.boms(organization_id,id)
);
CREATE TABLE manufacturing.production_cost_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, production_order_id uuid NOT NULL, event_type varchar(30) NOT NULL, direction varchar(20) NOT NULL CHECK(direction IN('wip_debit','wip_credit')),
 amount_base numeric(38,8) NOT NULL CHECK(amount_base>0), source_type varchar(100) NOT NULL, source_id uuid NOT NULL, journal_entry_id uuid, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,production_order_id) REFERENCES manufacturing.production_orders(organization_id,id)
);
CREATE OR REPLACE VIEW manufacturing.production_wip_balances WITH (security_invoker=true) AS
SELECT po.organization_id,po.id production_order_id,po.production_order_number,po.product_id,po.status,
 COALESCE(SUM(CASE WHEN e.direction='wip_debit' THEN e.amount_base ELSE -e.amount_base END),0) wip_balance
FROM manufacturing.production_orders po LEFT JOIN manufacturing.production_cost_events e ON e.organization_id=po.organization_id AND e.production_order_id=po.id
GROUP BY po.organization_id,po.id;

CREATE TABLE pos.terminals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, code varchar(64) NOT NULL, name varchar(150) NOT NULL, warehouse_id uuid NOT NULL,
 default_customer_id uuid NOT NULL, UNIQUE(organization_id,id), UNIQUE(organization_id,code), FOREIGN KEY(organization_id,warehouse_id) REFERENCES inventory.warehouses(organization_id,id)
);
CREATE TABLE pos.devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, terminal_id uuid NOT NULL, device_uid uuid NOT NULL, name varchar(160) NOT NULL,
 status varchar(20) NOT NULL DEFAULT 'active', token_hash bytea NOT NULL, last_accepted_sequence bigint NOT NULL DEFAULT 0, UNIQUE(organization_id,id), UNIQUE(organization_id,device_uid),
 FOREIGN KEY(organization_id,terminal_id) REFERENCES pos.terminals(organization_id,id)
);
CREATE TABLE pos.sync_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, device_id uuid NOT NULL, client_batch_id uuid NOT NULL, first_sequence bigint NOT NULL,
 last_sequence bigint NOT NULL, command_count int NOT NULL, payload_hash varchar(128) NOT NULL, status varchar(40) NOT NULL DEFAULT 'received', received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,device_id,client_batch_id), FOREIGN KEY(organization_id,device_id) REFERENCES pos.devices(organization_id,id)
);
CREATE TABLE pos.sync_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, batch_id uuid NOT NULL, device_id uuid NOT NULL, command_id uuid NOT NULL, sequence_number bigint NOT NULL,
 command_type varchar(80) NOT NULL, payload jsonb NOT NULL, payload_hash varchar(128) NOT NULL, status varchar(30) NOT NULL DEFAULT 'received', result_payload jsonb, error_code varchar(100), error_message text,
 UNIQUE(organization_id,device_id,sequence_number), UNIQUE(organization_id,device_id,command_id), FOREIGN KEY(organization_id,batch_id) REFERENCES pos.sync_batches(organization_id,id)
);

CREATE TABLE integration.outbox_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL, event_type varchar(120) NOT NULL, aggregate_type varchar(120) NOT NULL,
 aggregate_id varchar(200) NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), published_at timestamptz, attempt_count int NOT NULL DEFAULT 0, last_error text
);

INSERT INTO app.permissions(code,module,description) VALUES
('inventory.read','inventory','Read inventory'),('inventory.manage','inventory','Manage inventory'),('inventory.post','inventory','Post inventory documents'),
('purchasing.read','purchasing','Read purchasing'),('purchasing.manage','purchasing','Manage purchasing'),
('sales.read','sales','Read sales'),('sales.manage','sales','Manage sales'),('treasury.read','treasury','Read treasury'),('treasury.reconcile','treasury','Reconcile bank statements'),
('fixed_assets.read','fixed_assets','Read fixed assets'),('fixed_assets.manage','fixed_assets','Manage fixed assets'),('payroll.read','payroll','Read payroll'),('payroll.manage','payroll','Manage payroll'),
('manufacturing.read','manufacturing','Read manufacturing'),('manufacturing.manage','manufacturing','Manage manufacturing'),('pos.sync','pos','Synchronize POS') ON CONFLICT DO NOTHING;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('inventory','purchasing','sales','treasury','fixed_assets','hr','payroll','manufacturing','pos') LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',r.schemaname,r.tablename);
  IF EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=r.schemaname AND c.table_name=r.tablename AND c.column_name='organization_id') THEN
   EXECUTE format('CREATE POLICY tenant_policy ON %I.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',r.schemaname,r.tablename);
  END IF;
 END LOOP;
END $$;

COMMIT;
