import { describe, expect, it } from 'vitest';
import { dailyReminder } from './reminders';
import type { Recurring } from './types';

const TODAY = '2026-11-20';
const rec = (id: string, nextDueDate: string, extra: Partial<Recurring> = {}): Recurring => ({
  id,
  spaceId: 's',
  name: `Secret name ${id}`,
  amount: 987654,
  type: 'expense',
  accountId: 'bank',
  frequency: 'monthly',
  startDate: '2026-01-01',
  nextDueDate,
  status: 'active',
  reminderDays: 3,
  ...extra,
});
const none = { obligations: [], transactions: [] };

describe('the daily reminder', () => {
  it('is nothing when nothing needs attention', () => {
    expect(dailyReminder({ recurring: [rec('far', '2026-12-15')], ...none }, TODAY)).toBeNull();
    expect(dailyReminder({ recurring: [], ...none }, TODAY)).toBeNull();
  });

  it('counts what is overdue, due today, due soon and expected in, in one sentence', () => {
    const r = dailyReminder(
      {
        recurring: [rec('late', '2026-11-18'), rec('today', TODAY), rec('today2', TODAY), rec('soon', '2026-11-22'), rec('pay', '2026-11-21', { type: 'income' })],
        ...none,
      },
      TODAY,
    )!;
    expect(r.title).toBe('Something is overdue');
    expect(r.body).toBe('1 payment is overdue, 2 payments are due today, 1 payment is due soon and 1 amount is expected in. Open Finken to see them.');
    expect(r.counts).toEqual({ overdue: 1, dueToday: 2, dueSoon: 1, toReceive: 1 });
    expect(r).toMatchObject({ tag: 'finken-reminder-2026-11-20', url: '/money/upcoming' });
  });

  it('never says amounts or names, as it can show on a locked screen', () => {
    const r = dailyReminder({ recurring: [rec('today', TODAY)], ...none }, TODAY)!;
    expect(`${r.title} ${r.body}`).not.toMatch(/Secret|9,876|98765|Rs/);
    expect(r).toMatchObject({ title: 'Due today', body: '1 payment is due today. Open Finken to see them.' });
  });

  it('respects each item’s own lead time and snoozes', () => {
    expect(dailyReminder({ recurring: [rec('a', '2026-11-25', { reminderDays: 3 })], ...none }, TODAY)).toBeNull();
    expect(dailyReminder({ recurring: [rec('a', '2026-11-25', { reminderDays: 7 })], ...none }, TODAY)?.body).toBe('1 payment is due soon. Open Finken to see them.');
    expect(dailyReminder({ recurring: [rec('a', TODAY, { snoozedUntil: '2026-11-22' })], ...none }, TODAY)).toBeNull();
  });

  it('changes its digest only when what needs attention changes', () => {
    const one = dailyReminder({ recurring: [rec('a', TODAY)], ...none }, TODAY)!;
    expect(dailyReminder({ recurring: [rec('a', TODAY)], ...none }, TODAY)!.digest).toBe(one.digest);
    expect(dailyReminder({ recurring: [rec('a', TODAY), rec('b', TODAY)], ...none }, TODAY)!.digest).not.toBe(one.digest);
  });
});
