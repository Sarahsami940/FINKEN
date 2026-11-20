import { describe, expect, it } from 'vitest';
import { ageing, businessRange, byContact, cashAt, cashFlow, comparableRanges, contactSummaries, monthlyCashFlow, previousRange, profitAndLoss } from './business';
import { totalBalance } from './money';
import { buildReport, REPORTS, reportToCsv } from './reports';
import { buildSeed } from './seed';
import type { Account, Category, Obligation, Person, Transaction } from './types';

let n = 0;
function tx(type: Transaction['type'], amount: number, date: string, extra: Partial<Transaction> = {}): Transaction {
  return { id: `t${n++}`, spaceId: 's', type, amount, currency: 'PKR', date, description: '', accountId: 'bank', createdAt: '', updatedAt: '', status: 'confirmed', ...extra };
}
const cat = (id: string, kind: Category['kind'], costType?: Category['costType']): Category => ({
  id,
  spaceId: 's',
  name: id[0].toUpperCase() + id.slice(1),
  kind,
  icon: 'circle',
  color: 'slate',
  subcategories: [],
  costType,
});
const categories = [cat('sales', 'income'), cat('supplies', 'expense', 'direct'), cat('rent', 'expense', 'operating'), cat('ads', 'expense')];
const NOW = '2026-11-17';
const NOV = { from: '2026-11-01', to: '2026-11-30' };

