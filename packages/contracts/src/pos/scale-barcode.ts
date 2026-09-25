import { z } from 'zod';

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,8})?$/);

export const scaleBarcodeMetadataSchema = z.object({
  source: z.literal('scale_barcode'),
  barcode: z.string().regex(/^\d+$/),
  profileId: z.string().uuid(),
  profileCode: z.string().min(1),
  plu: z.string().regex(/^\d+$/),
  measureKind: z.enum(['weight', 'price']),
  measuredValue: decimal,
  netWeight: decimal.nullable(),
  embeddedPrice: decimal.nullable(),
}).superRefine((value, ctx) => {
  if (value.measureKind === 'weight' && value.netWeight === null) {
    ctx.addIssue({ code: 'custom', path: ['netWeight'], message: 'Weight barcode requires netWeight' });
  }
  if (value.measureKind === 'price' && value.embeddedPrice === null) {
    ctx.addIssue({ code: 'custom', path: ['embeddedPrice'], message: 'Price barcode requires embeddedPrice' });
  }
});

export type ScaleBarcodeMetadata = z.infer<typeof scaleBarcodeMetadataSchema>;
