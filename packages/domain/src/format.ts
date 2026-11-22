/** Display prefixes for supported currencies. PKR is the default. */
export const CURRENCIES: Record<string, { symbol: string; label: string }> = {
  PKR: { symbol: 'Rs.', label: 'Pakistani Rupee' },
  USD: { symbol: '$', label: 'US Dollar' },
  EUR: { symbol: '€', label: 'Euro' },
  GBP: { symbol: '£', label: 'British Pound' },
  AED: { symbol: 'AED', label: 'UAE Dirham' },
  SAR: { symbol: 'SAR', label: 'Saudi Riyal' },
  INR: { symbol: '₹', label: 'Indian Rupee' },
};

export const DEFAULT_CURRENCY = 'PKR';

/**
 * Money is stored as a whole number of the currency's minor unit: paisa for
 * PKR, cents for USD. Rs. 1,250.50 is stored as 125050. Sums of whole numbers
 * are exact, so totals can never drift by a fraction.
 */
export const MINOR_UNITS = 100;

/** True for a valid stored amount: a whole number of minor units. */
export function isMinorAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Major units (rupees) to minor units (paisa), rounded to the nearest paisa. */
export function toMinor(major: number): number {
  return Math.round(Number((major * MINOR_UNITS).toFixed(4)));
}

/** Minor units to major units, for export only. Never calculate with the result. */
export function toMajor(minor: number): number {
  return minor / MINOR_UNITS;
}

/** Rounds down to a whole rupee (or dollar), for "about X a day" figures. */
export function floorToMajor(minor: number): number {
  return Math.floor(minor / MINOR_UNITS) * MINOR_UNITS;
}

/**
 * Reads a typed amount such as "1,250.5" into minor units (125050), working on
 * the digits so no floating-point error can creep in. Returns NaN for anything
 * that is not a number with at most two decimals.
 */
export function parseMoney(text: string): number {
  const m = /^\s*(-)?\s*(\d[\d,]*)?(?:\.(\d{0,2}))?\s*$/.exec(text);
  if (!m || (!m[2] && !m[3])) return Number.NaN;
  const whole = Number((m[2] ?? '0').replace(/,/g, ''));
  const fraction = Number((m[3] ?? '').padEnd(2, '0'));
  const minor = whole * MINOR_UNITS + fraction;
  if (!Number.isSafeInteger(minor)) return Number.NaN;
  return m[1] ? -minor : minor;
}

/** Minor units as the text an amount field starts with: "1250" or "1250.50". */
export function moneyToInput(minor: number): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / MINOR_UNITS);
  const fraction = abs % MINOR_UNITS;
  return `${minor < 0 ? '-' : ''}${whole}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function currencySymbol(currency: string): string {
  return CURRENCIES[currency]?.symbol ?? currency;
}

/**
 * An amount in minor units as digits: "1,250" or "1,250.50". Recorded amounts
 * are whole paisa and show exactly; a calculated estimate that is not whole
 * paisa (an average, a projection) shows to the nearest rupee.
 */
export function formatNumber(amount: number): string {
  const abs = Math.abs(amount);
  if (!Number.isInteger(abs)) return numberFormat.format(Math.round(abs / MINOR_UNITS));
  const fraction = abs % MINOR_UNITS;
  const whole = numberFormat.format(Math.floor(abs / MINOR_UNITS));
  return fraction ? `${whole}.${String(fraction).padStart(2, '0')}` : whole;
}

interface MoneyOptions {
  /** Show "+" for positive amounts as well as "−" for negative ones. */
  signed?: boolean;
  /** Abbreviate large values: 2.4M, 480K. */
  compact?: boolean;
}

/** Formats an amount held in minor units. */
export function formatMoney(amount: number, currency = DEFAULT_CURRENCY, opts: MoneyOptions = {}): string {
  const symbol = currencySymbol(currency);
  const spacer = symbol.length > 1 ? ' ' : '';
  const major = Math.abs(amount) / MINOR_UNITS;
  let body: string;
  if (opts.compact && major >= 1_000_000) body = `${trim(major / 1_000_000)}M`;
  else if (opts.compact && major >= 10_000) body = `${trim(major / 1_000)}K`;
  else body = formatNumber(amount);
  // Anything under half a paisa shows as zero, with no sign.
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '−' : opts.signed && rounded > 0 ? '+' : '';
  return `${sign}${symbol}${spacer}${body}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

export function formatPercent(ratio: number): string {
  return `${Math.round(Math.abs(ratio) * 100)}%`;
}
