const EAN13_PREFIX = "4820";

export const EAN13_SVG_SIZE = { width: 230, height: 100 } as const;
export const EAN13_SVG_RENDER_OPTIONS = {
  width: 2.32,
  height: 71,
  fontSize: 14,
  textMargin: 0,
  margin: 0,
} as const;

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

export function getEan13Value(value: string | null | undefined): string | null {
  if (!value) return null;
  return generateEan13(value) ?? (isValidEan13(value) ? value.replace(/\s/g, "") : null);
}
