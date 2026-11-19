/** Decimal digits of a currency's minor unit (INR 2, JPY 0, BHD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** 49900 INR → "499.00" (for APIs that take decimal strings). */
export function toDecimal(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor).toString().padStart(digits + 1, "0");
  return digits === 0 ? `${sign}${abs}` : `${sign}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}

/** "499.00" or 499 → 49900. Rounds half away from zero to absorb float noise. */
export function toMinor(value: string | number, currency: string): number {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  const scaled = n * 10 ** currencyDigits(currency);
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/** Throws unless the amount is a positive integer of minor units. */
export function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("Amount must be a positive integer of minor units");
}
