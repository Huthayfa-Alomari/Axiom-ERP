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
import { PosTenantService, uuidSchema, type PosRequest } from './pos-tenant.service.js';

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

const decimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/);

const createProfileSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(160),
  preset: z.enum(['EAN13_WEIGHT_20', 'EAN13_PRICE_20']).optional(),
  acceptedPrefixes: z.array(z.string().regex(/^\d+$/)).min(1).default(['20']),
  totalLength: z.number().int().min(8).max(32).default(13),
  pluStart: z.number().int().min(0).default(2),
  pluLength: z.number().int().positive().default(5),
  measureStart: z.number().int().min(0).default(7),
  measureLength: z.number().int().positive().default(5),
  measureKind: z.enum(['weight', 'price']).optional(),
  measureDecimals: z.number().int().min(0).max(8).optional(),
  checksumMode: z.enum(['ean13', 'none']).default('ean13'),
  priority: z.number().int().min(0).default(100),
});

const mappingSchema = z.object({
  plu: z.string().regex(/^\d+$/).max(32),
  productId: z.string().uuid(),
  tareWeight: decimalSchema.default('0'),
});

@Controller('pos')
export class PosScaleController {
  constructor(private readonly tenant: PosTenantService) {}

  @Get('terminals/:terminalId/scale-config')
  async getScaleConfiguration(
    @Param('terminalId') terminalIdRaw: string,
    @Headers('x-organization-id') organizationIdRaw: string | undefined,
    @Req() request: PosRequest,
  ) {
    const terminalId = uuidSchema.safeParse(terminalIdRaw);
    if (!terminalId.success) {
      throw new BadRequestException('Valid terminal ID is required.');
    }

    return this.tenant.run(
      organizationIdRaw,
      request,
      'pos.scale.read',
      async (client, organizationId) => {
        const terminal = await client.query(
          `SELECT 1 FROM pos.terminals
           WHERE organization_id=$1 AND id=$2`,
          [organizationId, terminalId.data],
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
          [organizationId, terminalId.data],
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

        return { profiles: [...profiles.values()], mappings };
      },
    );
  }

  @Post('terminals/:terminalId/scale-profiles')
  async createScaleProfile(
    @Param('terminalId') terminalIdRaw: string,
    @Headers('x-organization-id') organizationIdRaw: string | undefined,
    @Req() request: PosRequest,
    @Body() rawBody: unknown,
  ) {
    const terminalId = uuidSchema.safeParse(terminalIdRaw);
    const body = createProfileSchema.safeParse(rawBody);

    if (!terminalId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid terminal ID.' : body.error.flatten());
    }

    const presetKind =
      body.data.preset === 'EAN13_PRICE_20'
        ? 'price'
        : body.data.preset === 'EAN13_WEIGHT_20'
          ? 'weight'
          : undefined;

    const measureKind = body.data.measureKind ?? presetKind ?? 'weight';
    const measureDecimals =
      body.data.measureDecimals ?? (measureKind === 'weight' ? 3 : 2);

    if (body.data.pluStart + body.data.pluLength > body.data.totalLength) {
      throw new BadRequestException('PLU segment exceeds barcode length.');
    }
    if (body.data.measureStart + body.data.measureLength > body.data.totalLength) {
      throw new BadRequestException('Measure segment exceeds barcode length.');
    }

    return this.tenant.run(
      organizationIdRaw,
      request,
      'pos.scale.configure',
      async (client, organizationId) => {
        const terminal = await client.query(
          `SELECT 1 FROM pos.terminals
           WHERE organization_id=$1 AND id=$2`,
          [organizationId, terminalId.data],
        );
        if (terminal.rowCount !== 1) throw new BadRequestException('POS terminal not found.');

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO pos.scale_barcode_profiles(
             organization_id,code,name,symbology,total_length,accepted_prefixes,
             plu_start,plu_length,measure_start,measure_length,measure_kind,
             measure_decimals,checksum_mode
           )
           VALUES($1,$2,$3,'EAN13',$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            organizationId,
            body.data.code,
            body.data.name,
            body.data.totalLength,
            body.data.acceptedPrefixes,
            body.data.pluStart,
            body.data.pluLength,
            body.data.measureStart,
            body.data.measureLength,
            measureKind,
            measureDecimals,
            body.data.checksumMode,
          ],
        );

        const profileId = inserted.rows[0]!.id;

        await client.query(
          `INSERT INTO pos.terminal_scale_profiles(
             organization_id,terminal_id,profile_id,priority
           ) VALUES($1,$2,$3,$4)`,
          [organizationId, terminalId.data, profileId, body.data.priority],
        );

        return {
          id: profileId,
          terminalId: terminalId.data,
          code: body.data.code,
          measureKind,
          measureDecimals,
        };
      },
    );
  }

  @Post('scale-profiles/:profileId/mappings')
  async upsertPluMapping(
    @Param('profileId') profileIdRaw: string,
    @Headers('x-organization-id') organizationIdRaw: string | undefined,
    @Req() request: PosRequest,
    @Body() rawBody: unknown,
  ) {
    const profileId = uuidSchema.safeParse(profileIdRaw);
    const body = mappingSchema.safeParse(rawBody);

    if (!profileId.success || !body.success) {
      throw new BadRequestException(body.success ? 'Invalid profile ID.' : body.error.flatten());
    }

    return this.tenant.run(
      organizationIdRaw,
      request,
      'pos.scale.configure',
      async (client, organizationId) => {
        const profile = await client.query<{ plu_length: number }>(
          `SELECT plu_length FROM pos.scale_barcode_profiles
           WHERE organization_id=$1 AND id=$2 AND is_active`,
          [organizationId, profileId.data],
        );

        if (profile.rowCount !== 1) throw new BadRequestException('Scale profile not found.');
        if (body.data.plu.length !== profile.rows[0]!.plu_length) {
          throw new BadRequestException(
            `PLU must contain exactly ${profile.rows[0]!.plu_length} digits.`,
          );
        }

        const product = await client.query(
          `SELECT 1 FROM inventory.products
           WHERE organization_id=$1 AND id=$2 AND is_active`,
          [organizationId, body.data.productId],
        );
        if (product.rowCount !== 1) throw new BadRequestException('Active product not found.');

        await client.query(
          `DELETE FROM pos.scale_plu_mappings
           WHERE organization_id=$1
             AND profile_id=$2
             AND (plu=$3 OR product_id=$4)`,
          [organizationId, profileId.data, body.data.plu, body.data.productId],
        );

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO pos.scale_plu_mappings(
             organization_id,profile_id,plu,product_id,tare_weight
           ) VALUES($1,$2,$3,$4,$5)
           RETURNING id`,
          [
            organizationId,
            profileId.data,
            body.data.plu,
            body.data.productId,
            body.data.tareWeight,
          ],
        );

        return {
          id: inserted.rows[0]!.id,
          profileId: profileId.data,
          plu: body.data.plu,
          productId: body.data.productId,
          tareWeight: body.data.tareWeight,
        };
      },
    );
  }
}
