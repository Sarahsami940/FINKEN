/**
 * The Money Engine — shared, pure financial calculations.
 *
 * Every screen derives its numbers from these functions. Nothing here reads
 * storage or UI state: callers pass in the records for one Space.
 *
 * Integrity rules enforced here:
 *  - Transfers are never income or expenses; they net to zero across accounts.
 *  - Loan principal received is never income; principal repaid is never spending.
 *  - A refund reduces spending. It is never income.
 *  - Receivables and payables count once, when the money actually moves.
 *  - What is still owed is always calculated from linked transactions.
 */
import { addDays, addMonths, inRange, monthRange, nextOccurrence, parseISODate, today } from './dates';
import type { Account, Category, DateRange, ID, ISODate, Obligation, ObligationKind, Person, Transaction, TransactionDraft, TransactionType } from './types';

/** Which way money moves through `accountId`: in (+1), out (-1), or between accounts (0). */
export const DIRECTION: Record<TransactionType, 1 | -1 | 0> = {
  income: 1,
  refund: 1,
  principal_in: 1,
  expense: -1,
  principal_out: -1,
  transfer: 0,
};

export const isPrincipal = (type: TransactionType) => type === 'principal_in' || type === 'principal_out';

export function inPeriod(transactions: Transaction[], range: DateRange): Transaction[] {
  return transactions.filter((t) => inRange(t.date, range));
}

export function totalIncome(transactions: Transaction[]): number {
  return transactions.reduce((sum, t) => (t.type === 'income' ? sum + t.amount : sum), 0);
}

/** Spending, less anything refunded. */
export function totalSpent(transactions: Transaction[]): number {
  return transactions.reduce((sum, t) => (t.type === 'expense' ? sum + t.amount : t.type === 'refund' ? sum - t.amount : sum), 0);
}

export interface PeriodSummary {
  income: number;
  /** Expenses less refunds. */
  spent: number;
  /** income - spent. */
  net: number;
  /** Money that arrived without being income: loans taken, money lent coming back. */
  owedIn: number;
  /** Money that left without being spending: money lent, loans repaid. */
  owedOut: number;
  /** Change in total account balances: net + owedIn - owedOut. */
  cashChange: number;
  count: number;
}

export function summarize(transactions: Transaction[], range?: DateRange): PeriodSummary {
  const list = range ? inPeriod(transactions, range) : transactions;
  const income = totalIncome(list);
  const spent = totalSpent(list);
  let owedIn = 0;
  let owedOut = 0;
  for (const t of list) {
    if (t.type === 'principal_in') owedIn += t.amount;
    else if (t.type === 'principal_out') owedOut += t.amount;
  }
  const net = income - spent;
  return { income, spent, net, owedIn, owedOut, cashChange: net + owedIn - owedOut, count: list.length };
}

/** Signed effect of one transaction on one account. */
export function accountDelta(t: Transaction, accountId: ID): number {
  if (t.type !== 'transfer') return t.accountId === accountId ? DIRECTION[t.type] * t.amount : 0;
  let delta = 0;
  if (t.accountId === accountId) delta -= t.amount;
  if (t.toAccountId === accountId) delta += t.amount;
  return delta;
}

export interface AccountBalance {
  account: Account;
  balance: number;
}

export function accountBalances(accounts: Account[], transactions: Transaction[]): AccountBalance[] {
  return accounts.map((account) => ({
    account,
    balance: transactions.reduce((sum, t) => sum + accountDelta(t, account.id), account.openingBalance),
  }));
}

export function totalBalance(accounts: Account[], transactions: Transaction[]): number {
  return accountBalances(accounts, transactions).reduce((sum, b) => sum + b.balance, 0);
}

export type MovementKind = 'withdrawal' | 'deposit' | 'transfer';

/** Names a transfer by what it does: cash taken out, cash paid in, or a plain transfer. */
export function movementKind(t: Transaction, accounts: Account[]): MovementKind {
  const from = accounts.find((a) => a.id === t.accountId)?.kind;
  const to = accounts.find((a) => a.id === t.toAccountId)?.kind;
  if (to === 'cash' && from && from !== 'cash') return 'withdrawal';
  if (from === 'cash' && to && to !== 'cash') return 'deposit';
  return 'transfer';
}

