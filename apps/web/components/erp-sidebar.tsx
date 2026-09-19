import Link from 'next/link';
const links=[['/','Dashboard'],['/sales','Sales'],['/purchasing','Purchasing'],['/inventory','Inventory'],['/treasury','Treasury'],['/fixed-assets','Fixed Assets'],['/payroll','Payroll'],['/manufacturing','Manufacturing'],['/reports','Financial Reports']];
export function ErpSidebar(){return <aside className="sidebar"><div className="brand">Axiom ERP</div><nav className="nav">{links.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}</nav></aside>}
