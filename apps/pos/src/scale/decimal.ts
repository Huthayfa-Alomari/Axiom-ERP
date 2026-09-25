export function scaledIntegerToDecimal(rawDigits: string, decimals: number): string {
  if (!/^\d+$/.test(rawDigits)) throw new Error('SCALE_MEASURE_NOT_NUMERIC');
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('INVALID_DECIMAL_SCALE');

  const normalized = rawDigits.replace(/^0+(?=\d)/, '') || '0';
  if (decimals === 0) return normalized;

  const padded = normalized.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals) || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');

  return fraction ? `${whole}.${fraction}` : whole;
}
