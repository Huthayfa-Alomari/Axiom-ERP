import Decimal from 'decimal.js';
import { isValidEan13 } from './ean13';
import { scaledIntegerToDecimal } from './decimal';
import type {
  LocalScaleMapping,
  LocalScaleProfile,
  ParsedScaleBarcode,
} from './types.js';

function matchesPrefix(barcode: string, profile: LocalScaleProfile): boolean {
  return profile.acceptedPrefixes.length === 0
    || profile.acceptedPrefixes.some(prefix => barcode.startsWith(prefix));
}

export function parseScaleBarcode(
  barcode: string,
  profiles: readonly LocalScaleProfile[],
  mappings: readonly LocalScaleMapping[],
): ParsedScaleBarcode | null {
  if (!/^\d+$/.test(barcode)) return null;

  const orderedProfiles = [...profiles]
    .filter(profile => barcode.length === profile.totalLength)
    .filter(profile => matchesPrefix(barcode, profile))
    .sort((a, b) => a.priority - b.priority);

  for (const profile of orderedProfiles) {
    if (profile.checksumMode === 'ean13' && !isValidEan13(barcode)) continue;

    const plu = barcode.slice(profile.pluStart, profile.pluStart + profile.pluLength);
    const mapping = mappings.find(item => item.profileId === profile.id && item.plu === plu);
    if (!mapping) continue;

    const rawMeasure = barcode.slice(
      profile.measureStart,
      profile.measureStart + profile.measureLength,
    );

    if (rawMeasure.length !== profile.measureLength) continue;

    const measuredValue = scaledIntegerToDecimal(rawMeasure, profile.measureDecimals);

    if (profile.measureKind === 'weight') {
      const netWeight = Decimal.max(
        new Decimal(measuredValue).minus(new Decimal(mapping.tareWeight || '0')),
        new Decimal(0),
      ).toDecimalPlaces(8).toFixed();

      if (new Decimal(netWeight).lte(0)) {
        throw new Error('SCALE_NET_WEIGHT_MUST_BE_POSITIVE');
      }

      return {
        profile,
        mapping,
        metadata: {
          source: 'scale_barcode',
          barcode,
          profileId: profile.id,
          profileCode: profile.code,
          plu,
          measureKind: 'weight',
          measuredValue,
          netWeight,
          embeddedPrice: null,
        },
      };
    }

    if (new Decimal(measuredValue).lte(0)) {
      throw new Error('SCALE_PRICE_MUST_BE_POSITIVE');
    }

    return {
      profile,
      mapping,
      metadata: {
        source: 'scale_barcode',
        barcode,
        profileId: profile.id,
        profileCode: profile.code,
        plu,
        measureKind: 'price',
        measuredValue,
        netWeight: null,
        embeddedPrice: measuredValue,
      },
    };
  }

  return null;
}
