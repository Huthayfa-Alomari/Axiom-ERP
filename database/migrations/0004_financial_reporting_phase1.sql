BEGIN;

-- Phase 1 Financial Reporting Engine.
-- All reports are derived from the immutable accounting.general_ledger view.
-- No balances are persisted here.

DO $$ BEGIN
  CREATE TYPE reporting.indirect_cf_role AS ENUM ('none','pnl_reversal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE reporting.working_capital_role AS ENUM ('none','operating_asset','operating_liability');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE reporting.account_report_mappings
  ADD COLUMN IF NOT EXISTS pnl_line_label varchar(160),
  ADD COLUMN IF NOT EXISTS balance_sheet_line_label varchar(160),
  ADD COLUMN IF NOT EXISTS indirect_cf_role reporting.indirect_cf_role NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS working_capital_role reporting.working_capital_role NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS journal_entries_reporting_idx
  ON accounting.journal_entries(organization_id, entry_date, status, id);

CREATE INDEX IF NOT EXISTS journal_lines_reporting_account_idx
  ON accounting.journal_lines(organization_id, account_id, journal_entry_id);

CREATE INDEX IF NOT EXISTS report_mappings_cash_idx
  ON reporting.account_report_mappings(organization_id, account_id)
  WHERE is_cash_equivalent;

DROP FUNCTION IF EXISTS reporting.get_profit_and_loss(date,date);
CREATE FUNCTION reporting.get_profit_and_loss(p_start date,p_end date)
RETURNS TABLE(
  account_id uuid,
  account_code varchar,
  account_name varchar,
  account_type accounting.account_type,
  pnl_section reporting.pnl_section,
  line_label varchar,
  sort_order int,
  amount numeric(18,4),
  section_total numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH lines AS (
    SELECT
      fl.account_id,
      fl.account_code,
      fl.account_name,
      fl.account_type,
      COALESCE(
        m.pnl_section,
        CASE
          WHEN fl.account_type='revenue' THEN 'revenue'::reporting.pnl_section
          ELSE 'operating_expense'::reporting.pnl_section
        END
      ) AS pnl_section,
      COALESCE(m.pnl_line_label, fl.account_name)::varchar AS line_label,
      COALESCE(m.sort_order,1000) AS sort_order,
      round(sum(fl.base_credit-fl.base_debit),4)::numeric(18,4) AS amount
    FROM reporting.financial_ledger fl
    LEFT JOIN reporting.account_report_mappings m
      ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date BETWEEN p_start AND p_end
      AND fl.account_type IN ('revenue','expense')
    GROUP BY
      fl.account_id,fl.account_code,fl.account_name,fl.account_type,
      m.pnl_section,m.pnl_line_label,m.sort_order
  ),
  totals AS (
    SELECT pnl_section,round(sum(amount),4)::numeric(18,4) AS section_total
    FROM lines GROUP BY pnl_section
  )
  SELECT l.account_id,l.account_code,l.account_name,l.account_type,l.pnl_section,l.line_label,l.sort_order,l.amount,t.section_total
  FROM lines l
  JOIN totals t USING (pnl_section)
  WHERE l.amount<>0
  ORDER BY l.sort_order,l.account_code;
$$;

CREATE OR REPLACE FUNCTION reporting.get_profit_and_loss_summary(p_start date,p_end date)
RETURNS TABLE(
  revenue numeric(18,4),
  cost_of_sales numeric(18,4),
  gross_profit numeric(18,4),
  operating_expense numeric(18,4),
  operating_profit numeric(18,4),
  other_income numeric(18,4),
  other_expense numeric(18,4),
  profit_before_tax numeric(18,4),
  income_tax numeric(18,4),
  net_profit numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH s AS (
    SELECT pnl_section,round(sum(amount),4)::numeric(18,4) amount
    FROM reporting.get_profit_and_loss(p_start,p_end)
    GROUP BY pnl_section
  ),
  v AS (
    SELECT
      COALESCE((SELECT amount FROM s WHERE pnl_section='revenue'),0)::numeric(18,4) revenue,
      COALESCE((SELECT amount FROM s WHERE pnl_section='cost_of_sales'),0)::numeric(18,4) cost_of_sales,
      COALESCE((SELECT amount FROM s WHERE pnl_section='operating_expense'),0)::numeric(18,4) operating_expense,
      COALESCE((SELECT amount FROM s WHERE pnl_section='other_income'),0)::numeric(18,4) other_income,
      COALESCE((SELECT amount FROM s WHERE pnl_section='other_expense'),0)::numeric(18,4) other_expense,
      COALESCE((SELECT amount FROM s WHERE pnl_section='income_tax'),0)::numeric(18,4) income_tax
  )
  SELECT
    revenue,
    cost_of_sales,
    round(revenue+cost_of_sales,4)::numeric(18,4) gross_profit,
    operating_expense,
    round(revenue+cost_of_sales+operating_expense,4)::numeric(18,4) operating_profit,
    other_income,
    other_expense,
    round(revenue+cost_of_sales+operating_expense+other_income+other_expense,4)::numeric(18,4) profit_before_tax,
    income_tax,
    round(revenue+cost_of_sales+operating_expense+other_income+other_expense+income_tax,4)::numeric(18,4) net_profit
  FROM v;
$$;

DROP FUNCTION IF EXISTS reporting.get_balance_sheet(date);
CREATE FUNCTION reporting.get_balance_sheet(p_as_of date)
RETURNS TABLE(
  item_type varchar,
  account_id uuid,
  account_code varchar,
  account_name varchar,
  account_type accounting.account_type,
  balance_sheet_section reporting.balance_sheet_section,
  line_label varchar,
  sort_order int,
  amount numeric(18,4),
  section_total numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH account_lines AS (
    SELECT
      'account'::varchar AS item_type,
      fl.account_id,
      fl.account_code,
      fl.account_name,
      fl.account_type,
      COALESCE(
        m.balance_sheet_section,
        CASE
          WHEN fl.account_type='asset' THEN 'other_current_assets'::reporting.balance_sheet_section
          WHEN fl.account_type='liability' THEN 'other_current_liabilities'::reporting.balance_sheet_section
          ELSE 'equity'::reporting.balance_sheet_section
        END
      ) AS balance_sheet_section,
      COALESCE(m.balance_sheet_line_label, fl.account_name)::varchar AS line_label,
      COALESCE(m.sort_order,1000) AS sort_order,
      round(sum(
        CASE WHEN fl.account_type='asset'
          THEN fl.base_debit-fl.base_credit
          ELSE fl.base_credit-fl.base_debit
        END
      ),4)::numeric(18,4) AS amount
    FROM reporting.financial_ledger fl
    LEFT JOIN reporting.account_report_mappings m
      ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date<=p_as_of
      AND fl.account_type IN ('asset','liability','equity')
    GROUP BY
      fl.account_id,fl.account_code,fl.account_name,fl.account_type,
      m.balance_sheet_section,m.balance_sheet_line_label,m.sort_order
  ),
  earnings AS (
    SELECT
      'current_earnings'::varchar AS item_type,
      NULL::uuid AS account_id,
      'CURRENT_EARNINGS'::varchar AS account_code,
      'Current / Unclosed Earnings'::varchar AS account_name,
      'equity'::accounting.account_type AS account_type,
      'equity'::reporting.balance_sheet_section AS balance_sheet_section,
      'Current / Unclosed Earnings'::varchar AS line_label,
      999999::int AS sort_order,
      round(COALESCE(sum(fl.base_credit-fl.base_debit),0),4)::numeric(18,4) AS amount
    FROM reporting.financial_ledger fl
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date<=p_as_of
      AND fl.account_type IN ('revenue','expense')
  ),
  all_lines AS (
    SELECT * FROM account_lines
    UNION ALL
    SELECT * FROM earnings
  ),
  nonzero AS (
    SELECT * FROM all_lines WHERE amount<>0
  ),
  totals AS (
    SELECT balance_sheet_section,round(sum(amount),4)::numeric(18,4) section_total
    FROM nonzero GROUP BY balance_sheet_section
  )
  SELECT
    n.item_type,n.account_id,n.account_code,n.account_name,n.account_type,
    n.balance_sheet_section,n.line_label,n.sort_order,n.amount,t.section_total
  FROM nonzero n JOIN totals t USING(balance_sheet_section)
  ORDER BY n.sort_order,n.account_code;
$$;

CREATE OR REPLACE FUNCTION reporting.get_balance_sheet_summary(p_as_of date)
RETURNS TABLE(
  assets numeric(18,4),
  liabilities numeric(18,4),
  equity numeric(18,4),
  liabilities_and_equity numeric(18,4),
  difference numeric(18,4),
  balanced boolean
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH r AS (SELECT * FROM reporting.get_balance_sheet(p_as_of)),
  s AS (
    SELECT
      round(COALESCE(sum(amount) FILTER(WHERE account_type='asset'),0),4)::numeric(18,4) assets,
      round(COALESCE(sum(amount) FILTER(WHERE account_type='liability'),0),4)::numeric(18,4) liabilities,
      round(COALESCE(sum(amount) FILTER(WHERE account_type='equity'),0),4)::numeric(18,4) equity
    FROM r
  )
  SELECT
    assets,liabilities,equity,
    round(liabilities+equity,4)::numeric(18,4) liabilities_and_equity,
    round(assets-liabilities-equity,4)::numeric(18,4) difference,
    abs(assets-liabilities-equity)<=0.0001 balanced
  FROM s;
$$;

CREATE OR REPLACE FUNCTION reporting.assert_balance_sheet(p_as_of date,p_tolerance numeric DEFAULT 0.0001)
RETURNS void LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE v_difference numeric;
BEGIN
  SELECT difference INTO v_difference FROM reporting.get_balance_sheet_summary(p_as_of);
  IF abs(COALESCE(v_difference,0))>p_tolerance THEN
    RAISE EXCEPTION 'BALANCE_SHEET_OUT_OF_BALANCE:%',v_difference;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reporting.get_cash_balance(p_as_of date)
RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT round(COALESCE(sum(fl.base_debit-fl.base_credit),0),4)::numeric(18,4)
  FROM reporting.financial_ledger fl
  JOIN reporting.account_report_mappings m
    ON m.organization_id=fl.organization_id
   AND m.account_id=fl.account_id
   AND m.is_cash_equivalent
  WHERE fl.organization_id=app.require_organization_id()
    AND fl.entry_date<=p_as_of;
$$;

DROP FUNCTION IF EXISTS reporting.get_cash_flow_direct(date,date);
CREATE FUNCTION reporting.get_cash_flow_direct(p_start date,p_end date)
RETURNS TABLE(
  item_type varchar,
  account_id uuid,
  cash_flow_section varchar,
  cash_flow_item varchar,
  sort_order int,
  amount numeric(18,4),
  section_total numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH cash_entries AS (
    SELECT DISTINCT fl.journal_entry_id
    FROM reporting.financial_ledger fl
    JOIN reporting.account_report_mappings m
      ON m.organization_id=fl.organization_id
     AND m.account_id=fl.account_id
     AND m.is_cash_equivalent
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date BETWEEN p_start AND p_end
  ),
  counterpart AS (
    SELECT
      fl.account_id,
      COALESCE(m.cash_flow_section::varchar,'unclassified') AS cash_flow_section,
      COALESCE(m.cash_flow_item,fl.account_name)::varchar AS cash_flow_item,
      COALESCE(m.sort_order,999999) AS sort_order,
      fl.base_credit-fl.base_debit AS cash_effect
    FROM reporting.financial_ledger fl
    JOIN cash_entries ce ON ce.journal_entry_id=fl.journal_entry_id
    LEFT JOIN reporting.account_report_mappings m
      ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date BETWEEN p_start AND p_end
      AND COALESCE(m.is_cash_equivalent,false)=false
  ),
  lines AS (
    SELECT
      'account'::varchar item_type,
      account_id,
      cash_flow_section,cash_flow_item,min(sort_order)::int AS sort_order,
      round(sum(cash_effect),4)::numeric(18,4) AS amount
    FROM counterpart
    GROUP BY account_id,cash_flow_section,cash_flow_item
    HAVING round(sum(cash_effect),4)<>0
  ),
  totals AS (
    SELECT cash_flow_section,round(sum(amount),4)::numeric(18,4) section_total
    FROM lines GROUP BY cash_flow_section
  )
  SELECT l.item_type,l.account_id,l.cash_flow_section,l.cash_flow_item,l.sort_order,l.amount,t.section_total
  FROM lines l JOIN totals t USING(cash_flow_section)
  ORDER BY CASE l.cash_flow_section WHEN 'operating' THEN 1 WHEN 'investing' THEN 2 WHEN 'financing' THEN 3 ELSE 4 END,
           l.sort_order,l.cash_flow_item;
$$;

CREATE OR REPLACE FUNCTION reporting.get_cash_flow_indirect(p_start date,p_end date)
RETURNS TABLE(
  item_type varchar,
  account_id uuid,
  cash_flow_section varchar,
  cash_flow_item varchar,
  sort_order int,
  amount numeric(18,4),
  section_total numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH net_income AS (
    SELECT 'current_earnings'::varchar item_type,NULL::uuid account_id,
           'operating'::varchar cash_flow_section,'Net income'::varchar cash_flow_item,10::int sort_order,
           net_profit::numeric(18,4) amount
    FROM reporting.get_profit_and_loss_summary(p_start,p_end)
  ),
  pnl_accounts AS (
    SELECT
      fl.account_id,fl.account_name,
      round(sum(fl.base_credit-fl.base_debit),4)::numeric(18,4) pnl_amount,
      CASE
        WHEN COALESCE(m.indirect_cf_role,'none'::reporting.indirect_cf_role)='pnl_reversal'
          OR EXISTS (
            SELECT 1 FROM fixed_assets.asset_classes ac
            WHERE ac.organization_id=fl.organization_id
              AND ac.depreciation_expense_account_id=fl.account_id
          )
        THEN 'pnl_reversal'::reporting.indirect_cf_role
        ELSE 'none'::reporting.indirect_cf_role
      END role,
      COALESCE(m.sort_order,1100) sort_order
    FROM reporting.financial_ledger fl
    LEFT JOIN reporting.account_report_mappings m
      ON m.organization_id=fl.organization_id AND m.account_id=fl.account_id
    WHERE fl.organization_id=app.require_organization_id()
      AND fl.entry_date BETWEEN p_start AND p_end
      AND fl.account_type IN ('revenue','expense')
    GROUP BY fl.account_id,fl.account_name,fl.organization_id,m.indirect_cf_role,m.sort_order
  ),
  non_cash AS (
    SELECT 'account'::varchar item_type,account_id,
           'operating'::varchar cash_flow_section,
           ('Non-cash: '||account_name)::varchar cash_flow_item,
           sort_order::int,
           round(-pnl_amount,4)::numeric(18,4) amount
    FROM pnl_accounts
    WHERE role='pnl_reversal' AND pnl_amount<>0
  ),
  wc_roles AS (
    SELECT
      coa.id account_id,coa.name account_name,coa.account_type,
      CASE
        WHEN COALESCE(m.working_capital_role,'none'::reporting.working_capital_role)<>'none'
          THEN m.working_capital_role
        WHEN EXISTS (
          SELECT 1 FROM crm.customers c
          WHERE c.organization_id=coa.organization_id AND c.receivable_account_id=coa.id
        ) THEN 'operating_asset'::reporting.working_capital_role
        WHEN EXISTS (
          SELECT 1 FROM inventory.products p
          WHERE p.organization_id=coa.organization_id AND p.inventory_asset_account_id=coa.id
        ) THEN 'operating_asset'::reporting.working_capital_role
        WHEN EXISTS (
          SELECT 1 FROM crm.vendors v
          WHERE v.organization_id=coa.organization_id AND v.payable_account_id=coa.id
        ) THEN 'operating_liability'::reporting.working_capital_role
        ELSE 'none'::reporting.working_capital_role
      END role,
      COALESCE(m.sort_order,2100) sort_order
    FROM accounting.chart_of_accounts coa
    LEFT JOIN reporting.account_report_mappings m
      ON m.organization_id=coa.organization_id AND m.account_id=coa.id
    WHERE coa.organization_id=app.require_organization_id()
      AND coa.account_type IN ('asset','liability')
      AND COALESCE(m.is_cash_equivalent,false)=false
  ),
  wc_balances AS (
    SELECT
      r.account_id,r.account_name,r.role,r.sort_order,
      round(COALESCE(sum(
        CASE WHEN fl.entry_date < p_start THEN
          CASE WHEN r.account_type='asset' THEN fl.base_debit-fl.base_credit ELSE fl.base_credit-fl.base_debit END
        ELSE 0 END
      ),0),4)::numeric(18,4) opening_balance,
      round(COALESCE(sum(
        CASE WHEN fl.entry_date <= p_end THEN
          CASE WHEN r.account_type='asset' THEN fl.base_debit-fl.base_credit ELSE fl.base_credit-fl.base_debit END
        ELSE 0 END
      ),0),4)::numeric(18,4) closing_balance
    FROM wc_roles r
    LEFT JOIN reporting.financial_ledger fl
      ON fl.organization_id=app.require_organization_id()
     AND fl.account_id=r.account_id
     AND fl.entry_date<=p_end
    WHERE r.role<>'none'
    GROUP BY r.account_id,r.account_name,r.account_type,r.role,r.sort_order
  ),
  working_capital AS (
    SELECT
      'account'::varchar item_type,account_id,
      'operating'::varchar cash_flow_section,
      ('Change in '||account_name)::varchar cash_flow_item,
      sort_order::int,
      round(CASE role
        WHEN 'operating_asset' THEN opening_balance-closing_balance
        ELSE closing_balance-opening_balance END,4)::numeric(18,4) amount
    FROM wc_balances
    WHERE round(CASE role
      WHEN 'operating_asset' THEN opening_balance-closing_balance
      ELSE closing_balance-opening_balance END,4)<>0
  ),
  non_operating AS (
    SELECT item_type,account_id,cash_flow_section,cash_flow_item,sort_order,amount
    FROM reporting.get_cash_flow_direct(p_start,p_end)
    WHERE cash_flow_section IN ('investing','financing')
  ),
  core_rows AS (
    SELECT * FROM net_income
    UNION ALL SELECT * FROM non_cash
    UNION ALL SELECT * FROM working_capital
    UNION ALL SELECT * FROM non_operating
  ),
  calc AS (
    SELECT round(COALESCE(sum(amount),0),4)::numeric(18,4) reported_change FROM core_rows
  ),
  actual AS (
    SELECT round(reporting.get_cash_balance(p_end)-reporting.get_cash_balance(p_start-1),4)::numeric(18,4) actual_change
  ),
  reconciler AS (
    SELECT
      'reconciliation'::varchar item_type,NULL::uuid account_id,
      'unclassified'::varchar cash_flow_section,
      'Unclassified / reconciliation difference'::varchar cash_flow_item,
      999999::int sort_order,
      round(actual.actual_change-calc.reported_change,4)::numeric(18,4) amount
    FROM actual,calc
    WHERE round(actual.actual_change-calc.reported_change,4)<>0
  ),
  all_rows AS (
    SELECT * FROM core_rows
    UNION ALL SELECT * FROM reconciler
  ),
  totals AS (
    SELECT cash_flow_section,round(sum(amount),4)::numeric(18,4) section_total
    FROM all_rows GROUP BY cash_flow_section
  )
  SELECT a.item_type,a.account_id,a.cash_flow_section,a.cash_flow_item,a.sort_order,a.amount,t.section_total
  FROM all_rows a JOIN totals t USING(cash_flow_section)
  WHERE a.amount<>0
  ORDER BY CASE a.cash_flow_section WHEN 'operating' THEN 1 WHEN 'investing' THEN 2 WHEN 'financing' THEN 3 ELSE 4 END,
           a.sort_order,a.cash_flow_item;
$$;

CREATE OR REPLACE FUNCTION reporting.get_cash_flow_reconciliation(p_start date,p_end date,p_method varchar)
RETURNS TABLE(
  opening_cash numeric(18,4),
  closing_cash numeric(18,4),
  actual_net_change numeric(18,4),
  reported_net_change numeric(18,4),
  difference numeric(18,4),
  reconciled boolean
)
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE v_reported numeric;
BEGIN
  IF p_method NOT IN ('direct','indirect') THEN
    RAISE EXCEPTION 'INVALID_CASH_FLOW_METHOD:%',p_method;
  END IF;
  IF p_method='direct' THEN
    SELECT COALESCE(sum(amount),0) INTO v_reported FROM reporting.get_cash_flow_direct(p_start,p_end);
  ELSE
    SELECT COALESCE(sum(amount),0) INTO v_reported FROM reporting.get_cash_flow_indirect(p_start,p_end);
  END IF;
  RETURN QUERY
  WITH v AS (
    SELECT reporting.get_cash_balance(p_start-1)::numeric(18,4) opening_cash,
           reporting.get_cash_balance(p_end)::numeric(18,4) closing_cash
  )
  SELECT
    v.opening_cash,v.closing_cash,
    round(v.closing_cash-v.opening_cash,4)::numeric(18,4),
    round(v_reported,4)::numeric(18,4),
    round((v.closing_cash-v.opening_cash)-v_reported,4)::numeric(18,4),
    abs((v.closing_cash-v.opening_cash)-v_reported)<=0.0001
  FROM v;
END $$;

CREATE OR REPLACE FUNCTION reporting.get_trial_balance(p_start date,p_end date)
RETURNS TABLE(
  account_id uuid,
  account_code varchar,
  account_name varchar,
  account_type accounting.account_type,
  opening_debit numeric(18,4),
  opening_credit numeric(18,4),
  period_debit numeric(18,4),
  period_credit numeric(18,4),
  closing_debit numeric(18,4),
  closing_credit numeric(18,4)
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH b AS (
    SELECT
      coa.id account_id,coa.code account_code,coa.name account_name,coa.account_type,
      round(COALESCE(sum(CASE WHEN gl.entry_date<p_start THEN gl.base_debit-gl.base_credit ELSE 0 END),0),4) opening_raw,
      round(COALESCE(sum(CASE WHEN gl.entry_date BETWEEN p_start AND p_end THEN gl.base_debit ELSE 0 END),0),4) period_debit,
      round(COALESCE(sum(CASE WHEN gl.entry_date BETWEEN p_start AND p_end THEN gl.base_credit ELSE 0 END),0),4) period_credit
    FROM accounting.chart_of_accounts coa
    LEFT JOIN accounting.general_ledger gl
      ON gl.organization_id=coa.organization_id AND gl.account_id=coa.id AND gl.entry_date<=p_end
    WHERE coa.organization_id=app.require_organization_id()
    GROUP BY coa.id,coa.code,coa.name,coa.account_type
  ),
  c AS (
    SELECT *,round(opening_raw+period_debit-period_credit,4) closing_raw FROM b
  )
  SELECT
    account_id,account_code,account_name,account_type,
    greatest(opening_raw,0)::numeric(18,4),
    greatest(-opening_raw,0)::numeric(18,4),
    period_debit::numeric(18,4),
    period_credit::numeric(18,4),
    greatest(closing_raw,0)::numeric(18,4),
    greatest(-closing_raw,0)::numeric(18,4)
  FROM c
  WHERE opening_raw<>0 OR period_debit<>0 OR period_credit<>0 OR closing_raw<>0
  ORDER BY account_code;
$$;

CREATE OR REPLACE FUNCTION reporting.get_trial_balance_summary(p_start date,p_end date)
RETURNS TABLE(
  period_debit numeric(18,4),
  period_credit numeric(18,4),
  closing_debit numeric(18,4),
  closing_credit numeric(18,4),
  difference numeric(18,4),
  balanced boolean
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH t AS (SELECT * FROM reporting.get_trial_balance(p_start,p_end)),
  s AS (
    SELECT
      round(COALESCE(sum(period_debit),0),4)::numeric(18,4) period_debit,
      round(COALESCE(sum(period_credit),0),4)::numeric(18,4) period_credit,
      round(COALESCE(sum(closing_debit),0),4)::numeric(18,4) closing_debit,
      round(COALESCE(sum(closing_credit),0),4)::numeric(18,4) closing_credit
    FROM t
  )
  SELECT
    period_debit,period_credit,closing_debit,closing_credit,
    round(closing_debit-closing_credit,4)::numeric(18,4) difference,
    abs(closing_debit-closing_credit)<=0.0001 balanced
  FROM s;
$$;

COMMIT;
