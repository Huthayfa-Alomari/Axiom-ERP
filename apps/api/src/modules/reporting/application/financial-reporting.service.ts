import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { TenantRequestContext } from '../../../infrastructure/database/database.service.js';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import {
  FinancialReportingRepository,
  type BalanceSheetRow,
  type CashFlowRow,
  type DrillDownRow,
  type ProfitLossRow,
  type TrialBalanceRow,
} from '../infrastructure/financial-reporting.repository.js';
import type {
  BalanceSheetQuery,
  CashFlowQuery,
  DrillDownQuery,
  ProfitAndLossQuery,
  ReconciliationQuery,
  TrialBalanceQuery,
} from '../dto/financial-reporting.dto.js';

export type MoneyString = string;

function money(value: unknown): MoneyString {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new InternalServerErrorException('Database returned an invalid monetary value');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  if (fraction.length > 4) {
    throw new InternalServerErrorException('Database monetary value exceeded NUMERIC(18,4) precision');
  }
  return `${negative ? '-' : ''}${integer}.${fraction.padEnd(4, '0')}`;
}

function mapPnlRow(row: ProfitLossRow) {
  return {
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    section: row.pnl_section,
    label: row.line_label,
    sortOrder: row.sort_order,
    amount: money(row.amount),
    sectionTotal: money(row.section_total),
    drilldown: { accountId: row.account_id },
  };
}

function mapBalanceRow(row: BalanceSheetRow) {
  return {
    itemType: row.item_type,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    section: row.balance_sheet_section,
    label: row.line_label,
    sortOrder: row.sort_order,
    amount: money(row.amount),
    sectionTotal: money(row.section_total),
    drilldown: row.item_type === 'current_earnings'
      ? { lineKey: 'current_earnings' as const }
      : { accountId: row.account_id! },
  };
}

function mapCashFlowRow(row: CashFlowRow) {
  return {
    itemType: row.item_type,
    accountId: row.account_id,
    section: row.cash_flow_section,
    label: row.cash_flow_item,
    sortOrder: row.sort_order,
    amount: money(row.amount),
    sectionTotal: money(row.section_total),
    drilldown: row.item_type === 'current_earnings'
      ? { lineKey: 'current_earnings' as const }
      : row.item_type === 'account' && row.account_id
        ? { accountId: row.account_id }
        : null,
  };
}

function mapTrialBalanceRow(row: TrialBalanceRow) {
  return {
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    accountType: row.account_type,
    openingDebit: money(row.opening_debit),
    openingCredit: money(row.opening_credit),
    periodDebit: money(row.period_debit),
    periodCredit: money(row.period_credit),
    closingDebit: money(row.closing_debit),
    closingCredit: money(row.closing_credit),
    drilldown: { accountId: row.account_id },
  };
}

function mapDrillRow(row: DrillDownRow) {
  return {
    journalEntryId: row.journal_entry_id,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    documentDate: row.document_date,
    source: row.source,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    entryDescription: row.entry_description,
    journalLineId: row.journal_line_id,
    lineNumber: row.line_number,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    lineDescription: row.line_description,
    currencyCode: row.currency_code,
    debit: money(row.debit),
    credit: money(row.credit),
    baseDebit: money(row.base_debit),
    baseCredit: money(row.base_credit),
  };
}

