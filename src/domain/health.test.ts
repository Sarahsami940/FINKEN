import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import { analyticsRange, budgetAdherence, dailyStats, monthsIn, recurringBreakdown, weekdaySpending } from './analytics';
import { DEFAULT_SAFE_OPTIONS, healthChange, moneyHealth, safeToSpend, type PlanningInput } from './health';
import { buildInsights } from './insights';
import { budgetHistory } from './planning';
import type { Account, Budget, Goal, GoalEntry, Obligation, Recurring, Transaction } from './types';

let n = 0;
function tx(type: Transaction['type'], amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return { id: `t${n++}`, spaceId: 's', type, amount, currency: 'PKR', date, description: '', accountId: 'bank', categoryId: 'food', createdAt: '', updatedAt: '', status: 'confirmed', ...extra };
}
const bank: Account = { id: 'bank', spaceId: 's', name: 'Bank', kind: 'bank', openingBalance: 100000, createdAt: '' } as Account;
const rent: Recurring = {
  id: 'rent',
  spaceId: 's',
  name: 'Rent',
  amount: 30000,
  type: 'expense',
  accountId: 'bank',
  categoryId: 'housing',
  frequency: 'monthly',
  startDate: '2026-01-25',
  nextDueDate: '2026-11-25',
  status: 'active',
  reminderDays: 3,
  createdAt: '',
} as Recurring;
const salary: Recurring = { ...rent, id: 'salary', name: 'Salary', type: 'income', amount: 150000, categoryId: 'salary', nextDueDate: '2026-11-28' } as Recurring;
const NOW = '2026-11-17';

function input(extra: Partial<PlanningInput> = {}): PlanningInput {
  return { accounts: [bank], transactions: [], recurring: [rent, salary], obligations: [], budgets: [], goals: [], goalEntries: [], ...extra };
}

describe('Safe to Spend', () => {
  it('keeps back bills, never counts expected income, and spreads the rest over the days left', () => {
    const safe = safeToSpend(input(), DEFAULT_SAFE_OPTIONS, NOW);
    expect(safe.until).toBe('2026-11-30');
    expect(safe.days).toBe(14);
    expect(safe.lines.find((l) => l.key === 'available')?.amount).toBe(100000);
    expect(safe.lines.find((l) => l.key === 'bills')?.amount).toBe(30000);
    expect(safe.expectedIn).toBe(150000);
    expect(safe.amount).toBe(70000);
    expect(safe.perDay).toBe(5000);
  });

  it('does not keep back a bill twice when it sits inside a budget', () => {
    const housing: Budget = { id: 'h', spaceId: 's', name: 'Housing', categoryId: 'housing', amount: 35000, frequency: 'monthly', startDate: '2026-01-01', createdAt: '' };
    const safe = safeToSpend(input({ budgets: [housing] }), DEFAULT_SAFE_OPTIONS, NOW);
    // 35,000 left in the budget, of which 30,000 is the rent already counted.
    expect(safe.lines.find((l) => l.key === 'budgets')?.amount).toBe(5000);
    expect(safe.amount).toBe(65000);
    expect(safeToSpend(input({ budgets: [housing] }), { ...DEFAULT_SAFE_OPTIONS, reserveBudgets: false }, NOW).amount).toBe(70000);
  });

  it('keeps back goal money and what goals still need this month', () => {
    const goal: Goal = { id: 'g', spaceId: 's', name: 'Laptop', targetAmount: 60000, targetDate: '2027-02-17', description: '', icon: 'laptop', createdAt: '' };
    const entries: GoalEntry[] = [
      { id: 'e1', spaceId: 's', goalId: 'g', amount: 20000, date: '2026-10-01', createdAt: '' },
      { id: 'e2', spaceId: 's', goalId: 'g', amount: 4000, date: '2026-11-02', createdAt: '' },
    ];
    const safe = safeToSpend(input({ goals: [goal], goalEntries: entries }), DEFAULT_SAFE_OPTIONS, NOW);
    expect(safe.lines.find((l) => l.key === 'goals')?.amount).toBe(24000);
    // Three months and a day away counts as four months: 36,000 / 4 = 9,000, less 4,000 already set aside in November.
    expect(safe.lines.find((l) => l.key === 'savings')?.amount).toBe(5000);
    expect(safe.amount).toBe(100000 - 24000 - 30000 - 5000);
  });

  it('can go below zero, and then has nothing to spend per day', () => {
    const safe = safeToSpend(input({ accounts: [{ ...bank, openingBalance: 10000 }] }), DEFAULT_SAFE_OPTIONS, NOW);
    expect(safe.amount).toBe(-20000);
    expect(safe.perDay).toBe(0);
  });

  it('counts money owed that falls due, but not money owed to you', () => {
    const owe: Obligation = { id: 'o', spaceId: 's', kind: 'payable', personId: 'p', title: 'Supplier', amount: 12000, date: '2026-10-01', dueDate: '2026-11-20', status: 'open', createdAt: '' } as Obligation;
    const owedToMe: Obligation = { ...owe, id: 'o2', kind: 'receivable', amount: 50000 } as Obligation;
    const safe = safeToSpend(input({ obligations: [owe, owedToMe] }), DEFAULT_SAFE_OPTIONS, NOW);
    expect(safe.lines.find((l) => l.key === 'owed')?.amount).toBe(12000);
    expect(safe.expectedIn).toBe(200000);
    expect(safe.amount).toBe(58000);
  });
});

