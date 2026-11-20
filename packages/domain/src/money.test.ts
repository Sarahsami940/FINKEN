import { describe, expect, it } from 'vitest';
import {
  accountBalances,
  checkTransaction,
  filterTransactions,
  type IntegrityContext,
  interestPaid,
  movementKind,
  nextDueDate,
  obligationPosition,
  obligationStatus,
  owedSummary,
  personHistory,
  personSummaries,
  refundedAmount,
  settlementType,
  sharedAmount,
  spendingByCategory,
  splitEqually,
  summarize,
  totalBalance,
  totalIncome,
  totalSpent,
  transactionLabel,
} from './money';
import { buildSeed } from './seed';
import type { Account, Category, Obligation, Transaction, TransactionDraft, TransactionType } from './types';

const SPACE = 's1';
const accounts: Account[] = [
  { id: 'bank', spaceId: SPACE, name: 'Bank', kind: 'bank', openingBalance: 1000 },
  { id: 'cash', spaceId: SPACE, name: 'Cash', kind: 'cash', openingBalance: 200 },
  { id: 'elsewhere', spaceId: 's2', name: 'Other Space', kind: 'bank', openingBalance: 0 },
];
const categories: Category[] = [
  { id: 'food', spaceId: SPACE, name: 'Food', kind: 'expense', icon: 'utensils', color: 'orange', subcategories: [] },
  { id: 'shopping', spaceId: SPACE, name: 'Shopping', kind: 'expense', icon: 'shopping-bag', color: 'rose', subcategories: [] },
  { id: 'salary', spaceId: SPACE, name: 'Salary', kind: 'income', icon: 'briefcase', color: 'green', subcategories: [] },
];

let n = 0;
function tx(type: TransactionType, amount: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: `t${n++}`,
    spaceId: SPACE,
    type,
    amount,
    currency: 'PKR',
    date: '2026-03-10',
    description: '',
    accountId: 'bank',
    createdAt: '',
    updatedAt: '',
    status: 'confirmed',
    ...extra,
  };
}

