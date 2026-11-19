/**
 * Business Mode: the same Money Engine, read the way a small business reads it.
 *
 * Nothing here records or stores anything. Revenue is income, costs are
 * expenses less refunds, and money owed is counted once, when it is paid.
 * Loans are never revenue or cost. These views are management summaries,
 * not audited or tax-ready statements.
 */
import { addDays, addMonths, customRange, diffDays, inRange, monthRange, parseISODate, today } from './dates';
import { accountDelta, inPeriod, type ObligationPosition, obligationPosition, spendingByCategory } from './money';
import type { Account, Category, DateRange, ID, ISODate, Obligation, ObligationKind, Person, PersonRole, Recurring, Transaction } from './types';
import { type ExpectedEvent, expectedEvents } from './upcoming';

export const ROLE_LABEL: Record<PersonRole, string> = { customer: 'Customer', supplier: 'Supplier', lender: 'Lender', other: 'Other' };

// ── Reporting ranges ───────────────────────────────────────────────────────

export type BusinessRange = 'month' | 'last-month' | 'quarter' | 'year' | 'custom';

export const BUSINESS_RANGES: { value: BusinessRange; label: string }[] = [
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

export function businessRange(range: BusinessRange, anchor: ISODate = today(), custom: { from?: string; to?: string } = {}): DateRange {
  const d = parseISODate(anchor);
  switch (range) {
    case 'last-month':
      return monthRange(anchor, -1);
    case 'quarter': {
      const first = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
      const from = monthRange(`${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`).from;
      return { from, to: monthRange(addMonths(from, 2)).to };
    }
    case 'year':
      return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
    case 'custom':
      return customRange(custom, monthRange(anchor));
    default:
      return monthRange(anchor);
  }
}

/** The stretch of the same length just before `range`. */
export function previousRange(range: DateRange): DateRange {
  const mr = monthRange(range.from);
  // Whole months compare with the same number of whole months before.
  if (mr.from === range.from && monthRange(range.to).to === range.to) {
    const months =
      (parseISODate(range.to).getFullYear() - parseISODate(range.from).getFullYear()) * 12 + parseISODate(range.to).getMonth() - parseISODate(range.from).getMonth() + 1;
    return { from: addMonths(range.from, -months), to: addDays(range.from, -1) };
  }
  const days = diffDays(range.from, range.to) + 1;
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

/**
 * A fair comparison: a period still running is compared up to today with
 * the same number of days at the start of the period before.
 */
export function comparableRanges(range: DateRange, anchor: ISODate = today()): { current: DateRange; previous: DateRange; partial: boolean } {
  const before = previousRange(range);
  if (range.from > anchor || range.to <= anchor) return { current: range, previous: before, partial: false };
  const end = addDays(before.from, diffDays(range.from, anchor));
  return { current: { from: range.from, to: anchor }, previous: { from: before.from, to: end < before.to ? end : before.to }, partial: true };
}

// ── Profit and Loss ────────────────────────────────────────────────────────

export interface PnlLine {
  categoryId?: ID;
  name: string;
  amount: number;
}

export interface ProfitAndLoss {
  revenue: number;
  revenueLines: PnlLine[];
  costOfSales: number;
  costOfSalesLines: PnlLine[];
  grossProfit: number;
  operating: number;
  operatingLines: PnlLine[];
  netProfit: number;
  /** Shares of revenue; null without revenue. */
  grossMargin: number | null;
  netMargin: number | null;
}

/** Income by category, largest first. */
export function incomeByCategory(transactions: Transaction[], categories: Category[]): PnlLine[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<string, number>();
  for (const t of transactions) {
    if (t.type !== 'income') continue;
    const key = t.categoryId && byId.has(t.categoryId) ? t.categoryId : '';
    totals.set(key, (totals.get(key) ?? 0) + t.amount);
  }
  return [...totals.entries()].map(([key, amount]) => ({ categoryId: key || undefined, name: byId.get(key)?.name ?? 'Uncategorised', amount })).sort((a, b) => b.amount - a.amount);
}

/**
 * Revenue − cost of goods sold = gross profit; − operating expenses = net
 * profit. Expenses are split by each category's cost type, so moving a
 * category between the two only changes where it appears, never the total.
 */
export function profitAndLoss(transactions: Transaction[], categories: Category[], range: DateRange): ProfitAndLoss {
  const list = inPeriod(transactions, range);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const revenueLines = incomeByCategory(list, categories);
  const spend = spendingByCategory(list, categories).filter((c) => c.amount !== 0);
  const toLine = (c: (typeof spend)[number]): PnlLine => ({ categoryId: c.categoryId, name: c.name, amount: c.amount });
  const costOfSalesLines = spend.filter((c) => c.categoryId && byId.get(c.categoryId)?.costType === 'direct').map(toLine);
  const operatingLines = spend.filter((c) => !c.categoryId || byId.get(c.categoryId)?.costType !== 'direct').map(toLine);
  const sum = (lines: PnlLine[]) => lines.reduce((s, l) => s + l.amount, 0);
  const revenue = sum(revenueLines);
  const costOfSales = sum(costOfSalesLines);
  const operating = sum(operatingLines);
  const grossProfit = revenue - costOfSales;
  const netProfit = grossProfit - operating;
  return {
    revenue,
    revenueLines,
    costOfSales,
    costOfSalesLines,
    grossProfit,
    operating,
    operatingLines,
    netProfit,
    grossMargin: revenue > 0 ? grossProfit / revenue : null,
    netMargin: revenue > 0 ? netProfit / revenue : null,
  };
}

// ── Cash flow ──────────────────────────────────────────────────────────────

export type CashLineKey = 'sales' | 'customer-payments' | 'refunds' | 'loans-in' | 'costs' | 'supplier-payments' | 'loans-out' | 'other-accounts';

export interface CashLine {
  key: CashLineKey;
  label: string;
  amount: number;
}

export interface CashFlow {
  range: DateRange;
  opening: number;
  received: number;
  paid: number;
  net: number;
  closing: number;
  receivedLines: CashLine[];
  paidLines: CashLine[];
}

const CASH_LABEL: Record<CashLineKey, string> = {
  sales: 'Sales and other income',
  'customer-payments': 'Customer payments on invoices',
  refunds: 'Refunds received',
  'loans-in': 'Loans received and money paid back to you',
  costs: 'Running costs and purchases',
  'supplier-payments': 'Supplier bills paid',
  'loans-out': 'Loan repayments and money lent',
  'other-accounts': 'Moved to or from other accounts',
};

/** Money in the given accounts at the end of `date`. */
export function cashAt(accounts: Account[], transactions: Transaction[], date: ISODate): number {
  let total = accounts.reduce((s, a) => s + a.openingBalance, 0);
  for (const t of transactions) {
    if (t.date > date) continue;
    for (const a of accounts) total += accountDelta(t, a.id);
  }
  return total;
}

/**
 * Opening cash, what came in and went out, and closing cash for the
 * accounts given. Transfers between those accounts cancel out; a transfer
 * to an account outside them shows as its own line, so the figures always
 * add up: opening + received − paid = closing.
 */
export function cashFlow(accounts: Account[], transactions: Transaction[], obligations: Obligation[], range: DateRange): CashFlow {
  const kindOf = new Map(obligations.map((o) => [o.id, o.kind]));
  const lines = new Map<CashLineKey, number>();
  const add = (key: CashLineKey, amount: number) => lines.set(key, (lines.get(key) ?? 0) + amount);
  for (const t of transactions) {
    if (!inRange(t.date, range)) continue;
    const delta = accounts.reduce((s, a) => s + accountDelta(t, a.id), 0);
    if (delta === 0) continue;
    const kind = t.obligationId ? kindOf.get(t.obligationId) : undefined;
    switch (t.type) {
      case 'income':
        add(kind === 'receivable' ? 'customer-payments' : 'sales', delta);
        break;
      case 'refund':
        add('refunds', delta);
        break;
      case 'principal_in':
        add('loans-in', delta);
        break;
      case 'expense':
        add(kind === 'payable' ? 'supplier-payments' : 'costs', delta);
        break;
      case 'principal_out':
        add('loans-out', delta);
        break;
      case 'transfer':
        add('other-accounts', delta);
        break;
    }
  }
  const opening = cashAt(accounts, transactions, addDays(range.from, -1));
  const receivedLines: CashLine[] = [];
  const paidLines: CashLine[] = [];
  for (const key of Object.keys(CASH_LABEL) as CashLineKey[]) {
    const amount = lines.get(key) ?? 0;
    if (amount > 0) receivedLines.push({ key, label: CASH_LABEL[key], amount });
    else if (amount < 0) paidLines.push({ key, label: CASH_LABEL[key], amount: -amount });
  }
  const received = receivedLines.reduce((s, l) => s + l.amount, 0);
  const paid = paidLines.reduce((s, l) => s + l.amount, 0);
  return { range, opening, received, paid, net: received - paid, closing: opening + received - paid, receivedLines, paidLines };
}

/** Cash flow month by month across a range. */
export function monthlyCashFlow(accounts: Account[], transactions: Transaction[], obligations: Obligation[], range: DateRange): CashFlow[] {
  const out: CashFlow[] = [];
  for (let m = monthRange(range.from); m.from <= range.to; m = monthRange(m.from, 1)) {
    out.push(cashFlow(accounts, transactions, obligations, { from: m.from < range.from ? range.from : m.from, to: m.to > range.to ? range.to : m.to }));
  }
  return out;
}

export interface CashForecast {
  days: number;
  now: number;
  inflow: number;
  outflow: number;
  /** Cash now, plus what is expected in, less what is expected out. An estimate. */
  projected: number;
  events: ExpectedEvent[];
}

export function cashForecast(
  accounts: Account[],
  input: { recurring: Recurring[]; obligations: Obligation[]; transactions: Transaction[] },
  days: number,
  anchor: ISODate = today(),
): CashForecast {
  const now = cashAt(accounts, input.transactions, '9999-12-31');
  const events = expectedEvents(input, { from: anchor, to: addDays(anchor, days) }, anchor);
  const inflow = events.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0);
  const outflow = events.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0);
  return { days, now, inflow, outflow, projected: now + inflow - outflow, events };
}

