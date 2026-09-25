BEGIN;

CREATE TYPE payroll.component_kind AS ENUM ('earning','deduction','employer_cost');

CREATE TABLE payroll.pay_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  code varchar(64) NOT NULL,
  name varchar(160) NOT NULL,
  kind payroll.component_kind NOT NULL,
  expense_account_id uuid,
  liability_account_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid DEFAULT app.current_user_id(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,code),
  FOREIGN KEY (organization_id,expense_account_id)
    REFERENCES accounting.chart_of_accounts(organization_id,id),
  FOREIGN KEY (organization_id,liability_account_id)
    REFERENCES accounting.chart_of_accounts(organization_id,id),
  CHECK (
    (kind='earning')
    OR (kind='deduction' AND liability_account_id IS NOT NULL)
    OR (kind='employer_cost' AND expense_account_id IS NOT NULL AND liability_account_id IS NOT NULL)
  )
);

CREATE TABLE payroll.employee_component_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  component_id uuid NOT NULL,
  amount_base numeric(38,8) NOT NULL CHECK (amount_base>=0),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid DEFAULT app.current_user_id(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,employee_id,component_id,effective_from),
  FOREIGN KEY (organization_id,employee_id)
    REFERENCES hr.employees(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,component_id)
    REFERENCES payroll.pay_components(organization_id,id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to>=effective_from)
);

CREATE OR REPLACE FUNCTION payroll.prevent_component_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $
BEGIN
  IF EXISTS(
    SELECT 1
    FROM payroll.employee_component_assignments a
    WHERE a.organization_id=NEW.organization_id
      AND a.employee_id=NEW.employee_id
      AND a.component_id=NEW.component_id
      AND a.id<>NEW.id
      AND daterange(
        a.effective_from,
        COALESCE(a.effective_to,'infinity'::date),
        '[]'
      ) && daterange(
        NEW.effective_from,
        COALESCE(NEW.effective_to,'infinity'::date),
        '[]'
      )
  ) THEN
    RAISE EXCEPTION 'PAY_COMPONENT_EFFECTIVE_RANGE_OVERLAP';
  END IF;
  RETURN NEW;
END
$;

CREATE TRIGGER payroll_component_overlap_guard
BEFORE INSERT OR UPDATE ON payroll.employee_component_assignments
FOR EACH ROW EXECUTE FUNCTION payroll.prevent_component_overlap();

CREATE TABLE payroll.run_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  gross_earnings_base numeric(38,8) NOT NULL DEFAULT 0,
  deductions_base numeric(38,8) NOT NULL DEFAULT 0,
  employer_cost_base numeric(38,8) NOT NULL DEFAULT 0,
  net_pay_base numeric(38,8) NOT NULL DEFAULT 0,
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,run_id,employee_id),
  FOREIGN KEY (organization_id,run_id)
    REFERENCES payroll.payroll_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,employee_id)
    REFERENCES hr.employees(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE payroll.run_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  run_employee_id uuid NOT NULL,
  component_id uuid NOT NULL,
  component_code varchar(64) NOT NULL,
  component_name varchar(160) NOT NULL,
  kind payroll.component_kind NOT NULL,
  amount_base numeric(38,8) NOT NULL CHECK (amount_base>=0),
  expense_account_id uuid,
  liability_account_id uuid,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,run_employee_id)
    REFERENCES payroll.run_employees(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,component_id)
    REFERENCES payroll.pay_components(organization_id,id) ON DELETE RESTRICT
);

ALTER TABLE payroll.pay_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.employee_component_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.run_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll.run_components ENABLE ROW LEVEL SECURITY;

CREATE POLICY pay_components_tenant ON payroll.pay_components
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE POLICY employee_components_tenant ON payroll.employee_component_assignments
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE POLICY run_employees_tenant ON payroll.run_employees
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE POLICY run_components_tenant ON payroll.run_components
USING (organization_id=app.current_organization_id())
WITH CHECK (organization_id=app.current_organization_id());

