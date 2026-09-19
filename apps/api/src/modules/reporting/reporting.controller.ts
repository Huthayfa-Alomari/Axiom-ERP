import { Controller, Get, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../infrastructure/database/database.service';

@Controller('reports/financial')
export class ReportingController {
  constructor(private readonly database: DatabaseService) {}
  @Get('profit-and-loss') async pnl(@Query('startDate') startDate:string,@Query('endDate') endDate:string) {
    return (await sql`select * from reporting.get_profit_and_loss(${startDate}::date,${endDate}::date)`.execute(this.database.db)).rows;
  }
  @Get('balance-sheet') async balance(@Query('asOfDate') asOfDate:string) {
    return (await sql`select * from reporting.get_balance_sheet(${asOfDate}::date)`.execute(this.database.db)).rows;
  }
  @Get('cash-flow') async cashFlow(@Query('startDate') startDate:string,@Query('endDate') endDate:string) {
    return (await sql`select * from reporting.get_cash_flow_direct(${startDate}::date,${endDate}::date)`.execute(this.database.db)).rows;
  }
  @Get('reconciliation') async reconciliation(@Query('asOfDate') asOfDate:string) {
    const rows=(await sql<any>`select * from reconciliation.run_suite(${asOfDate}::date)`.execute(this.database.db)).rows;
    return { healthy: rows.every((r:any)=>r.passed), modules: rows };
  }
}