const PRINCIPAL_LABELS: Record<ObligationKind, Partial<Record<TransactionType, string>>> = {
  lent: { principal_out: 'Money lent', principal_in: 'Repayment received' },
  borrowed: { principal_in: 'Loan received', principal_out: 'Loan repayment' },
  receivable: {},
  payable: {},
};

/** Plain-language name for what a transaction is. */
export function transactionLabel(t: Transaction, accounts: Account[] = [], obligation?: Obligation): string {
  switch (t.type) {
    case 'expense':
      return 'Expense';
    case 'income':
      return 'Income';
    case 'refund':
      return 'Refund';
    case 'transfer':
      return { withdrawal: 'Cash withdrawal', deposit: 'Cash deposit', transfer: 'Transfer' }[movementKind(t, accounts)];
    case 'principal_in':
      return (obligation && PRINCIPAL_LABELS[obligation.kind].principal_in) ?? 'Money owed, received';
    case 'principal_out':
      return (obligation && PRINCIPAL_LABELS[obligation.kind].principal_out) ?? 'Money owed, paid';
  }
}

export interface CategorySpend {
  categoryId: ID | undefined;
  name: string;
  icon: string;
  color: string;
  amount: number;
  /** Share of the total, 0–1. */
  share: number;
  count: number;
}

/**
 * Spending per category, largest first. Refunds are taken off the category
 * they belong to, so the parts always add up to `totalSpent`.
 */
