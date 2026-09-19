BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS accounting;
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS ar;
CREATE SCHEMA IF NOT EXISTS ap;

CREATE TYPE accounting.account_type AS ENUM ('asset','liability','equity','revenue','expense');
CREATE TYPE accounting.normal_balance AS ENUM ('debit','credit');
CREATE TYPE accounting.journal_status AS ENUM ('draft','posted','reversed','void');

CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(50) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  base_currency_code varchar(3) NOT NULL CHECK (base_currency_code ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL UNIQUE,
  display_name varchar(200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE app.memberships (
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id)
);

CREATE TABLE app.permissions (
  code varchar(120) PRIMARY KEY,
  module varchar(80) NOT NULL,
  description varchar(500) NOT NULL
);

CREATE TABLE app.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE CASCADE,
  code varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  UNIQUE (organization_id,code),
  UNIQUE (organization_id,id)
);

CREATE TABLE app.role_permissions (
  organization_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_code varchar(120) NOT NULL REFERENCES app.permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (organization_id,role_id,permission_code),
  FOREIGN KEY (organization_id,role_id) REFERENCES app.roles(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE app.member_roles (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (organization_id,user_id,role_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES app.memberships(organization_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,role_id) REFERENCES app.roles(organization_id,id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.organization_id',true),'')::uuid;
$$;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id',true),'')::uuid;
$$;
CREATE OR REPLACE FUNCTION app.require_organization_id() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE v uuid := app.current_organization_id(); BEGIN IF v IS NULL THEN RAISE EXCEPTION 'ORGANIZATION_CONTEXT_REQUIRED'; END IF; RETURN v; END $$;
CREATE OR REPLACE FUNCTION app.require_user_id() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE v uuid := app.current_user_id(); BEGIN IF v IS NULL THEN RAISE EXCEPTION 'USER_CONTEXT_REQUIRED'; END IF; RETURN v; END $$;

CREATE OR REPLACE FUNCTION app.user_has_permission(p_permission text,p_org uuid DEFAULT app.require_organization_id()) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.member_roles mr
    JOIN app.role_permissions rp ON rp.organization_id=mr.organization_id AND rp.role_id=mr.role_id
    JOIN app.memberships m ON m.organization_id=mr.organization_id AND m.user_id=mr.user_id AND m.is_active
    WHERE mr.organization_id=p_org AND mr.user_id=app.current_user_id() AND rp.permission_code=p_permission
  );
$$;
CREATE OR REPLACE FUNCTION app.assert_permission(p_permission text,p_org uuid DEFAULT app.require_organization_id()) RETURNS void
LANGUAGE plpgsql STABLE AS $$ BEGIN IF NOT app.user_has_permission(p_permission,p_org) THEN RAISE EXCEPTION 'PERMISSION_DENIED:%',p_permission; END IF; END $$;

CREATE TABLE audit.logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid,
  user_id uuid,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  operation text NOT NULL,
  row_id text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION audit.capture_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb; rid text; org uuid; BEGIN
  d := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  rid := d->>'id'; org := COALESCE((d->>'organization_id')::uuid,app.current_organization_id());
  INSERT INTO audit.logs(organization_id,user_id,schema_name,table_name,operation,row_id,old_data,new_data)
  VALUES(org,app.current_user_id(),TG_TABLE_SCHEMA,TG_TABLE_NAME,TG_OP,rid,CASE WHEN TG_OP IN('UPDATE','DELETE') THEN to_jsonb(OLD) END,CASE WHEN TG_OP IN('INSERT','UPDATE') THEN to_jsonb(NEW) END);
  RETURN COALESCE(NEW,OLD);
END $$;

CREATE TABLE accounting.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  code varchar(64) NOT NULL,
  name varchar(200) NOT NULL,
  account_type accounting.account_type NOT NULL,
  normal_balance accounting.normal_balance NOT NULL,
  system_code varchar(80),
  is_active boolean NOT NULL DEFAULT true,
  is_postable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,code)
);
CREATE UNIQUE INDEX coa_system_code_uq ON accounting.chart_of_accounts(organization_id,system_code) WHERE system_code IS NOT NULL;

CREATE TABLE accounting.fiscal_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  code varchar(30) NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','soft_closed','hard_closed')),
  UNIQUE (organization_id,code),
  CHECK (end_date>=start_date)
);

CREATE TABLE accounting.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id) ON DELETE RESTRICT,
  entry_number bigint GENERATED ALWAYS AS IDENTITY,
  entry_date date NOT NULL,
  document_date date NOT NULL,
  status accounting.journal_status NOT NULL DEFAULT 'draft',
  source varchar(80) NOT NULL,
  reference_type varchar(100),
  reference_id varchar(200),
  description text,
  currency_code varchar(3) NOT NULL,
  exchange_rate numeric(38,18) NOT NULL DEFAULT 1 CHECK(exchange_rate>0),
  reversed_entry_id uuid,
  posted_at timestamptz,
  posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL DEFAULT app.require_user_id(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,entry_number),
  FOREIGN KEY (organization_id,reversed_entry_id) REFERENCES accounting.journal_entries(organization_id,id)
);

