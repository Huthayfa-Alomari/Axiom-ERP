import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  const org = process.env.RELEASE_CHECK_ORG_ID;
  const user = process.env.RELEASE_CHECK_USER_ID;
  if (!url || !org || !user) {
    throw new Error('DATABASE_URL, RELEASE_CHECK_ORG_ID and RELEASE_CHECK_USER_ID are required');
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('app.request_id','release-gate',true)",
      [org, user],
    );

    const unbalanced = await client.query(`
      select je.id
      from accounting.journal_entries je
      join accounting.journal_lines jl
        on jl.organization_id=je.organization_id and jl.journal_entry_id=je.id
      where je.organization_id=$1 and je.status in ('posted','reversed')
      group by je.id
      having round(sum(jl.base_debit)-sum(jl.base_credit),8)<>0
    `, [org]);
    if (unbalanced.rowCount) throw new Error('Unbalanced journals detected');

    await client.query('select reporting.assert_balance_sheet(current_date)');

    const trial = await client.query<{ balanced: boolean; difference: string }>(`
      select balanced,difference
      from reporting.get_trial_balance_summary(date_trunc('year',current_date)::date,current_date)
    `);
    if (!trial.rows[0]?.balanced) {
      throw new Error(`Trial balance failed: difference=${trial.rows[0]?.difference ?? 'unknown'}`);
    }

    const rec = await client.query('select * from reconciliation.run_suite(current_date) where passed=false');
    if (rec.rowCount) throw new Error('Subledger reconciliation failed');

    const neg = await client.query(
      'select * from inventory.stock_on_hand where organization_id=$1 and quantity_on_hand<0',
      [org],
    );
    if (neg.rowCount) throw new Error('Negative inventory detected');

    console.log('Database release invariants passed');
    await client.query('rollback');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

void main();