export function spendingByCategory(transactions: Transaction[], categories: Category[]): CategorySpend[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<string, { amount: number; count: number }>();
  for (const t of transactions) {
    if (t.type !== 'expense' && t.type !== 'refund') continue;
    const key = t.categoryId && byId.has(t.categoryId) ? t.categoryId : '';
    const entry = totals.get(key) ?? { amount: 0, count: 0 };
    if (t.type === 'expense') {
      entry.amount += t.amount;
      entry.count += 1;
    } else {
      entry.amount -= t.amount;
    }
    totals.set(key, entry);
  }
  const total = [...totals.values()].reduce((sum, e) => sum + e.amount, 0);
  return [...totals.entries()]
    .filter(([, entry]) => entry.amount !== 0)
    .map(([key, entry]) => {
      const category = key ? byId.get(key) : undefined;
      return {
        categoryId: category?.id,
        name: category?.name ?? 'Uncategorised',
        icon: category?.icon ?? 'circle',
        color: category?.color ?? 'slate',
        amount: entry.amount,
        count: entry.count,
        share: total > 0 ? entry.amount / total : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

export interface MonthPoint {
  /** First day of the month. */
  month: ISODate;
  income: number;
  spent: number;
  net: number;
}

/** Income and spending for the last `months` calendar months, oldest first. */
export function monthlySeries(transactions: Transaction[], months = 6, anchor: ISODate = today()): MonthPoint[] {
  const points: MonthPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const range = monthRange(anchor, -i);
    const s = summarize(transactions, range);
    points.push({ month: range.from, income: s.income, spent: s.spent, net: s.net });
  }
  return points;
}

/** Relative change from `previous` to `current`, or null when there is no baseline. */
export function changeRatio(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/**
 * Compares the month so far with the same number of days last month, so a
 * half-finished month is not measured against a complete one.
 */
export function monthToDateComparison(transactions: Transaction[], anchor: ISODate = today()) {
  const current = { from: monthRange(anchor).from, to: anchor };
  const prevMonth = monthRange(anchor, -1);
  const sameDay = addMonths(anchor, -1);
  const previous = { from: prevMonth.from, to: sameDay < prevMonth.to ? sameDay : prevMonth.to };
  return { current, previous, now: summarize(transactions, current), before: summarize(transactions, previous) };
}

/** Day of week (0 = Sunday) with the highest total spending, if there is enough data. */
export function busiestSpendingDay(transactions: Transaction[]): { day: number; amount: number } | null {
  const totals = new Array<number>(7).fill(0);
  let count = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    totals[parseISODate(t.date).getDay()] += t.amount;
    count++;
  }
  if (count < 14) return null;
  const day = totals.indexOf(Math.max(...totals));
  return { day, amount: totals[day] };
}

export interface TransactionFilter {
  search?: string;
  /** `owed` matches both principal types. */
  type?: TransactionType | 'owed' | 'all';
  categoryId?: ID;
  accountId?: ID;
  range?: DateRange;
}

export function filterTransactions(transactions: Transaction[], filter: TransactionFilter, categories: Category[] = []): Transaction[] {
  const names = new Map(categories.map((c) => [c.id, c.name.toLowerCase()]));
  const q = filter.search?.trim().toLowerCase();
  return transactions.filter((t) => {
    if (filter.type && filter.type !== 'all') {
      if (filter.type === 'owed' ? !isPrincipal(t.type) : t.type !== filter.type) return false;
    }
    if (filter.categoryId && t.categoryId !== filter.categoryId) return false;
    if (filter.accountId && t.accountId !== filter.accountId && t.toAccountId !== filter.accountId) return false;
    if (filter.range && !inRange(t.date, filter.range)) return false;
    if (q) {
      const haystack = `${t.description} ${t.notes ?? ''} ${names.get(t.categoryId ?? '') ?? ''} ${t.amount}`;
      if (!haystack.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** Newest first; ties broken by when the record was created. */
export function sortByDateDesc(transactions: Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export type TransactionSort = 'newest' | 'oldest' | 'largest' | 'smallest';

export function sortTransactions(transactions: Transaction[], sort: TransactionSort): Transaction[] {
  switch (sort) {
    case 'newest':
      return sortByDateDesc(transactions);
    case 'oldest':
      return sortByDateDesc(transactions).reverse();
    case 'largest':
      return [...transactions].sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date));
    case 'smallest':
      return [...transactions].sort((a, b) => a.amount - b.amount || b.date.localeCompare(a.date));
  }
}

/** Groups by day, newest day first unless `oldestFirst` is set. */
export function groupByDate(transactions: Transaction[], oldestFirst = false): { date: ISODate; items: Transaction[] }[] {
  const groups: { date: ISODate; items: Transaction[] }[] = [];
  for (const t of sortTransactions(transactions, oldestFirst ? 'oldest' : 'newest')) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }
  return groups;
}

// ── Habits ─────────────────────────────────────────────────────────────────

/**
 * What the user usually picks, learned from their own records, so the form
 * can open with the likeliest category and account already chosen.
 */
export interface Habits {
  /** Category ids, most used first. */
  categoryOrder: ID[];
  /** The account used most often overall. */
  account?: ID;
  /** The account used most often with each category. */
  accountByCategory: Map<ID, ID>;
}

export function habits(transactions: Transaction[], type: TransactionType, anchor: ISODate = today()): Habits {
  // Recent behaviour counts for more than what happened months ago.
  const recentFrom = addMonths(anchor, -3);
  const categories = new Map<ID, number>();
  const accounts = new Map<ID, number>();
  const pairs = new Map<ID, Map<ID, number>>();
  const bump = (map: Map<ID, number>, key: ID, by: number) => map.set(key, (map.get(key) ?? 0) + by);
  for (const t of transactions) {
    if (t.type !== type) continue;
    const weight = t.date >= recentFrom ? 3 : 1;
    bump(accounts, t.accountId, weight);
    if (t.categoryId) {
      bump(categories, t.categoryId, weight);
      let forCategory = pairs.get(t.categoryId);
      if (!forCategory) pairs.set(t.categoryId, (forCategory = new Map()));
      bump(forCategory, t.accountId, weight);
    }
  }
  const top = (map: Map<ID, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return {
    categoryOrder: top(categories),
    account: top(accounts)[0],
    accountByCategory: new Map([...pairs.entries()].map(([categoryId, map]) => [categoryId, top(map)[0]])),
  };
}

// ── Refunds ────────────────────────────────────────────────────────────────

/** How much of an expense has been refunded so far. */
export function refundedAmount(expenseId: ID, transactions: Transaction[], ignoreId?: ID): number {
  return transactions.reduce((sum, t) => (t.type === 'refund' && t.refundOfId === expenseId && t.id !== ignoreId ? sum + t.amount : sum), 0);
}

// ── Money Owed ─────────────────────────────────────────────────────────────

/** The transaction type that pays an obligation down. */
export function settlementType(o: Pick<Obligation, 'kind' | 'sourceTransactionId'>): TransactionType {
  switch (o.kind) {
    case 'receivable':
      // Someone's share of a cost you already paid comes back as a refund of that cost.
      return o.sourceTransactionId ? 'refund' : 'income';
    case 'payable':
      return 'expense';
    case 'lent':
      return 'principal_in';
    case 'borrowed':
      return 'principal_out';
  }
}

/** The transaction type that hands the money over at the start, for loans only. */
export function openingType(kind: ObligationKind): TransactionType | null {
  return kind === 'lent' ? 'principal_out' : kind === 'borrowed' ? 'principal_in' : null;
}

export interface ObligationPosition {
  obligation: Obligation;
  /** Paid back or settled so far. */
  settled: number;
  outstanding: number;
  state: 'open' | 'settled' | 'cancelled';
  overdue: boolean;
  /** Due within the next week, and not yet overdue. */
  dueSoon: boolean;
  /** When the next payment is expected: the next instalment, or the final date. */
  nextDue?: ISODate;
}

/** The next instalment date for a loan repaid in regular amounts, or the final due date. */
export function nextDueDate(o: Obligation, settled: number): ISODate | undefined {
  if (!o.instalmentAmount || !o.instalmentFrequency || o.instalmentAmount <= 0) return o.dueDate;
  const paid = Math.floor(settled / o.instalmentAmount + 1e-9);
  let due = o.date;
  for (let i = 0; i <= paid; i++) due = nextOccurrence(due, o.instalmentFrequency);
  // Instalments never run past the agreed final date.
  return o.dueDate && due > o.dueDate ? o.dueDate : due;
}

function settledAmount(o: Obligation, transactions: Transaction[], ignoreId?: ID): number {
  const type = settlementType(o);
  return transactions.reduce((sum, t) => (t.obligationId === o.id && t.type === type && t.id !== ignoreId ? sum + t.amount : sum), 0);
}

export function obligationPosition(o: Obligation, transactions: Transaction[], anchor: ISODate = today()): ObligationPosition {
  const settled = settledAmount(o, transactions);
  const outstanding = o.status === 'cancelled' ? 0 : Math.max(0, o.amount - settled);
  const state = o.status === 'cancelled' ? 'cancelled' : outstanding === 0 ? 'settled' : 'open';
  const nextDue = state === 'open' ? nextDueDate(o, settled) : undefined;
  const overdue = Boolean(nextDue) && nextDue! < anchor;
  return { obligation: o, settled, outstanding, state, overdue, dueSoon: Boolean(nextDue) && !overdue && nextDue! <= addDays(anchor, 7), nextDue };
}

/** The status word shown to the user. `toYou` picks between "received" and "paid". */
export function obligationStatus(p: ObligationPosition): { label: string; tone: 'neutral' | 'positive' | 'negative' | 'warning' } {
  if (p.state === 'cancelled') return { label: 'Written off', tone: 'neutral' };
  if (p.state === 'settled') return { label: 'Settled', tone: 'positive' };
  if (p.overdue) return { label: 'Overdue', tone: 'negative' };
  if (p.dueSoon) return { label: 'Due soon', tone: 'warning' };
  if (p.settled > 0) return { label: owedToYouKind(p.obligation.kind) ? 'Partially received' : 'Partially paid', tone: 'neutral' };
  return { label: 'Outstanding', tone: 'neutral' };
}

/** Interest recorded against a loan. It is real income or spending, and never reduces what is owed. */
export function interestPaid(o: Obligation, transactions: Transaction[]): number {
  const type = o.kind === 'borrowed' ? 'expense' : o.kind === 'lent' ? 'income' : null;
  if (!type) return 0;
  return transactions.reduce((sum, t) => (t.obligationId === o.id && t.type === type ? sum + t.amount : sum), 0);
}

export interface PersonSummary {
  person: Person;
  /** What they still owe you. */
  owesYou: number;
  /** What you still owe them. */
  youOwe: number;
  /** owesYou - youOwe. Positive means they owe you overall. */
  net: number;
  open: ObligationPosition[];
  /** True when there is, or was, anything between you. */
  hasHistory: boolean;
}

export function personSummaries(people: Person[], obligations: Obligation[], transactions: Transaction[], anchor: ISODate = today()): PersonSummary[] {
  return people
    .map((person) => {
      const mine = obligations.filter((o) => o.personId === person.id);
      const open = mine.map((o) => obligationPosition(o, transactions, anchor)).filter((p) => p.state === 'open');
      let owesYou = 0;
      let youOwe = 0;
      for (const p of open) {
        if (owedToYouKind(p.obligation.kind)) owesYou += p.outstanding;
        else youOwe += p.outstanding;
      }
      return { person, owesYou, youOwe, net: owesYou - youOwe, open, hasHistory: mine.length > 0 || transactions.some((t) => t.personId === person.id) };
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.person.name.localeCompare(b.person.name));
}

/** Everything recorded with one person: linked to what is owed, or simply paid to or received from them. */
export function personHistory(personId: ID, obligations: Obligation[], transactions: Transaction[]): Transaction[] {
  const theirs = new Set(obligations.filter((o) => o.personId === personId).map((o) => o.id));
  return sortByDateDesc(transactions.filter((t) => t.personId === personId || (t.obligationId && theirs.has(t.obligationId))));
}

/**
 * Splits `total` into `parts` equal shares that add up exactly. Any
 * leftover from rounding goes to the first shares, one unit at a time.
 */
export function splitEqually(total: number, parts: number, unit = 1): number[] {
  if (parts <= 0) return [];
  const units = Math.round(total / unit);
  const base = Math.floor(units / parts);
  const extra = units - base * parts;
  return Array.from({ length: parts }, (_, i) => (base + (i < extra ? 1 : 0)) * unit);
}

/** How much of an expense other people have been asked to pay back. */
export function sharedAmount(expenseId: ID, obligations: Obligation[], ignoreId?: ID): number {
  return obligations.reduce((sum, o) => (o.sourceTransactionId === expenseId && o.status !== 'cancelled' && o.id !== ignoreId ? sum + o.amount : sum), 0);
}

export interface OwedSummary {
  /** Receivables and money you lent that is still outstanding. */
  owedToYou: number;
  /** Payables and money you borrowed that is still outstanding. */
  youOwe: number;
  /** Open positions, soonest due date first; undated ones last. */
  open: ObligationPosition[];
}

export const owedToYouKind = (kind: ObligationKind) => kind === 'receivable' || kind === 'lent';

export function owedSummary(obligations: Obligation[], transactions: Transaction[], anchor: ISODate = today()): OwedSummary {
  const open = obligations
    .map((o) => obligationPosition(o, transactions, anchor))
    .filter((p) => p.state === 'open')
    .sort((a, b) => (a.obligation.dueDate ?? '9999').localeCompare(b.obligation.dueDate ?? '9999') || a.obligation.date.localeCompare(b.obligation.date));
  let owedToYou = 0;
  let youOwe = 0;
  for (const p of open) {
    if (owedToYouKind(p.obligation.kind)) owedToYou += p.outstanding;
    else youOwe += p.outstanding;
  }
  return { owedToYou, youOwe, open };
}

// ── Validation ─────────────────────────────────────────────────────────────

/** Checks the fields of a draft on their own. Returns a message, or null when valid. */
export function validateDraft(draft: { type: TransactionType; amount: number; accountId?: ID; toAccountId?: ID; date?: ISODate; obligationId?: ID }): string | null {
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) return 'Enter an amount greater than zero.';
  if (!draft.accountId) return 'Choose an account.';
  if (!draft.date || !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) return 'Choose a date.';
  if (draft.type === 'transfer') {
    if (!draft.toAccountId) return 'Choose where the money is going.';
    if (draft.toAccountId === draft.accountId) return 'Choose two different accounts.';
  }
  if (isPrincipal(draft.type) && !draft.obligationId) return 'Choose which loan this belongs to.';
  return null;
}

/** The records of one Space that a transaction can depend on. */
export interface IntegrityContext {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  obligations: Obligation[];
}

const amountText = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * Checks a draft against the other records in its Space, so a save can never
 * leave the books inconsistent. Pass `editingId` when the draft replaces an
 * existing transaction. Returns a message, or null when the draft is sound.
 */
export function checkTransaction(draft: TransactionDraft, ctx: IntegrityContext, editingId?: ID): string | null {
  const invalid = validateDraft(draft);
  if (invalid) return invalid;

  const inSpace = <T extends { id: ID; spaceId: ID }>(items: T[], id?: ID) => items.find((i) => i.id === id && i.spaceId === draft.spaceId);
  if (!inSpace(ctx.accounts, draft.accountId)) return 'Choose an account from this Space.';
  if (draft.type === 'transfer' && !inSpace(ctx.accounts, draft.toAccountId)) return 'Choose an account from this Space.';

  if (draft.categoryId && draft.type !== 'transfer' && !isPrincipal(draft.type)) {
    const category = inSpace(ctx.categories, draft.categoryId);
    if (!category) return 'Choose a category from this Space.';
    const expected = draft.type === 'income' ? 'income' : 'expense';
    if (category.kind !== expected) return expected === 'income' ? 'Choose an income category.' : 'Choose a spending category.';
  }

  // An expense that has been refunded cannot shrink below what came back, or stop being an expense.
  if (editingId) {
    const refunded = refundedAmount(editingId, ctx.transactions);
    if (refunded > 0) {
      if (draft.type !== 'expense') return 'This expense has a refund against it, so it has to stay an expense.';
      if (draft.amount < refunded) return `${amountText(refunded)} of this has already been refunded, so it cannot be less than that.`;
    }
    const shared = sharedAmount(editingId, ctx.obligations);
    if (shared > 0) {
      if (draft.type !== 'expense') return 'This expense is shared with other people, so it has to stay an expense.';
      if (draft.amount < shared) return `Other people owe you ${amountText(shared)} of this, so it cannot be less than that.`;
    }
  }

  if (draft.type === 'refund' && draft.refundOfId) {
    const original = inSpace(ctx.transactions, draft.refundOfId);
    if (original?.type !== 'expense') return 'The expense being refunded no longer exists.';
    const left = original.amount - refundedAmount(original.id, ctx.transactions, editingId);
    if (draft.amount > left) return left > 0 ? `Only ${amountText(left)} of that expense is left to refund.` : 'That expense has already been refunded in full.';
  }

  if (draft.obligationId) {
    const o = inSpace(ctx.obligations, draft.obligationId);
    if (!o) return 'The record this is linked to no longer exists.';
    const settles = settlementType(o);
    const opens = openingType(o.kind);
    if (draft.type === settles) {
      const left = o.amount - settledAmount(o, ctx.transactions, editingId);
      if (draft.amount > left) return left > 0 ? `Only ${amountText(left)} is still outstanding.` : 'This has already been settled in full.';
    } else if (draft.type === opens) {
      const handedOver = ctx.transactions.reduce((sum, t) => (t.obligationId === o.id && t.type === opens && t.id !== editingId ? sum + t.amount : sum), 0);
      if (handedOver + draft.amount > o.amount) return `That is more than the ${amountText(o.amount)} agreed.`;
    } else if ((o.kind === 'borrowed' && draft.type === 'expense') || (o.kind === 'lent' && draft.type === 'income')) {
      // Interest on a loan: real spending or income, and it does not reduce what is owed.
    } else {
      return 'That kind of transaction cannot be linked to this record.';
    }
  }
  return null;
}