CREATE OR REPLACE FUNCTION payroll.generate_run(p_period_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_period payroll.payroll_periods%ROWTYPE;
  v_currency varchar(3);
  v_run uuid;
  v_negative_count integer;
BEGIN
  PERFORM app.assert_permission('payroll.manage',v_org);

  SELECT *
  INTO v_period
  FROM payroll.payroll_periods
  WHERE organization_id=v_org
    AND id=p_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_NOT_FOUND';
  END IF;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_CLOSED';
  END IF;

  SELECT base_currency_code INTO v_currency
  FROM app.organizations
  WHERE id=v_org;

  INSERT INTO payroll.payroll_runs(
    organization_id,payroll_period_id,status,currency_code
  ) VALUES(v_org,p_period_id,'draft',v_currency)
  RETURNING id INTO v_run;

  INSERT INTO payroll.run_employees(
    organization_id,run_id,employee_id,
    gross_earnings_base,deductions_base,employer_cost_base,net_pay_base
  )
  SELECT
    e.organization_id,
    v_run,
    e.id,
    COALESCE(sum(a.amount_base) FILTER (WHERE c.kind='earning'),0),
    COALESCE(sum(a.amount_base) FILTER (WHERE c.kind='deduction'),0),
    COALESCE(sum(a.amount_base) FILTER (WHERE c.kind='employer_cost'),0),
    COALESCE(sum(a.amount_base) FILTER (WHERE c.kind='earning'),0)
      - COALESCE(sum(a.amount_base) FILTER (WHERE c.kind='deduction'),0)
  FROM hr.employees e
  JOIN payroll.employee_component_assignments a
    ON a.organization_id=e.organization_id
   AND a.employee_id=e.id
   AND a.effective_from<=v_period.end_date
   AND (a.effective_to IS NULL OR a.effective_to>=v_period.end_date)
  JOIN payroll.pay_components c
    ON c.organization_id=a.organization_id
   AND c.id=a.component_id
   AND c.is_active
  WHERE e.organization_id=v_org
    AND e.status='active'
    AND e.hire_date<=v_period.end_date
  GROUP BY e.organization_id,e.id;

  SELECT count(*)
  INTO v_negative_count
  FROM payroll.run_employees
  WHERE organization_id=v_org
    AND run_id=v_run
    AND net_pay_base<0;

  IF v_negative_count>0 THEN
    RAISE EXCEPTION 'PAYROLL_NET_PAY_NEGATIVE';
  END IF;

  INSERT INTO payroll.run_components(
    organization_id,run_employee_id,component_id,component_code,component_name,
    kind,amount_base,expense_account_id,liability_account_id
  )
  SELECT
    re.organization_id,
    re.id,
    c.id,
    c.code,
    c.name,
    c.kind,
    a.amount_base,
    c.expense_account_id,
    c.liability_account_id
  FROM payroll.run_employees re
  JOIN payroll.employee_component_assignments a
    ON a.organization_id=re.organization_id
   AND a.employee_id=re.employee_id
   AND a.effective_from<=v_period.end_date
   AND (a.effective_to IS NULL OR a.effective_to>=v_period.end_date)
  JOIN payroll.pay_components c
    ON c.organization_id=a.organization_id
   AND c.id=a.component_id
   AND c.is_active
  WHERE re.organization_id=v_org
    AND re.run_id=v_run;

  RETURN v_run;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'PAYROLL_RUN_ALREADY_EXISTS_FOR_PERIOD';
END
$$;

CREATE OR REPLACE FUNCTION payroll.post_run(p_run_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_run payroll.payroll_runs%ROWTYPE;
  v_period payroll.payroll_periods%ROWTYPE;
  v_currency varchar(3);
  v_journal uuid;
  v_line_no integer := 0;
  v_component record;
  v_expense_account uuid;
  v_payable_account uuid;
BEGIN
  PERFORM app.assert_permission('payroll.manage',v_org);

  SELECT *
  INTO v_run
  FROM payroll.payroll_runs
  WHERE organization_id=v_org AND id=p_run_id
  FOR UPDATE;

  IF NOT FOUND OR v_run.status<>'draft' THEN
    RAISE EXCEPTION 'DRAFT_PAYROLL_RUN_NOT_FOUND';
  END IF;

  SELECT *
  INTO v_period
  FROM payroll.payroll_periods
  WHERE organization_id=v_org AND id=v_run.payroll_period_id;

  SELECT base_currency_code INTO v_currency
  FROM app.organizations
  WHERE id=v_org;

  INSERT INTO accounting.journal_entries(
    organization_id,entry_date,document_date,source,reference_type,reference_id,
    description,currency_code,exchange_rate
  ) VALUES(
    v_org,v_period.end_date,v_period.end_date,'payroll_accrual',
    'payroll_run',v_run.id::text,
    'Payroll accrual '||v_period.code,v_currency,1
  )
  RETURNING id INTO v_journal;

  FOR v_component IN
    SELECT
      rc.*,
      re.employee_id,
      e.code AS employee_code,
      e.expense_account_id AS employee_expense_account_id,
      e.payroll_payable_account_id
    FROM payroll.run_components rc
    JOIN payroll.run_employees re
      ON re.organization_id=rc.organization_id
     AND re.id=rc.run_employee_id
    JOIN hr.employees e
      ON e.organization_id=re.organization_id
     AND e.id=re.employee_id
    WHERE rc.organization_id=v_org
      AND re.run_id=p_run_id
      AND rc.amount_base>0
    ORDER BY e.employee_number,rc.component_code
  LOOP
    v_payable_account := v_component.payroll_payable_account_id;

    IF v_component.kind='earning' THEN
      v_expense_account := COALESCE(
        v_component.expense_account_id,
        v_component.employee_expense_account_id
      );

      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_expense_account,
        v_component.component_name||' - '||v_component.employee_code,
        v_component.amount_base,0,v_currency,1,
        v_component.amount_base,0,v_component.id::text
      );

      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_payable_account,
        'Payroll payable - '||v_component.employee_code,
        0,v_component.amount_base,v_currency,1,
        0,v_component.amount_base,v_component.id::text
      );

    ELSIF v_component.kind='deduction' THEN
      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_payable_account,
        v_component.component_name||' deduction - '||v_component.employee_code,
        v_component.amount_base,0,v_currency,1,
        v_component.amount_base,0,v_component.id::text
      );

      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_component.liability_account_id,
        v_component.component_name||' payable',
        0,v_component.amount_base,v_currency,1,
        0,v_component.amount_base,v_component.id::text
      );

    ELSE
      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_component.expense_account_id,
        v_component.component_name||' employer cost - '||v_component.employee_code,
        v_component.amount_base,0,v_currency,1,
        v_component.amount_base,0,v_component.id::text
      );

      v_line_no := v_line_no+1;
      INSERT INTO accounting.journal_lines(
        organization_id,journal_entry_id,line_number,account_id,description,
        debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
      ) VALUES(
        v_org,v_journal,v_line_no,v_component.liability_account_id,
        v_component.component_name||' employer liability',
        0,v_component.amount_base,v_currency,1,
        0,v_component.amount_base,v_component.id::text
      );
    END IF;
  END LOOP;

  IF v_line_no=0 THEN
    RAISE EXCEPTION 'PAYROLL_RUN_HAS_NO_COMPONENTS';
  END IF;

  PERFORM accounting.post_journal_entry(v_journal);

  UPDATE payroll.payroll_runs
  SET status='posted',journal_entry_id=v_journal
  WHERE organization_id=v_org AND id=p_run_id;

  RETURN v_journal;
