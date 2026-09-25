import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { TenantDatabaseService } from '../../infrastructure/database/tenant-database.service.js';

const uuidSchema = z.string().uuid();
const decimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const componentSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(160),
  kind: z.enum(['earning','deduction','employer_cost']),
  expenseAccountId: z.string().uuid().nullable().optional(),
  liabilityAccountId: z.string().uuid().nullable().optional(),
});

const assignmentSchema = z.object({
  componentId: z.string().uuid(),
  amountBase: decimalSchema,
  effectiveFrom: dateSchema,
  effectiveTo: dateSchema.nullable().optional(),
});

const disburseSchema = z.object({
  cashAccountId: z.string().uuid(),
  paymentDate: dateSchema.optional(),
});

interface RequestWithPrincipal {
  principal?: { id: string };
}

@Controller('payroll')
export class PayrollController {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  @Post('components')
  async createComponent(
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const body = componentSchema.safeParse(rawBody);
    if (!body.success) throw new BadRequestException(body.error.flatten());

    if (
      body.data.kind === 'deduction'
      && !body.data.liabilityAccountId
    ) {
      throw new BadRequestException('Deduction component requires liabilityAccountId.');
    }

    if (
      body.data.kind === 'employer_cost'
      && (!body.data.expenseAccountId || !body.data.liabilityAccountId)
    ) {
      throw new BadRequestException('Employer cost requires expense and liability accounts.');
    }

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.manage',
      async (client, orgId) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO payroll.pay_components(
             organization_id,code,name,kind,expense_account_id,liability_account_id
           ) VALUES($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [
            orgId,
            body.data.code,
            body.data.name,
            body.data.kind,
            body.data.expenseAccountId ?? null,
            body.data.liabilityAccountId ?? null,
          ],
        );
        return { id: result.rows[0]!.id, ...body.data };
      },
    );
  }

  @Post('employees/:employeeId/components')
  async assignComponent(
    @Param('employeeId') employeeIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const employeeId = uuidSchema.safeParse(employeeIdRaw);
    const body = assignmentSchema.safeParse(rawBody);

    if (!employeeId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid employee ID.' : body.error.flatten());
    }

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.manage',
      async (client, orgId) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO payroll.employee_component_assignments(
             organization_id,employee_id,component_id,amount_base,effective_from,effective_to
           )
           VALUES($1,$2,$3,$4::numeric,$5::date,$6::date)
           RETURNING id`,
          [
            orgId,
            employeeId.data,
            body.data.componentId,
            body.data.amountBase,
            body.data.effectiveFrom,
            body.data.effectiveTo ?? null,
          ],
        );
        return { id: result.rows[0]!.id, employeeId: employeeId.data, ...body.data };
      },
    );
  }

  @Post('periods/:periodId/runs/generate')
  async generateRun(
    @Param('periodId') periodIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const periodId = uuidSchema.safeParse(periodIdRaw);
    if (!periodId.success) throw new BadRequestException('Invalid payroll period ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.manage',
      async client => {
        const result = await client.query<{ run_id: string }>(
          'SELECT payroll.generate_run($1) AS run_id',
          [periodId.data],
        );
        return { runId: result.rows[0]!.run_id };
      },
    );
  }

  @Post('runs/:runId/post')
  async postRun(
    @Param('runId') runIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const runId = uuidSchema.safeParse(runIdRaw);
    if (!runId.success) throw new BadRequestException('Invalid payroll run ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.manage',
      async client => {
        const result = await client.query<{ journal_entry_id: string }>(
          'SELECT payroll.post_run($1) AS journal_entry_id',
          [runId.data],
        );
        return { runId: runId.data, status: 'posted', journalEntryId: result.rows[0]!.journal_entry_id };
      },
    );
  }

  @Post('runs/:runId/disburse')
  async disburseRun(
    @Param('runId') runIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const runId = uuidSchema.safeParse(runIdRaw);
    const body = disburseSchema.safeParse(rawBody);

    if (!runId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid payroll run ID.' : body.error.flatten());
    }

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.manage',
      async client => {
        const result = await client.query<{ journal_entry_id: string }>(
          'SELECT payroll.disburse_run($1,$2,$3::date) AS journal_entry_id',
          [runId.data, body.data.cashAccountId, body.data.paymentDate ?? null],
        );
        return { runId: runId.data, status: 'paid', journalEntryId: result.rows[0]!.journal_entry_id };
      },
    );
  }

  @Get('runs/:runId')
  async getRun(
    @Param('runId') runIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const runId = uuidSchema.safeParse(runIdRaw);
    if (!runId.success) throw new BadRequestException('Invalid payroll run ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'payroll.read',
      async (client, orgId) => {
        const run = await client.query(
          `SELECT r.id,r.status,r.currency_code,r.journal_entry_id,r.payment_journal_entry_id,
                  p.code AS period,p.start_date,p.end_date,p.payment_date,p.is_closed
           FROM payroll.payroll_runs r
           JOIN payroll.payroll_periods p
             ON p.organization_id=r.organization_id AND p.id=r.payroll_period_id
           WHERE r.organization_id=$1 AND r.id=$2`,
          [orgId, runId.data],
        );

        if (run.rowCount !== 1) throw new BadRequestException('Payroll run not found.');

        const employees = await client.query(
          `SELECT re.id,re.employee_id,e.code AS employee_code,e.full_name,
                  re.gross_earnings_base::text,re.deductions_base::text,
                  re.employer_cost_base::text,re.net_pay_base::text
           FROM payroll.run_employees re
           JOIN hr.employees e
             ON e.organization_id=re.organization_id AND e.id=re.employee_id
           WHERE re.organization_id=$1 AND re.run_id=$2
           ORDER BY e.employee_number`,
          [orgId, runId.data],
        );

        return { run: run.rows[0], employees: employees.rows };
      },
    );
  }
}
