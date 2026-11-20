/**
 * Business reports as plain tables, so the same rows can be shown on screen
 * and downloaded as CSV. Amounts stay as numbers; the screen formats them.
 */
import { AGE_BUCKETS, ageing, byContact, cashFlow, incomeByCategory, monthlyCashFlow, profitAndLoss } from './business';
import { formatMonthYear, inRange } from './dates';
import { toMajor } from './format';
import { accountDelta, inPeriod, spendingByCategory } from './money';
import type { Account, Category, DateRange, ISODate, Obligation, Person, Transaction } from './types';

export type Cell = string | number;

export interface ReportSection {
  title: string;
  columns: string[];
  /** Columns holding amounts, for formatting and right alignment. */
  money: number[];
  /** Text columns after the first that read better left-aligned (descriptions). */
  left?: number[];
  rows: Cell[][];
  /** Optional total row. */
  total?: Cell[];
}

export interface Report {
  key: ReportKey;
  title: string;
  description: string;
  sections: ReportSection[];
}

export type ReportKey = 'revenue' | 'expenses' | 'categories' | 'receivables' | 'payables' | 'pnl' | 'cashflow' | 'statement';

export const REPORTS: { key: ReportKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'categories', label: 'Categories' },
  { key: 'receivables', label: 'Receivables' },
  { key: 'payables', label: 'Payables' },
  { key: 'pnl', label: 'Profit and loss' },
  { key: 'cashflow', label: 'Cash flow' },
  { key: 'statement', label: 'Monthly statement' },
];

const TYPE_LABEL: Record<Transaction['type'], string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
  refund: 'Refund',
  principal_in: 'Loan or repayment in',
  principal_out: 'Loan or repayment out',
};

export interface ReportInput {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  obligations: Obligation[];
  people: Person[];
}

function monthly(transactions: Transaction[], range: DateRange, pick: (t: Transaction) => number): Cell[][] {
  const rows: Cell[][] = [];
  const start = new Date(Number(range.from.slice(0, 4)), Number(range.from.slice(5, 7)) - 1, 1);
  for (let d = start; ; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    if (from > range.to) break;
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    const r = { from: from < range.from ? range.from : from, to: to > range.to ? range.to : to };
    rows.push([formatMonthYear(from), inPeriod(transactions, r).reduce((s, t) => s + pick(t), 0)]);
  }
  return rows;
}

