BEGIN;

CREATE SCHEMA IF NOT EXISTS reporting;
CREATE SCHEMA IF NOT EXISTS reconciliation;
CREATE SCHEMA IF NOT EXISTS risk;

CREATE TYPE reporting.pnl_section AS ENUM ('revenue','cost_of_sales','operating_expense','other_income','other_expense','income_tax');
CREATE TYPE reporting.balance_sheet_section AS ENUM ('cash_and_cash_equivalents','accounts_receivable','inventory','other_current_assets','property_plant_equipment','other_noncurrent_assets','accounts_payable','other_current_liabilities','long_term_debt','other_noncurrent_liabilities','equity');
CREATE TYPE reporting.cash_flow_section AS ENUM ('operating','investing','financing');
CREATE TYPE risk.assessment_decision AS ENUM ('pass','warn','block');

CREATE TABLE reporting.account_report_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, account_id uuid NOT NULL,
 pnl_section reporting.pnl_section, balance_sheet_section reporting.balance_sheet_section, cash_flow_section reporting.cash_flow_section,
 cash_flow_item varchar(160), is_cash_equivalent boolean NOT NULL DEFAULT false, sort_order int NOT NULL DEFAULT 1000,
 UNIQUE(organization_id,account_id), FOREIGN KEY(organization_id,account_id) REFERENCES accounting.chart_of_accounts(organization_id,id)
);

CREATE OR REPLACE VIEW reporting.financial_ledger WITH (security_invoker=true) AS
SELECT gl.*,
 CASE WHEN gl.account_type IN ('asset','expense') THEN gl.base_debit-gl.base_credit ELSE gl.base_credit-gl.base_debit END account_type_amount
FROM accounting.general_ledger gl;

CREATE OR REPLACE FUNCTION reporting.get_profit_and_loss(p_start date,p_end date)
RETURNS TABLE(account_id uuid,account_code varchar,account_name varchar,account_type accounting.account_type,pnl_section reporting.pnl_section,sort_order int,amount numeric)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT fl.account_id,max(fl.account_code),max(fl.account_name),max(fl.account_type),
        COALESCE(max(m.pnl_section),CASE WHEN max(fl.account_type)='revenue' THEN 'revenue'::reporting.pnl_section ELSE 'operating_expense'::reporting.pnl_section END),
        COALESCE(max(m.sort_order),1000),
        round(sum(CASE WHEN fl.account_type='revenue' THEN fl.base_credit-fl.base_debit ELSE fl.base_debit-fl.base_credit END),8)
 FROM reporting.financial_ledger fl LEFT JOIN reporting.account_report_mappings m ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
 WHERE fl.organization_id=app.require_organization_id() AND fl.entry_date BETWEEN p_start AND p_end AND fl.account_type IN('revenue','expense')
 GROUP BY fl.account_id ORDER BY COALESCE(max(m.sort_order),1000),max(fl.account_code);
$$;

CREATE OR REPLACE FUNCTION reporting.get_balance_sheet(p_as_of date)
RETURNS TABLE(item_type varchar,account_id uuid,account_code varchar,account_name varchar,account_type accounting.account_type,balance_sheet_section reporting.balance_sheet_section,sort_order int,amount numeric)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH b AS (
  SELECT fl.account_id,max(fl.account_code) code,max(fl.account_name) name,max(fl.account_type) typ,
   COALESCE(max(m.balance_sheet_section),CASE WHEN max(fl.account_type)='asset' THEN 'other_current_assets'::reporting.balance_sheet_section WHEN max(fl.account_type)='liability' THEN 'other_current_liabilities'::reporting.balance_sheet_section ELSE 'equity'::reporting.balance_sheet_section END) section,
   COALESCE(max(m.sort_order),1000) sort_order,
   round(sum(CASE WHEN fl.account_type='asset' THEN fl.base_debit-fl.base_credit ELSE fl.base_credit-fl.base_debit END),8) amount
  FROM reporting.financial_ledger fl LEFT JOIN reporting.account_report_mappings m ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
  WHERE fl.organization_id=app.require_organization_id() AND fl.entry_date<=p_as_of AND fl.account_type IN('asset','liability','equity') GROUP BY fl.account_id
 ), earnings AS (
  SELECT round(COALESCE(sum(base_credit-base_debit),0),8) amount FROM reporting.financial_ledger
  WHERE organization_id=app.require_organization_id() AND entry_date<=p_as_of AND account_type IN('revenue','expense')
 )
 SELECT 'account'::varchar,b.account_id,b.code,b.name,b.typ,b.section,b.sort_order,b.amount FROM b WHERE b.amount<>0
 UNION ALL SELECT 'current_earnings',NULL,'CURRENT_EARNINGS','Current / Unclosed Earnings','equity','equity',999999,e.amount FROM earnings e WHERE e.amount<>0;
