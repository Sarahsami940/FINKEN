import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import { expectedEvents, expectedTotals, needsReminder, recentlySettled, undatedOwed, type UpcomingInput } from './upcoming';
import type { Obligation, Recurring, Transaction } from './types';

const NOW = '2026-03-10';
let n = 0;

function rec(extra: Partial<Recurring> = {}): Recurring {
  return {
    id: `r${n++}`,
    spaceId: 's',
    name: 'Rent',
    amount: 1000,
    type: 'expense',
    accountId: 'bank',
    frequency: 'monthly',
    startDate: '2026-01-15',
    nextDueDate: '2026-03-15',
    status: 'active',
    ...extra,
  };
}
function owe(kind: Obligation['kind'], amount: number, extra: Partial<Obligation> = {}): Obligation {
  return { id: `o${n++}`, spaceId: 's', kind, personId: 'p', title: 'Owed', amount, currency: 'PKR', date: '2026-01-01', status: 'open', createdAt: '', updatedAt: '', ...extra };
}
function tx(type: Transaction['type'], amount: number, extra: Partial<Transaction> = {}): Transaction {
  return { id: `t${n++}`, spaceId: 's', type, amount, currency: 'PKR', date: '2026-03-01', description: '', accountId: 'bank', createdAt: '', updatedAt: '', status: 'confirmed', ...extra };
}
const input = (extra: Partial<UpcomingInput>): UpcomingInput => ({ recurring: [], obligations: [], transactions: [], ...extra });
const range = (to: string, from = NOW) => ({ from, to });

describe('expected events', () => {
  it('projects each recurring occurrence in the range, and only the first can be marked paid', () => {
    const events = expectedEvents(input({ recurring: [rec()] }), range('2026-05-31'), NOW);
    expect(events.map((e) => e.date)).toEqual(['2026-03-15', '2026-04-15', '2026-05-15']);
    expect(events.map((e) => e.actionable)).toEqual([true, false, false]);
    expect(events[0]).toMatchObject({ direction: 'out', kind: 'bill', status: 'due-soon' });
    expect(events[1].status).toBe('upcoming');
  });

  it('includes overdue items whatever the range start, and skips stopped ones', () => {
    const late = rec({ nextDueDate: '2026-03-01' });
    const paused = rec({ status: 'paused' });
    const ended = rec({ endDate: '2026-03-31' });
    const events = expectedEvents(input({ recurring: [late, paused, ended] }), range('2026-04-30', '2026-03-12'), NOW);
    expect(events.filter((e) => e.sourceId === late.id)[0]).toMatchObject({ date: '2026-03-01', status: 'overdue' });
    expect(events.some((e) => e.sourceId === paused.id)).toBe(false);
    expect(events.filter((e) => e.sourceId === ended.id).map((e) => e.date)).toEqual(['2026-03-15']);
  });

  it('expects only what is still owed, and nothing for settled or written-off records', () => {
    const invoice = owe('receivable', 5000, { dueDate: '2026-03-20' });
    const settled = owe('payable', 300, { dueDate: '2026-03-20' });
    const written = owe('payable', 999, { dueDate: '2026-03-20', status: 'cancelled' });
    const transactions = [tx('income', 2000, { obligationId: invoice.id }), tx('expense', 300, { obligationId: settled.id })];
    const events = expectedEvents(input({ obligations: [invoice, settled, written], transactions }), range('2026-04-30'), NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ amount: 3000, direction: 'in', kind: 'to-receive' });
  });

  it('spreads a loan into its remaining instalments, with the rest due on the final date', () => {
    const loan = owe('borrowed', 1000, { instalmentAmount: 300, instalmentFrequency: 'monthly', dueDate: '2026-06-01' });
    const transactions = [tx('principal_in', 1000, { obligationId: loan.id }), tx('principal_out', 300, { obligationId: loan.id })];
    const events = expectedEvents(input({ obligations: [loan], transactions }), range('2026-12-31'), NOW);
    expect(events.map((e) => [e.date, e.amount])).toEqual([
      ['2026-03-01', 300],
      ['2026-04-01', 300],
      ['2026-05-01', 100],
    ]);
    expect(events[0].status).toBe('overdue');
    expect(expectedTotals(events).outgoing).toBe(700);
  });

  it('shows an obligation once when a recurring item pays it, and stops at the balance', () => {
    const loan = owe('borrowed', 1000, { instalmentAmount: 400, instalmentFrequency: 'monthly' });
    const plan = rec({ name: 'Loan instalment', amount: 400, obligationId: loan.id });
    const events = expectedEvents(input({ recurring: [plan], obligations: [loan], transactions: [tx('principal_in', 1000, { obligationId: loan.id })] }), range('2026-12-31'), NOW);
    expect(events.every((e) => e.source === 'recurring')).toBe(true);
    expect(events.map((e) => e.amount)).toEqual([400, 400, 200]);
    expect(events[0]).toMatchObject({ kind: 'instalment', obligationId: loan.id, personId: 'p' });
  });

  it('expects nothing from a recurring plan once its loan is settled', () => {
    const loan = owe('borrowed', 400);
    const plan = rec({ amount: 400, obligationId: loan.id });
    const transactions = [tx('principal_in', 400, { obligationId: loan.id }), tx('principal_out', 400, { obligationId: loan.id })];
    expect(expectedEvents(input({ recurring: [plan], obligations: [loan], transactions }), range('2026-12-31'), NOW)).toEqual([]);
  });

  it('keeps undated money owed out of the calendar but available to list', () => {
    const undated = owe('lent', 500);
    const data = input({ obligations: [undated], transactions: [tx('principal_out', 500, { obligationId: undated.id })] });
    expect(expectedEvents(data, range('2026-12-31'), NOW)).toEqual([]);
    expect(undatedOwed(data, NOW).map((p) => p.outstanding)).toEqual([500]);
  });
});

