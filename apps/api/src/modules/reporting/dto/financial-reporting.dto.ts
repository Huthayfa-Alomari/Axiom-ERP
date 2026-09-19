import { z } from 'zod';

const dateRangeFields = {
  startDate: z.iso.date(),
  endDate: z.iso.date(),
};

const validDateRange = <T extends { startDate: string; endDate: string }>(value: T) =>
  value.startDate <= value.endDate;

const dateRangeSchema = z.object(dateRangeFields).refine(validDateRange, {
  message: 'startDate must be on or before endDate',
  path: ['startDate'],
});

export const profitAndLossQuerySchema = dateRangeSchema;
export type ProfitAndLossQuery = z.infer<typeof profitAndLossQuerySchema>;

export const balanceSheetQuerySchema = z.object({
  asOfDate: z.iso.date(),
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;

export const cashFlowQuerySchema = z.object({
  ...dateRangeFields,
  method: z.enum(['direct', 'indirect']).default('direct'),
}).refine(validDateRange, {
  message: 'startDate must be on or before endDate',
  path: ['startDate'],
});
export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;

export const trialBalanceQuerySchema = dateRangeSchema;
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const reconciliationQuerySchema = z.object({
  asOfDate: z.iso.date(),
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;

export const drillDownQuerySchema = z.object({
  accountId: z.uuid().optional(),
  lineKey: z.enum(['current_earnings']).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((value) => Boolean(value.accountId) !== Boolean(value.lineKey), {
  message: 'Provide exactly one of accountId or lineKey',
  path: ['accountId'],
}).refine((value) => !value.startDate || value.startDate <= value.endDate, {
  message: 'startDate must be on or before endDate',
  path: ['startDate'],
});
export type DrillDownQuery = z.infer<typeof drillDownQuerySchema>;
