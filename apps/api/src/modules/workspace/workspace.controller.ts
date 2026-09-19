import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

@Controller('workspace')
export class WorkspaceController {
  constructor(private readonly database: DatabaseService) {}
  @Get(':module') async collection(@Param('module') module:string) {
    switch(module) {
      case 'inventory': return (await sql`select p.id,p.sku,p.name,p.product_type,p.costing_method,p.is_active,coalesce(sum(a.quantity_on_hand),0) quantity_on_hand,coalesce(sum(a.available_quantity),0) available_quantity from inventory.products p left join inventory.available_stock a on a.organization_id=p.organization_id and a.product_id=p.id where p.organization_id=app.require_organization_id() group by p.id order by p.sku limit 500`.execute(this.database.db)).rows;
      case 'purchasing': return (await sql`select po.id,po.po_number,v.name vendor,po.order_date,po.expected_date,po.status,po.currency_code from purchasing.purchase_orders po join crm.vendors v on v.organization_id=po.organization_id and v.id=po.vendor_id where po.organization_id=app.require_organization_id() order by po.po_number desc limit 200`.execute(this.database.db)).rows;
      case 'sales': return (await sql`select so.id,so.order_number,c.name customer,so.order_date,so.status,so.currency_code from sales.sales_orders so join crm.customers c on c.organization_id=so.organization_id and c.id=so.customer_id where so.organization_id=app.require_organization_id() order by so.order_number desc limit 200`.execute(this.database.db)).rows;
      case 'treasury': return (await sql`select s.id,b.name bank_account,s.statement_number,s.period_start,s.period_end,s.opening_balance,s.closing_balance,s.status from treasury.bank_statements s join treasury.bank_accounts b on b.organization_id=s.organization_id and b.id=s.bank_account_id where s.organization_id=app.require_organization_id() order by s.period_end desc limit 200`.execute(this.database.db)).rows;
      case 'fixed-assets': return (await sql`select a.id,a.asset_number,a.code,a.name,c.name asset_class,a.status,a.cost_base,a.accumulated_depreciation_base,a.net_book_value_base from fixed_assets.assets a join fixed_assets.asset_classes c on c.organization_id=a.organization_id and c.id=a.asset_class_id where a.organization_id=app.require_organization_id() order by a.asset_number desc limit 300`.execute(this.database.db)).rows;
      case 'payroll': return (await sql`select r.id,p.code period,p.start_date,p.end_date,p.payment_date,r.status,r.currency_code from payroll.payroll_runs r join payroll.payroll_periods p on p.organization_id=r.organization_id and p.id=r.payroll_period_id where r.organization_id=app.require_organization_id() order by p.end_date desc`.execute(this.database.db)).rows;
      case 'manufacturing': return (await sql`select po.id,po.production_order_number,p.sku,p.name product,po.status,po.planned_quantity,po.completed_quantity,coalesce(w.wip_balance,0) wip_balance from manufacturing.production_orders po join inventory.products p on p.organization_id=po.organization_id and p.id=po.product_id left join manufacturing.production_wip_balances w on w.organization_id=po.organization_id and w.production_order_id=po.id where po.organization_id=app.require_organization_id() order by po.production_order_number desc`.execute(this.database.db)).rows;
      default: throw new NotFoundException();
    }
  }
}
