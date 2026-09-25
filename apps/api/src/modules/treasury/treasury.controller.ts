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
const autoMatchSchema = z.object({
  windowDays: z.number().int().min(0).max(30).default(3),
});
const finalizeSchema = z.object({
  tolerance: z.string().regex(/^\d+(\.\d{1,8})?$/).default('0.00000001'),
});

interface RequestWithPrincipal {
  principal?: { id: string };
}

@Controller('treasury')
export class TreasuryController {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  @Post('statements/:statementId/auto-match')
  async autoMatch(
    @Param('statementId') statementIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const statementId = uuidSchema.safeParse(statementIdRaw);
    const body = autoMatchSchema.safeParse(rawBody ?? {});

    if (!statementId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid statement ID.' : body.error.flatten());
    }

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'treasury.reconcile',
      async client => {
        const result = await client.query<{ matched_count: number }>(
          'SELECT treasury.auto_match_statement($1,$2) AS matched_count',
          [statementId.data, body.data.windowDays],
        );
        return { matchedCount: result.rows[0]?.matched_count ?? 0 };
      },
    );
  }

  @Post('statements/:statementId/finalize')
  async finalize(
    @Param('statementId') statementIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const statementId = uuidSchema.safeParse(statementIdRaw);
    const body = finalizeSchema.safeParse(rawBody ?? {});

    if (!statementId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid statement ID.' : body.error.flatten());
    }

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'treasury.reconcile',
      async client => {
        await client.query(
          'SELECT treasury.finalize_bank_statement($1,$2::numeric)',
          [statementId.data, body.data.tolerance],
        );
        return { statementId: statementId.data, status: 'reconciled' };
      },
    );
  }

  @Get('statements/:statementId/reconciliation')
  async status(
    @Param('statementId') statementIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const statementId = uuidSchema.safeParse(statementIdRaw);
    if (!statementId.success) throw new BadRequestException('Invalid statement ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'treasury.read',
      async (client, orgId) => {
        const statement = await client.query(
          `SELECT id,bank_account_id,statement_number,period_start,period_end,
                  opening_balance::text,closing_balance::text,status
           FROM treasury.bank_statements
           WHERE organization_id=$1 AND id=$2`,
          [orgId, statementId.data],
        );
        if (statement.rowCount !== 1) throw new BadRequestException('Bank statement not found.');

        const unmatchedStatementLines = await client.query(
          `SELECT statement_line_id,line_number,transaction_date,amount::text,
                  matched_amount::text,remaining_amount::text,description,bank_reference
           FROM treasury.unreconciled_statement_lines
           WHERE organization_id=$1 AND statement_id=$2
           ORDER BY line_number`,
          [orgId, statementId.data],
        );

        const bankAccountId = (statement.rows[0] as { bank_account_id: string }).bank_account_id;
        const outstandingBookLines = await client.query(
          `SELECT journal_line_id,journal_entry_id,entry_date,statement_currency_effect::text,
                  matched_amount::text,remaining_amount::text,reference_type,reference_id,description
           FROM treasury.unreconciled_gl_bank_lines
           WHERE organization_id=$1 AND bank_account_id=$2
           ORDER BY entry_date,journal_line_id`,
          [orgId, bankAccountId],
        );

        return {
          statement: statement.rows[0],
          unmatchedStatementLines: unmatchedStatementLines.rows,
          outstandingBookLines: outstandingBookLines.rows,
        };
      },
    );
  }
}