describe('totals and reminders', () => {
  it('nets expected money in and out', () => {
    const events = expectedEvents(input({ recurring: [rec(), rec({ type: 'income', name: 'Salary', amount: 5000 })] }), range('2026-03-31'), NOW);
    expect(expectedTotals(events)).toEqual({ incoming: 5000, outgoing: 1000, net: 4000, count: 2 });
  });

  it('reminds inside the window, always for overdue, and never while snoozed', () => {
    const soon = rec({ nextDueDate: '2026-03-12', reminderDays: 3 });
    const quiet = rec({ nextDueDate: '2026-03-12' });
    const late = rec({ nextDueDate: '2026-03-01' });
    const snoozed = rec({ nextDueDate: '2026-03-01', snoozedUntil: '2026-03-13' });
    const bill = owe('payable', 200, { dueDate: '2026-03-12' });
    const data = input({ recurring: [soon, quiet, late, snoozed], obligations: [bill] });
    const events = expectedEvents(data, range('2026-04-30'), NOW);
    const ids = needsReminder(events, data.recurring, NOW).map((e) => e.sourceId);
    expect(ids.sort()).toEqual([soon.id, late.id, bill.id].sort());
    // Once the snooze ends, the reminder is back.
    expect(needsReminder(events, data.recurring, '2026-03-13').some((e) => e.sourceId === snoozed.id)).toBe(true);
  });

  it('lists recent settlements but not loan hand-overs or interest', () => {
    const loan = owe('borrowed', 1000);
    const invoice = owe('receivable', 500);
    const transactions = [
      tx('principal_in', 1000, { obligationId: loan.id }),
      tx('principal_out', 200, { obligationId: loan.id }),
      tx('expense', 20, { obligationId: loan.id }),
      tx('income', 500, { obligationId: invoice.id }),
      tx('expense', 100, { recurringId: 'r-x' }),
      tx('expense', 70),
    ];
    const settled = recentlySettled(input({ obligations: [loan, invoice], transactions }), range('2026-03-31', '2026-02-01'));
    expect(settled.map((s) => [s.transaction.amount, s.direction])).toEqual(
      expect.arrayContaining([
        [200, 'out'],
        [500, 'in'],
        [100, 'out'],
      ]),
    );
    expect(settled).toHaveLength(3);
  });
});

describe('demo data', () => {
  it('projects the next month for every Space without double counting the equipment loan', () => {
    const now = '2026-11-14';
    const seed = buildSeed('guest', now);
    for (const space of seed.spaces) {
      const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === space.id);
      const events = expectedEvents(
        { recurring: own(seed.recurring), obligations: own(seed.obligations), transactions: own(seed.transactions) },
        { from: now, to: '2026-12-14' },
        now,
      );
      expect(events.length, space.name).toBeGreaterThan(0);
      const keys = events.map((e) => `${e.obligationId ?? e.key}:${e.date}`);
      expect(new Set(keys).size, space.name).toBe(keys.length);
    }
  });
});
