import { z } from 'zod';
import { scaleBarcodeMetadataSchema } from './scale-barcode.js';

const decimal=z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/);

export const posSyncBatchSchema=z.object({
  clientBatchId:z.string().uuid(),
  firstSequence:z.number().int().positive(),
  lastSequence:z.number().int().positive(),
  commands:z.array(z.object({
    commandId:z.string().uuid(),
    sequence:z.number().int().positive(),
    type:z.literal('POS_SALE'),
    payload:z.object({
      clientSaleId:z.string().uuid(),
      sessionId:z.string().uuid(),
      saleDate:z.string(),
      stockSnapshotRevision:z.string(),
      lines:z.array(z.object({
        productId:z.string().uuid(),
        quantity:decimal,
        unitPriceSnapshot:decimal,
        lineTotalSnapshot:decimal.optional(),
        discountAmount:decimal.default('0'),
        source:z.enum(['manual','standard_barcode','scale_barcode']).default('manual'),
        scanMetadata:scaleBarcodeMetadataSchema.optional(),
      })).min(1),
      payments:z.array(z.object({
        paymentMethodId:z.string().uuid(),
        amount:decimal
      })).min(1)
    })
  })).min(1)
});

export type PosSyncBatch=z.infer<typeof posSyncBatchSchema>;
