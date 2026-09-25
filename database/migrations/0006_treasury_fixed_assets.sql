BEGIN;

CREATE TABLE treasury.reconciliation_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  statement_line_id uuid NOT NULL,
  journal_line_id uuid NOT NULL REFERENCES accounting.journal_lines(id) ON DELETE RESTRICT,
  matched_amount numeric(38,8) NOT NULL CHECK (matched_amount > 0),
  match_method varchar(30) NOT NULL DEFAULT 'manual'
    CHECK (match_method IN ('manual','auto_exact')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL DEFAULT app.require_user_id(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, statement_line_id, journal_line_id),
  FOREIGN KEY (organization_id, statement_line_id)
    REFERENCES treasury.bank_statement_lines(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX treasury_match_statement_idx
  ON treasury.reconciliation_matches(organization_id, statement_line_id);

CREATE INDEX treasury_match_journal_idx
  ON treasury.reconciliation_matches(organization_id, journal_line_id);

ALTER TABLE treasury.reconciliation_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY treasury_reconciliation_tenant
ON treasury.reconciliation_matches
USING (organization_id = app.current_organization_id())
WITH CHECK (organization_id = app.current_organization_id());

CREATE OR REPLACE VIEW treasury.unreconciled_statement_lines
WITH (security_invoker=true) AS
SELECT
  sl.organization_id,
  s.bank_account_id,
  sl.statement_id,
  sl.id AS statement_line_id,
  sl.line_number,
  sl.transaction_date,
  sl.amount,
  sl.description,
  sl.bank_reference,
  COALESCE(sum(rm.matched_amount),0)::numeric(38,8) AS matched_amount,
  greatest(abs(sl.amount)-COALESCE(sum(rm.matched_amount),0),0)::numeric(38,8) AS remaining_amount
FROM treasury.bank_statement_lines sl
JOIN treasury.bank_statements s
  ON s.organization_id=sl.organization_id
 AND s.id=sl.statement_id
LEFT JOIN treasury.reconciliation_matches rm
  ON rm.organization_id=sl.organization_id
 AND rm.statement_line_id=sl.id
GROUP BY
  sl.organization_id,s.bank_account_id,sl.statement_id,sl.id,sl.line_number,
  sl.transaction_date,sl.amount,sl.description,sl.bank_reference
HAVING greatest(abs(sl.amount)-COALESCE(sum(rm.matched_amount),0),0) > 0;

CREATE OR REPLACE VIEW treasury.unreconciled_gl_bank_lines
WITH (security_invoker=true) AS
SELECT
  b.organization_id,
  b.id AS bank_account_id,
  jl.id AS journal_line_id,
  je.id AS journal_entry_id,
  je.entry_date,
  je.currency_code,
  (jl.debit-jl.credit)::numeric(38,8) AS statement_currency_effect,
  abs(jl.debit-jl.credit)::numeric(38,8) AS absolute_amount,
  COALESCE(sum(rm.matched_amount),0)::numeric(38,8) AS matched_amount,
  greatest(abs(jl.debit-jl.credit)-COALESCE(sum(rm.matched_amount),0),0)::numeric(38,8) AS remaining_amount,
  je.reference_type,
  je.reference_id,
  jl.description
FROM treasury.bank_accounts b
JOIN accounting.journal_lines jl
  ON jl.organization_id=b.organization_id
 AND jl.account_id=b.gl_account_id
JOIN accounting.journal_entries je
  ON je.organization_id=jl.organization_id
 AND je.id=jl.journal_entry_id
 AND je.status IN ('posted','reversed')
LEFT JOIN treasury.reconciliation_matches rm
  ON rm.organization_id=jl.organization_id
 AND rm.journal_line_id=jl.id
WHERE je.currency_code=b.currency_code
GROUP BY
  b.organization_id,b.id,jl.id,je.id,je.entry_date,je.currency_code,
  jl.debit,jl.credit,je.reference_type,je.reference_id,jl.description
HAVING greatest(abs(jl.debit-jl.credit)-COALESCE(sum(rm.matched_amount),0),0) > 0;

CREATE OR REPLACE FUNCTION treasury.validate_reconciliation_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_statement_amount numeric(38,8);
  v_bank_account uuid;
  v_bank_gl_account uuid;
  v_bank_currency varchar(3);
  v_journal_account uuid;
  v_journal_currency varchar(3);
  v_journal_effect numeric(38,8);
  v_statement_matched numeric(38,8);
  v_journal_matched numeric(38,8);
BEGIN
  SELECT sl.amount,s.bank_account_id
  INTO v_statement_amount,v_bank_account
  FROM treasury.bank_statement_lines sl
  JOIN treasury.bank_statements s
    ON s.organization_id=sl.organization_id
   AND s.id=sl.statement_id
  WHERE sl.organization_id=NEW.organization_id
    AND sl.id=NEW.statement_line_id;

  SELECT gl_account_id,currency_code
  INTO v_bank_gl_account,v_bank_currency
  FROM treasury.bank_accounts
  WHERE organization_id=NEW.organization_id
    AND id=v_bank_account;

  SELECT jl.account_id,je.currency_code,jl.debit-jl.credit
  INTO v_journal_account,v_journal_currency,v_journal_effect
  FROM accounting.journal_lines jl
  JOIN accounting.journal_entries je
    ON je.organization_id=jl.organization_id
   AND je.id=jl.journal_entry_id
  WHERE jl.organization_id=NEW.organization_id
    AND jl.id=NEW.journal_line_id
    AND je.status IN ('posted','reversed');

  IF v_statement_amount IS NULL OR v_journal_account IS NULL THEN
    RAISE EXCEPTION 'RECONCILIATION_REFERENCE_NOT_FOUND';
  END IF;

  IF v_journal_account <> v_bank_gl_account THEN
    RAISE EXCEPTION 'JOURNAL_LINE_NOT_BANK_ACCOUNT';
  END IF;

  IF v_journal_currency <> v_bank_currency THEN
    RAISE EXCEPTION 'BANK_CURRENCY_MISMATCH';
  END IF;

  IF sign(v_statement_amount) <> sign(v_journal_effect) THEN
    RAISE EXCEPTION 'RECONCILIATION_DIRECTION_MISMATCH';
  END IF;

  SELECT COALESCE(sum(matched_amount),0)
  INTO v_statement_matched
  FROM treasury.reconciliation_matches
  WHERE organization_id=NEW.organization_id
    AND statement_line_id=NEW.statement_line_id
    AND id<>NEW.id;

  SELECT COALESCE(sum(matched_amount),0)
  INTO v_journal_matched
  FROM treasury.reconciliation_matches
  WHERE organization_id=NEW.organization_id
    AND journal_line_id=NEW.journal_line_id
    AND id<>NEW.id;

  IF v_statement_matched + NEW.matched_amount > abs(v_statement_amount) + 0.00000001 THEN
    RAISE EXCEPTION 'STATEMENT_LINE_OVERMATCHED';
  END IF;

  IF v_journal_matched + NEW.matched_amount > abs(v_journal_effect) + 0.00000001 THEN
    RAISE EXCEPTION 'JOURNAL_LINE_OVERMATCHED';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER reconciliation_match_guard
BEFORE INSERT OR UPDATE ON treasury.reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION treasury.validate_reconciliation_match();

CREATE OR REPLACE FUNCTION treasury.auto_match_statement(
  p_statement_id uuid,
  p_window_days integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_bank_account uuid;
  v_bank_gl_account uuid;
  v_currency varchar(3);
  v_line record;
  v_candidate uuid;
  v_count integer;
  v_matched integer := 0;
BEGIN
  PERFORM app.assert_permission('treasury.reconcile',v_org);

  IF p_window_days < 0 OR p_window_days > 30 THEN
    RAISE EXCEPTION 'INVALID_MATCH_WINDOW';
  END IF;

  SELECT s.bank_account_id,b.gl_account_id,b.currency_code
  INTO v_bank_account,v_bank_gl_account,v_currency
  FROM treasury.bank_statements s
  JOIN treasury.bank_accounts b
    ON b.organization_id=s.organization_id
   AND b.id=s.bank_account_id
  WHERE s.organization_id=v_org
    AND s.id=p_statement_id
  FOR UPDATE OF s;

  IF v_bank_account IS NULL THEN
    RAISE EXCEPTION 'BANK_STATEMENT_NOT_FOUND';
  END IF;

  FOR v_line IN
    SELECT *
    FROM treasury.unreconciled_statement_lines
    WHERE organization_id=v_org
      AND statement_id=p_statement_id
    ORDER BY transaction_date,line_number
  LOOP
    SELECT count(*),min(journal_line_id)
    INTO v_count,v_candidate
    FROM treasury.unreconciled_gl_bank_lines gl
    WHERE gl.organization_id=v_org
      AND gl.bank_account_id=v_bank_account
      AND gl.currency_code=v_currency
      AND gl.statement_currency_effect=v_line.amount
      AND gl.remaining_amount=abs(v_line.amount)
      AND abs(gl.entry_date-v_line.transaction_date) <= p_window_days;

    IF v_count=1 THEN
      INSERT INTO treasury.reconciliation_matches(
        organization_id,statement_line_id,journal_line_id,matched_amount,match_method
      ) VALUES(
        v_org,v_line.statement_line_id,v_candidate,abs(v_line.amount),'auto_exact'
      );
      v_matched := v_matched + 1;
    END IF;
  END LOOP;

  RETURN v_matched;
END
$$;

CREATE OR REPLACE FUNCTION treasury.finalize_bank_statement(
  p_statement_id uuid,
  p_tolerance numeric DEFAULT 0.00000001
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_opening numeric(38,8);
  v_closing numeric(38,8);
  v_movement numeric(38,8);
  v_unmatched integer;
BEGIN
  PERFORM app.assert_permission('treasury.reconcile',v_org);

  SELECT opening_balance,closing_balance
  INTO v_opening,v_closing
  FROM treasury.bank_statements
  WHERE organization_id=v_org
    AND id=p_statement_id
  FOR UPDATE;

  IF v_opening IS NULL THEN
    RAISE EXCEPTION 'BANK_STATEMENT_NOT_FOUND';
  END IF;

  SELECT COALESCE(sum(amount),0)
  INTO v_movement
  FROM treasury.bank_statement_lines
  WHERE organization_id=v_org
    AND statement_id=p_statement_id;

  IF abs((v_opening+v_movement)-v_closing) > p_tolerance THEN
    RAISE EXCEPTION 'BANK_STATEMENT_BALANCE_INVALID';
  END IF;

  SELECT count(*)
  INTO v_unmatched
  FROM treasury.unreconciled_statement_lines
  WHERE organization_id=v_org
    AND statement_id=p_statement_id
    AND remaining_amount > p_tolerance;

  IF v_unmatched>0 THEN
    RAISE EXCEPTION 'BANK_STATEMENT_HAS_UNMATCHED_LINES';
  END IF;

  UPDATE treasury.bank_statements
  SET status='reconciled'
  WHERE organization_id=v_org
    AND id=p_statement_id;
END
$$;

CREATE TABLE fixed_assets.depreciation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','posted','reversed')),
  journal_entry_id uuid,
  total_amount_base numeric(38,8) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL DEFAULT app.require_user_id(),
  posted_at timestamptz,
  posted_by uuid,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,period_end),
  FOREIGN KEY (organization_id,journal_entry_id)
    REFERENCES accounting.journal_entries(organization_id,id)
);

CREATE TABLE fixed_assets.depreciation_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  amount_base numeric(38,8) NOT NULL CHECK (amount_base>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,run_id,asset_id),
  FOREIGN KEY (organization_id,run_id)
    REFERENCES fixed_assets.depreciation_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,asset_id)
    REFERENCES fixed_assets.assets(organization_id,id) ON DELETE RESTRICT
);

