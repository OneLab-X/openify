/** Fraction digits of a currency (INR 2, JPY 0, KWD 3). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Integer minor units → the string shown in a price input ("999.00"). */
export function toInput(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return "";
  const d = currencyDigits(currency);
  return (minor / 10 ** d).toFixed(d);
}

/** Price input → integer minor units (the API never accepts decimals). Empty → null; invalid → NaN. */
export function fromInput(value: string, currency: string): number | null {
  const clean = value.trim().replace(/,/g, "");
  if (clean === "") return null;
  if (!/^\d+(\.\d*)?$/.test(clean)) return Number.NaN;
  const d = currencyDigits(currency);
  const [whole, frac = ""] = clean.split(".");
  return Number(whole) * 10 ** d + Number((frac + "0".repeat(d)).slice(0, d) || "0");
}

export function formatMoney(minor: number, currency: string, locale = "en"): string {
  const d = currencyDigits(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: d }).format(minor / 10 ** d);
}
