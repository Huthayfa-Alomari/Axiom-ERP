import { apiGet } from '@/lib/server-api';
import { EnterpriseTable } from '@/components/enterprise-table';
export default async function Reports(){const today=new Date().toISOString().slice(0,10);const start=`${today.slice(0,4)}-01-01`;const [pnl,bs,cf,rec]=await Promise.all([
 apiGet<any[]>(`/api/v1/reports/financial/profit-and-loss?startDate=${start}&endDate=${today}`),
 apiGet<any[]>(`/api/v1/reports/financial/balance-sheet?asOfDate=${today}`),
 apiGet<any[]>(`/api/v1/reports/financial/cash-flow?startDate=${start}&endDate=${today}`),
 apiGet<{healthy:boolean;modules:any[]}>(`/api/v1/reports/financial/reconciliation?asOfDate=${today}`)]);
 return <><h1>Financial Reports</h1><p className="muted">P&amp;L, Balance Sheet, Cash Flow and subledger reconciliation.</p><section style={{marginTop:24}}><h2>Reconciliation {rec.healthy?'✓':'!'}</h2><EnterpriseTable rows={rec.modules}/></section><section style={{marginTop:32}}><h2>Profit &amp; Loss</h2><EnterpriseTable rows={pnl}/></section><section style={{marginTop:32}}><h2>Balance Sheet</h2><EnterpriseTable rows={bs}/></section><section style={{marginTop:32}}><h2>Cash Flow</h2><EnterpriseTable rows={cf}/></section></>}