@Injectable()
export class FinancialReportingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: FinancialReportingRepository,
  ) {}

  async profitAndLoss(ctx: TenantRequestContext, query: ProfitAndLossQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const currencyCode = await this.repository.baseCurrency(trx);
      const { rows, summary } = await this.repository.profitAndLoss(trx, query.startDate, query.endDate);
      return {
        statement: 'profit_and_loss' as const,
        currencyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        rows: rows.map(mapPnlRow),
        summary: {
          revenue: money(summary.revenue),
          costOfSales: money(summary.cost_of_sales),
          grossProfit: money(summary.gross_profit),
          operatingExpense: money(summary.operating_expense),
          operatingProfit: money(summary.operating_profit),
          otherIncome: money(summary.other_income),
          otherExpense: money(summary.other_expense),
          profitBeforeTax: money(summary.profit_before_tax),
          incomeTax: money(summary.income_tax),
          netProfit: money(summary.net_profit),
        },
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }

  async balanceSheet(ctx: TenantRequestContext, query: BalanceSheetQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const currencyCode = await this.repository.baseCurrency(trx);
      const { rows, summary } = await this.repository.balanceSheet(trx, query.asOfDate);
      return {
        statement: 'balance_sheet' as const,
        currencyCode,
        asOfDate: query.asOfDate,
        rows: rows.map(mapBalanceRow),
        summary: {
          assets: money(summary.assets),
          liabilities: money(summary.liabilities),
          equity: money(summary.equity),
          liabilitiesAndEquity: money(summary.liabilities_and_equity),
          difference: money(summary.difference),
          balanced: summary.balanced,
        },
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }

  async cashFlow(ctx: TenantRequestContext, query: CashFlowQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const currencyCode = await this.repository.baseCurrency(trx);
      const { rows, reconciliation } = await this.repository.cashFlow(
        trx,
        query.startDate,
        query.endDate,
        query.method,
      );
      return {
        statement: 'cash_flow' as const,
        method: query.method,
        currencyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        rows: rows.map(mapCashFlowRow),
        reconciliation: {
          openingCash: money(reconciliation.opening_cash),
          closingCash: money(reconciliation.closing_cash),
          actualNetChange: money(reconciliation.actual_net_change),
          reportedNetChange: money(reconciliation.reported_net_change),
          difference: money(reconciliation.difference),
          reconciled: reconciliation.reconciled,
        },
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }

  async trialBalance(ctx: TenantRequestContext, query: TrialBalanceQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const currencyCode = await this.repository.baseCurrency(trx);
      const { rows, summary } = await this.repository.trialBalance(trx, query.startDate, query.endDate);
      return {
        statement: 'trial_balance' as const,
        currencyCode,
        startDate: query.startDate,
        endDate: query.endDate,
        rows: rows.map(mapTrialBalanceRow),
        summary: {
          periodDebit: money(summary.period_debit),
          periodCredit: money(summary.period_credit),
          closingDebit: money(summary.closing_debit),
          closingCredit: money(summary.closing_credit),
          difference: money(summary.difference),
          balanced: summary.balanced,
        },
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }

  async reconciliation(ctx: TenantRequestContext, query: ReconciliationQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const rows = await this.repository.reconciliation(trx, query.asOfDate);
      return {
        healthy: rows.every((row) => row.passed),
        asOfDate: query.asOfDate,
        modules: rows.map((row) => ({
          module: row.module,
          accountId: row.account_id,
          accountCode: row.account_code,
          accountName: row.account_name,
          subledgerBalance: money(row.subledger_balance),
          glBalance: money(row.gl_balance),
          difference: money(row.difference),
          passed: row.passed,
        })),
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }

  async drillDown(ctx: TenantRequestContext, query: DrillDownQuery) {
    return this.database.runInTenantContext(ctx, async (trx) => {
      await this.repository.assertReadPermission(trx);
      const currencyCode = await this.repository.baseCurrency(trx);
      const rows = await this.repository.drillDown(trx, query);
      const total = rows[0]?.total_count ?? 0;
      return {
        currencyCode,
        filter: {
          accountId: query.accountId ?? null,
          lineKey: query.lineKey ?? null,
          startDate: query.startDate ?? null,
          endDate: query.endDate,
        },
        pagination: {
          limit: query.limit,
          offset: query.offset,
          total,
          hasMore: query.offset + rows.length < total,
        },
        rows: rows.map(mapDrillRow),
      };
    }, { readOnly: true, isolationLevel: 'repeatable_read' });
  }
}