describe('periods', () => {
  it('covers this quarter and this year, and finds the period before', () => {
    expect(businessRange('quarter', NOW)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(businessRange('year', NOW)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(previousRange({ from: '2026-10-01', to: '2026-12-31' })).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(previousRange({ from: '2026-11-10', to: '2026-11-19' })).toEqual({ from: '2026-10-31', to: '2026-11-09' });
  });

  it('compares a running period with the same number of days before it', () => {
    expect(comparableRanges(NOV, NOW)).toEqual({ current: { from: '2026-11-01', to: NOW }, previous: { from: '2026-10-01', to: '2026-10-17' }, partial: true });
    expect(comparableRanges({ from: '2026-10-01', to: '2026-10-31' }, NOW).partial).toBe(false);
  });
});

describe('profit and loss', () => {
  const list = [
    tx('income', 100000, '2026-11-02', { categoryId: 'sales' }),
    tx('expense', 30000, '2026-11-03', { categoryId: 'supplies' }),
    tx('refund', 5000, '2026-11-04', { categoryId: 'supplies' }),
    tx('expense', 20000, '2026-11-05', { categoryId: 'rent' }),
    tx('expense', 4000, '2026-11-06', { categoryId: 'ads' }),
    // Loans and transfers are never revenue or cost.
    tx('principal_in', 500000, '2026-11-07'),
    tx('principal_out', 50000, '2026-11-08'),
    tx('transfer', 9000, '2026-11-09', { toAccountId: 'cash' }),
    tx('income', 7000, '2026-10-30', { categoryId: 'sales' }),
  ];

  it('works out gross and net profit from cost types', () => {
    const p = profitAndLoss(list, categories, NOV);
    expect(p.revenue).toBe(100000);
    expect(p.costOfSales).toBe(25000);
    expect(p.grossProfit).toBe(75000);
    // A category without a cost type counts as operating.
    expect(p.operatingLines.map((l) => l.name)).toEqual(['Rent', 'Ads']);
    expect(p.operating).toBe(24000);
    expect(p.netProfit).toBe(51000);
    expect(p.grossMargin).toBeCloseTo(0.75);
  });

  it('moves a category between sections without changing net profit', () => {
    const moved = profitAndLoss(
      list,
      categories.map((c) => (c.id === 'rent' ? { ...c, costType: 'direct' as const } : c)),
      NOV,
    );
    expect(moved.costOfSales).toBe(45000);
    expect(moved.netProfit).toBe(51000);
  });
});

describe('cash flow', () => {
  const accounts: Account[] = [
    { id: 'bank', spaceId: 's', name: 'Bank', kind: 'bank', openingBalance: 100000 },
    { id: 'cash', spaceId: 's', name: 'Cash', kind: 'cash', openingBalance: 5000 },
    { id: 'old', spaceId: 's', name: 'Old', kind: 'bank', openingBalance: 0, archived: true },
  ];
  const invoice = { id: 'inv', kind: 'receivable' } as Obligation;
  const bill = { id: 'bill', kind: 'payable' } as Obligation;
  const list = [
    tx('income', 10000, '2026-10-20'),
    tx('income', 40000, '2026-11-02', { obligationId: 'inv' }),
    tx('income', 25000, '2026-11-03'),
    tx('expense', 15000, '2026-11-04', { obligationId: 'bill' }),
    tx('expense', 6000, '2026-11-05', { accountId: 'cash' }),
    tx('transfer', 8000, '2026-11-06', { toAccountId: 'cash' }),
    tx('transfer', 3000, '2026-11-07', { toAccountId: 'old' }),
    tx('principal_out', 20000, '2026-11-08'),
  ];
  const active = accounts.filter((a) => !a.archived);

  it('reconciles opening, received, paid and closing cash', () => {
    const c = cashFlow(active, list, [invoice, bill], NOV);
    expect(c.opening).toBe(115000);
    expect(c.receivedLines.map((l) => [l.key, l.amount])).toEqual([
      ['sales', 25000],
      ['customer-payments', 40000],
    ]);
    expect(c.paidLines.map((l) => [l.key, l.amount])).toEqual([
      ['costs', 6000],
      ['supplier-payments', 15000],
      ['loans-out', 20000],
      ['other-accounts', 3000],
    ]);
    expect(c.closing).toBe(c.opening + c.received - c.paid);
    expect(c.closing).toBe(cashAt(active, list, NOV.to));
    expect(c.closing).toBe(totalBalance(active, list));
  });

  it('chains months so each opens where the last closed', () => {
    const months = monthlyCashFlow(active, list, [invoice, bill], { from: '2026-10-01', to: '2026-11-30' });
    expect(months).toHaveLength(2);
    expect(months[1].opening).toBe(months[0].closing);
  });
});

describe('ageing and contacts', () => {
  const people: Person[] = [
    { id: 'a', spaceId: 's', name: 'Ali Traders', role: 'customer', createdAt: '' },
    { id: 'b', spaceId: 's', name: 'Bano Supplies', role: 'supplier', createdAt: '' },
  ];
  const o = (id: string, kind: Obligation['kind'], personId: string, amount: number, dueDate?: string): Obligation => ({
    id,
    spaceId: 's',
    kind,
    personId,
    title: id,
    amount,
    currency: 'PKR',
    date: '2026-08-01',
    dueDate,
    status: 'open',
    createdAt: '',
    updatedAt: '',
  });
  const obligations = [
    o('i1', 'receivable', 'a', 50000, '2026-11-30'),
    o('i2', 'receivable', 'a', 30000, '2026-10-28'),
    o('i3', 'receivable', 'a', 20000, '2026-07-01'),
    o('i4', 'receivable', 'a', 9000),
    o('p1', 'payable', 'b', 40000, '2026-09-30'),
  ];
  const list = [
    tx('income', 10000, '2026-11-05', { obligationId: 'i2' }),
    tx('expense', 15000, '2026-11-06', { obligationId: 'p1' }),
    tx('income', 6000, '2026-11-07', { personId: 'a' }),
  ];

  it('puts each open item in the right age band, net of part payments', () => {
    const a = ageing(obligations, list, people, 'receivable', NOW);
    expect(a.totals).toEqual({ current: 50000, d30: 20000, d60: 0, d90: 0, older: 20000, undated: 9000 });
    expect(a.total).toBe(99000);
    expect(a.overdue).toBe(40000);
    const pay = ageing(obligations, list, people, 'payable', NOW);
    expect(pay.totals.d60).toBe(25000);
  });

  it('summarises each contact and who revenue came from', () => {
    const [ali, bano] = contactSummaries(people, obligations, list, NOV, NOW);
    expect([ali.owedToYou, ali.received, ali.overdue]).toEqual([99000, 16000, true]);
    expect([bano.youOwe, bano.paid]).toEqual([25000, 15000]);
    expect(byContact(list, obligations, people, NOV, 'income')).toEqual([{ personId: 'a', name: 'Ali Traders', amount: 16000, count: 2 }]);
  });
});

describe('reports on the demo business', () => {
  const seed = buildSeed('u1', NOW);
  const id = seed.spaceIdByType.business!;
  const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => i.spaceId === id);
  const input = {
    accounts: own(seed.accounts),
    categories: own(seed.categories),
    transactions: own(seed.transactions),
    obligations: own(seed.obligations),
    people: own(seed.people),
  };
  const range = businessRange('quarter', NOW);

  it('builds every report with matching totals', () => {
    for (const { key } of REPORTS) {
      const r = buildReport(key, input, range, NOW);
      expect(r.sections.length).toBeGreaterThan(0);
    }
    const pnl = profitAndLoss(input.transactions, input.categories, range);
    const revenue = buildReport('revenue', input, range, NOW).sections[0];
    expect(revenue.total?.[1]).toBe(pnl.revenue);
    const expenses = buildReport('expenses', input, range, NOW).sections[0];
    expect(expenses.total?.[2]).toBe(pnl.costOfSales + pnl.operating);
    // Supplies starts as cost of goods sold in a business Space.
    expect(pnl.costOfSalesLines.map((l) => l.name)).toEqual(['Supplies']);
    // Customers are linked, so revenue by customer names them.
    expect(revenue.rows.length).toBeGreaterThan(0);
    expect(buildReport('revenue', input, range, NOW).sections[1].rows.some((r) => r[0] === 'Al-Noor Traders')).toBe(true);
  });

  it('writes CSV that spreadsheets read safely', () => {
    const csv = reportToCsv(
      {
        key: 'revenue',
        title: 'Test',
        description: 'Has a "quote", and a comma',
        sections: [{ title: 'S', columns: ['Name', 'Amount'], money: [1], rows: [['=SUM(A1)', 123450]] }],
      },
      { space: 'Shop', range: NOV, currency: 'PKR' },
    );
    expect(csv).toContain('"Has a ""quote"", and a comma"');
    expect(csv).toContain("'=SUM(A1),1234.50");
    expect(csv.split('\r\n')[2]).toBe('Period,2026-11-01,2026-11-30');
  });
});
