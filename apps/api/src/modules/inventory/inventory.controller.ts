import {
  BadRequestException,
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

interface RequestWithPrincipal {
  principal?: { id: string };
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly tenantDb: TenantDatabaseService) {}

  @Post('documents/:documentId/post')
  async postDocument(
    @Param('documentId') documentIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const documentId = uuidSchema.safeParse(documentIdRaw);
    if (!documentId.success) throw new BadRequestException('Invalid inventory document ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'inventory.post',
      async client => {
        const result = await client.query<{ journal_entry_id: string | null }>(
          'SELECT inventory.post_document($1) AS journal_entry_id',
          [documentId.data],
        );

        return {
          documentId: documentId.data,
          status: 'posted',
          journalEntryId: result.rows[0]?.journal_entry_id ?? null,
        };
      },
    );
  }

  @Get('products/:productId/stock')
  async stock(
    @Param('productId') productIdRaw: string,
    @Headers('x-organization-id') organizationId: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    const productId = uuidSchema.safeParse(productIdRaw);
    if (!productId.success) throw new BadRequestException('Invalid product ID.');

    return this.tenantDb.run(
      organizationId,
      request.principal?.id,
      'inventory.read',
      async (client, orgId) => {
        const rows = await client.query(
          `SELECT
             warehouse_id,
             quantity_on_hand::text,
             reserved_quantity::text,
             available_quantity::text
           FROM inventory.available_stock
           WHERE organization_id=$1 AND product_id=$2
           ORDER BY warehouse_id`,
          [orgId, productId.data],
        );
        return { productId: productId.data, warehouses: rows.rows };
      },
    );
  }
}