export function buildReport(key: ReportKey, input: ReportInput, range: DateRange, anchor: ISODate): Report {
  const { transactions, categories, obligations, people, accounts } = input;
  const list = inPeriod(transactions, range);
  const byId = new Map(categories.map((c) => [c.id, c]));

  switch (key) {
    case 'revenue': {
      const cats = incomeByCategory(list, categories);
      const total = cats.reduce((s, c) => s + c.amount, 0);
      const customers = byContact(transactions, obligations, people, range, 'income');
      return {
        key,
        title: 'Revenue report',
        description: 'Income received in the period. Money a customer still owes is not revenue until it arrives.',
        sections: [
          {
            title: 'By category',
            columns: ['Category', 'Amount', 'Share'],
            money: [1],
            rows: cats.map((c) => [c.name, c.amount, total > 0 ? `${Math.round((c.amount / total) * 100)}%` : '']),
            total: ['Total revenue', total, ''],
          },
          {
            title: 'By customer',
            columns: ['Customer', 'Payments', 'Amount'],
            money: [2],
            rows: customers.map((c) => [c.name, c.count, c.amount]),
            total: ['Total', customers.reduce((s, c) => s + c.count, 0), customers.reduce((s, c) => s + c.amount, 0)],
          },
          { title: 'By month', columns: ['Month', 'Revenue'], money: [1], rows: monthly(list, range, (t) => (t.type === 'income' ? t.amount : 0)) },
        ],
      };
    }
    case 'expenses': {
      const cats = spendingByCategory(list, categories).filter((c) => c.amount !== 0);
      const total = cats.reduce((s, c) => s + c.amount, 0);
      const suppliers = byContact(transactions, obligations, people, range, 'expense');
      return {
        key,
        title: 'Expense report',
        description: 'Costs paid in the period, less refunds. Loan repayments are not costs and are left out.',
        sections: [
          {
            title: 'By category',
            columns: ['Category', 'Counts as', 'Amount', 'Share'],
            money: [2],
            rows: cats.map((c) => [
              c.name,
              c.categoryId && byId.get(c.categoryId)?.costType === 'direct' ? 'Cost of goods sold' : 'Operating expense',
              c.amount,
              total > 0 ? `${Math.round((c.amount / total) * 100)}%` : '',
            ]),
            total: ['Total expenses', '', total, ''],
          },
          {
            title: 'By supplier',
            columns: ['Supplier', 'Payments', 'Amount'],
            money: [2],
            rows: suppliers.map((c) => [c.name, c.count, c.amount]),
            total: ['Total', suppliers.reduce((s, c) => s + c.count, 0), suppliers.reduce((s, c) => s + c.amount, 0)],
          },
          {
            title: 'By month',
            columns: ['Month', 'Expenses'],
            money: [1],
            rows: monthly(list, range, (t) => (t.type === 'expense' ? t.amount : t.type === 'refund' ? -t.amount : 0)),
          },
        ],
      };
    }
    case 'categories': {
      const rows: Cell[][] = categories
        .map((c) => {
          const own = list.filter((t) => t.categoryId === c.id);
          const amount =
            c.kind === 'income' ? own.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0) : spendingByCategory(own, categories).reduce((s, x) => s + x.amount, 0);
          return [c.name, c.kind === 'income' ? 'Income' : c.costType === 'direct' ? 'Cost of goods sold' : 'Operating expense', own.length, amount] as Cell[];
        })
        .filter((r) => (r[2] as number) > 0)
        .sort((a, b) => String(a[1]).localeCompare(String(b[1])) || (b[3] as number) - (a[3] as number));
      return {
        key,
        title: 'Category report',
        description: 'Every category used in the period, with how many transactions and how much money.',
        sections: [{ title: 'Categories', columns: ['Category', 'Type', 'Transactions', 'Amount'], money: [3], rows }],
      };
    }
    case 'receivables':
    case 'payables': {
      const kind = key === 'receivables' ? 'receivable' : 'payable';
      const a = ageing(obligations, transactions, people, kind, anchor);
      const who = key === 'receivables' ? 'Customer' : 'Supplier';
      return {
        key,
        title: key === 'receivables' ? 'Receivables report' : 'Payables report',
        description: `What is still ${key === 'receivables' ? 'owed to the business' : 'owed by the business'} today, by how late it is. This is a snapshot of today, whatever period is chosen.`,
        sections: [
          {
            title: `By ${who.toLowerCase()}`,
            columns: [who, ...AGE_BUCKETS.map((b) => b.label), 'Total'],
            money: [1, 2, 3, 4, 5, 6, 7],
            rows: a.byPerson.map((p) => [p.person?.name ?? 'Unknown', ...AGE_BUCKETS.map((b) => p.buckets[b.key]), p.total]),
            total: ['Total', ...AGE_BUCKETS.map((b) => a.totals[b.key]), a.total],
          },
          {
            title: 'Open items',
            columns: [who, 'For', 'Started', 'Due', 'Days late', 'Amount', 'Paid so far', 'Still owed'],
            money: [5, 6, 7],
            rows: a.items.map((i) => [
              i.person?.name ?? 'Unknown',
              i.position.obligation.title,
              i.position.obligation.date,
              i.position.nextDue ?? '',
              i.daysLate,
              i.position.obligation.amount,
              i.position.settled,
              i.position.outstanding,
            ]),
          },
        ],
      };
    }
    case 'pnl': {
      const p = profitAndLoss(transactions, categories, range);
      const rows: Cell[][] = [
        ['Revenue', '', p.revenue],
        ...p.revenueLines.map((l) => ['', l.name, l.amount]),
        ['Cost of goods sold', '', -p.costOfSales],
        ...p.costOfSalesLines.map((l) => ['', l.name, -l.amount]),
        ['Gross profit', '', p.grossProfit],
        ['Operating expenses', '', -p.operating],
        ...p.operatingLines.map((l) => ['', l.name, -l.amount]),
        ['Net profit', '', p.netProfit],
      ];
      return {
        key,
        title: 'Profit and loss',
        description: 'A simple summary from recorded money in and out. It is not an audited or tax-ready statement.',
        sections: [{ title: 'Profit and loss', columns: ['Line', 'Category', 'Amount'], money: [2], rows }],
      };
    }
    case 'statement':
      return statement(input, range);
    case 'cashflow': {
      const active = accounts.filter((acc) => !acc.archived);
      const c = cashFlow(active, transactions, obligations, range);
      const months = monthlyCashFlow(active, transactions, obligations, range);
      return {
        key,
        title: 'Cash-flow report',
        description: 'Money that actually moved through your accounts. Opening cash plus money received, less money paid, gives closing cash.',
        sections: [
          {
            title: 'Summary',
            columns: ['Line', 'Amount'],
            money: [1],
            rows: [
              ['Opening cash', c.opening],
              ...c.receivedLines.map((l) => [`Received: ${l.label}`, l.amount]),
              ...c.paidLines.map((l) => [`Paid: ${l.label}`, -l.amount]),
              ['Net cash movement', c.net],
              ['Closing cash', c.closing],
            ],
          },
          {
            title: 'By month',
            columns: ['Month', 'Opening', 'Received', 'Paid', 'Closing'],
            money: [1, 2, 3, 4],
            rows: months.map((m) => [formatMonthYear(m.range.from), m.opening, m.received, m.paid, m.closing]),
          },
        ],
      };
    }
  }
}