CREATE TABLE accounting.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL,
  line_number integer NOT NULL,
  account_id uuid NOT NULL,
  description text,
  debit numeric(38,8) NOT NULL DEFAULT 0,
  credit numeric(38,8) NOT NULL DEFAULT 0,
  currency_code varchar(3) NOT NULL,
  exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
  base_debit numeric(38,8) NOT NULL,
  base_credit numeric(38,8) NOT NULL,
  source_line_ref varchar(200),
  UNIQUE (organization_id,journal_entry_id,line_number),
  FOREIGN KEY (organization_id,journal_entry_id) REFERENCES accounting.journal_entries(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,account_id) REFERENCES accounting.chart_of_accounts(organization_id,id),
  CHECK (debit>=0 AND credit>=0 AND ((debit>0 AND credit=0) OR (credit>0 AND debit=0))),
  CHECK (base_debit>=0 AND base_credit>=0 AND ((base_debit>0 AND base_credit=0) OR (base_credit>0 AND base_debit=0)) )
);

CREATE OR REPLACE FUNCTION accounting.guard_journal_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s accounting.journal_status; BEGIN
  SELECT status INTO s FROM accounting.journal_entries WHERE organization_id=COALESCE(NEW.organization_id,OLD.organization_id) AND id=COALESCE(NEW.journal_entry_id,OLD.journal_entry_id);
  IF s<>'draft' THEN RAISE EXCEPTION 'POSTED_JOURNAL_IMMUTABLE'; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER journal_line_mutation_guard BEFORE INSERT OR UPDATE OR DELETE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_line_mutation();

