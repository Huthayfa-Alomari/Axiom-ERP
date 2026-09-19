import { Injectable } from '@nestjs/common';
import { Transaction, sql } from 'kysely';
import type { DatabaseSchema } from '../../../infrastructure/database/database.service.js';
import type { DrillDownQuery } from '../dto/financial-reporting.dto.js';

export interface ProfitLossRow {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  pnl_section: string;
  line_label: string;
  sort_order: number;
  amount: string;
  section_total: string;
}

export interface ProfitLossSummaryRow {
  revenue: string;
  cost_of_sales: string;
  gross_profit: string;
  operating_expense: string;
  operating_profit: string;
  other_income: string;
  other_expense: string;
  profit_before_tax: string;
  income_tax: string;
  net_profit: string;
}

export interface BalanceSheetRow {
  item_type: 'account' | 'current_earnings';
  account_id: string | null;
  account_code: string;
  account_name: string;
  account_type: 'asset' | 'liability' | 'equity';
  balance_sheet_section: string;
  line_label: string;
  sort_order: number;
  amount: string;
  section_total: string;
}

export interface BalanceSheetSummaryRow {
  assets: string;
  liabilities: string;
  equity: string;
  liabilities_and_equity: string;
  difference: string;
  balanced: boolean;
}

export interface CashFlowRow {
  item_type: 'account' | 'current_earnings' | 'reconciliation';
  account_id: string | null;
  cash_flow_section: string;
  cash_flow_item: string;
  sort_order: number;
  amount: string;
  section_total: string;
}

export interface CashFlowReconciliationRow {
  opening_cash: string;
  closing_cash: string;
  actual_net_change: string;
  reported_net_change: string;
  difference: string;
  reconciled: boolean;
}

export interface TrialBalanceRow {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
}

export interface TrialBalanceSummaryRow {
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
  difference: string;
  balanced: boolean;
}

export interface DrillDownRow {
  journal_entry_id: string;
  entry_number: string;
  entry_date: string;
  document_date: string;
  source: string;
  reference_type: string | null;
  reference_id: string | null;
  entry_description: string | null;
  journal_line_id: string;
  line_number: number;
  account_id: string;
  account_code: string;
  account_name: string;
  line_description: string | null;
  currency_code: string;
  debit: string;
  credit: string;
  base_debit: string;
  base_credit: string;
  total_count: number;
}

export interface ReconciliationRow {
  module: string;
  account_id: string;
  account_code: string;
  account_name: string;
  subledger_balance: string;
  gl_balance: string;
  difference: string;
  passed: boolean;
}

@Injectable()
export class FinancialReportingRepository {
  async assertReadPermission(trx: Transaction<DatabaseSchema>): Promise<void> {
    await sql`select app.assert_permission('reporting.financial.read')`.execute(trx);
  }

  async baseCurrency(trx: Transaction<DatabaseSchema>): Promise<string> {
    const result = await sql<{ base_currency_code: string }>`
      select base_currency_code
      from app.organizations
      where id=app.require_organization_id()
    `.execute(trx);
    const currency = result.rows[0]?.base_currency_code;
    if (!currency) throw new Error('ORGANIZATION_NOT_FOUND');
    return currency;
  }

  async profitAndLoss(trx: Transaction<DatabaseSchema>, startDate: string, endDate: string) {
    const rows = await sql<ProfitLossRow>`
      select * from reporting.get_profit_and_loss(${startDate}::date,${endDate}::date)
    `.execute(trx);
    const summary = await sql<ProfitLossSummaryRow>`
      select * from reporting.get_profit_and_loss_summary(${startDate}::date,${endDate}::date)
    `.execute(trx);
    return { rows: rows.rows, summary: summary.rows[0]! };
  }

  async balanceSheet(trx: Transaction<DatabaseSchema>, asOfDate: string) {
    const rows = await sql<BalanceSheetRow>`
      select * from reporting.get_balance_sheet(${asOfDate}::date)
    `.execute(trx);
    const summary = await sql<BalanceSheetSummaryRow>`
      select * from reporting.get_balance_sheet_summary(${asOfDate}::date)
    `.execute(trx);
    return { rows: rows.rows, summary: summary.rows[0]! };
  }

