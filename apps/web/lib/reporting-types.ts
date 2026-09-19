export interface ProfitAndLossResponse {
  statement: 'profit_and_loss';
  currencyCode: string;
  startDate: string;
  endDate: string;
  rows: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    accountType: string;
    section: string;
    label: string;
    sortOrder: number;
    amount: string;
    sectionTotal: string;
    drilldown: { accountId: string };
  }>;
  summary: {
    revenue: string;
    costOfSales: string;
    grossProfit: string;
    operatingExpense: string;
    operatingProfit: string;
    otherIncome: string;
    otherExpense: string;
    profitBeforeTax: string;
    incomeTax: string;
    netProfit: string;
  };
}

export interface BalanceSheetResponse {
  statement: 'balance_sheet';
  currencyCode: string;
  asOfDate: string;
  rows: Array<{
    itemType: 'account' | 'current_earnings';
    accountId: string | null;
    accountCode: string;
    accountName: string;
    accountType: 'asset' | 'liability' | 'equity';
    section: string;
    label: string;
    sortOrder: number;
    amount: string;
    sectionTotal: string;
    drilldown: { accountId: string } | { lineKey: 'current_earnings' };
  }>;
  summary: {
    assets: string;
    liabilities: string;
    equity: string;
    liabilitiesAndEquity: string;
    difference: string;
    balanced: boolean;
  };
}

export interface CashFlowResponse {
  statement: 'cash_flow';
  method: 'direct' | 'indirect';
  currencyCode: string;
  startDate: string;
  endDate: string;
  rows: Array<{
    itemType: 'account' | 'current_earnings' | 'reconciliation';
    accountId: string | null;
    section: string;
    label: string;
    sortOrder: number;
    amount: string;
    sectionTotal: string;
    drilldown: { accountId: string } | { lineKey: 'current_earnings' } | null;
  }>;
  reconciliation: {
    openingCash: string;
    closingCash: string;
    actualNetChange: string;
    reportedNetChange: string;
    difference: string;
    reconciled: boolean;
  };
}

export interface TrialBalanceResponse {
  statement: 'trial_balance';
  currencyCode: string;
  startDate: string;
  endDate: string;
  rows: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    accountType: string;
    openingDebit: string;
    openingCredit: string;
    periodDebit: string;
    periodCredit: string;
    closingDebit: string;
    closingCredit: string;
    drilldown: { accountId: string };
  }>;
  summary: {
    periodDebit: string;
    periodCredit: string;
    closingDebit: string;
    closingCredit: string;
    difference: string;
    balanced: boolean;
  };
}

export interface DrillDownResponse {
  currencyCode: string;
  filter: {
    accountId: string | null;
    lineKey: string | null;
    startDate: string | null;
    endDate: string;
  };
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
  rows: Array<{
    journalEntryId: string;
    entryNumber: string;
    entryDate: string;
    documentDate: string;
    source: string;
    referenceType: string | null;
    referenceId: string | null;
    entryDescription: string | null;
    journalLineId: string;
    lineNumber: number;
    accountId: string;
    accountCode: string;
    accountName: string;
    lineDescription: string | null;
    currencyCode: string;
    debit: string;
    credit: string;
    baseDebit: string;
    baseCredit: string;
  }>;
}

export interface ReconciliationResponse {
  healthy: boolean;
  asOfDate: string;
  modules: Array<Record<string, string | boolean | null>>;
}
