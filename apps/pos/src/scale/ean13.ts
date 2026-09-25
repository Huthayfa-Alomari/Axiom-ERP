export function ean13CheckDigit(firstTwelveDigits: string): number {
  if (!/^\d{12}$/.test(firstTwelveDigits)) {
    throw new Error('EAN13_BODY_MUST_BE_12_DIGITS');
  }

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(firstTwelveDigits[i]);
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }

  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(value: string): boolean {
  return /^\d{13}$/.test(value)
    && Number(value[12]) === ean13CheckDigit(value.slice(0, 12));
}

export function appendEan13CheckDigit(firstTwelveDigits: string): string {
  return `${firstTwelveDigits}${ean13CheckDigit(firstTwelveDigits)}`;
}
