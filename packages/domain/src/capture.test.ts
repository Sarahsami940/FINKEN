import { describe, expect, it } from 'vitest';
import { parseCapture } from './capture';
import type { Account, Category } from './types';

const accounts: Account[] = [
  { id: 'bank', spaceId: 's', name: 'Bank Account', kind: 'bank', openingBalance: 0 },
  { id: 'cash', spaceId: 's', name: 'Cash', kind: 'cash', openingBalance: 0 },
  { id: 'wallet', spaceId: 's', name: 'Mobile Wallet', kind: 'wallet', openingBalance: 0 },
];
const cat = (id: string, name: string, kind: Category['kind'], subs: string[] = []): Category => ({
  id,
  spaceId: 's',
  name,
  kind,
  icon: 'circle',
  color: 'slate',
  subcategories: subs.map((s) => ({ id: `${id}:${s}`, name: s })),
});
const categories = [
  cat('food', 'Food', 'expense', ['Groceries', 'Dining Out']),
  cat('transport', 'Transport', 'expense', ['Fuel', 'Ride-hailing']),
  cat('other', 'Other', 'expense'),
  cat('salary', 'Salary', 'income'),
];
// A Saturday.
const now = '2026-11-14';
const parse = (text: string) => parseCapture(text, { categories, accounts, now });

describe('parseCapture', () => {
  it('reads the example from the brief', () => {
    const r = parse('Spent Rs. 850 on dinner yesterday.');
    expect(r).toMatchObject({ type: 'expense', amount: 850, date: '2026-11-13', categoryId: 'food', subcategoryId: 'food:Dining Out', description: 'Dinner' });
    expect(r.guesses).toEqual([]);
  });

  it('reads income and an account', () => {
    const r = parse('Received 185,000 salary in bank today');
    expect(r).toMatchObject({ type: 'income', amount: 185000, date: now, categoryId: 'salary', accountId: 'bank' });
  });

  it('understands k and lakh', () => {
    expect(parse('paid 2.5k for fuel').amount).toBe(2500);
    expect(parse('bought a bike for 1.2 lakh').amount).toBe(120000);
  });

  it('does not mistake a date for the amount', () => {
    expect(parse('fuel 3200 on 12 nov')).toMatchObject({ amount: 3200, date: '2026-11-12', subcategoryId: 'transport:Fuel' });
    expect(parse('paid 900 for groceries 3 days ago')).toMatchObject({ amount: 900, date: '2026-11-11' });
    expect(parse('lunch 5/11 450')).toMatchObject({ amount: 450, date: '2026-11-05' });
  });

  it('resolves weekdays to the most recent one', () => {
    expect(parse('spent 500 on friday').date).toBe('2026-11-13');
    expect(parse('spent 500 last saturday').date).toBe('2026-11-07');
    expect(parse('spent 500 on saturday').date).toBe(now);
  });

  it('puts a date later in the year into last year', () => {
    expect(parse('spent 500 on 25 dec').date).toBe('2025-12-25');
  });

  it('reads withdrawals and transfers between named accounts', () => {
    expect(parse('withdrew 20000')).toMatchObject({ type: 'transfer', amount: 20000, accountId: 'bank', toAccountId: 'cash' });
    expect(parse('transferred 6,000 from bank to wallet')).toMatchObject({ type: 'transfer', accountId: 'bank', toAccountId: 'wallet' });
  });

  it('says what it had to guess', () => {
    const r = parse('haircut');
    expect(r.amount).toBeUndefined();
    expect(r.guesses).toEqual(expect.arrayContaining(['Assumed this is an expense', 'No amount found', 'Could not tell the category']));
    expect(r.description).toBe('Haircut');
  });

  it('uses an account only when it is named', () => {
    expect(parse('spent 300 on chai').accountId).toBeUndefined();
    expect(parse('spent 300 on chai with cash')).toMatchObject({ accountId: 'cash', description: 'Chai' });
  });
});
