import { describe, expect, it } from 'vitest';
import { appendEan13CheckDigit, isValidEan13 } from './ean13.js';
import { parseScaleBarcode } from './parser.js';
import type { LocalScaleMapping, LocalScaleProfile } from './types.js';

const profile: LocalScaleProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'DEFAULT_WEIGHT',
  name: 'Default weight scale',
  priority: 10,
  symbology: 'EAN13',
  totalLength: 13,
  acceptedPrefixes: ['20'],
  pluStart: 2,
  pluLength: 5,
  measureStart: 7,
  measureLength: 5,
  measureKind: 'weight',
  measureDecimals: 3,
  checksumMode: 'ean13',
};

const mapping: LocalScaleMapping = {
  id: '22222222-2222-4222-8222-222222222222',
  profileId: profile.id,
  plu: '12345',
  productId: '33333333-3333-4333-8333-333333333333',
  tareWeight: '0.025',
};

describe('electronic scale barcode parser', () => {
  it('validates EAN-13 and extracts net weight', () => {
    const barcode = appendEan13CheckDigit('201234500125');
    expect(isValidEan13(barcode)).toBe(true);

    const parsed = parseScaleBarcode(barcode, [profile], [mapping]);
    expect(parsed?.metadata.plu).toBe('12345');
    expect(parsed?.metadata.measuredValue).toBe('0.125');
    expect(parsed?.metadata.netWeight).toBe('0.1');
  });

  it('rejects a bad check digit', () => {
    const barcode = '2012345001259';
    expect(parseScaleBarcode(barcode, [profile], [mapping])).toBeNull();
  });

  it('supports price-encoded barcodes', () => {
    const priceProfile = { ...profile, id: '44444444-4444-4444-8444-444444444444', measureKind: 'price' as const, measureDecimals: 2 };
    const priceMapping = { ...mapping, profileId: priceProfile.id, tareWeight: '0' };
    const barcode = appendEan13CheckDigit('201234500725');

    const parsed = parseScaleBarcode(barcode, [priceProfile], [priceMapping]);
    expect(parsed?.metadata.embeddedPrice).toBe('7.25');
    expect(parsed?.metadata.netWeight).toBeNull();
  });
});
