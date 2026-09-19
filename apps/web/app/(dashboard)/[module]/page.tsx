import { notFound } from 'next/navigation';
import { EnterpriseTable } from '@/components/enterprise-table';
import { apiGet } from '@/lib/server-api';
const modules=['sales','purchasing','inventory','treasury','fixed-assets','payroll','manufacturing'] as const;
export default async function ModulePage({params}:{params:Promise<{module:string}>}){const {module}=await params;if(!modules.includes(module as any)) notFound();const rows=await apiGet<Array<Record<string,unknown>>>(`/api/v1/workspace/${module}`);return <><h1>{module.replaceAll('-',' ')}</h1><p className="muted">Operational workspace</p><div style={{marginTop:24}}><EnterpriseTable rows={rows}/></div></>}
