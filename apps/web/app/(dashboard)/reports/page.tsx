import Link from 'next/link';
import type { ReactNode } from 'react';
import { apiGet } from '@/lib/server-api';
import type {
  BalanceSheetResponse,
  CashFlowResponse,
  DrillDownResponse,
  ProfitAndLossResponse,
  ReconciliationResponse,
  TrialBalanceResponse,
} from '@/lib/reporting-types';

type SearchParams = Record<string, string | string[] | undefined>;
type ReportView = 'pnl' | 'balance-sheet' | 'cash-flow' | 'trial-balance' | 'reconciliation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function reportUrl(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value);
  });
  return `/reports?${query.toString()}`;
}

function Amount({ value, currency }: { value: string; currency: string }) {
  const negative = value.startsWith('-');
  return <span className={negative ? 'amount negative' : 'amount'}>{value} {currency}</span>;
}

function SummaryCard({ label, value, currency, status }: {
  label: string;
  value: string;
  currency?: string;
  status?: 'good' | 'bad';
}) {
  return (
    <div className={`report-kpi ${status ? `status-${status}` : ''}`}>
      <div className="muted">{label}</div>
      <strong>{value}{currency ? ` ${currency}` : ''}</strong>
    </div>
  );
}

function DrillLink({ label, href }: { label: string; href: string | null }) {
  return href ? <Link className="drill-link" href={href}>{label}</Link> : <>{label}</>;
}