// ── Receivables and payables, with ageing ─────────────────────────────────

export type AgeBucket = 'current' | 'd30' | 'd60' | 'd90' | 'older' | 'undated';

export const AGE_BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd30', label: '1–30 days late' },
  { key: 'd60', label: '31–60 days late' },
  { key: 'd90', label: '61–90 days late' },
  { key: 'older', label: 'Over 90 days late' },
  { key: 'undated', label: 'No due date' },
];

export interface AgedItem {
  position: ObligationPosition;
  person?: Person;
  bucket: AgeBucket;
  /** 0 when not yet due or undated. */
  daysLate: number;
}

export interface AgeingSummary {
  items: AgedItem[];
  totals: Record<AgeBucket, number>;
  total: number;
  overdue: number;
  byPerson: { person?: Person; personId: ID; total: number; overdue: number; buckets: Record<AgeBucket, number> }[];
}

function bucketFor(daysLate: number, due?: ISODate): AgeBucket {
  if (!due) return 'undated';
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return 'd30';
  if (daysLate <= 60) return 'd60';
  if (daysLate <= 90) return 'd90';
  return 'older';
}

const emptyBuckets = (): Record<AgeBucket, number> => ({ current: 0, d30: 0, d60: 0, d90: 0, older: 0, undated: 0 });

