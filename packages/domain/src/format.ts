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

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function currencySymbol(currency: string): string {
  return CURRENCIES[currency]?.symbol ?? currency;
}

export function formatNumber(amount: number): string {
  return numberFormat.format(Math.round(Math.abs(amount)));
}

interface MoneyOptions {
  /** Show "+" for positive amounts as well as "−" for negative ones. */
  signed?: boolean;
  /** Abbreviate large values: 2.4M, 480K. */
  compact?: boolean;
}

export function formatMoney(amount: number, currency = DEFAULT_CURRENCY, opts: MoneyOptions = {}): string {
  const symbol = currencySymbol(currency);
  const spacer = symbol.length > 1 ? ' ' : '';
  const abs = Math.abs(amount);
  let body: string;
  if (opts.compact && abs >= 1_000_000) body = `${trim(abs / 1_000_000)}M`;
  else if (opts.compact && abs >= 10_000) body = `${trim(abs / 1_000)}K`;
  else body = formatNumber(abs);
  const sign = amount < 0 ? '−' : opts.signed && amount > 0 ? '+' : '';
  return `${sign}${symbol}${spacer}${body}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

export function formatPercent(ratio: number): string {
  return `${Math.round(Math.abs(ratio) * 100)}%`;
}
