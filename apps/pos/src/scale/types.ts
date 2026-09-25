export type ScaleMeasureKind = 'weight' | 'price';
export type ScaleChecksumMode = 'ean13' | 'none';

export interface LocalScaleProfile {
  id: string;
  code: string;
  name: string;
  priority: number;
  symbology: 'EAN13';
  totalLength: number;
  acceptedPrefixes: string[];
  pluStart: number;
  pluLength: number;
  measureStart: number;
  measureLength: number;
  measureKind: ScaleMeasureKind;
  measureDecimals: number;
  checksumMode: ScaleChecksumMode;
}

export interface LocalScaleMapping {
  id: string;
  profileId: string;
  plu: string;
  productId: string;
  tareWeight: string;
}

export interface ScaleBarcodeMetadata {
  source: 'scale_barcode';
  barcode: string;
  profileId: string;
  profileCode: string;
  plu: string;
  measureKind: ScaleMeasureKind;
  measuredValue: string;
  netWeight: string | null;
  embeddedPrice: string | null;
}

export interface ParsedScaleBarcode {
  profile: LocalScaleProfile;
  mapping: LocalScaleMapping;
  metadata: ScaleBarcodeMetadata;
}
