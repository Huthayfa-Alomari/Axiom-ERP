import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../infrastructure/database/database.service.js';

interface AuthenticatedRequest {
  principal?: { id: string; email: string | null };
}

interface ScaleConfigRow {
  priority: number;
  profile_id: string;
  profile_code: string;
  profile_name: string;
  symbology: 'EAN13';
  total_length: number;
  accepted_prefixes: string[];
  plu_start: number;
  plu_length: number;
  measure_start: number;
  measure_length: number;
  measure_kind: 'weight' | 'price';
  measure_decimals: number;
  checksum_mode: 'ean13' | 'none';
  plu: string;
  product_id: string;
  tare_weight: string;
}

const uuidSchema = z.string().uuid();

@Controller('pos')
export class PosScaleController {
  constructor(private readonly database: DatabaseService) {}

  @Get('terminals/:terminalId/scale-config')
  async getScaleConfiguration(
    @Param('terminalId') terminalIdRaw: string,
    @Headers('x-organization-id') organizationIdRaw: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    const terminalId = uuidSchema.safeParse(terminalIdRaw);
    const organizationId = uuidSchema.safeParse(organizationIdRaw);

    if (!terminalId.success || !organizationId.success) {
      throw new BadRequestException('Valid terminal and organization IDs are required.');
    }

    if (!request.principal?.id) {
      throw new ForbiddenException('Authenticated principal required.');
    }

    const client = await this.database.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('app.organization_id',$1,true), set_config('app.user_id',$2,true)",
        [organizationId.data, request.principal.id],
      );

      const membership = await client.query<{ allowed: boolean }>(
        `SELECT EXISTS (
          SELECT 1
          FROM app.memberships
          WHERE organization_id=$1
            AND user_id=$2
            AND is_active
        ) AS allowed`,
        [organizationId.data, request.principal.id],
      );

      if (!membership.rows[0]?.allowed) {
        throw new ForbiddenException('User is not an active organization member.');
      }

      const terminal = await client.query(
        `SELECT 1
         FROM pos.terminals
         WHERE organization_id=$1 AND id=$2`,
        [organizationId.data, terminalId.data],
      );

      if (terminal.rowCount !== 1) {
        throw new BadRequestException('POS terminal not found.');
      }

      const result = await client.query<ScaleConfigRow>(
        `SELECT
           priority, profile_id, profile_code, profile_name, symbology,
           total_length, accepted_prefixes, plu_start, plu_length,
           measure_start, measure_length, measure_kind, measure_decimals,
           checksum_mode, plu, product_id, tare_weight::text
         FROM pos.terminal_scale_configuration
         WHERE organization_id=$1 AND terminal_id=$2
         ORDER BY priority, profile_code, plu`,
        [organizationId.data, terminalId.data],
      );

      const profiles = new Map<string, {
        id: string;
        code: string;
        name: string;
        priority: number;
        symbology: 'EAN13';
        totalLength: number;
        acceptedPrefixes: string[];
        pluStart: number;
        pluLength: number;
        measureStart: number;
        measureLength: number;
        measureKind: 'weight' | 'price';
        measureDecimals: number;
        checksumMode: 'ean13' | 'none';
      }>();

      const mappings = result.rows.map(row => {
        if (!profiles.has(row.profile_id)) {
          profiles.set(row.profile_id, {
            id: row.profile_id,
            code: row.profile_code,
            name: row.profile_name,
            priority: row.priority,
            symbology: row.symbology,
            totalLength: row.total_length,
            acceptedPrefixes: row.accepted_prefixes,
            pluStart: row.plu_start,
            pluLength: row.plu_length,
            measureStart: row.measure_start,
            measureLength: row.measure_length,
            measureKind: row.measure_kind,
            measureDecimals: row.measure_decimals,
            checksumMode: row.checksum_mode,
          });
        }

        return {
          id: `${row.profile_id}:${row.plu}`,
          profileId: row.profile_id,
          plu: row.plu,
          productId: row.product_id,
          tareWeight: row.tare_weight,
        };
      });

      await client.query('COMMIT');

      return {
        profiles: [...profiles.values()],
        mappings,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
