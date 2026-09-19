import { Controller, Get, Query } from '@nestjs/common';
import { CurrentTenant } from '../../common/tenant/current-tenant.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import type { TenantRequestContext } from '../../infrastructure/database/database.service.js';
import { FinancialReportingService } from './application/financial-reporting.service.js';
import {
  balanceSheetQuerySchema,
  cashFlowQuerySchema,
  drillDownQuerySchema,
  profitAndLossQuerySchema,
  reconciliationQuerySchema,
  trialBalanceQuerySchema,
  type BalanceSheetQuery,
  type CashFlowQuery,
  type DrillDownQuery,
  type ProfitAndLossQuery,
  type ReconciliationQuery,
  type TrialBalanceQuery,
} from './dto/financial-reporting.dto.js';

@Controller('reports/financial')
export class ReportingController {
  constructor(private readonly reporting: FinancialReportingService) {}

  @Get('profit-and-loss')
  profitAndLoss(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(profitAndLossQuerySchema)) query: ProfitAndLossQuery,
  ) {
    return this.reporting.profitAndLoss(ctx, query);
  }

  @Get('balance-sheet')
  balanceSheet(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
  ) {
    return this.reporting.balanceSheet(ctx, query);
  }

  @Get('cash-flow')
  cashFlow(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(cashFlowQuerySchema)) query: CashFlowQuery,
  ) {
    return this.reporting.cashFlow(ctx, query);
  }

  @Get('trial-balance')
  trialBalance(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery,
  ) {
    return this.reporting.trialBalance(ctx, query);
  }

  @Get('drill-down')
  drillDown(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(drillDownQuerySchema)) query: DrillDownQuery,
  ) {
    return this.reporting.drillDown(ctx, query);
  }

  @Get('reconciliation')
  reconciliation(
    @CurrentTenant() ctx: TenantRequestContext,
    @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery,
  ) {
    return this.reporting.reconciliation(ctx, query);
  }
}