$$;

CREATE OR REPLACE FUNCTION reporting.get_cash_balance(p_as_of date) RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT round(COALESCE(sum(fl.base_debit-fl.base_credit),0),8)
 FROM reporting.financial_ledger fl JOIN reporting.account_report_mappings m ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id AND m.is_cash_equivalent
 WHERE fl.organization_id=app.require_organization_id() AND fl.entry_date<=p_as_of;
$$;

CREATE OR REPLACE FUNCTION reporting.get_cash_flow_direct(p_start date,p_end date)
RETURNS TABLE(cash_flow_section varchar,cash_flow_item varchar,sort_order int,amount numeric)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH cash_entries AS (
  SELECT DISTINCT fl.journal_entry_id FROM reporting.financial_ledger fl JOIN reporting.account_report_mappings m ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id AND m.is_cash_equivalent
  WHERE fl.organization_id=app.require_organization_id() AND fl.entry_date BETWEEN p_start AND p_end
 ), cp AS (
  SELECT COALESCE(m.cash_flow_section::varchar,'unclassified') section,COALESCE(m.cash_flow_item,fl.account_name) item,COALESCE(m.sort_order,999999) ord,fl.base_credit-fl.base_debit amt
  FROM reporting.financial_ledger fl JOIN cash_entries ce ON ce.journal_entry_id=fl.journal_entry_id
  LEFT JOIN reporting.account_report_mappings m ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
  WHERE fl.organization_id=app.require_organization_id() AND fl.entry_date BETWEEN p_start AND p_end AND COALESCE(m.is_cash_equivalent,false)=false
 )
 SELECT section,item,min(ord),round(sum(amt),8) FROM cp GROUP BY section,item HAVING round(sum(amt),8)<>0 ORDER BY 1,3,2;
$$;

CREATE OR REPLACE VIEW reconciliation.inventory_positions WITH (security_invoker=true) AS
SELECT sl.organization_id,p.inventory_asset_account_id account_id,round(sum(CASE WHEN sl.direction='in' THEN sl.total_cost_base ELSE -sl.total_cost_base END),8) subledger_balance
FROM inventory.stock_ledger sl JOIN inventory.products p ON p.organization_id=sl.organization_id AND p.id=sl.product_id
WHERE p.inventory_asset_account_id IS NOT NULL GROUP BY sl.organization_id,p.inventory_asset_account_id;

CREATE OR REPLACE VIEW reconciliation.wip_positions WITH (security_invoker=true) AS
SELECT po.organization_id,po.wip_account_id account_id,round(COALESCE(sum(CASE WHEN e.direction='wip_debit' THEN e.amount_base ELSE -e.amount_base END),0),8) subledger_balance
FROM manufacturing.production_orders po LEFT JOIN manufacturing.production_cost_events e ON e.organization_id=po.organization_id AND e.production_order_id=po.id GROUP BY po.organization_id,po.wip_account_id;