  async cashFlow(
    trx: Transaction<DatabaseSchema>,
    startDate: string,
    endDate: string,
    method: 'direct' | 'indirect',
  ) {
    const rows = method === 'direct'
      ? await sql<CashFlowRow>`
          select * from reporting.get_cash_flow_direct(${startDate}::date,${endDate}::date)
        `.execute(trx)
      : await sql<CashFlowRow>`
          select * from reporting.get_cash_flow_indirect(${startDate}::date,${endDate}::date)
        `.execute(trx);

    const reconciliation = await sql<CashFlowReconciliationRow>`
      select * from reporting.get_cash_flow_reconciliation(
        ${startDate}::date,
        ${endDate}::date,
        ${method}::varchar
      )
    `.execute(trx);

    return { rows: rows.rows, reconciliation: reconciliation.rows[0]! };
  }

  async trialBalance(trx: Transaction<DatabaseSchema>, startDate: string, endDate: string) {
    const rows = await sql<TrialBalanceRow>`
      select * from reporting.get_trial_balance(${startDate}::date,${endDate}::date)
    `.execute(trx);
    const summary = await sql<TrialBalanceSummaryRow>`
      select * from reporting.get_trial_balance_summary(${startDate}::date,${endDate}::date)
    `.execute(trx);
    return { rows: rows.rows, summary: summary.rows[0]! };
  }

  async reconciliation(trx: Transaction<DatabaseSchema>, asOfDate: string) {
    const result = await sql<ReconciliationRow>`
      select * from reconciliation.run_suite(${asOfDate}::date)
    `.execute(trx);
    return result.rows;
  }

  async drillDown(trx: Transaction<DatabaseSchema>, query: DrillDownQuery): Promise<DrillDownRow[]> {
    const startDate = query.startDate ?? null;

    if (query.accountId) {
      const result = await sql<DrillDownRow>`
        select
          je.id::text journal_entry_id,
          je.entry_number::text entry_number,
          je.entry_date::text entry_date,
          je.document_date::text document_date,
          je.source,
          je.reference_type,
          je.reference_id,
          je.description entry_description,
          jl.id::text journal_line_id,
          jl.line_number,
          coa.id::text account_id,
          coa.code account_code,
          coa.name account_name,
          jl.description line_description,
          jl.currency_code,
          round(jl.debit,4)::numeric(18,4) debit,
          round(jl.credit,4)::numeric(18,4) credit,
          round(jl.base_debit,4)::numeric(18,4) base_debit,
          round(jl.base_credit,4)::numeric(18,4) base_credit,
          count(*) over()::int total_count
        from accounting.journal_entries je
        join accounting.journal_lines jl
          on jl.organization_id=je.organization_id and jl.journal_entry_id=je.id
        join accounting.chart_of_accounts coa
          on coa.organization_id=jl.organization_id and coa.id=jl.account_id
        where je.organization_id=app.require_organization_id()
          and je.status in ('posted','reversed')
          and jl.account_id=${query.accountId}::uuid
          and (${startDate}::date is null or je.entry_date>=${startDate}::date)
          and je.entry_date<=${query.endDate}::date
        order by je.entry_date desc,je.entry_number desc,jl.line_number
        limit ${query.limit} offset ${query.offset}
      `.execute(trx);
      return result.rows;
    }

    const result = await sql<DrillDownRow>`
      select
        je.id::text journal_entry_id,
        je.entry_number::text entry_number,
        je.entry_date::text entry_date,
        je.document_date::text document_date,
        je.source,
        je.reference_type,
        je.reference_id,
        je.description entry_description,
        jl.id::text journal_line_id,
        jl.line_number,
        coa.id::text account_id,
        coa.code account_code,
        coa.name account_name,
        jl.description line_description,
        jl.currency_code,
        round(jl.debit,4)::numeric(18,4) debit,
        round(jl.credit,4)::numeric(18,4) credit,
        round(jl.base_debit,4)::numeric(18,4) base_debit,
        round(jl.base_credit,4)::numeric(18,4) base_credit,
        count(*) over()::int total_count
      from accounting.journal_entries je
      join accounting.journal_lines jl
        on jl.organization_id=je.organization_id and jl.journal_entry_id=je.id
      join accounting.chart_of_accounts coa
        on coa.organization_id=jl.organization_id and coa.id=jl.account_id
      where je.organization_id=app.require_organization_id()
        and je.status in ('posted','reversed')
        and coa.account_type in ('revenue','expense')
        and (${startDate}::date is null or je.entry_date>=${startDate}::date)
        and je.entry_date<=${query.endDate}::date
      order by je.entry_date desc,je.entry_number desc,jl.line_number
      limit ${query.limit} offset ${query.offset}
    `.execute(trx);
    return result.rows;
  }
}