/** What customers owe (receivable) or what is owed to suppliers (payable), by how late it is. */
export function ageing(
  obligations: Obligation[],
  transactions: Transaction[],
  people: Person[],
  kind: Extract<ObligationKind, 'receivable' | 'payable'>,
  anchor: ISODate = today(),
): AgeingSummary {
  const personById = new Map(people.map((p) => [p.id, p]));
  const items: AgedItem[] = obligations
    .filter((o) => o.kind === kind)
    .map((o) => obligationPosition(o, transactions, anchor))
    .filter((p) => p.state === 'open')
    .map((position) => {
      const due = position.nextDue;
      const daysLate = due ? Math.max(0, diffDays(due, anchor)) : 0;
      return { position, person: personById.get(position.obligation.personId), bucket: bucketFor(daysLate, due), daysLate };
    })
    .sort((a, b) => b.daysLate - a.daysLate || b.position.outstanding - a.position.outstanding);
  const totals = emptyBuckets();
  const people_ = new Map<ID, AgeingSummary['byPerson'][number]>();
  for (const item of items) {
    const amount = item.position.outstanding;
    totals[item.bucket] += amount;
    const id = item.position.obligation.personId;
    const row = people_.get(id) ?? { person: item.person, personId: id, total: 0, overdue: 0, buckets: emptyBuckets() };
    row.total += amount;
    row.buckets[item.bucket] += amount;
    if (item.daysLate > 0) row.overdue += amount;
    people_.set(id, row);
  }
  const total = items.reduce((s, i) => s + i.position.outstanding, 0);
  const overdue = items.filter((i) => i.daysLate > 0).reduce((s, i) => s + i.position.outstanding, 0);
  return { items, totals, total, overdue, byPerson: [...people_.values()].sort((a, b) => b.total - a.total) };
}