CREATE OR REPLACE FUNCTION reconciliation.gl_account_balance(p_account uuid,p_as_of date) RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT round(COALESCE(sum(CASE WHEN account_type IN('asset','expense') THEN base_debit-base_credit ELSE base_credit-base_debit END),0),8)
 FROM accounting.general_ledger WHERE organization_id=app.require_organization_id() AND account_id=p_account AND entry_date<=p_as_of;
$$;

CREATE OR REPLACE FUNCTION reconciliation.run_suite(p_as_of date,p_tolerance numeric DEFAULT 0.00000001)
RETURNS TABLE(module varchar,account_id uuid,account_code varchar,account_name varchar,subledger_balance numeric,gl_balance numeric,difference numeric,passed boolean)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH p AS (
  SELECT 'INVENTORY'::varchar module,* FROM reconciliation.inventory_positions WHERE organization_id=app.require_organization_id()
  UNION ALL SELECT 'WIP',* FROM reconciliation.wip_positions WHERE organization_id=app.require_organization_id()
 )
 SELECT p.module,p.account_id,coa.code,coa.name,p.subledger_balance,reconciliation.gl_account_balance(p.account_id,p_as_of),
        round(p.subledger_balance-reconciliation.gl_account_balance(p.account_id,p_as_of),8),
        abs(p.subledger_balance-reconciliation.gl_account_balance(p.account_id,p_as_of))<=p_tolerance
 FROM p JOIN accounting.chart_of_accounts coa ON coa.organization_id=app.require_organization_id() AND coa.id=p.account_id ORDER BY p.module,coa.code;
$$;

CREATE TABLE risk.organization_policies (
 organization_id uuid PRIMARY KEY REFERENCES app.organizations(id), require_ai_clearance boolean NOT NULL DEFAULT false,
 ai_warn_threshold numeric(8,6) NOT NULL DEFAULT .65, ai_block_threshold numeric(8,6) NOT NULL DEFAULT .90,
 manual_journal_warn_limit numeric(38,8), manual_journal_block_limit numeric(38,8), assessment_ttl_minutes int NOT NULL DEFAULT 30
);
CREATE TABLE risk.pre_posting_assessments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, journal_entry_id uuid NOT NULL, journal_fingerprint varchar(64) NOT NULL,
 deterministic_score numeric(8,6) NOT NULL DEFAULT 0, ai_score numeric(8,6), deterministic_decision risk.assessment_decision NOT NULL,
 ai_decision risk.assessment_decision, final_decision risk.assessment_decision NOT NULL, deterministic_findings jsonb NOT NULL DEFAULT '[]', ai_findings jsonb,
 model_name varchar(200),model_version varchar(100),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,journal_entry_id) REFERENCES accounting.journal_entries(organization_id,id)
);
CREATE OR REPLACE FUNCTION risk.journal_fingerprint(p_id uuid) RETURNS varchar LANGUAGE sql STABLE AS $$
 SELECT encode(digest(jsonb_build_object('entry',to_jsonb(je),'lines',COALESCE((SELECT jsonb_agg(to_jsonb(jl) ORDER BY line_number) FROM accounting.journal_lines jl WHERE jl.organization_id=je.organization_id AND jl.journal_entry_id=je.id),'[]'::jsonb))::text,'sha256'),'hex')
 FROM accounting.journal_entries je WHERE je.organization_id=app.require_organization_id() AND je.id=p_id;
$$;

ALTER TABLE reporting.account_report_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk.organization_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk.pre_posting_assessments ENABLE ROW LEVEL SECURITY;
CREATE POLICY reporting_tenant ON reporting.account_report_mappings USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY risk_policy_tenant ON risk.organization_policies USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY risk_assessment_tenant ON risk.pre_posting_assessments USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());

INSERT INTO app.permissions(code,module,description) VALUES ('reporting.financial.read','reporting','Read financial statements'),('risk.read','risk','Read risk assessments'),('risk.configure','risk','Configure risk policies') ON CONFLICT DO NOTHING;

COMMIT;