CREATE OR REPLACE FUNCTION accounting.post_journal_entry(p_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e accounting.journal_entries%ROWTYPE; d numeric; c numeric; bad bigint; BEGIN
  PERFORM app.assert_permission('accounting.journals.post');
  SELECT * INTO e FROM accounting.journal_entries WHERE organization_id=app.require_organization_id() AND id=p_id FOR UPDATE;
  IF NOT FOUND OR e.status<>'draft' THEN RAISE EXCEPTION 'DRAFT_JOURNAL_NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM accounting.fiscal_periods fp WHERE fp.organization_id=e.organization_id AND e.entry_date BETWEEN fp.start_date AND fp.end_date AND fp.status='hard_closed') THEN RAISE EXCEPTION 'FISCAL_PERIOD_CLOSED'; END IF;
  SELECT COALESCE(SUM(base_debit),0),COALESCE(SUM(base_credit),0),COUNT(*) FILTER(WHERE NOT coa.is_active OR NOT coa.is_postable)
  INTO d,c,bad FROM accounting.journal_lines jl JOIN accounting.chart_of_accounts coa ON coa.organization_id=jl.organization_id AND coa.id=jl.account_id
  WHERE jl.organization_id=e.organization_id AND jl.journal_entry_id=e.id;
  IF d=0 OR round(d-c,8)<>0 THEN RAISE EXCEPTION 'JOURNAL_NOT_BALANCED'; END IF;
  IF bad>0 THEN RAISE EXCEPTION 'ACCOUNT_NOT_POSTABLE'; END IF;
  UPDATE accounting.journal_entries SET status='posted',posted_at=clock_timestamp(),posted_by=app.require_user_id() WHERE organization_id=e.organization_id AND id=e.id;
  RETURN e.id;
END $$;

CREATE OR REPLACE FUNCTION accounting.reverse_journal_entry(p_id uuid,p_date date,p_reason text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE e accounting.journal_entries%ROWTYPE; rid uuid; BEGIN
  PERFORM app.assert_permission('accounting.journals.post');
  SELECT * INTO e FROM accounting.journal_entries WHERE organization_id=app.require_organization_id() AND id=p_id FOR UPDATE;
  IF NOT FOUND OR e.status NOT IN ('posted','reversed') THEN RAISE EXCEPTION 'POSTED_JOURNAL_NOT_FOUND'; END IF;
  INSERT INTO accounting.journal_entries(organization_id,entry_date,document_date,source,reference_type,reference_id,description,currency_code,exchange_rate,reversed_entry_id)
  VALUES(e.organization_id,p_date,p_date,'reversal','journal_entry',e.id::text,p_reason,e.currency_code,e.exchange_rate,e.id) RETURNING id INTO rid;
  INSERT INTO accounting.journal_lines(organization_id,journal_entry_id,line_number,account_id,description,debit,credit,currency_code,exchange_rate,base_debit,base_credit)
  SELECT organization_id,rid,line_number,account_id,'Reversal: '||COALESCE(description,''),credit,debit,currency_code,exchange_rate,base_credit,base_debit FROM accounting.journal_lines WHERE organization_id=e.organization_id AND journal_entry_id=e.id ORDER BY line_number;
  PERFORM accounting.post_journal_entry(rid);
  UPDATE accounting.journal_entries SET status='reversed' WHERE organization_id=e.organization_id AND id=e.id;
  RETURN rid;
END $$;

CREATE OR REPLACE VIEW accounting.general_ledger WITH (security_invoker=true) AS
SELECT je.organization_id,je.id journal_entry_id,je.entry_number,je.entry_date,je.status,je.source,je.reference_type,je.reference_id,
       jl.id journal_line_id,jl.account_id,coa.code account_code,coa.name account_name,coa.account_type,coa.normal_balance,
       je.currency_code base_currency_code,jl.base_debit,jl.base_credit,jl.debit,jl.credit
FROM accounting.journal_entries je JOIN accounting.journal_lines jl ON jl.organization_id=je.organization_id AND jl.journal_entry_id=je.id
JOIN accounting.chart_of_accounts coa ON coa.organization_id=jl.organization_id AND coa.id=jl.account_id
WHERE je.status IN ('posted','reversed');

CREATE TABLE crm.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), code varchar(64) NOT NULL,
  name varchar(220) NOT NULL, currency_code varchar(3) NOT NULL, receivable_account_id uuid NOT NULL, credit_limit numeric(38,8) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,code),
  FOREIGN KEY(organization_id,receivable_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE crm.vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES app.organizations(id), code varchar(64) NOT NULL,
  name varchar(220) NOT NULL, currency_code varchar(3) NOT NULL, payable_account_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true,
  UNIQUE(organization_id,id), UNIQUE(organization_id,code), FOREIGN KEY(organization_id,payable_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);

CREATE TABLE ar.sales_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, customer_id uuid NOT NULL, invoice_number bigint GENERATED ALWAYS AS IDENTITY,
 invoice_date date NOT NULL, due_date date NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft', currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
 journal_entry_id uuid, UNIQUE(organization_id,id), UNIQUE(organization_id,invoice_number), FOREIGN KEY(organization_id,customer_id) REFERENCES crm.customers(organization_id,id),
 FOREIGN KEY(organization_id,journal_entry_id) REFERENCES accounting.journal_entries(organization_id,id)
);
CREATE TABLE ar.sales_invoice_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, invoice_id uuid NOT NULL, line_number int NOT NULL, description text NOT NULL,
 quantity numeric(38,8) NOT NULL, unit_price numeric(38,8) NOT NULL, revenue_account_id uuid NOT NULL, tax_account_id uuid,
 line_total numeric(38,8) GENERATED ALWAYS AS (round(quantity*unit_price,8)) STORED,
 FOREIGN KEY(organization_id,invoice_id) REFERENCES ar.sales_invoices(organization_id,id), FOREIGN KEY(organization_id,revenue_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE ar.customer_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, customer_id uuid NOT NULL, payment_date date NOT NULL, amount numeric(38,8) NOT NULL CHECK(amount>0),
 currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1, status varchar(30) NOT NULL DEFAULT 'draft', cash_account_id uuid NOT NULL, journal_entry_id uuid,
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,customer_id) REFERENCES crm.customers(organization_id,id), FOREIGN KEY(organization_id,cash_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE ar.customer_payment_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, payment_id uuid NOT NULL, invoice_id uuid NOT NULL, amount numeric(38,8) NOT NULL CHECK(amount>0),
 FOREIGN KEY(organization_id,payment_id) REFERENCES ar.customer_payments(organization_id,id), FOREIGN KEY(organization_id,invoice_id) REFERENCES ar.sales_invoices(organization_id,id)
);

