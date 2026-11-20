/**
 * The data-consistency scenarios from the build plan, run against the real
 * store and the shared Money Engine. The same scenarios run twice: on browser
 * storage (integration.test.ts) and on the real API and Postgres
 * (tests/e2e). Opening a second store on the same storage stands in for
 * refreshing the browser.
 */

import { cashFlow, profitAndLoss } from '@finken/domain/business';
import { monthRange, today, todayIn } from '@finken/domain/dates';
import { accountBalances, obligationPosition, spendingByCategory, summarize, totalBalance } from '@finken/domain/money';
import { budgetStatus, goalStatus, occurrenceId } from '@finken/domain/planning';
import { parseSearch, runSearch } from '@finken/domain/search';
import type { Transaction } from '@finken/domain/types';
import { expectedEvents } from '@finken/domain/upcoming';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditedStorage, type AuditFields, type MemoryAdapter } from './storage';
import type { AppStore } from './store';

export interface ScenarioSetup {
  store: AppStore;
  /** A second store on the same data, as after refreshing the page. */
  reopen: () => Promise<AppStore>;
  /** Resolves once every save has reached storage. */
  settle: () => Promise<void>;
  /** Whether the user is a guest (browser only) or a signed-in account (API). */
  guest: boolean;
  /** Reads transactions straight from storage, change history included. */
  readTransactions: (ids: string[]) => Promise<(Transaction & AuditFields)[]>;
}

