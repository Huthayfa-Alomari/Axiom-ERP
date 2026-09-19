import type { ReactNode } from 'react';
import { ErpSidebar } from '@/components/erp-sidebar';
export default function DashboardLayout({children}:{children:ReactNode}){return <div className="shell"><ErpSidebar/><main className="main">{children}</main></div>}
