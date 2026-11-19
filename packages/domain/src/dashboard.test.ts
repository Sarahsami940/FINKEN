import { describe, expect, it } from 'vitest';
import { comparisonFor, flowSeries, overallBudget, reportRange, transactionsLink, weekRange } from './dashboard';
import { buildInsights } from './insights';
import { buildSeed } from './seed';
import type { Budget, Transaction } from './types';

let n = 0;
function tx(type: Transaction['type'], amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: `t${n++}`,
    spaceId: 's',
    type,
    amount,
    currency: 'PKR',
    date,
    description: '',
    accountId: 'bank',
    categoryId: 'food',
    createdAt: '',
    updatedAt: '',
    status: 'confirmed',
    ...extra,
  };
}

describe('reporting periods', () => {
  // 2026-11-17 is a Tuesday.
  const now = '2026-11-17';

  it('covers the right dates for each period', () => {
    expect(reportRange('today', now)).toEqual({ from: now, to: now });
    expect(reportRange('week', now)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(reportRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(reportRange('last-month', now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(weekRange('2026-11-22')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });

  it('repairs a custom range instead of failing', () => {
    expect(reportRange('custom', now, { from: '2026-10-05', to: '2026-10-20' })).toEqual({ from: '2026-10-05', to: '2026-10-20' });
    expect(reportRange('custom', now, { from: '2026-10-20', to: '2026-10-05' })).toEqual({ from: '2026-10-05', to: '2026-10-20' });
    expect(reportRange('custom', now, { from: '2026-10-05' })).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(reportRange('custom', now, { from: 'nonsense' })).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('compares a period in progress with the same stretch before it', () => {
    expect(comparisonFor('today', reportRange('today', now), now)?.previous).toEqual({ from: '2026-11-16', to: '2026-11-16' });
    const week = comparisonFor('week', reportRange('week', now), now)!;
    expect(week.current).toEqual({ from: '2026-11-16', to: now });
    expect(week.previous).toEqual({ from: '2026-11-09', to: '2026-11-10' });
    const month = comparisonFor('month', reportRange('month', now), now)!;
    expect(month.current).toEqual({ from: '2026-11-01', to: now });
    expect(month.previous).toEqual({ from: '2026-10-01', to: '2026-10-17' });
    expect(comparisonFor('last-month', reportRange('last-month', now), now)?.previous).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const custom = comparisonFor('custom', { from: '2026-11-01', to: '2026-11-10' }, now)!;
    expect(custom.previous).toEqual({ from: '2026-10-22', to: '2026-10-31' });
    expect(comparisonFor('custom', { from: '2026-12-01', to: '2026-12-10' }, now)).toBeNull();
  });

  it('never stretches a short month comparison past its end', () => {
    const month = comparisonFor('month', reportRange('month', '2026-03-31'), '2026-03-31')!;
    expect(month.previous).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('income and spending chart', () => {
  const list = [
    tx('income', 50000, '2026-11-02'),
    tx('expense', 3000, '2026-11-02'),
    tx('refund', 500, '2026-11-03'),
    tx('expense', 1200, '2026-11-17'),
    tx('principal_in', 90000, '2026-11-05', { categoryId: undefined }),
    tx('transfer', 7000, '2026-11-06', { categoryId: undefined }),
  ];

  it('uses weeks for a month and adds up to the period totals', () => {
    const s = flowSeries(list, { from: '2026-11-01', to: '2026-11-30' });
    expect(s.unit).toBe('week');
    expect(s.buckets.map((b) => b.from)).toEqual(['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
    expect(s.buckets.at(-1)?.to).toBe('2026-11-30');
    expect(flowSeries(list, { from: '2026-11-16', to: '2026-11-22' }).unit).toBe('day');
    expect(s.buckets.reduce((a, b) => a + b.income, 0)).toBe(50000);
    // Refunds reduce spending; loans and transfers are neither.
    expect(s.buckets.reduce((a, b) => a + b.spent, 0)).toBe(3700);
  });

  it('widens a single day to a week, and groups longer ranges', () => {
    const day = flowSeries(list, { from: '2026-11-17', to: '2026-11-17' });
    expect(day.widened).toBe(true);
    expect(day.buckets[0].from).toBe('2026-11-11');
    expect(day.buckets).toHaveLength(7);
    expect(flowSeries(list, { from: '2026-09-01', to: '2026-11-30' }).unit).toBe('week');
    const year = flowSeries(list, { from: '2026-01-15', to: '2026-11-30' });
    expect(year.unit).toBe('month');
    expect(year.buckets[0]).toMatchObject({ from: '2026-01-15', to: '2026-01-31' });
    expect(year.buckets.at(-1)).toMatchObject({ from: '2026-11-01', to: '2026-11-30', income: 50000 });
  });
});

describe('budget remaining today', () => {
  const overall: Budget = { id: 'all', spaceId: 's', name: 'All spending', amount: 30000, frequency: 'monthly', startDate: '2026-01-01', createdAt: '' };
  const food: Budget = { ...overall, id: 'food', name: 'Food', categoryId: 'food', amount: 10000 };

  it('uses the overall budget and spreads what is left over the remaining days', () => {
    const result = overallBudget([food, overall], [tx('expense', 16000, '2026-11-05', { categoryId: 'rent' })], '2026-11-17')!;
    expect(result.status.budget.id).toBe('all');
    expect(result.status.remaining).toBe(14000);
    // 14 days from the 17th to the 30th, today included.
    expect(result.perDay).toBe(1000);
  });

  it('has nothing to say without an overall budget, or once it is used up', () => {
    expect(overallBudget([food], [], '2026-11-17')).toBeNull();
    expect(overallBudget([overall], [tx('expense', 31000, '2026-11-05')], '2026-11-17')?.perDay).toBeNull();
  });
});

describe('drill-down links', () => {
  it('links a whole month by month and anything else by dates', () => {
    expect(transactionsLink({ from: '2026-11-01', to: '2026-11-30' }, { type: 'expense' })).toBe('/transactions?month=2026-11&type=expense');
    expect(transactionsLink({ from: '2026-11-16', to: '2026-11-22' }, { category: 'food', type: undefined })).toBe(
      '/transactions?period=custom&from=2026-11-16&to=2026-11-22&category=food',
    );
  });
});

describe('category movement insight', () => {
  it('ignores a category whose refunds outweigh its spending', () => {
    const fun = { id: 'fun', spaceId: 's', name: 'Entertainment', kind: 'expense' as const, icon: 'film', color: 'plum', subcategories: [], createdAt: '' };
    const list = [
      tx('expense', 1100, '2026-10-05', { categoryId: 'fun' }),
      tx('expense', 1100, '2026-11-05', { categoryId: 'fun' }),
      tx('refund', 6000, '2026-11-10', { categoryId: 'fun' }),
    ];
    const insights = buildInsights({ transactions: list, categories: [fun], recurring: [], currency: 'PKR', anchor: '2026-11-17' });
    expect(insights.find((i) => i.id === 'category-mover')).toBeUndefined();
  });
});

describe('dashboard insights on the demo data', () => {
  it('mentions money owed and what is left after commitments, from real records', () => {
    const seed = buildSeed('u1', new Date().toISOString().slice(0, 10));
    const space = seed.spaces[0];
    const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === space.id);
    const insights = buildInsights({
      transactions: own(seed.transactions),
      categories: own(seed.categories),
      recurring: own(seed.recurring),
      budgets: own(seed.budgets),
      obligations: own(seed.obligations),
      people: own(seed.people),
      accounts: own(seed.accounts),
      currency: space.currency,
    });
    const ids = insights.map((i) => i.id);
    expect(ids.some((id) => id.startsWith('owed-'))).toBe(true);
    expect(insights.some((i) => /still owes you Rs/.test(i.title) || /still owes you Rs/.test(i.detail))).toBe(true);
    // Every insight is a sentence about real figures, with somewhere to act on it.
    for (const i of insights) expect(i.title.length).toBeGreaterThan(0);
  });
});
