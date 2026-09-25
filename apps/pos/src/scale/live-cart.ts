import Decimal from 'decimal.js';
import type { StableScaleReading } from './live-scale.js';

export interface WeighableProduct {
  id: string;
  sku: string;
  name: string;
  salePrice: string;
  unitCode: string;
  tareWeight: string;
}

export interface LiveScaleLine {
  id: string;
  product: WeighableProduct;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  source: 'live_scale';
  scanMetadata: {
    source: 'live_scale';
    capturedAt: string;
    measuredWeightKg: string;
    deviceUnit: 'kg' | 'g';
    readingKind: 'gross' | 'net';
    tareWeightKg: string;
    netWeightKg: string;
    stableSamples: number;
  };
}

export function priceLiveScaleLine(
  product: WeighableProduct,
  reading: StableScaleReading,
  defaultKind: 'gross' | 'net',
): LiveScaleLine {
  if (!['KG', 'KGM'].includes(product.unitCode.toUpperCase())) {
    throw new Error('SCALE_PRODUCT_MUST_USE_KILOGRAMS');
  }
  const kind = reading.readingKind ?? defaultKind;
  const measured = new Decimal(reading.weightKg);
  const tare = kind === 'gross' ? new Decimal(product.tareWeight) : new Decimal(0);
  const price = new Decimal(product.salePrice);
  const net = measured.minus(tare);
  if (!net.isFinite() || !price.isFinite() || net.lte(0) || price.lte(0)) {
    throw new Error('SCALE_INVALID_NET_WEIGHT_OR_PRICE');
  }
  if (net.decimalPlaces() > 4 || price.decimalPlaces() > 4) {
    throw new Error('SCALE_PRECISION_EXCEEDS_FOUR_DECIMALS');
  }
  return {
    id: crypto.randomUUID(),
    product,
    quantity: net.toFixed(),
    unitPrice: price.toFixed(),
    lineTotal: net.mul(price).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
    source: 'live_scale',
    scanMetadata: {
      source: 'live_scale',
      capturedAt: reading.capturedAt,
      measuredWeightKg: reading.weightKg,
      deviceUnit: reading.deviceUnit,
      readingKind: kind,
      tareWeightKg: tare.toFixed(),
      netWeightKg: net.toFixed(),
      stableSamples: reading.stableSamples,
    },
  };
}

export function totalLiveScaleLines(lines: readonly LiveScaleLine[]): string {
  return lines.reduce((total, line) => total.plus(line.lineTotal), new Decimal(0)).toFixed(4);
}
