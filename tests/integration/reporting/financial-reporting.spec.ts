import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration('Financial reporting invariants', () => {
  let client: Client;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const cashAccountId = randomUUID();
  const equityAccountId = randomUUID();
  const revenueAccountId = randomUUID();
  const expenseAccountId = randomUUID();

  async function postJournal(
    entryDate: string,
    source: string,
    lines: Array<{ accountId: string; debit: string; credit: string }>,
  ) {
    const entry = await client.query<{ id: string }>(`
      insert into accounting.journal_entries(
        organization_id,entry_date,document_date,status,source,currency_code,exchange_rate
      ) values ($1,$2,$2,'draft',$3,'JOD',1)
      returning id
    `, [organizationId, entryDate, source]);
    const journalEntryId = entry.rows[0]!.id;

    for (const [index, line] of lines.entries()) {
      await client.query(`
        insert into accounting.journal_lines(
          organization_id,journal_entry_id,line_number,account_id,
          debit,credit,currency_code,exchange_rate,base_debit,base_credit
        ) values ($1,$2,$3,$4,$5,$6,'JOD',1,$5,$6)
      `, [organizationId, journalEntryId, index + 1, line.accountId, line.debit, line.credit]);
    }

    await client.query(`
      update accounting.journal_entries
      set status='posted',posted_at=clock_timestamp(),posted_by=$2
      where organization_id=$1 and id=$3
    `, [organizationId, userId, journalEntryId]);
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('begin');

    await client.query(`
      insert into app.organizations(id,code,name,base_currency_code)
      values ($1,$2,'Financial Reporting Test','JOD')
    `, [organizationId, `REPORT-${organizationId.slice(0, 8)}`]);
    await client.query(`
      insert into app.users(id,email,display_name)
      values ($1,$2,'Reporting Test')
    `, [userId, `report-${userId}@example.test`]);
    await client.query(`
      insert into app.memberships(organization_id,user_id,is_active)
      values ($1,$2,true)
    `, [organizationId, userId]);
    await client.query(
      "select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)",
      [organizationId, userId],
    );

    await client.query(`
      insert into accounting.chart_of_accounts(
        id,organization_id,code,name,account_type,normal_balance,system_code
      ) values
        ($2,$1,'1000','Cash','asset','debit','TEST_CASH'),
        ($3,$1,'3000','Equity','equity','credit','TEST_EQUITY'),
        ($4,$1,'4000','Revenue','revenue','credit','TEST_REVENUE'),
        ($5,$1,'5000','Operating Expense','expense','debit','TEST_EXPENSE')
    `, [organizationId, cashAccountId, equityAccountId, revenueAccountId, expenseAccountId]);

    await client.query(`
      insert into reporting.account_report_mappings(
        organization_id,account_id,pnl_section,balance_sheet_section,cash_flow_section,
        cash_flow_item,is_cash_equivalent,sort_order
      ) values
        ($1,$2,null,'cash_and_cash_equivalents',null,null,true,10),
        ($1,$3,null,'equity','financing','Owner capital',false,10),
        ($1,$4,'revenue',null,'operating','Customer receipts',false,10),
        ($1,$5,'operating_expense',null,'operating','Operating payments',false,20)
    `, [organizationId, cashAccountId, equityAccountId, revenueAccountId, expenseAccountId]);

    await postJournal('2025-12-31', 'opening_capital', [
      { accountId: cashAccountId, debit: '1000.0000', credit: '0.0000' },
      { accountId: equityAccountId, debit: '0.0000', credit: '1000.0000' },
    ]);
    await postJournal('2026-01-10', 'cash_sale', [
      { accountId: cashAccountId, debit: '500.0000', credit: '0.0000' },
      { accountId: revenueAccountId, debit: '0.0000', credit: '500.0000' },
    ]);
    await postJournal('2026-01-15', 'cash_expense', [
      { accountId: expenseAccountId, debit: '200.0000', credit: '0.0000' },
      { accountId: cashAccountId, debit: '0.0000', credit: '200.0000' },
    ]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('rollback');
    await client.end();
  });

  it('produces a P&L from posted GL lines only', async () => {
    const result = await client.query<{
      revenue: string;
      operating_expense: string;
      net_profit: string;
    }>("select revenue,operating_expense,net_profit from reporting.get_profit_and_loss_summary('2026-01-01','2026-01-31')");

    expect(result.rows[0]).toMatchObject({
      revenue: '500.0000',
      operating_expense: '-200.0000',
      net_profit: '300.0000',
    });
  });

  it('enforces Assets = Liabilities + Equity including current earnings', async () => {
    const result = await client.query<{
      assets: string;
      liabilities_and_equity: string;
      difference: string;
      balanced: boolean;
    }>("select assets,liabilities_and_equity,difference,balanced from reporting.get_balance_sheet_summary('2026-01-31')");

    expect(result.rows[0]).toEqual({
      assets: '1300.0000',
      liabilities_and_equity: '1300.0000',
      difference: '0.0000',
      balanced: true,
    });
  });

  it.each(['direct', 'indirect'] as const)('reconciles %s cash flow to the actual cash movement', async (method) => {
    const result = await client.query<{
      opening_cash: string;
      closing_cash: string;
      actual_net_change: string;
      reported_net_change: string;
      difference: string;
      reconciled: boolean;
    }>("select * from reporting.get_cash_flow_reconciliation('2026-01-01','2026-01-31',$1)", [method]);

    expect(result.rows[0]).toEqual({
      opening_cash: '1000.0000',
      closing_cash: '1300.0000',
      actual_net_change: '300.0000',
      reported_net_change: '300.0000',
      difference: '0.0000',
      reconciled: true,
    });
  });

  it('keeps the trial balance exactly balanced', async () => {
    const result = await client.query<{
      period_debit: string;
      period_credit: string;
      difference: string;
      balanced: boolean;
    }>("select period_debit,period_credit,difference,balanced from reporting.get_trial_balance_summary('2026-01-01','2026-01-31')");

    expect(result.rows[0]).toEqual({
      period_debit: '700.0000',
      period_credit: '700.0000',
      difference: '0.0000',
      balanced: true,
    });
  });
});
