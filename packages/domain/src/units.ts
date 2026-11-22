import { toMinor } from './format';

/** Every stored field that holds money, by collection. Everything else is left alone. */
export const MONEY_FIELDS = {
  accounts: ['openingBalance'],
  transactions: ['amount'],
  recurring: ['amount'],
  budgets: ['amount'],
  goals: ['targetAmount'],
  goalEntries: ['amount'],
  obligations: ['amount', 'instalmentAmount'],
} as const satisfies Record<string, readonly string[]>;

export type MoneyCollection = keyof typeof MONEY_FIELDS;

export function hasMoney(collection: string): collection is MoneyCollection {
  return collection in MONEY_FIELDS;
}

/**
 * Converts one record saved in major units (rupees, as Finken stored money
 * before paisa) to minor units. Returns a new object; fields that are missing
 * stay missing.
 */
export function recordToMinor<T extends object>(collection: MoneyCollection, record: T): T {
  const out = { ...record } as Record<string, unknown>;
  for (const field of MONEY_FIELDS[collection]) {
    const value = out[field];
    if (typeof value === 'number') out[field] = toMinor(value);
  }
  return out as T;
}