export function consistencyScenarios(label: string, setup: () => Promise<ScenarioSetup>, options: { localStorage?: MemoryAdapter } = {}) {
  let env: ScenarioSetup;
  let store: AppStore;
  const storage = options.localStorage;
  const now = today();
  const month = monthRange(now);
  let spaceId = '';
  let bank = '';
  let cash = '';
  let food = '';

  const mine = () => {
    const s = store.getState();
    const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === spaceId);
    return {
      transactions: own(s.transactions),
      accounts: own(s.accounts),
      categories: own(s.categories),
      obligations: own(s.obligations),
      recurring: own(s.recurring),
      budgets: own(s.budgets),
      goals: own(s.goals),
      goalEntries: own(s.goalEntries),
    };
  };
  const thisMonth = () => summarize(mine().transactions, month);
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error);
    return r as Extract<T, { ok: true }>;
  };
  const draft = (type: 'expense' | 'income', amount: number, extra: Record<string, string> = {}) => ({
    spaceId,
    type,
    amount,
    date: now,
    description: `${type} ${amount}`,
    accountId: bank,
    ...extra,
  });

  beforeAll(async () => {
    env = await setup();
    store = env.store;
    await store.init();
    await store.enterGuest('personal');
    // A clean Space of its own, next to the demo Spaces, so every figure here is exact.
    const space = store.createSpace({ name: 'QA', type: 'personal', icon: 'home', description: '', currency: 'PKR' })!;
    spaceId = space.id;
    store.setActiveSpace(spaceId);
    const { accounts, categories } = mine();
    bank = accounts.find((a) => a.kind === 'bank')!.id;
    cash = accounts.find((a) => a.kind === 'cash')!.id;
    food = categories.find((c) => c.name === 'Food')!.id;
  });

  // Anything the storage refuses would leave the screen and the saved data apart.
  afterEach(async () => {
    await env.settle();
    expect(store.getState().error).toBeNull();
  });

  describe(`data consistency: ${label}`, () => {
    it('1. an expense increases Spent', () => {
      ok(store.addTransaction(draft('expense', 4000, { categoryId: food })));
      expect(thisMonth().spent).toBe(4000);
      expect(spendingByCategory(mine().transactions, mine().categories)[0]).toMatchObject({ name: 'Food', amount: 4000 });
    });

    it('2. income increases Income', () => {
      ok(store.addTransaction(draft('income', 50000)));
      expect(thisMonth().income).toBe(50000);
      expect(totalBalance(mine().accounts, mine().transactions)).toBe(46000);
    });

    it('3. a transfer moves money without being income or spending', () => {
      ok(store.addTransaction({ spaceId, type: 'transfer', amount: 10000, date: now, description: 'Cash', accountId: bank, toAccountId: cash }));
      const s = thisMonth();
      expect([s.income, s.spent]).toEqual([50000, 4000]);
      const balances = new Map(accountBalances(mine().accounts, mine().transactions).map((b) => [b.account.id, b.balance]));
      expect([balances.get(bank), balances.get(cash)]).toEqual([36000, 10000]);
    });

    it('4. spending in a budgeted category uses up that budget', () => {
      const { budget } = ok(store.addBudget(spaceId, { name: 'Food', amount: 10000, frequency: 'monthly', startDate: month.from, categoryId: food }));
      ok(store.addTransaction(draft('expense', 2500, { categoryId: food })));
      const status = budgetStatus(budget, mine().transactions, now);
      expect(status.spent).toBe(6500);
      expect(status.remaining).toBe(3500);
    });

    it('5. a receivable is partly settled', () => {
      const person = ok(store.addPerson(spaceId, { name: 'Ali' })).person;
      const { obligation } = ok(store.addObligation({ spaceId, kind: 'receivable', personId: person.id, title: 'Invoice', amount: 8000, date: now }));
      ok(store.settleObligation(obligation.id, { amount: 3000, date: now, accountId: bank, categoryId: mine().categories.find((c) => c.kind === 'income')!.id }));
      const o = mine().obligations.find((x) => x.id === obligation.id)!;
      expect(obligationPosition(o, mine().transactions, now)).toMatchObject({ settled: 3000, outstanding: 5000, state: 'open' });
      // Counted once, when the money arrives.
      expect(thisMonth().income).toBe(53000);
      const search = runSearch(parseSearch('how much does Ali owe me', { ...store.getState(), activeSpaceId: spaceId }, now), store.getState(), now);
      expect(search.kind === 'owed' && search.total).toBe(5000);
    });

    it('6. a payable is partly settled', () => {
      const person = ok(store.addPerson(spaceId, { name: 'Supplier' })).person;
      const { obligation } = ok(store.addObligation({ spaceId, kind: 'payable', personId: person.id, title: 'Bill', amount: 6000, date: now }));
      ok(store.settleObligation(obligation.id, { amount: 2000, date: now, accountId: bank, categoryId: food }));
      expect(obligationPosition(mine().obligations.find((x) => x.id === obligation.id)!, mine().transactions, now).outstanding).toBe(4000);
      expect(thisMonth().spent).toBe(8500);
    });

    it('7. a loan and a repayment update what is owed, never income or spending', () => {
      const before = thisMonth();
      const lender = ok(store.addPerson(spaceId, { name: 'Bank Loan' })).person;
      const { obligation } = ok(store.addObligation({ spaceId, kind: 'borrowed', personId: lender.id, title: 'Loan', amount: 100000, date: now }, { accountId: bank }));
      ok(store.settleObligation(obligation.id, { amount: 25000, date: now, accountId: bank }));
      expect(obligationPosition(mine().obligations.find((x) => x.id === obligation.id)!, mine().transactions, now).outstanding).toBe(75000);
      const after = thisMonth();
      expect([after.income, after.spent]).toEqual([before.income, before.spent]);
      expect(after.cashChange - before.cashChange).toBe(75000);
    });

    it('8. a recurring expense appears in Coming up', () => {
      const next = monthRange(now, 1).from;
      ok(store.addRecurring(spaceId, { name: 'Internet', amount: 3000, type: 'expense', accountId: bank, frequency: 'monthly', startDate: next }));
      const events = expectedEvents(
        { recurring: mine().recurring, obligations: mine().obligations, transactions: mine().transactions },
        { from: now, to: monthRange(now, 1).to },
        now,
      );
      expect(events.some((e) => e.title === 'Internet' && e.date === next && e.amount === 3000)).toBe(true);
    });

    it('9. a goal contribution counts towards the goal and changes no balance', () => {
      const balance = totalBalance(mine().accounts, mine().transactions);
      const { goal } = ok(store.addGoal(spaceId, { name: 'Trip', targetAmount: 20000, description: '', icon: 'plane' }));
      ok(store.addGoalEntry(goal.id, { amount: 5000, date: now }));
      expect(goalStatus(goal, mine().goalEntries, now)).toMatchObject({ saved: 5000, remaining: 15000 });
      expect(totalBalance(mine().accounts, mine().transactions)).toBe(balance);
    });

    it('10. Spaces keep their records apart', () => {
      const s = store.getState();
      const demo = s.spaces.find((x) => x.type === 'business')!;
      const qaIds = new Set(mine().transactions.map((t) => t.id));
      expect(s.transactions.filter((t) => t.spaceId === demo.id).some((t) => qaIds.has(t.id))).toBe(false);
      // Each Space has its own categories, so a QA category can never be used in another Space.
      expect(s.categories.find((c) => c.id === food)!.spaceId).toBe(spaceId);
      const p = profitAndLoss(
        s.transactions.filter((t) => t.spaceId === demo.id),
        s.categories.filter((c) => c.spaceId === demo.id),
        month,
      );
      expect(p.revenue).toBe(
        summarize(
          s.transactions.filter((t) => t.spaceId === demo.id),
          month,
        ).income,
      );
    });

    it('11. editing and deleting a transaction updates every figure built on it', () => {
      const { transaction } = ok(store.addTransaction(draft('expense', 1000, { categoryId: food })));
      const budget = mine().budgets[0];
      expect(budgetStatus(budget, mine().transactions, now).spent).toBe(9500);
      ok(store.updateTransaction(transaction.id, draft('expense', 1500, { categoryId: food })));
      expect(budgetStatus(budget, mine().transactions, now).spent).toBe(10000);
      expect(thisMonth().spent).toBe(10000);
      expect(store.deleteTransaction(transaction.id)).not.toBeNull();
      expect(budgetStatus(budget, mine().transactions, now).spent).toBe(8500);
      expect(thisMonth().spent).toBe(8500);
      // Cash flow reconciles with balances after all of it.
      const flow = cashFlow(mine().accounts, mine().transactions, mine().obligations, month);
      expect(flow.closing).toBe(totalBalance(mine().accounts, mine().transactions));
    });

    it('12. everything is still there after a refresh', async () => {
      await env.settle();
      const reopened = await env.reopen();
      await reopened.init();
      const s = reopened.getState();
      const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === spaceId);
      expect(s.user?.isGuest).toBe(env.guest);
      expect(s.user?.id).toBe(store.getState().user?.id);
      expect(own(s.transactions).length).toBe(mine().transactions.length);
      expect(summarize(own(s.transactions), month)).toEqual(thisMonth());
      expect(own(s.obligations).length).toBe(3);
      expect([own(s.budgets).length, own(s.goals).length, own(s.goalEntries).length, own(s.recurring).length]).toEqual([1, 1, 1, 1]);
    });
  });

  describe(`production rules: ${label}`, () => {
    it('13. saving the same request twice records the money once', () => {
      const before = mine().transactions.length;
      const first = ok(store.addTransaction(draft('expense', 12345, { categoryId: food }), 'req-1'));
      const again = ok(store.addTransaction(draft('expense', 12345, { categoryId: food }), 'req-1'));
      expect(again.transaction).toBe(first.transaction);
      expect(mine().transactions.length).toBe(before + 1);
      expect(first.transaction.id).toBe('req-1');
    });

    it('14. marking the same occurrence paid twice pays it once and moves the due date once', () => {
      const due = monthRange(now, 1).from;
      const { recurring } = ok(store.addRecurring(spaceId, { name: 'Gym', amount: 500000, type: 'expense', accountId: bank, frequency: 'monthly', startDate: due }));
      const id = occurrenceId(recurring.id, due);
      ok(store.confirmRecurring(recurring.id, due, undefined, id));
      ok(store.confirmRecurring(recurring.id, due, undefined, id));
      expect(mine().transactions.filter((t) => t.recurringId === recurring.id)).toHaveLength(1);
      expect(mine().recurring.find((r) => r.id === recurring.id)!.nextDueDate).toBe(monthRange(now, 2).from);
    });

    it('15. amounts must be whole paisa', () => {
      expect(store.addTransaction(draft('expense', 10.5)).ok).toBe(false);
      expect(store.addTransaction(draft('expense', 1050)).ok).toBe(true);
    });

    it('16. a deleted transaction stays deleted after a refresh', async () => {
      const { transaction } = ok(store.addTransaction(draft('expense', 777, { categoryId: food })));
      expect(store.deleteTransaction(transaction.id)).not.toBeNull();
      await env.settle();
      if (storage) {
        // Browser storage keeps the deleted record, with its history. (The API's own tests cover the server.)
        const deleted = await new AuditedStorage(storage, () => undefined).getDeleted<Transaction & AuditFields>('transactions');
        expect(deleted.find((t) => t.id === transaction.id)).toMatchObject({ amount: 777, version: 2, deletedBy: store.getState().user!.id });
      }
      const reopened = await env.reopen();
      await reopened.init();
      expect(reopened.getState().transactions.some((t) => t.id === transaction.id)).toBe(false);
    });

    it('17. every saved record says who made it and when', async () => {
      await env.settle();
      const [saved] = await env.readTransactions(['req-1']);
      expect(saved).toMatchObject({ createdBy: store.getState().user!.id, version: 1 });
      expect(Date.parse(saved.updatedAt!)).not.toBeNaN();
    });

    it('18. the guest has a time zone, and today follows it', () => {
      const user = store.getState().user!;
      expect(user.timeZone).toBeTruthy();
      store.updateUser({ timeZone: 'Pacific/Kiritimati' });
      expect(today()).toBe(todayIn('Pacific/Kiritimati'));
      store.updateUser({ timeZone: 'Not/AZone' });
      expect(store.getState().user!.timeZone).toBe('Pacific/Kiritimati');
      store.updateUser({ timeZone: user.timeZone });
    });
  });
}
