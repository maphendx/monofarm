const EAN13_PREFIX = "4820";

function calculateCheckDigit(body: string): string {
  const sum = [...body].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

export function generateEan13(productCode: string): string | null {
  const normalized = productCode.replace(/\s/g, "");
  if (!/^\d{8}$/.test(normalized)) return null;

  const body = EAN13_PREFIX + normalized;
  return body + calculateCheckDigit(body);
}

export function isValidEan13(value: string): boolean {
  const normalized = value.replace(/\s/g, "");
  if (!/^\d{13}$/.test(normalized)) return false;
  return normalized[12] === calculateCheckDigit(normalized.slice(0, 12));
}
