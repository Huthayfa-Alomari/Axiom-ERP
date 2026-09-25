import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { PosTenantService, uuidSchema, type PosRequest } from './pos-tenant.service.js';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/);
const serialSettingsSchema = z.object({
  baudRate: z.number().int().min(1200).max(115200),
  dataBits: z.union([z.literal(7), z.literal(8)]),
  stopBits: z.union([z.literal(1), z.literal(2)]),
  parity: z.enum(['none', 'even', 'odd']),
  flowControl: z.enum(['none', 'hardware']),
  defaultUnit: z.enum(['kg', 'g']),
  readingKind: z.enum(['gross', 'net']),
  toleranceKg: decimal,
  maxWeightKg: decimal,
  maxAgeMs: z.number().int().min(250).max(10000),
}).refine(v => Number(v.toleranceKg) <= 0.1 &&
  Number(v.maxWeightKg) >= 0.001 && Number(v.maxWeightKg) <= 1000,
{ message: 'Invalid scale tolerance or capacity.' });

const weighableSchema = z.object({
  productId: uuidSchema,
  tareWeight: decimal,
  isActive: z.boolean().default(true),
});

@Controller('pos/terminals/:terminalId')
export class PosLiveScaleController {
  constructor(private readonly tenant: PosTenantService) {}

  private async terminal(client: PoolClient, organizationId: string, raw: string) {
    const id = uuidSchema.safeParse(raw);
    if (!id.success) throw new BadRequestException('Valid terminal ID is required.');
    const terminal = await client.query(
      `SELECT 1 FROM pos.terminals WHERE organization_id=$1 AND id=$2`,
      [organizationId, id.data],
    );
    if (terminal.rowCount !== 1) throw new BadRequestException('POS terminal not found.');
    return id.data;
  }

  @Get('live-scale')
  async getLiveScale(
    @Param('terminalId') terminalId: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: PosRequest,
  ) {
    return this.tenant.run(organizationId, request, 'pos.scale.read', async (client, org) => {
      const id = await this.terminal(client, org, terminalId);
      const [settings, catalog, organization] = await Promise.all([
        client.query<{
          baud_rate: number; data_bits: 7 | 8; stop_bits: 1 | 2;
          parity: 'none' | 'even' | 'odd'; flow_control: 'none' | 'hardware';
          default_unit: 'kg' | 'g'; reading_kind: 'gross' | 'net';
          tolerance_kg: string; max_weight_kg: string; max_age_ms: number;
        }>(
          `SELECT baud_rate,data_bits,stop_bits,parity,flow_control,default_unit,
                  reading_kind,tolerance_kg::text,max_weight_kg::text,max_age_ms
             FROM pos.terminal_serial_scales
            WHERE organization_id=$1 AND terminal_id=$2`, [org, id],
        ),
        client.query<{
          id: string; sku: string; name: string; sale_price: string;
          unit_code: string; tare_weight: string; available_quantity: string;
        }>(
          `SELECT p.id,p.sku,p.name,p.standard_sale_price::text AS sale_price,
                  u.code AS unit_code,w.tare_weight_kg::text AS tare_weight,
                  COALESCE(a.available_quantity,0)::text AS available_quantity
             FROM pos.weighable_products w
             JOIN inventory.products p ON p.organization_id=w.organization_id AND p.id=w.product_id
             JOIN inventory.units_of_measure u ON u.organization_id=p.organization_id AND u.id=p.base_uom_id
             LEFT JOIN inventory.available_stock a ON a.organization_id=p.organization_id
                   AND a.product_id=p.id AND a.warehouse_id=(
                     SELECT warehouse_id FROM pos.terminals WHERE organization_id=$1 AND id=$2)
            WHERE w.organization_id=$1 AND w.is_active AND p.is_active
              AND u.code IN ('KG','KGM') AND p.standard_sale_price>0
              AND round(p.standard_sale_price,4)=p.standard_sale_price
            ORDER BY p.name,p.sku`, [org, id],
        ),
        client.query<{ base_currency_code: string }>(
          `SELECT base_currency_code FROM app.organizations WHERE id=$1`, [org],
        ),
      ]);
      const row = settings.rows[0];
      return {
        currencyCode: organization.rows[0]!.base_currency_code,
        settings: row ? {
          baudRate: row.baud_rate, dataBits: row.data_bits, stopBits: row.stop_bits,
          parity: row.parity, flowControl: row.flow_control, defaultUnit: row.default_unit,
          readingKind: row.reading_kind, toleranceKg: row.tolerance_kg,
          maxWeightKg: row.max_weight_kg, maxAgeMs: row.max_age_ms,
        } : null,
        products: catalog.rows.map(p => ({
          id: p.id, sku: p.sku, name: p.name, salePrice: p.sale_price,
          unitCode: p.unit_code, tareWeight: p.tare_weight,
          availableQuantity: p.available_quantity,
        })),
      };
    });
  }

