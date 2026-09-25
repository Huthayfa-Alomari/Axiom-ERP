import Decimal from 'decimal.js';
import { parseScaleBarcode } from './parser';
import type { LocalScaleMapping, LocalScaleProfile, ScaleBarcodeMetadata } from './types.js';
import type { WeighableProduct } from './live-cart.js';
export type { LocalScaleMapping, LocalScaleProfile } from './types.js';

export interface BarcodeScaleLine {
  id: string;
  product: WeighableProduct;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  source: 'scale_barcode';
  scanMetadata: ScaleBarcodeMetadata;
}

export function priceBarcodeScaleLine(
  barcode: string,
  profiles: readonly LocalScaleProfile[],
  mappings: readonly LocalScaleMapping[],
  products: readonly WeighableProduct[],
  existing: readonly ({ source: 'scale_barcode'; scanMetadata: { barcode: string } } | { source: 'live_scale' })[],
): BarcodeScaleLine {
  if (existing.some(line => line.source === 'scale_barcode' && line.scanMetadata.barcode === barcode)) {
    throw new Error('SCALE_BARCODE_ALREADY_IN_CART');
  }
  const parsed = parseScaleBarcode(barcode, profiles, mappings);
  if (!parsed) throw new Error('SCALE_BARCODE_NOT_RECOGNIZED');
  if (parsed.metadata.measureKind !== 'weight' || !parsed.metadata.netWeight) {
    throw new Error('SCALE_PRICE_LABEL_NEEDS_WEIGHT');
  }
  const product = products.find(item => item.id === parsed.mapping.productId);
  if (!product) throw new Error('SCALE_PRODUCT_NOT_IN_CATALOG');
  if (!['KG', 'KGM'].includes(product.unitCode.toUpperCase())) {
    throw new Error('SCALE_PRODUCT_MUST_USE_KILOGRAMS');
  }
  const quantity = new Decimal(parsed.metadata.netWeight);
  const unitPrice = new Decimal(product.salePrice);
  if (!quantity.isFinite() || quantity.lte(0) || !unitPrice.isFinite() || unitPrice.lte(0)) {
    throw new Error('SCALE_INVALID_NET_WEIGHT_OR_PRICE');
  }
  if (quantity.decimalPlaces() > 4 || unitPrice.decimalPlaces() > 4) {
    throw new Error('SCALE_PRECISION_EXCEEDS_FOUR_DECIMALS');
  }
  return {
    id: crypto.randomUUID(), product, quantity: quantity.toFixed(),
    unitPrice: unitPrice.toFixed(),
    lineTotal: quantity.mul(unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    source: 'scale_barcode', scanMetadata: parsed.metadata,
  };
}
