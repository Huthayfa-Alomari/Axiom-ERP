import Decimal from 'decimal.js';
import { getPosDb, type LocalProduct } from '../db/pos-db.js';
import { parseScaleBarcode } from './parser.js';
import type { ScaleBarcodeMetadata } from './types.js';

export interface ResolvedScanLine {
  product: LocalProduct;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  source: 'standard_barcode' | 'scale_barcode';
  scanMetadata: ScaleBarcodeMetadata | null;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed();
}

export async function resolveScannedBarcode(barcode: string): Promise<ResolvedScanLine> {
  const db = await getPosDb();

  const normalProduct = await db.getFromIndex('products', 'barcode', barcode);
  if (normalProduct) {
    const unitPrice = new Decimal(normalProduct.salePrice);
    return {
      product: normalProduct,
      quantity: '1',
      unitPrice: unitPrice.toFixed(),
      lineTotal: money(unitPrice),
      source: 'standard_barcode',
      scanMetadata: null,
    };
  }

  const [profiles, mappings] = await Promise.all([
    db.getAll('scaleProfiles'),
    db.getAll('scaleMappings'),
  ]);

  const parsed = parseScaleBarcode(barcode, profiles, mappings);
  if (!parsed) throw new Error('BARCODE_NOT_FOUND');

  const product = await db.get('products', parsed.mapping.productId);
  if (!product) throw new Error('SCALE_PRODUCT_NOT_CACHED');

  const unitPrice = new Decimal(product.salePrice);
  if (unitPrice.lte(0)) throw new Error('SCALE_PRODUCT_PRICE_MUST_BE_POSITIVE');

  if (parsed.metadata.measureKind === 'weight') {
    const quantity = new Decimal(parsed.metadata.netWeight!);
    return {
      product,
      quantity: quantity.toDecimalPlaces(8).toFixed(),
      unitPrice: unitPrice.toFixed(),
      lineTotal: money(quantity.mul(unitPrice)),
      source: 'scale_barcode',
      scanMetadata: parsed.metadata,
    };
  }

  const lineTotal = new Decimal(parsed.metadata.embeddedPrice!);
  const quantity = lineTotal.div(unitPrice).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);

  if (quantity.lte(0)) throw new Error('SCALE_DERIVED_QUANTITY_MUST_BE_POSITIVE');

  return {
    product,
    quantity: quantity.toFixed(),
    unitPrice: unitPrice.toFixed(),
    lineTotal: money(lineTotal),
    source: 'scale_barcode',
    scanMetadata: parsed.metadata,
  };
}
