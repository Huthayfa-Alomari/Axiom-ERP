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
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const createRunSchema = z.object({ date: dateSchema });

interface RequestWithPrincipal {
  principal?: { id: string };
}

@Controller('fixed-assets')
export class FixedAssetsController {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  @Post('depreciation/runs')
  async createRun(
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
    @Body() rawBody: unknown,
  ) {
    const body = createRunSchema.safeParse(rawBody);
    if (!body.success) throw new BadRequestException(body.error.flatten());

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'fixed_assets.manage',
      async client => {
        const result = await client.query<{ run_id: string }>(
          'SELECT fixed_assets.generate_monthly_depreciation($1::date) AS run_id',
          [body.data.date],
        );
        return { runId: result.rows[0]!.run_id };
      },
    );
  }

  @Post('depreciation/runs/:runId/post')
  async postRun(
    @Param('runId') runIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const runId = uuidSchema.safeParse(runIdRaw);
    if (!runId.success) throw new BadRequestException('Invalid depreciation run ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'fixed_assets.manage',
      async client => {
        const result = await client.query<{ journal_entry_id: string | null }>(
          'SELECT fixed_assets.post_depreciation_run($1) AS journal_entry_id',
          [runId.data],
        );
        return {
          runId: runId.data,
          status: 'posted',
          journalEntryId: result.rows[0]?.journal_entry_id ?? null,
        };
      },
    );
  }

  @Get('depreciation/runs/:runId')
  async getRun(
    @Param('runId') runIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const runId = uuidSchema.safeParse(runIdRaw);
    if (!runId.success) throw new BadRequestException('Invalid depreciation run ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'fixed_assets.read',
      async (client, orgId) => {
        const run = await client.query(
          `SELECT id,period_start,period_end,status,journal_entry_id,
                  total_amount_base::text,created_at,posted_at
           FROM fixed_assets.depreciation_runs
           WHERE organization_id=$1 AND id=$2`,
          [orgId, runId.data],
        );
        if (run.rowCount !== 1) throw new BadRequestException('Depreciation run not found.');

        const lines = await client.query(
          `SELECT dl.id,dl.asset_id,a.code AS asset_code,a.name AS asset_name,
                  dl.amount_base::text
           FROM fixed_assets.depreciation_run_lines dl
           JOIN fixed_assets.assets a
             ON a.organization_id=dl.organization_id AND a.id=dl.asset_id
           WHERE dl.organization_id=$1 AND dl.run_id=$2
           ORDER BY a.asset_number`,
          [orgId, runId.data],
        );

        return { run: run.rows[0], lines: lines.rows };
      },
    );
  }
}