describe('Money Health', () => {
  it('says nothing overall when there is too little to go on', () => {
    const health = moneyHealth(input({ recurring: [] }), NOW);
    expect(health.level).toBeNull();
  });

  it('reads steady for kept income, steady spending and nothing overdue', () => {
    const list: Transaction[] = [];
    for (const m of ['05', '06', '07', '08', '09', '10']) {
      list.push(tx('income', 100000, `2026-${m}-01`, { categoryId: 'salary' }));
      list.push(tx('expense', 60000, `2026-${m}-10`));
    }
    const health = moneyHealth(input({ transactions: list, recurring: [] }), NOW);
    expect(health.factors.find((f) => f.key === 'kept')?.score).toBe(1);
    expect(health.factors.find((f) => f.key === 'steadiness')?.score).toBe(1);
    expect(health.level).toBe('steady');
  });

  it('explains what changed against 30 days ago', () => {
    const list: Transaction[] = [];
    for (const m of ['05', '06', '07', '08', '09']) {
      list.push(tx('income', 100000, `2026-${m}-01`, { categoryId: 'salary' }));
      list.push(tx('expense', 60000, `2026-${m}-10`));
    }
    // October: spending far ahead of income.
    list.push(tx('income', 100000, '2026-10-01', { categoryId: 'salary' }));
    list.push(tx('expense', 190000, '2026-10-10'));
    const change = healthChange(input({ transactions: list, recurring: [] }), NOW);
    expect(change.direction).toBe('lower');
    expect(change.moved.map((m) => m.factor.key)).toContain('kept');
  });
});

describe('analytics', () => {
  it('builds ranges of whole months ending today', () => {
    expect(analyticsRange('3m', NOW)).toEqual({ from: '2026-09-01', to: NOW });
    expect(analyticsRange('ytd', NOW)).toEqual({ from: '2026-01-01', to: NOW });
    expect(analyticsRange('custom', NOW, { from: '2026-10-20', to: '2026-10-01' })).toEqual({ from: '2026-10-01', to: '2026-10-20' });
  });

  it('splits a range into clipped months', () => {
    const months = monthsIn([tx('expense', 500, '2026-10-15'), tx('income', 900, '2026-11-02')], { from: '2026-10-10', to: '2026-11-17' });
    expect(months).toEqual([
      { from: '2026-10-10', to: '2026-10-31', income: 0, spent: 500, net: -500 },
      { from: '2026-11-01', to: '2026-11-17', income: 900, spent: 0, net: 900 },
    ]);
  });

  it('averages spending per weekday over every such day, refunds included', () => {
    // 2026-11-16 is a Monday; the range has two Mondays.
    const w = weekdaySpending([tx('expense', 1000, '2026-11-16'), tx('refund', 200, '2026-11-16'), tx('expense', 600, '2026-11-18')], { from: '2026-11-09', to: '2026-11-22' });
    expect(w[0]).toEqual({ day: 0, total: 800, average: 400 });
    expect(w[2].total).toBe(600);
    const d = dailyStats([tx('expense', 1000, '2026-11-16'), tx('expense', 600, '2026-11-18')], { from: '2026-11-09', to: '2026-11-22' }, 2);
    expect(d.noSpendDays).toBe(12);
    expect(d.peak).toEqual({ date: '2026-11-16', amount: 1000 });
    expect(d.weeks.map((x) => x.spent)).toEqual([0, 1600]);
  });

  it('tracks budget periods from when the budget started', () => {
    const food: Budget = { id: 'f', spaceId: 's', name: 'Food', categoryId: 'food', amount: 1000, frequency: 'monthly', startDate: '2026-09-15', createdAt: '' };
    const list = [tx('expense', 1200, '2026-09-20'), tx('expense', 800, '2026-10-05'), tx('expense', 300, '2026-11-02')];
    const history = budgetHistory(food, list, NOW, 6);
    expect(history.map((h) => [h.range.from, h.spent, h.current])).toEqual([
      ['2026-09-15', 1200, false],
      ['2026-10-01', 800, false],
      ['2026-11-01', 300, true],
    ]);
    const [a] = budgetAdherence([food], list, NOW);
    expect([a.kept, a.finished]).toEqual([1, 2]);
  });

  it('converts regular payments to a monthly amount', () => {
    const weekly = { ...rent, id: 'w', name: 'Milk', amount: 700, frequency: 'weekly' } as Recurring;
    const r = recurringBreakdown([rent, salary, weekly, { ...rent, id: 'x', status: 'paused' } as Recurring]);
    expect(r.items.map((i) => i.recurring.id)).toEqual(['rent', 'w']);
    expect(r.monthlyIncome).toBe(150000);
  });
});