function ProfitAndLossTable({ data, hrefFor }: {
  data: ProfitAndLossResponse;
  hrefFor: (drill: { accountId: string }) => string;
}) {
  let section = '';
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead><tr><th>Account</th><th>Line</th><th>Section</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {data.rows.map((row) => {
            const showSection = row.section !== section;
            section = row.section;
            return (
              <tr key={row.accountId}>
                <td>{row.accountCode}</td>
                <td><DrillLink label={row.label} href={hrefFor(row.drilldown)} /></td>
                <td>{showSection ? row.section.replaceAll('_', ' ') : ''}</td>
                <td className="num"><Amount value={row.amount} currency={data.currencyCode} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BalanceSheetTable({ data, hrefFor }: {
  data: BalanceSheetResponse;
  hrefFor: (drill: { accountId: string } | { lineKey: 'current_earnings' }) => string;
}) {
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead><tr><th>Account</th><th>Line</th><th>Section</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={`${row.itemType}:${row.accountCode}`}>
              <td>{row.accountCode}</td>
              <td><DrillLink label={row.label} href={hrefFor(row.drilldown)} /></td>
              <td>{row.section.replaceAll('_', ' ')}</td>
              <td className="num"><Amount value={row.amount} currency={data.currencyCode} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CashFlowTable({ data, hrefFor }: {
  data: CashFlowResponse;
  hrefFor: (drill: { accountId: string } | { lineKey: 'current_earnings' } | null) => string | null;
}) {
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead><tr><th>Activity</th><th>Line</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {data.rows.map((row, index) => (
            <tr key={`${row.section}:${row.accountId ?? row.label}:${index}`}>
              <td>{row.section.replaceAll('_', ' ')}</td>
              <td><DrillLink label={row.label} href={hrefFor(row.drilldown)} /></td>
              <td className="num"><Amount value={row.amount} currency={data.currencyCode} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrialBalanceTable({ data, hrefFor }: {
  data: TrialBalanceResponse;
  hrefFor: (drill: { accountId: string }) => string;
}) {
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <thead>
          <tr>
            <th>Account</th><th>Name</th>
            <th className="num">Opening Dr</th><th className="num">Opening Cr</th>
            <th className="num">Period Dr</th><th className="num">Period Cr</th>
            <th className="num">Closing Dr</th><th className="num">Closing Cr</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.accountId}>
              <td>{row.accountCode}</td>
              <td><DrillLink label={row.accountName} href={hrefFor(row.drilldown)} /></td>
              <td className="num">{row.openingDebit}</td>
              <td className="num">{row.openingCredit}</td>
              <td className="num">{row.periodDebit}</td>
              <td className="num">{row.periodCredit}</td>
              <td className="num">{row.closingDebit}</td>
              <td className="num">{row.closingCredit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrillDownPanel({ data }: { data: DrillDownResponse }) {
  return (
    <section className="report-panel">
      <div className="report-heading">
        <div>
          <h2>General Ledger drill-down</h2>
          <p className="muted">{data.pagination.total} journal line(s) match this statement line.</p>
        </div>
      </div>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>Date</th><th>JE #</th><th>Account</th><th>Source</th><th>Description</th>
              <th className="num">Base Debit</th><th className="num">Base Credit</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.journalLineId}>
                <td>{row.entryDate}</td>
                <td>{row.entryNumber}</td>
                <td>{row.accountCode} — {row.accountName}</td>
                <td>{row.source}</td>
                <td>{row.lineDescription ?? row.entryDescription ?? '—'}</td>
                <td className="num">{row.baseDebit}</td>
                <td className="num">{row.baseCredit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = `${today.slice(0, 4)}-01-01`;

  const requestedView = first(params.view);
  const allowedViews: ReportView[] = ['pnl', 'balance-sheet', 'cash-flow', 'trial-balance', 'reconciliation'];
  const view: ReportView = allowedViews.includes(requestedView as ReportView)
    ? requestedView as ReportView
    : 'pnl';
  const startDate = first(params.startDate) ?? defaultStart;
  const endDate = first(params.endDate) ?? today;
  const asOfDate = first(params.asOfDate) ?? endDate;
  const method = first(params.method) === 'indirect' ? 'indirect' : 'direct';
  const drillAccount = first(params.drillAccount);
  const drillLine = first(params.drillLine);

  const common = { view, startDate, endDate, asOfDate, method };

  const drillHref = (drill: { accountId: string } | { lineKey: 'current_earnings' } | null, includeStart = true) => {
    if (!drill) return null;
    return reportUrl({
      ...common,
      drillAccount: 'accountId' in drill ? drill.accountId : undefined,
      drillLine: 'lineKey' in drill ? drill.lineKey : undefined,
      drillStartDate: includeStart ? startDate : undefined,
    });
  };

  let content: ReactNode;
  let currencyCode = '';

  if (view === 'balance-sheet') {
    const data = await apiGet<BalanceSheetResponse>(
      `/api/v1/reports/financial/balance-sheet?asOfDate=${encodeURIComponent(asOfDate)}`,
    );
    currencyCode = data.currencyCode;
    content = (
      <>
        <div className="report-kpis">
          <SummaryCard label="Assets" value={data.summary.assets} currency={data.currencyCode} />
          <SummaryCard label="Liabilities + Equity" value={data.summary.liabilitiesAndEquity} currency={data.currencyCode} />
          <SummaryCard
            label="Equation difference"
            value={data.summary.difference}
            currency={data.currencyCode}
            status={data.summary.balanced ? 'good' : 'bad'}
          />
        </div>
        <BalanceSheetTable data={data} hrefFor={(drill) => drillHref(drill, false)!} />
      </>
    );
  } else if (view === 'cash-flow') {
    const data = await apiGet<CashFlowResponse>(
      `/api/v1/reports/financial/cash-flow?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&method=${method}`,
    );
    currencyCode = data.currencyCode;
    content = (
      <>
        <div className="report-kpis">
          <SummaryCard label="Opening cash" value={data.reconciliation.openingCash} currency={data.currencyCode} />
          <SummaryCard label="Net cash change" value={data.reconciliation.actualNetChange} currency={data.currencyCode} />
          <SummaryCard label="Closing cash" value={data.reconciliation.closingCash} currency={data.currencyCode} />
          <SummaryCard
            label="Reconciliation difference"
            value={data.reconciliation.difference}
            currency={data.currencyCode}
            status={data.reconciliation.reconciled ? 'good' : 'bad'}
          />
        </div>
        <CashFlowTable data={data} hrefFor={(drill) => drillHref(drill, true)} />
      </>
    );
  } else if (view === 'trial-balance') {
    const data = await apiGet<TrialBalanceResponse>(
      `/api/v1/reports/financial/trial-balance?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
    );
    currencyCode = data.currencyCode;
    content = (
      <>
        <div className="report-kpis">
          <SummaryCard label="Period debit" value={data.summary.periodDebit} currency={data.currencyCode} />
          <SummaryCard label="Period credit" value={data.summary.periodCredit} currency={data.currencyCode} />
          <SummaryCard
            label="Closing difference"
            value={data.summary.difference}
            currency={data.currencyCode}
            status={data.summary.balanced ? 'good' : 'bad'}
          />
        </div>
        <TrialBalanceTable data={data} hrefFor={(drill) => drillHref(drill, true)!} />
      </>
    );
  } else if (view === 'reconciliation') {
    const data = await apiGet<ReconciliationResponse>(
      `/api/v1/reports/financial/reconciliation?asOfDate=${encodeURIComponent(asOfDate)}`,
    );
    content = (
      <section className="report-panel">
        <h2>Subledger reconciliation {data.healthy ? '✓' : '!'}</h2>
        <div className="report-table-wrap">
          <table className="report-table">
            <thead><tr><th>Module</th><th>Account</th><th className="num">Subledger</th><th className="num">GL</th><th className="num">Difference</th><th>Status</th></tr></thead>
            <tbody>
              {data.modules.map((row, index) => (
                <tr key={`${String(row.module)}:${String(row.accountId)}:${index}`}>
                  <td>{String(row.module)}</td>
                  <td>{String(row.accountCode)} — {String(row.accountName)}</td>
                  <td className="num">{String(row.subledgerBalance)}</td>
                  <td className="num">{String(row.glBalance)}</td>
                  <td className="num">{String(row.difference)}</td>
                  <td>{row.passed ? 'Passed' : 'Failed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  } else {
    const data = await apiGet<ProfitAndLossResponse>(
      `/api/v1/reports/financial/profit-and-loss?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
    );
    currencyCode = data.currencyCode;
    content = (
      <>
        <div className="report-kpis">
          <SummaryCard label="Revenue" value={data.summary.revenue} currency={data.currencyCode} />
          <SummaryCard label="Gross profit" value={data.summary.grossProfit} currency={data.currencyCode} />
          <SummaryCard label="Operating profit" value={data.summary.operatingProfit} currency={data.currencyCode} />
          <SummaryCard label="Net profit" value={data.summary.netProfit} currency={data.currencyCode} />
        </div>
        <ProfitAndLossTable data={data} hrefFor={(drill) => drillHref(drill, true)!} />
      </>
    );
  }

  let drillDown: DrillDownResponse | null = null;
  if (drillAccount || drillLine) {
    const drillStart = first(params.drillStartDate);
    const query = new URLSearchParams({
      endDate: view === 'balance-sheet' ? asOfDate : endDate,
      limit: '100',
      offset: '0',
    });
    if (drillStart) query.set('startDate', drillStart);
    if (drillAccount) query.set('accountId', drillAccount);
    if (drillLine) query.set('lineKey', drillLine);
    drillDown = await apiGet<DrillDownResponse>(`/api/v1/reports/financial/drill-down?${query.toString()}`);
  }

  const views: Array<[ReportView, string]> = [
    ['pnl', 'Profit & Loss'],
    ['balance-sheet', 'Balance Sheet'],
    ['cash-flow', 'Cash Flow'],
    ['trial-balance', 'Trial Balance'],
    ['reconciliation', 'Reconciliation'],
  ];

  return (
    <div className="reports-page">
      <div className="report-heading">
        <div>
          <h1>Financial Reporting</h1>
          <p className="muted">Immutable GL-backed statements, reconciliation, and journal drill-down.</p>
        </div>
        {currencyCode && <span className="report-badge">Base currency: {currencyCode}</span>}
      </div>

      <nav className="report-tabs">
        {views.map(([key, label]) => (
          <Link
            key={key}
            className={view === key ? 'active' : ''}
            href={reportUrl({ ...common, view: key, drillAccount: undefined, drillLine: undefined })}
          >
            {label}
          </Link>
        ))}
      </nav>

      <form className="report-filters" method="get">
        <input type="hidden" name="view" value={view} />
        <label>Start date<input type="date" name="startDate" defaultValue={startDate} /></label>
        <label>End date<input type="date" name="endDate" defaultValue={endDate} /></label>
        <label>As-of date<input type="date" name="asOfDate" defaultValue={asOfDate} /></label>
        {view === 'cash-flow' && (
          <label>Method
            <select name="method" defaultValue={method}>
              <option value="direct">Direct</option>
              <option value="indirect">Indirect</option>
            </select>
          </label>
        )}
        <button type="submit">Run report</button>
      </form>

      <section className="report-panel">{content}</section>
      {drillDown && <DrillDownPanel data={drillDown} />}
    </div>
  );
}