CREATE TABLE ap.vendor_bills (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, vendor_id uuid NOT NULL, bill_number bigint GENERATED ALWAYS AS IDENTITY,
 bill_date date NOT NULL, due_date date NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft', currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1,
 journal_entry_id uuid, UNIQUE(organization_id,id), UNIQUE(organization_id,bill_number), FOREIGN KEY(organization_id,vendor_id) REFERENCES crm.vendors(organization_id,id)
);
CREATE TABLE ap.vendor_bill_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, bill_id uuid NOT NULL, line_number int NOT NULL, description text NOT NULL,
 quantity numeric(38,8) NOT NULL, unit_price numeric(38,8) NOT NULL, expense_account_id uuid NOT NULL, line_total numeric(38,8) GENERATED ALWAYS AS (round(quantity*unit_price,8)) STORED,
 FOREIGN KEY(organization_id,bill_id) REFERENCES ap.vendor_bills(organization_id,id), FOREIGN KEY(organization_id,expense_account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);
CREATE TABLE ap.vendor_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, vendor_id uuid NOT NULL, payment_date date NOT NULL, amount numeric(38,8) NOT NULL CHECK(amount>0),
 currency_code varchar(3) NOT NULL, exchange_rate numeric(38,18) NOT NULL DEFAULT 1, status varchar(30) NOT NULL DEFAULT 'draft', cash_account_id uuid NOT NULL, journal_entry_id uuid,
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,vendor_id) REFERENCES crm.vendors(organization_id,id)
);
CREATE TABLE ap.vendor_payment_allocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, payment_id uuid NOT NULL, bill_id uuid NOT NULL, amount numeric(38,8) NOT NULL CHECK(amount>0),
 FOREIGN KEY(organization_id,payment_id) REFERENCES ap.vendor_payments(organization_id,id), FOREIGN KEY(organization_id,bill_id) REFERENCES ap.vendor_bills(organization_id,id)
);

INSERT INTO app.permissions(code,module,description) VALUES
('accounting.journals.post','accounting','Post and reverse journals'),
('accounting.reports.read','accounting','Read financial reports'),
('ar.read','ar','Read receivables'),('ar.manage','ar','Manage receivables'),
('ap.read','ap','Read payables'),('ap.manage','ap','Manage payables')
ON CONFLICT DO NOTHING;

ALTER TABLE accounting.chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar.sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar.sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar.customer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar.customer_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap.vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap.vendor_bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap.vendor_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap.vendor_payment_allocations ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('accounting','crm','ar','ap') LOOP
  EXECUTE format('CREATE POLICY tenant_policy ON %I.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',r.schemaname,r.tablename);
 END LOOP;
END $$;

COMMIT;