END
$$;

CREATE OR REPLACE FUNCTION payroll.disburse_run(
  p_run_id uuid,
  p_cash_account_id uuid,
  p_payment_date date DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid := app.require_organization_id();
  v_run payroll.payroll_runs%ROWTYPE;
  v_period payroll.payroll_periods%ROWTYPE;
  v_currency varchar(3);
  v_journal uuid;
  v_line_no integer := 0;
  v_employee record;
  v_total numeric(38,8) := 0;
BEGIN
  PERFORM app.assert_permission('payroll.manage',v_org);

  SELECT *
  INTO v_run
  FROM payroll.payroll_runs
  WHERE organization_id=v_org AND id=p_run_id
  FOR UPDATE;

  IF NOT FOUND OR v_run.status<>'posted' OR v_run.payment_journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'POSTED_UNPAID_PAYROLL_RUN_NOT_FOUND';
  END IF;

  PERFORM 1
  FROM accounting.chart_of_accounts
  WHERE organization_id=v_org
    AND id=p_cash_account_id
    AND account_type='asset'
    AND is_active
    AND is_postable;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_PAYROLL_CASH_ACCOUNT';
  END IF;

  SELECT *
  INTO v_period
  FROM payroll.payroll_periods
  WHERE organization_id=v_org AND id=v_run.payroll_period_id;

  SELECT base_currency_code INTO v_currency
  FROM app.organizations
  WHERE id=v_org;

  p_payment_date := COALESCE(p_payment_date,v_period.payment_date);

  INSERT INTO accounting.journal_entries(
    organization_id,entry_date,document_date,source,reference_type,reference_id,
    description,currency_code,exchange_rate
  ) VALUES(
    v_org,p_payment_date,p_payment_date,'payroll_disbursement',
    'payroll_run',v_run.id::text,
    'Payroll disbursement '||v_period.code,v_currency,1
  )
  RETURNING id INTO v_journal;

  FOR v_employee IN
    SELECT
      re.employee_id,
      re.net_pay_base,
      e.code AS employee_code,
      e.payroll_payable_account_id
    FROM payroll.run_employees re
    JOIN hr.employees e
      ON e.organization_id=re.organization_id
     AND e.id=re.employee_id
    WHERE re.organization_id=v_org
      AND re.run_id=p_run_id
      AND re.net_pay_base>0
    ORDER BY e.employee_number
  LOOP
    v_line_no := v_line_no+1;
    INSERT INTO accounting.journal_lines(
      organization_id,journal_entry_id,line_number,account_id,description,
      debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
    ) VALUES(
      v_org,v_journal,v_line_no,v_employee.payroll_payable_account_id,
      'Salary payment - '||v_employee.employee_code,
      v_employee.net_pay_base,0,v_currency,1,
      v_employee.net_pay_base,0,v_employee.employee_id::text
    );
    v_total := v_total+v_employee.net_pay_base;
  END LOOP;

  IF v_total<=0 THEN
    RAISE EXCEPTION 'PAYROLL_RUN_HAS_NO_NET_PAY';
  END IF;

  v_line_no := v_line_no+1;
  INSERT INTO accounting.journal_lines(
    organization_id,journal_entry_id,line_number,account_id,description,
    debit,credit,currency_code,exchange_rate,base_debit,base_credit,source_line_ref
  ) VALUES(
    v_org,v_journal,v_line_no,p_cash_account_id,
    'Payroll bank/cash disbursement',
    0,v_total,v_currency,1,0,v_total,p_run_id::text
  );

  PERFORM accounting.post_journal_entry(v_journal);

  UPDATE payroll.payroll_runs
  SET status='paid',payment_journal_entry_id=v_journal
  WHERE organization_id=v_org AND id=p_run_id;

  UPDATE payroll.payroll_periods
  SET is_closed=true
  WHERE organization_id=v_org AND id=v_run.payroll_period_id;

  RETURN v_journal;
END
$$;

COMMIT;