ALTER TABLE fixed_assets.depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets.depreciation_run_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY depreciation_runs_tenant
ON fixed_assets.depreciation_runs
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE POLICY depreciation_lines_tenant
ON fixed_assets.depreciation_run_lines
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE OR REPLACE FUNCTION fixed_assets.generate_monthly_depreciation(
  p_any_date_in_month date
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_start date := date_trunc('month',p_any_date_in_month)::date;
  v_end date := (date_trunc('month',p_any_date_in_month)+interval '1 month - 1 day')::date;
  v_run uuid;
BEGIN
  PERFORM app.assert_permission('fixed_assets.manage',v_org);

  INSERT INTO fixed_assets.depreciation_runs(
    organization_id,period_start,period_end
  ) VALUES(v_org,v_start,v_end)
  RETURNING id INTO v_run;

  INSERT INTO fixed_assets.depreciation_run_lines(
    organization_id,run_id,asset_id,amount_base
  )
  SELECT
    a.organization_id,
    v_run,
    a.id,
    least(
      round((a.cost_base-a.salvage_value_base)/c.useful_life_months,8),
      round((a.cost_base-a.salvage_value_base)-a.accumulated_depreciation_base,8)
    )
  FROM fixed_assets.assets a
  JOIN fixed_assets.asset_classes c
    ON c.organization_id=a.organization_id
   AND c.id=a.asset_class_id
  WHERE a.organization_id=v_org
    AND a.status='active'
    AND a.in_service_date<=v_end
    AND (a.cost_base-a.salvage_value_base)-a.accumulated_depreciation_base > 0
    AND NOT EXISTS(
      SELECT 1
      FROM fixed_assets.depreciation_run_lines dl
      JOIN fixed_assets.depreciation_runs dr
        ON dr.organization_id=dl.organization_id
       AND dr.id=dl.run_id
      WHERE dl.organization_id=a.organization_id
        AND dl.asset_id=a.id
        AND dr.period_end=v_end
        AND dr.status IN ('draft','posted')
    );

  UPDATE fixed_assets.depreciation_runs r
  SET total_amount_base=COALESCE((
    SELECT sum(amount_base)
    FROM fixed_assets.depreciation_run_lines
    WHERE organization_id=v_org AND run_id=v_run
  ),0)
  WHERE r.organization_id=v_org
    AND r.id=v_run;

  RETURN v_run;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'DEPRECIATION_RUN_ALREADY_EXISTS_FOR_PERIOD';
END
$$;

CREATE OR REPLACE FUNCTION fixed_assets.post_depreciation_run(
  p_run_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_run fixed_assets.depreciation_runs%ROWTYPE;
  v_currency varchar(3);
  v_journal uuid;
  v_line_no integer := 0;
  v_line record;
  v_new_accum numeric(38,8);
  v_basis numeric(38,8);
BEGIN
  PERFORM app.assert_permission('fixed_assets.manage',v_org);

  SELECT *
  INTO v_run
  FROM fixed_assets.depreciation_runs
  WHERE organization_id=v_org
    AND id=p_run_id
  FOR UPDATE;

  IF NOT FOUND OR v_run.status<>'draft' THEN
    RAISE EXCEPTION 'DRAFT_DEPRECIATION_RUN_NOT_FOUND';
  END IF;

  IF v_run.total_amount_base=0 THEN
    UPDATE fixed_assets.depreciation_runs
    SET status='posted',posted_at=clock_timestamp(),posted_by=app.require_user_id()
    WHERE organization_id=v_org AND id=p_run_id;
    RETURN NULL;
  END IF;

  SELECT base_currency_code
  INTO v_currency
  FROM app.organizations
  WHERE id=v_org;

  INSERT INTO accounting.journal_entries(
    organization_id,entry_date,document_date,source,reference_type,reference_id,
    description,currency_code,exchange_rate
  ) VALUES(
    v_org,v_run.period_end,v_run.period_end,'fixed_asset_depreciation',
    'depreciation_run',v_run.id::text,
    'Monthly fixed asset depreciation',v_currency,1
  )
  RETURNING id INTO v_journal;

  FOR v_line IN
    SELECT
      dl.asset_id,
      dl.amount_base,
      a.code AS asset_code,
      a.cost_base,
      a.salvage_value_base,
      a.accumulated_depreciation_base,
      c.depreciation_expense_account_id,
      c.accumulated_depreciation_account_id
    FROM fixed_assets.depreciation_run_lines dl
    JOIN fixed_assets.assets a
      ON a.organization_id=dl.organization_id
     AND a.id=dl.asset_id
    JOIN fixed_assets.asset_classes c
      ON c.organization_id=a.organization_id
     AND c.id=a.asset_class_id
    WHERE dl.organization_id=v_org
      AND dl.run_id=p_run_id
    ORDER BY a.asset_number
  LOOP
    v_line_no := v_line_no + 1;
    INSERT INTO accounting.journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,
      debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
    ) VALUES(
      v_org,v_journal,v_line_no,v_line.depreciation_expense_account_id,
      'Depreciation - '||v_line.asset_code,
      v_line.amount_base,0,v_currency,1,v_line.amount_base,0,v_line.asset_id::text
    );

    v_line_no := v_line_no + 1;
    INSERT INTO accounting.journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,
      debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
    ) VALUES(
      v_org,v_journal,v_line_no,v_line.accumulated_depreciation_account_id,
      'Accumulated depreciation - '||v_line.asset_code,
      0,v_line.amount_base,v_currency,1,0,v_line.amount_base,v_line.asset_id::text
    );

    v_basis := v_line.cost_base-v_line.salvage_value_base;
    v_new_accum := least(v_basis,v_line.accumulated_depreciation_base+v_line.amount_base);

    UPDATE fixed_assets.assets
    SET
      accumulated_depreciation_base=v_new_accum,
      net_book_value_base=cost_base-v_new_accum,
      status=CASE
        WHEN v_new_accum>=v_basis THEN 'fully_depreciated'::fixed_assets.asset_status
        ELSE status
      END
    WHERE organization_id=v_org
      AND id=v_line.asset_id;
  END LOOP;

  PERFORM accounting.post_journal_entry(v_journal);

  UPDATE fixed_assets.depreciation_runs
  SET
    status='posted',
    journal_entry_id=v_journal,
    posted_at=clock_timestamp(),
    posted_by=app.require_user_id()
  WHERE organization_id=v_org
    AND id=p_run_id;

  RETURN v_journal;
END
$$;

COMMIT;