function owe(kind: Obligation['kind'], amount: number, extra: Partial<Obligation> = {}): Obligation {
  return {
    id: `o${n++}`,
    spaceId: SPACE,
    kind,
    personId: 'p1',
    title: 'Owed',
    amount,
    currency: 'PKR',
    date: '2026-03-01',
    status: 'open',
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

const draft = (type: TransactionType, amount: number, extra: Partial<TransactionDraft> = {}): TransactionDraft => ({
  spaceId: SPACE,
  type,
  amount,
  date: '2026-03-10',
  description: '',
  accountId: 'bank',
  ...extra,
});

const ctx = (transactions: Transaction[] = [], obligations: Obligation[] = []): IntegrityContext => ({ accounts, categories, transactions, obligations });

describe('income, spending and net', () => {
  it('counts only income and expenses', () => {
    const list = [tx('income', 500, { categoryId: 'salary' }), tx('expense', 120, { categoryId: 'food' })];
    expect(summarize(list)).toMatchObject({ income: 500, spent: 120, net: 380, cashChange: 380 });
  });

  it('never counts a transfer as income or spending', () => {
    const list = [tx('transfer', 300, { toAccountId: 'cash' })];
    expect(totalIncome(list)).toBe(0);
    expect(totalSpent(list)).toBe(0);
    expect(totalBalance(accounts.slice(0, 2), list)).toBe(1200);
    const [bank, cash] = accountBalances(accounts.slice(0, 2), list);
    expect([bank.balance, cash.balance]).toEqual([700, 500]);
  });

  it('never counts loan principal as income or spending, in either direction', () => {
    const list = [tx('principal_in', 5000), tx('principal_out', 1500)];
    const s = summarize(list);
    expect(s).toMatchObject({ income: 0, spent: 0, net: 0, owedIn: 5000, owedOut: 1500, cashChange: 3500 });
    expect(totalBalance(accounts.slice(0, 2), list)).toBe(1200 + 3500);
  });

  it('treats a refund as less spending, not as income', () => {
    const shoes = tx('expense', 900, { categoryId: 'shopping' });
    const list = [shoes, tx('refund', 400, { categoryId: 'shopping', refundOfId: shoes.id }), tx('expense', 100, { categoryId: 'food' })];
    expect(totalIncome(list)).toBe(0);
    expect(totalSpent(list)).toBe(600);
    const byCategory = spendingByCategory(list, categories);
    expect(byCategory.map((c) => [c.name, c.amount])).toEqual([
      ['Shopping', 500],
      ['Food', 100],
    ]);
    expect(byCategory.reduce((sum, c) => sum + c.amount, 0)).toBe(totalSpent(list));
  });

  it('keeps the change in balances equal to cashChange', () => {
    const list = [
      tx('income', 800),
      tx('expense', 250, { accountId: 'cash' }),
      tx('refund', 50, { accountId: 'cash' }),
      tx('transfer', 100, { toAccountId: 'cash' }),
      tx('principal_in', 400),
      tx('principal_out', 90),
    ];
    expect(totalBalance(accounts.slice(0, 2), list) - 1200).toBe(summarize(list).cashChange);
  });
});

describe('money movement', () => {
  it('names withdrawals and deposits', () => {
    expect(movementKind(tx('transfer', 1, { toAccountId: 'cash' }), accounts)).toBe('withdrawal');
    expect(movementKind(tx('transfer', 1, { accountId: 'cash', toAccountId: 'bank' }), accounts)).toBe('deposit');
    expect(transactionLabel(tx('transfer', 1, { toAccountId: 'cash' }), accounts)).toBe('Cash withdrawal');
  });
});

describe('money owed', () => {
  it('books a receivable as income once, when it is paid', () => {
    const o = owe('receivable', 1000);
    expect(settlementType(o)).toBe('income');
    expect(summarize([]).income).toBe(0); // creating it records nothing
    const list = [tx('income', 600, { obligationId: o.id })];
    expect(summarize(list).income).toBe(600);
    expect(obligationPosition(o, list)).toMatchObject({ settled: 600, outstanding: 400, state: 'open' });
  });

  it('books a payable as an expense once, when it is paid', () => {
    const o = owe('payable', 700);
    const list = [tx('expense', 700, { obligationId: o.id })];
    expect(summarize(list).spent).toBe(700);
    expect(obligationPosition(o, list).state).toBe('settled');
  });

  it('settles a share of an expense as a refund of that expense', () => {
    const dinner = tx('expense', 600, { categoryId: 'food' });
    const o = owe('receivable', 300, { sourceTransactionId: dinner.id });
    expect(settlementType(o)).toBe('refund');
    const list = [dinner, tx('refund', 300, { obligationId: o.id, refundOfId: dinner.id, categoryId: 'food' })];
    expect(summarize(list)).toMatchObject({ income: 0, spent: 300 });
    expect(obligationPosition(o, list).outstanding).toBe(0);
  });

  it('tracks a loan through hand-over and repayments', () => {
    const o = owe('borrowed', 1000, { dueDate: '2026-03-05' });
    const list = [tx('principal_in', 1000, { obligationId: o.id }), tx('principal_out', 250, { obligationId: o.id })];
    const position = obligationPosition(o, list, '2026-03-10');
    expect(position).toMatchObject({ settled: 250, outstanding: 750, overdue: true });
    expect(transactionLabel(list[0], accounts, o)).toBe('Loan received');
    expect(transactionLabel(list[1], accounts, o)).toBe('Loan repayment');
  });

  it('totals what is owed each way and ignores written-off items', () => {
    const lent = owe('lent', 500);
    const payable = owe('payable', 300);
    const gone = owe('receivable', 999, { status: 'cancelled' });
    const s = owedSummary([lent, payable, gone], [tx('principal_in', 200, { obligationId: lent.id })]);
    expect(s).toMatchObject({ owedToYou: 300, youOwe: 300 });
    expect(s.open).toHaveLength(2);
  });

  it('updates the position when a linked transaction is deleted', () => {
    const o = owe('lent', 500);
    const repayment = tx('principal_in', 200, { obligationId: o.id });
    expect(obligationPosition(o, [repayment]).outstanding).toBe(300);
    expect(obligationPosition(o, []).outstanding).toBe(500);
  });
});

describe('integrity checks', () => {
  it('accepts a plain expense', () => {
    expect(checkTransaction(draft('expense', 50, { categoryId: 'food' }), ctx())).toBeNull();
  });

  it('rejects amounts that are not positive', () => {
    expect(checkTransaction(draft('expense', 0), ctx())).toMatch(/greater than zero/);
    expect(checkTransaction(draft('income', Number.NaN), ctx())).toMatch(/greater than zero/);
  });

  it('rejects an account from another Space', () => {
    expect(checkTransaction(draft('expense', 50, { accountId: 'elsewhere' }), ctx())).toMatch(/account from this Space/);
    expect(checkTransaction(draft('transfer', 50, { toAccountId: 'elsewhere' }), ctx())).toMatch(/account from this Space/);
  });

  it('rejects a category of the wrong kind', () => {
    expect(checkTransaction(draft('income', 50, { categoryId: 'food' }), ctx())).toMatch(/income category/);
    expect(checkTransaction(draft('expense', 50, { categoryId: 'salary' }), ctx())).toMatch(/spending category/);
  });

  it('rejects a transfer to the same account', () => {
    expect(checkTransaction(draft('transfer', 50, { toAccountId: 'bank' }), ctx())).toMatch(/two different accounts/);
  });

  it('stops a refund exceeding what is left of the expense', () => {
    const shoes = tx('expense', 900);
    const first = tx('refund', 500, { refundOfId: shoes.id });
    const c = ctx([shoes, first]);
    expect(refundedAmount(shoes.id, c.transactions)).toBe(500);
    expect(checkTransaction(draft('refund', 400, { refundOfId: shoes.id }), c)).toBeNull();
    expect(checkTransaction(draft('refund', 401, { refundOfId: shoes.id }), c)).toMatch(/Only 4 of/);
    // Editing the existing refund may use its own amount again.
    expect(checkTransaction(draft('refund', 900, { refundOfId: shoes.id }), c, first.id)).toBeNull();
  });

  it('stops a refunded expense shrinking below its refunds', () => {
    const shoes = tx('expense', 900);
    const c = ctx([shoes, tx('refund', 500, { refundOfId: shoes.id })]);
    expect(checkTransaction(draft('expense', 400), c, shoes.id)).toMatch(/already been refunded/);
    expect(checkTransaction(draft('income', 900), c, shoes.id)).toMatch(/stay an expense/);
    expect(checkTransaction(draft('expense', 500), c, shoes.id)).toBeNull();
  });

  it('requires principal to belong to a loan and stay within it', () => {
    const o = owe('borrowed', 1000);
    const c = ctx([tx('principal_in', 1000, { obligationId: o.id }), tx('principal_out', 700, { obligationId: o.id })], [o]);
    expect(checkTransaction(draft('principal_out', 100), c)).toMatch(/which loan/);
    expect(checkTransaction(draft('principal_out', 300, { obligationId: o.id }), c)).toBeNull();
    expect(checkTransaction(draft('principal_out', 301, { obligationId: o.id }), c)).toMatch(/Only 3 is/);
    expect(checkTransaction(draft('principal_in', 1, { obligationId: o.id }), c)).toMatch(/more than the 10 agreed/);
  });

  it('stops loan repayments being booked as ordinary income or expenses', () => {
    const lent = owe('lent', 500);
    const borrowed = owe('borrowed', 500);
    const c = ctx([], [lent, borrowed]);
    expect(checkTransaction(draft('expense', 100, { obligationId: lent.id }), c)).toMatch(/cannot be linked/);
    expect(checkTransaction(draft('income', 100, { obligationId: borrowed.id }), c)).toMatch(/cannot be linked/);
    expect(checkTransaction(draft('refund', 100, { obligationId: borrowed.id }), c)).toMatch(/cannot be linked/);
  });

  it('stops a receivable or payable being settled twice over', () => {
    const o = owe('receivable', 400);
    const c = ctx([tx('income', 400, { obligationId: o.id })], [o]);
    expect(checkTransaction(draft('income', 1, { obligationId: o.id }), c)).toMatch(/already been settled/);
  });
});

describe('people, loans and shared costs', () => {
  it('treats loan interest as real spending that does not reduce the loan', () => {
    const o = owe('borrowed', 1000);
    const list = [tx('principal_in', 1000, { obligationId: o.id }), tx('principal_out', 200, { obligationId: o.id }), tx('expense', 30, { obligationId: o.id })];
    expect(checkTransaction(draft('expense', 30, { obligationId: o.id }), ctx([], [o]))).toBeNull();
    expect(obligationPosition(o, list).outstanding).toBe(800);
    expect(interestPaid(o, list)).toBe(30);
    expect(summarize(list).spent).toBe(30);
  });

  it('works out the next instalment date from what has been repaid', () => {
    const o = owe('borrowed', 600, { date: '2026-01-10', instalmentAmount: 100, instalmentFrequency: 'monthly' });
    expect(nextDueDate(o, 0)).toBe('2026-02-10');
    expect(nextDueDate(o, 250)).toBe('2026-04-10');
    expect(nextDueDate({ ...o, dueDate: '2026-03-01' }, 250)).toBe('2026-03-01');
    expect(obligationPosition(o, [tx('principal_out', 100, { obligationId: o.id })], '2026-03-05')).toMatchObject({ nextDue: '2026-03-10', overdue: false, dueSoon: true });
  });

  it('names each status in plain words', () => {
    const o = owe('receivable', 500, { dueDate: '2026-03-20' });
    const at = (list: Transaction[], day: string, ob = o) => obligationStatus(obligationPosition(ob, list, day)).label;
    expect(at([], '2026-03-01')).toBe('Outstanding');
    expect(at([tx('income', 100, { obligationId: o.id })], '2026-03-01')).toBe('Partially received');
    expect(at([], '2026-03-15')).toBe('Due soon');
    expect(at([], '2026-03-21')).toBe('Overdue');
    expect(at([tx('income', 500, { obligationId: o.id })], '2026-03-21')).toBe('Settled');
    expect(at([], '2026-03-21', { ...o, status: 'cancelled' })).toBe('Written off');
  });

  it('nets what each person owes and is owed', () => {
    const ali = { id: 'ali', spaceId: SPACE, name: 'Ali', createdAt: '' };
    const usman = { id: 'usman', spaceId: SPACE, name: 'Usman', createdAt: '' };
    const lent = owe('lent', 8500, { personId: 'ali' });
    const payable = owe('payable', 1000, { personId: 'ali' });
    const done = owe('receivable', 300, { personId: 'usman' });
    const list = [tx('income', 300, { obligationId: done.id })];
    const [first, second] = personSummaries([usman, ali], [lent, payable, done], list);
    expect(first).toMatchObject({ owesYou: 8500, youOwe: 1000, net: 7500 });
    expect(first.person.name).toBe('Ali');
    expect(second).toMatchObject({ net: 0, hasHistory: true });
    expect(personHistory('usman', [lent, payable, done], list)).toHaveLength(1);
  });

  it('splits a bill into shares that add up exactly', () => {
    expect(splitEqually(6000, 3)).toEqual([2000, 2000, 2000]);
    expect(splitEqually(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEqually(10, 4, 0.01).reduce((a, b) => a + b, 0)).toBeCloseTo(10);
  });

  it('stops a shared expense shrinking below what others owe', () => {
    const dinner = tx('expense', 6000);
    const shares = [owe('receivable', 2000, { sourceTransactionId: dinner.id }), owe('receivable', 2000, { sourceTransactionId: dinner.id })];
    expect(sharedAmount(dinner.id, shares)).toBe(4000);
    expect(checkTransaction(draft('expense', 3000), ctx([dinner], shares), dinner.id)).toMatch(/Other people owe you 40 of/);
    expect(checkTransaction(draft('expense', 4000), ctx([dinner], shares), dinner.id)).toBeNull();
  });
});

describe('filtering', () => {
  it('filters by type, including money owed', () => {
    const list = [tx('expense', 1), tx('refund', 1), tx('principal_in', 1), tx('principal_out', 1)];
    expect(filterTransactions(list, { type: 'owed' })).toHaveLength(2);
    expect(filterTransactions(list, { type: 'refund' })).toHaveLength(1);
    expect(filterTransactions(list, { type: 'all' })).toHaveLength(4);
  });
});

describe('demo data', () => {
  const seed = buildSeed('guest', '2026-11-14');

  it('passes every integrity check when replayed in order', () => {
    for (const space of seed.spaces) {
      const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === space.id);
      const saved: Transaction[] = [];
      const context: IntegrityContext = { accounts: own(seed.accounts), categories: own(seed.categories), transactions: saved, obligations: own(seed.obligations) };
      const inOrder = own(seed.transactions).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, undefined, { numeric: true }));
      for (const t of inOrder) {
        expect(checkTransaction(t, context), `${space.name}: ${t.description}`).toBeNull();
        saved.push(t);
      }
    }
  });

  it('never leaves an account overdrawn and has money owed both ways', () => {
    for (const space of seed.spaces) {
      const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === space.id);
      for (const { account, balance } of accountBalances(own(seed.accounts), own(seed.transactions))) {
        expect(balance, `${space.name} ${account.name}`).toBeGreaterThanOrEqual(0);
      }
    }
    const business = seed.spaces.find((s) => s.type === 'business')!;
    const owed = owedSummary(
      seed.obligations.filter((o) => o.spaceId === business.id),
      seed.transactions.filter((t) => t.spaceId === business.id),
      '2026-11-14',
    );
    // The demo is written in rupees and stored in paisa.
    expect(owed.owedToYou).toBe((80000 + 65000) * 100);
    expect(owed.youOwe).toBe((70000 + 350000) * 100);
    expect(owed.open.some((p) => p.overdue)).toBe(true);
  });
});