describe('insight feed', () => {
  it('invents nothing for a Space with no records', () => {
    expect(buildInsights({ transactions: [], categories: [], recurring: [], currency: 'PKR', anchor: NOW })).toEqual([]);
  });

  it('spots one expense far above what its category usually costs', () => {
    const shopping = { id: 'shop', spaceId: 's', name: 'Shopping', kind: 'expense' as const, icon: 'bag', color: 'rose', subcategories: [], createdAt: '' };
    const list = [
      ...['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'].map((d) => tx('expense', 2000, d, { categoryId: 'shop' })),
      tx('expense', 9000, '2026-11-10', { categoryId: 'shop', description: 'Winter coat' }),
    ];
    const insight = buildInsights({ transactions: list, categories: [shopping], recurring: [], currency: 'PKR', anchor: NOW }).find((i) => i.section === 'unusual');
    expect(insight?.detail).toContain('Winter coat');
    expect(insight?.facts?.[1]).toEqual({ label: 'Usual amount', value: 'Rs. 2,000' });
  });

  it('says when a goal is behind schedule, and suggests increasing contributions', () => {
    const goal: Goal = { id: 'g', spaceId: 's', name: 'Laptop', targetAmount: 60000, targetDate: '2027-02-17', description: '', icon: 'laptop', createdAt: '' };
    const insight = buildInsights({
      transactions: [],
      categories: [],
      recurring: [],
      goals: [goal],
      goalEntries: [{ id: 'e', spaceId: 's', goalId: 'g', amount: 3000, date: '2026-10-01', createdAt: '' }],
      currency: 'PKR',
      anchor: NOW,
    }).find((i) => i.section === 'goals');
    expect(insight?.title).toBe('Your Laptop goal is behind schedule');
    expect(insight?.action?.label).toBe('Increase savings contributions');
  });

  it('gives every demo insight a reason, figures and an action', () => {
    const seed = buildSeed('u1', NOW);
    for (const space of seed.spaces) {
      const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === space.id);
      const insights = buildInsights({
        transactions: own(seed.transactions),
        categories: own(seed.categories),
        recurring: own(seed.recurring),
        budgets: own(seed.budgets),
        obligations: own(seed.obligations),
        people: own(seed.people),
        accounts: own(seed.accounts),
        goals: own(seed.goals),
        goalEntries: own(seed.goalEntries),
        currency: space.currency,
        anchor: NOW,
      });
      expect(insights.length).toBeGreaterThan(2);
      for (const i of insights) {
        expect(i.why).toBeTruthy();
        expect(i.facts?.length).toBeGreaterThan(0);
        expect(i.action).toBeTruthy();
        // No impossible percentages: nothing can fall by more than 100%.
        expect(i.title).not.toMatch(/down \d{3,}%/);
      }
      const health = moneyHealth({ accounts: own(seed.accounts), transactions: own(seed.transactions), recurring: own(seed.recurring), obligations: own(seed.obligations), budgets: own(seed.budgets), goals: own(seed.goals), goalEntries: own(seed.goalEntries) }, NOW);
      expect(health.level).not.toBeNull();
    }
  });
});