/**
 * A statement for the period (usually one month): what the business earned
 * and spent, how cash moved in each account, what was owed at the end, and
 * every transaction. The parts agree with each other: each account's
 * opening + in − out = closing, the accounts add up to the summary, and the
 * transactions add up to the accounts.
 */
function statement(input: ReportInput, range: DateRange): Report {
  const { accounts, categories, transactions, obligations, people } = input;
  const active = accounts.filter((a) => !a.archived || transactions.some((t) => inRange(t.date, range) && (t.accountId === a.id || t.toAccountId === a.id)));
  const pnl = profitAndLoss(transactions, categories, range);
  const cash = cashFlow(active, transactions, obligations, range);
  const perAccount = active.map((a) => ({ account: a, flow: cashFlow([a], transactions, obligations, range) }));
  // What was owed at the end of the period, from what had happened by then.
  const byEnd = transactions.filter((t) => t.date <= range.to);
  const openAt = obligations.filter((o) => o.date <= range.to);
  const owedToYou = ageing(openAt, byEnd, people, 'receivable', range.to);
  const youOwe = ageing(openAt, byEnd, people, 'payable', range.to);
  const names = new Map(active.map((a) => [a.id, a.name]));
  const cats = new Map(categories.map((c) => [c.id, c.name]));
  const lines = inPeriod(transactions, range)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  const rows: Cell[][] = [];
  let moneyIn = 0;
  let moneyOut = 0;
  for (const t of lines) {
    const delta = active.reduce((s, a) => s + accountDelta(t, a.id), 0);
    const account =
      t.type === 'transfer' ? `${names.get(t.accountId) ?? 'Another account'} → ${names.get(t.toAccountId ?? '') ?? 'another account'}` : (names.get(t.accountId) ?? '');
    const inn = delta > 0 ? delta : 0;
    const out = delta < 0 ? -delta : 0;
    moneyIn += inn;
    moneyOut += out;
    rows.push([t.date, t.description || TYPE_LABEL[t.type], TYPE_LABEL[t.type], (t.categoryId && cats.get(t.categoryId)) || '', account, inn || '', out || '']);
  }
  return {
    key: 'statement',
    title: 'Monthly statement',
    description: 'Everything in the period on one page: profit, cash in each account, money owed at the end, and every transaction.',
    sections: [
      {
        title: 'Summary',
        columns: ['Line', 'Amount'],
        money: [1],
        rows: [
          ['Revenue', pnl.revenue],
          ['Expenses', -(pnl.costOfSales + pnl.operating)],
          ['Net profit', pnl.netProfit],
          ['Cash at the start', cash.opening],
          ['Money received', cash.received],
          ['Money paid', -cash.paid],
          ['Cash at the end', cash.closing],
          ['Customers owed you at the end', owedToYou.total],
          ['You owed suppliers and others at the end', youOwe.total],
        ],
      },
      {
        title: 'Each account',
        columns: ['Account', 'At the start', 'In', 'Out', 'At the end'],
        money: [1, 2, 3, 4],
        rows: perAccount.map(({ account, flow }) => [account.name, flow.opening, flow.received, flow.paid, flow.closing]),
        total: [
          'All accounts',
          perAccount.reduce((s, p) => s + p.flow.opening, 0),
          perAccount.reduce((s, p) => s + p.flow.received, 0),
          perAccount.reduce((s, p) => s + p.flow.paid, 0),
          perAccount.reduce((s, p) => s + p.flow.closing, 0),
        ],
      },
      {
        title: 'Transactions',
        columns: ['Date', 'Description', 'Type', 'Category', 'Account', 'Money in', 'Money out'],
        money: [5, 6],
        left: [1, 2, 3, 4],
        rows,
        total: ['Total', '', '', '', '', moneyIn, moneyOut],
      },
    ],
  };
}

// ── CSV ────────────────────────────────────────────────────────────────────

function csvCell(value: Cell, money = false): string {
  const text = typeof value === 'number' ? (money ? toMajor(Math.round(value)).toFixed(2) : String(Math.round(value * 100) / 100)) : value;
  // Quote anything with a comma, quote or line break; and stop spreadsheet formulas.
  const safe = /^[=+\-@]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The whole report as CSV, one block per section. */
export function reportToCsv(report: Report, meta: { space: string; range: DateRange; currency: string }): string {
  const lines: string[] = [
    csvCell(report.title),
    `${csvCell('Space')},${csvCell(meta.space)}`,
    `${csvCell('Period')},${meta.range.from},${meta.range.to}`,
    `${csvCell('Currency')},${meta.currency}`,
    csvCell(report.description),
  ];
  for (const section of report.sections) {
    lines.push('', csvCell(section.title), section.columns.map((c) => csvCell(c)).join(','));
    const row = (cells: Cell[]) => cells.map((c, i) => csvCell(c, section.money.includes(i))).join(',');
    for (const r of section.rows) lines.push(row(r));
    if (section.total) lines.push(row(section.total));
  }
  return `${lines.join('\r\n')}\r\n`;
}