// ── Customers and suppliers ───────────────────────────────────────────────

export interface ContactSummary {
  person: Person;
  /** Still owed to the business by this person. */
  owedToYou: number;
  /** Still owed by the business to this person. */
  youOwe: number;
  /** Money received from them in the range. */
  received: number;
  /** Money paid to them in the range. */
  paid: number;
  lastActivity?: ISODate;
  overdue: boolean;
}

/** Each contact's balance and activity, linked through payments and money owed. */
export function contactSummaries(people: Person[], obligations: Obligation[], transactions: Transaction[], range: DateRange, anchor: ISODate = today()): ContactSummary[] {
  const owner = new Map(obligations.map((o) => [o.id, o.personId]));
  return people.map((person) => {
    let owedToYou = 0;
    let youOwe = 0;
    let overdue = false;
    for (const o of obligations) {
      if (o.personId !== person.id) continue;
      const p = obligationPosition(o, transactions, anchor);
      if (p.state !== 'open') continue;
      if (o.kind === 'receivable' || o.kind === 'lent') owedToYou += p.outstanding;
      else youOwe += p.outstanding;
      if (p.overdue) overdue = true;
    }
    let received = 0;
    let paid = 0;
    let lastActivity: ISODate | undefined;
    for (const t of transactions) {
      const who = t.personId ?? (t.obligationId ? owner.get(t.obligationId) : undefined);
      if (who !== person.id) continue;
      if (!lastActivity || t.date > lastActivity) lastActivity = t.date;
      if (!inRange(t.date, range)) continue;
      if (t.type === 'income' || t.type === 'principal_in' || t.type === 'refund') received += t.amount;
      else if (t.type === 'expense' || t.type === 'principal_out') paid += t.amount;
    }
    return { person, owedToYou, youOwe, received, paid, lastActivity, overdue };
  });
}

/** Income (or spending) per contact in a range, largest first. Unlinked money is grouped as "Not linked to anyone". */
export function byContact(
  transactions: Transaction[],
  obligations: Obligation[],
  people: Person[],
  range: DateRange,
  type: 'income' | 'expense',
): { personId?: ID; name: string; amount: number; count: number }[] {
  const owner = new Map(obligations.map((o) => [o.id, o.personId]));
  const names = new Map(people.map((p) => [p.id, p.name]));
  const totals = new Map<string, { amount: number; count: number }>();
  for (const t of transactions) {
    if (!inRange(t.date, range)) continue;
    const sign = t.type === type ? 1 : type === 'expense' && t.type === 'refund' ? -1 : 0;
    if (sign === 0) continue;
    const who = t.personId ?? (t.obligationId ? owner.get(t.obligationId) : undefined) ?? '';
    const row = totals.get(who) ?? { amount: 0, count: 0 };
    row.amount += sign * t.amount;
    if (sign > 0) row.count++;
    totals.set(who, row);
  }
  return [...totals.entries()]
    .filter(([, r]) => r.amount !== 0)
    .map(([id, r]) => ({ personId: id || undefined, name: id ? (names.get(id) ?? 'Unknown') : 'Not linked to anyone', ...r }))
    .sort((a, b) => (a.personId ? 0 : 1) - (b.personId ? 0 : 1) || b.amount - a.amount);
}
