import { describe, expect, it } from 'vitest';
import { appendEan13CheckDigit } from './ean13.js';
import { priceBarcodeScaleLine } from './barcode-cart.js';
import type { LocalScaleMapping, LocalScaleProfile } from './types.js';

const profile: LocalScaleProfile = {
  id: 'p', code: 'WEIGHT', name: 'Scale', priority: 1, symbology: 'EAN13',
  totalLength: 13, acceptedPrefixes: ['20'], pluStart: 2, pluLength: 5,
  measureStart: 7, measureLength: 5, measureKind: 'weight', measureDecimals: 3,
  checksumMode: 'ean13',
};
const mapping: LocalScaleMapping = { id: 'm', profileId: 'p', plu: '12345', productId: 'x', tareWeight: '0.025' };
const product = { id: 'x', sku: 'APPLE', name: 'Apples', salePrice: '2.5000', unitCode: 'KG', tareWeight: '0' };
const label = appendEan13CheckDigit('201234500125');

describe('printed scale labels in the POS cart', () => {
  it('prices the mapped net weight with exact decimals', () => {
    const line = priceBarcodeScaleLine(label, [profile], [mapping], [product], []);
    expect(line.quantity).toBe('0.1');
    expect(line.lineTotal).toBe('0.2500');
    expect(line.scanMetadata.barcode).toBe(label);
  });

  it('rejects duplicate labels and invalid checksums', () => {
    const line = priceBarcodeScaleLine(label, [profile], [mapping], [product], []);
    expect(() => priceBarcodeScaleLine(label, [profile], [mapping], [product], [line]))
      .toThrow('SCALE_BARCODE_ALREADY_IN_CART');
    expect(() => priceBarcodeScaleLine(label.slice(0, -1) + '9', [profile], [mapping], [product], []))
      .toThrow('SCALE_BARCODE_NOT_RECOGNIZED');
  });

  it('does not infer stock quantity from a price-only label', () => {
    const priceProfile = { ...profile, measureKind: 'price' as const, measureDecimals: 2 };
    expect(() => priceBarcodeScaleLine(label, [priceProfile], [mapping], [product], []))
      .toThrow('SCALE_PRICE_LABEL_NEEDS_WEIGHT');
  });
});
