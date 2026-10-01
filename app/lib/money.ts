// Shared (client + server) money helpers. Costs are kept as strings end to end
// so that no floating point rounding ever touches a merchant's numbers.

export type CostValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

// Max digits before the decimal point. Guards against absurd input; Shopify's
// own limit is far above any realistic unit cost.
const MAX_INTEGER_DIGITS = 12;

/** Number of minor-unit decimals a currency uses (USD 2, JPY 0, KWD 3). */
export function currencyDecimals(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Validates a cost typed by the merchant. Accepts non-negative plain decimals
 * ("12", "12.5", "0") with no more decimals than the currency allows.
 * Returns a normalized string suitable for the GraphQL `Decimal` scalar.
 */
export function validateCost(raw: string, currencyCode: string): CostValidation {
  const input = raw.trim();
  if (input === "") return { ok: false, error: "Enter a cost" };
  if (/^-/.test(input)) return { ok: false, error: "Cost can't be negative" };
  if (/,/.test(input)) {
    return { ok: false, error: "Use a dot for decimals, without commas" };
  }

  const match = /^(\d+)(?:\.(\d*))?$/.exec(input);
  if (!match) return { ok: false, error: "Enter a number, for example 12.50" };

  const integerPart = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const decimals = currencyDecimals(currencyCode);

  if (integerPart.length > MAX_INTEGER_DIGITS) {
    return { ok: false, error: "Cost is too large" };
  }
  if (fraction.length > decimals) {
    return {
      ok: false,
      error:
        decimals === 0
          ? `${currencyCode} doesn't use decimals`
          : `${currencyCode} allows at most ${decimals} decimal places`,
    };
  }

  return { ok: true, value: fraction ? `${integerPart}.${fraction}` : integerPart };
}

/** True when a Decimal string represents exactly zero ("0", "0.00"). */
export function isZeroAmount(amount: string): boolean {
  return /^0+(\.0*)?$/.test(amount.trim());
}

export function formatMoney(amount: string, currencyCode: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currencyCode}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currencyCode,
    }).format(value);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

/** Gross margin % = (price − cost) ÷ price. Null when it can't be computed. */
export function marginPercent(price: string, cost: string | null): number | null {
  if (cost === null) return null;
  const p = Number(price);
  const c = Number(cost);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p <= 0) return null;
  return ((p - c) / p) * 100;
}

/** Cost as a percentage of price, rounded to the currency's decimals. */
export function costFromPercentOfPrice(
  price: string,
  percent: number,
  currencyCode: string,
): string | null {
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0 || !Number.isFinite(percent) || percent < 0) return null;
  return ((p * percent) / 100).toFixed(currencyDecimals(currencyCode));
}

/** Lowest price that reaches `margin`% for this cost, rounded up to the currency's decimals. */
export function priceForMargin(cost: string, margin: number, currencyCode: string): string | null {
  const c = Number(cost);
  if (!Number.isFinite(c) || c <= 0 || margin < 0 || margin >= 100) return null;
  const decimals = currencyDecimals(currencyCode);
  const factor = 10 ** decimals;
  return (Math.ceil((c / (1 - margin / 100)) * factor - 1e-9) / factor).toFixed(decimals);
}
