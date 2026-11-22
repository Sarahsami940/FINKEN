import { describe, expect, it } from 'vitest';
import { budgetMessage, budgetPeriod, budgetSpent, budgetStatus, goalStatus, monthlyEquivalent, needsAttention, nextRecurringDate } from './planning';
import { buildSeed } from './seed';
import type { Budget, Goal, GoalEntry, Recurring, Transaction } from './types';

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
const budget = (extra: Partial<Budget> = {}): Budget => ({
  id: 'b',
  spaceId: 's',
  name: 'Food',
  amount: 30000,
  categoryId: 'food',
  frequency: 'monthly',
  startDate: '2026-01-01',
  createdAt: '',
  ...extra,
});

describe('budgets', () => {
  it('finds the current period for each frequency', () => {
    expect(budgetPeriod(budget(), '2026-03-15')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    // 2026-03-18 is a Wednesday.
    expect(budgetPeriod(budget({ frequency: 'weekly' }), '2026-03-18')).toEqual({ from: '2026-03-16', to: '2026-03-22' });
    expect(budgetPeriod(budget({ frequency: 'yearly' }), '2026-03-15')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(budgetPeriod(budget({ frequency: 'custom', startDate: '2026-03-10', endDate: '2026-03-20' }), '2026-03-15')).toEqual({ from: '2026-03-10', to: '2026-03-20' });
  });

  it('is not running before it starts or after it ends', () => {
    expect(budgetPeriod(budget({ startDate: '2026-04-01' }), '2026-03-15')).toBeNull();
    expect(budgetPeriod(budget({ endDate: '2026-02-28' }), '2026-03-15')).toBeNull();
    expect(budgetPeriod(budget({ startDate: '2026-03-10' }), '2026-03-15')).toEqual({ from: '2026-03-10', to: '2026-03-31' });
  });

  it('counts only spending in its category, subcategory and dates, less refunds', () => {
    const list = [
      tx('expense', 5000, '2026-03-02'),
      tx('expense', 2000, '2026-03-05', { subcategoryId: 'dining' }),
      tx('refund', 500, '2026-03-06', { subcategoryId: 'dining' }),
      tx('expense', 9000, '2026-03-07', { categoryId: 'rent' }),
      tx('expense', 4000, '2026-02-27'),
      tx('income', 8000, '2026-03-03'),
      tx('principal_out', 3000, '2026-03-04', { categoryId: undefined }),
      tx('transfer', 3000, '2026-03-04', { categoryId: undefined }),
    ];
    const march = { from: '2026-03-01', to: '2026-03-31' };
    expect(budgetSpent(budget(), list, march)).toBe(6500);
    expect(budgetSpent(budget({ subcategoryId: 'dining' }), list, march)).toBe(1500);
    expect(budgetSpent(budget({ categoryId: undefined }), list, march)).toBe(15500);
  });

  it('reports amount, spent, remaining, percentage and pace', () => {
    const s = budgetStatus(budget(), [tx('expense', 12000, '2026-03-05')], '2026-03-10');
    expect(s).toMatchObject({ spent: 12000, remaining: 18000, daysLeft: 21 });
    expect(s.used).toBeCloseTo(0.4);
    expect(s.elapsed).toBeCloseTo(10 / 31);
    expect(s.expectedByNow).toBeCloseTo(30000 * (10 / 31));
    // No earlier months, so the projection is a straight line.
    expect(s.fromHistory).toBe(false);
    expect(s.projected).toBeCloseTo(12000 * 3.1);
  });

  it('raises each alert', () => {
    const at = (list: Transaction[], day: string, b = budget()) => budgetStatus(b, list, day).alert;
    expect(at([tx('expense', 31000, '2026-03-05')], '2026-03-10')).toBe('exceeded');
    expect(at([tx('expense', 15000, '2026-03-05')], '2026-03-10')).toBe('likely');
    expect(at([tx('expense', 26000, '2026-03-05')], '2026-03-28')).toBe('approaching');
    expect(at([tx('expense', 5000, '2026-03-05')], '2026-03-20')).toBe('below');
    expect(at([tx('expense', 14000, '2026-03-05')], '2026-03-16')).toBeNull();
    // Too early for a straight-line guess to mean anything.
    expect(at([tx('expense', 4000, '2026-03-01')], '2026-03-02')).toBeNull();
  });

  it('learns from earlier periods so one large early payment is not projected forward', () => {
    const rent = budget({ name: 'Housing', categoryId: 'rent', amount: 45000 });
    const list = ['2026-01-03', '2026-02-03', '2026-03-03'].map((d) => tx('expense', 45000, d, { categoryId: 'rent' }));
    const s = budgetStatus(rent, list, '2026-03-05');
    expect(s.fromHistory).toBe(true);
    expect(s.projected).toBe(45000);
    expect(s.alert).toBe('approaching');
  });

  it('projects the rest of the period from what the same stretch cost before', () => {
    const list = [tx('expense', 10000, '2026-02-05'), tx('expense', 14000, '2026-02-20'), tx('expense', 18000, '2026-03-05')];
    const s = budgetStatus(budget(), list, '2026-03-10');
    expect(s.projected).toBe(18000 + 14000);
    expect(s.alert).toBe('likely');
    expect(budgetMessage(s, 'PKR')).toBe("You're likely to exceed your Food budget by Rs. 20 this month.");
  });
});

describe('goals', () => {
  const goal: Goal = { id: 'g', spaceId: 's', name: 'Laptop', targetAmount: 100000, targetDate: '2026-07-01', description: '', icon: 'laptop', createdAt: '' };
  const entry = (amount: number): GoalEntry => ({ id: `e${n++}`, spaceId: 's', goalId: 'g', amount, date: '2026-03-01', createdAt: '' });

  it('works out saved, remaining, percentage and the monthly amount needed', () => {
    const s = goalStatus(goal, [entry(30000), entry(20000), entry(-10000), { ...entry(999), goalId: 'other' }], '2026-03-01');
    expect(s).toMatchObject({ saved: 40000, remaining: 60000, reached: false, monthsLeft: 5, monthlyNeeded: 12000, late: false });
    expect(s.progress).toBeCloseTo(0.4);
  });

  it('handles reached, late and undated goals', () => {
    expect(goalStatus(goal, [entry(120000)], '2026-03-01')).toMatchObject({ reached: true, remaining: 0, progress: 1, monthlyNeeded: null });
    expect(goalStatus(goal, [entry(10000)], '2026-08-01')).toMatchObject({ late: true, monthlyNeeded: null });
    expect(goalStatus({ ...goal, targetDate: undefined }, [entry(10000)], '2026-03-01')).toMatchObject({ monthlyNeeded: null, late: false });
    // Less than a month left still needs the whole remainder.
    expect(goalStatus(goal, [entry(90000)], '2026-06-25').monthlyNeeded).toBe(10000);
  });
});

describe('recurring', () => {
  const r = (frequency: Recurring['frequency'], startDate: string, intervalDays?: number) => ({ frequency, startDate, intervalDays });

  it('steps through each frequency', () => {
    expect(nextRecurringDate(r('daily', '2026-03-01'), '2026-03-10')).toBe('2026-03-11');
    expect(nextRecurringDate(r('weekly', '2026-03-02'), '2026-03-10')).toBe('2026-03-16');
    expect(nextRecurringDate(r('monthly', '2026-01-05'), '2026-03-05')).toBe('2026-04-05');
    expect(nextRecurringDate(r('quarterly', '2026-01-05'), '2026-03-05')).toBe('2026-04-05');
    expect(nextRecurringDate(r('yearly', '2024-02-29'), '2026-03-01')).toBe('2027-02-28');
    expect(nextRecurringDate(r('custom', '2026-03-01', 10), '2026-03-11')).toBe('2026-03-21');
  });

  it('keeps a month-end payment on the last day instead of drifting', () => {
    const rent = r('monthly', '2026-01-31');
    expect(nextRecurringDate(rent, '2026-01-31')).toBe('2026-02-28');
    expect(nextRecurringDate(rent, '2026-02-28')).toBe('2026-03-31');
    expect(nextRecurringDate(rent, '2026-03-31')).toBe('2026-04-30');
  });

  it('returns the first date when asked from before the start', () => {
    expect(nextRecurringDate(r('monthly', '2026-05-10'), '2026-03-01')).toBe('2026-05-10');
    expect(nextRecurringDate(r('weekly', '2026-05-10'), '2026-03-01')).toBe('2026-05-10');
  });

  it('flags overdue items and those inside their reminder window', () => {
    const item = (id: string, nextDueDate: string, extra: Partial<Recurring> = {}): Recurring => ({
      id,
      spaceId: 's',
      name: id,
      amount: 100,
      type: 'expense',
      accountId: 'bank',
      frequency: 'monthly',
      startDate: '2026-01-01',
      nextDueDate,
      status: 'active',
      ...extra,
    });
    const list = [
      item('overdue', '2026-03-08'),
      item('today', '2026-03-10'),
      item('soon', '2026-03-12', { reminderDays: 3 }),
      item('later', '2026-03-12'),
      item('paused', '2026-03-01', { status: 'paused' }),
    ];
    expect(needsAttention(list, '2026-03-10').map((a) => a.recurring.id)).toEqual(['overdue', 'today', 'soon']);
  });

  it('compares schedules by their monthly cost', () => {
    expect(monthlyEquivalent({ amount: 1200, frequency: 'yearly' })).toBe(100);
    expect(monthlyEquivalent({ amount: 300, frequency: 'quarterly' })).toBe(100);
    expect(monthlyEquivalent({ amount: 100, frequency: 'monthly' })).toBe(100);
  });
});

describe('demo data', () => {
  const now = '2026-11-14';
  const seed = buildSeed('guest', now);

  it('gives every Space budgets and a goal that add up from real records', () => {
    for (const space of seed.spaces) {
      const budgets = seed.budgets.filter((b) => b.spaceId === space.id);
      const transactions = seed.transactions.filter((t) => t.spaceId === space.id);
      expect(budgets.length).toBeGreaterThan(0);
      const statuses = budgets.map((b) => budgetStatus(b, transactions, now));
      for (const s of statuses) expect(s.period, s.budget.name).not.toBeNull();
      // Some small budgets can be untouched this month; at least one must have real spending.
      expect(
        statuses.some((s) => s.spent > 0),
        space.name,
      ).toBe(true);
      for (const g of seed.goals.filter((goal) => goal.spaceId === space.id)) {
        const s = goalStatus(g, seed.goalEntries, now);
        expect(s.saved).toBeGreaterThan(0);
        expect(s.saved).toBeLessThan(g.targetAmount);
      }
    }
  });

  it('keeps each recurring item due on the day it started', () => {
    for (const r of seed.recurring) {
      expect(r.nextDueDate > now, r.name).toBe(true);
      expect(nextRecurringDate(r, now), r.name).toBe(r.nextDueDate);
    }
  });
});