  @Post('serial-scale')
  async configureSerialScale(
    @Param('terminalId') terminalId: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: PosRequest,
    @Body() raw: unknown,
  ) {
    const parsed = serialSettingsSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tenant.run(organizationId, request, 'pos.scale.configure', async (client, org) => {
      const id = await this.terminal(client, org, terminalId);
      const v = parsed.data;
      await client.query(
        `INSERT INTO pos.terminal_serial_scales(
           organization_id,terminal_id,baud_rate,data_bits,stop_bits,parity,flow_control,
           default_unit,reading_kind,tolerance_kg,max_weight_kg,max_age_ms)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (organization_id,terminal_id) DO UPDATE SET
           baud_rate=EXCLUDED.baud_rate,data_bits=EXCLUDED.data_bits,stop_bits=EXCLUDED.stop_bits,
           parity=EXCLUDED.parity,flow_control=EXCLUDED.flow_control,
           default_unit=EXCLUDED.default_unit,reading_kind=EXCLUDED.reading_kind,
           tolerance_kg=EXCLUDED.tolerance_kg,max_weight_kg=EXCLUDED.max_weight_kg,
           max_age_ms=EXCLUDED.max_age_ms,updated_at=clock_timestamp(),
           updated_by=app.require_user_id()`,
        [org,id,v.baudRate,v.dataBits,v.stopBits,v.parity,v.flowControl,v.defaultUnit,
          v.readingKind,v.toleranceKg,v.maxWeightKg,v.maxAgeMs],
      );
      return { terminalId: id, settings: v };
    });
  }

  @Post('weighable-products')
  async configureWeighableProduct(
    @Param('terminalId') terminalId: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: PosRequest,
    @Body() raw: unknown,
  ) {
    const parsed = weighableSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tenant.run(organizationId, request, 'pos.scale.configure', async (client, org) => {
      await this.terminal(client, org, terminalId);
      const p = parsed.data;
      const product = await client.query(
        `SELECT 1 FROM inventory.products p
         JOIN inventory.units_of_measure u ON u.organization_id=p.organization_id AND u.id=p.base_uom_id
         WHERE p.organization_id=$1 AND p.id=$2 AND p.is_active AND u.code IN ('KG','KGM')
           AND p.standard_sale_price>0 AND round(p.standard_sale_price,4)=p.standard_sale_price`,
        [org, p.productId],
      );
      if (product.rowCount !== 1) {
        throw new BadRequestException('An active kilogram product with a positive four-decimal price is required.');
      }
      await client.query(
        `INSERT INTO pos.weighable_products(organization_id,product_id,tare_weight_kg,is_active)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (organization_id,product_id) DO UPDATE SET
           tare_weight_kg=EXCLUDED.tare_weight_kg,is_active=EXCLUDED.is_active,
           updated_at=clock_timestamp(),updated_by=app.require_user_id()`,
        [org, p.productId, p.tareWeight, p.isActive],
      );
      return { ...p, terminalId };
    });
  }
}
