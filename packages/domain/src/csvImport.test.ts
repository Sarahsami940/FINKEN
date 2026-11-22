import { describe, expect, it } from 'vitest';
import { detectColumns, detectDateFormat, parseCsv, parseStatementAmount, parseStatementDate, planImport, readRows } from './csvImport';
import type { Category, Transaction } from './types';

const categories: Category[] = [
  { id: 'food', spaceId: 's', name: 'Food', kind: 'expense', icon: 'utensils', color: 'orange', subcategories: [{ id: 'groc', name: 'Groceries' }] },
  { id: 'bills', spaceId: 's', name: 'Bills', kind: 'expense', icon: 'bolt', color: 'blue', subcategories: [] },
  { id: 'salary', spaceId: 's', name: 'Salary', kind: 'income', icon: 'wallet', color: 'green', subcategories: [] },
] as Category[];

describe('reading the file', () => {
  it('handles quotes, commas inside quotes, escaped quotes, BOM and both line endings', () => {
    const text = '﻿Date,Description,Amount\r\n12/11/2026,"Imtiaz, Gulberg","-1,250.50"\n13/11/2026,"Said ""hi""",500\n\n';
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['12/11/2026', 'Imtiaz, Gulberg', '-1,250.50'],
      ['13/11/2026', 'Said "hi"', '500'],
    ]);
  });

  it('works out semicolons and tabs', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a\tb\n1\t2')[1]).toEqual(['1', '2']);
  });
});

describe('amounts', () => {
  it.each([
    ['1,250.50', 125050],
    ['Rs. 1,250', 125000],
    ['PKR -500', -50000],
    ['(500.00)', -50000],
    ['500-', -50000],
    ['1,000 Dr', -100000],
    ['2,000.5 CR', 200050],
    ['+75', 7500],
    ['0.1', 10],
  ])('reads %s exactly', (raw, paisa) => expect(parseStatementAmount(raw)).toBe(paisa));

  it.each(['', 'abc', '1.234', '12,34', '1e5', '1,2345'])('refuses %s', (raw) => expect(parseStatementAmount(raw)).toBeNull());

  it('never goes through floating point', () => {
    // 0.1 + 0.2 style errors would show here.
    expect(parseStatementAmount('1,234,567.89')).toBe(123456789);
    expect(parseStatementAmount('0.29')).toBe(29);
  });
});

describe('dates', () => {
  it('reads day-first, month-first, year-first and month names', () => {
    expect(parseStatementDate('05/11/2026', 'DMY')).toBe('2026-11-05');
    expect(parseStatementDate('11/05/2026', 'MDY')).toBe('2026-11-05');
    expect(parseStatementDate('2026-11-05', 'DMY')).toBe('2026-11-05');
    expect(parseStatementDate('05-Nov-2026', 'MDY')).toBe('2026-11-05');
    expect(parseStatementDate('5 November 26', 'DMY')).toBe('2026-11-05');
    expect(parseStatementDate('Nov 5, 2026', 'DMY')).toBe('2026-11-05');
    expect(parseStatementDate('05.11.2026 14:32', 'DMY')).toBe('2026-11-05');
    expect(parseStatementDate('31/02/2026', 'DMY')).toBeNull();
  });

  it('prefers day-first when both work, and says it is a guess', () => {
    expect(detectDateFormat(['05/11/2026', '06/11/2026'])).toEqual({ format: 'DMY', ambiguous: true });
    expect(detectDateFormat(['25/11/2026', '06/11/2026'])).toEqual({ format: 'DMY', ambiguous: false });
    expect(detectDateFormat(['11/25/2026', '11/06/2026'])).toEqual({ format: 'MDY', ambiguous: false });
    expect(detectDateFormat(['2026-11-25'])).toEqual({ format: 'DMY', ambiguous: false });
  });
});

describe('columns', () => {
  it('finds the header below a bank’s account details, with separate money out and in', () => {
    const rows = parseCsv(
      'Account statement,,,,\nAccount,0123-4567,,,\nTxn Date,Narration,Withdrawal,Deposit,Balance\n01/11/2026,Opening balance,,,10000\n02/11/2026,K-Electric bill,"3,200.00",,6800\n03/11/2026,SALARY NOV,,"85,000.00",91800\n,Closing balance,,,91800\n',
    );
    const found = detectColumns(rows);
    expect(found.headerRow).toBe(2);
    expect(found.columns).toEqual({ date: 0, description: 1, debit: 2, credit: 3 });
    const lines = readRows(rows, found.headerRow, { columns: found.columns!, dateFormat: 'DMY', sign: 'negative-is-out' });
    // The opening line has no amount, so it is a problem; the closing line has no date, so it is skipped.
    expect(lines.filter((l) => !l.problem)).toEqual([
      { line: 5, date: '2026-11-02', description: 'K-Electric bill', amount: 320000, type: 'expense' },
      { line: 6, date: '2026-11-03', description: 'SALARY NOV', amount: 8500000, type: 'income' },
    ]);
  });

  it('reads a single amount column with a Dr/Cr column', () => {
    const rows = parseCsv('Date,Details,Amount,Dr/Cr\n2026-11-02,Fuel,2500,DR\n2026-11-03,Refund,300,CR');
    const found = detectColumns(rows);
    expect(found.columns).toEqual({ date: 0, description: 1, amount: 2, direction: 3 });
    expect(readRows(rows, 0, { columns: found.columns!, dateFormat: 'DMY', sign: 'all-in' }).map((l) => [l.type, l.amount])).toEqual([
      ['expense', 250000],
      ['income', 30000],
    ]);
  });

  it('lets a hand-kept sheet of positive amounts count as spending', () => {
    const rows = parseCsv('Date,Item,Amount\n02/11/2026,Milk,180\n03/11/2026,Bread,120');
    const found = detectColumns(rows);
    expect(found.columns).toEqual({ date: 0, description: 1, amount: 2 });
    expect(readRows(rows, 0, { columns: found.columns!, dateFormat: 'DMY', sign: 'all-out' }).every((l) => l.type === 'expense')).toBe(true);
  });

  it('explains every line it cannot read', () => {
    const rows = parseCsv('Date,Description,Amount\nyesterday,Tea,50\n02/11/2026,Tea,fifty\n02/11/2026,Nothing,0\n02/11/2026,,');
    const lines = readRows(rows, 0, { columns: { date: 0, description: 1, amount: 2 }, dateFormat: 'DMY', sign: 'negative-is-out' });
    expect(lines.map((l) => l.problem)).toEqual([
      'The date "yesterday" could not be read.',
      'The amount "fifty" could not be read.',
      'The amount is zero.',
      'This line has no amount.',
    ]);
    expect(lines.map((l) => l.line)).toEqual([2, 3, 4, 5]);
  });
});

describe('planning the import', () => {
  const lines = [
    { line: 2, date: '2026-11-02', description: 'Imtiaz groceries 4471', amount: 250000, type: 'expense' as const },
    { line: 3, date: '2026-11-02', description: 'Chai', amount: 5000, type: 'expense' as const },
    { line: 4, date: '2026-11-02', description: 'Chai', amount: 5000, type: 'expense' as const },
    { line: 5, date: '2026-11-03', description: 'KE BILL', amount: 320000, type: 'expense' as const },
    { line: 6, date: '2026-11-04', description: 'Salary', amount: 8500000, type: 'income' as const },
    { line: 7, description: 'x', problem: 'This line has no date.' },
  ];
  const before = { id: 'old', spaceId: 's', accountId: 'bank', type: 'expense', amount: 320000, date: '2026-11-03', description: 'K-Electric', categoryId: 'bills' } as Transaction;
  const learnedFrom = { id: 'k', spaceId: 's', accountId: 'cash', type: 'expense', amount: 1, date: '2026-10-01', description: 'KE BILL', categoryId: 'bills' } as Transaction;

  it('leaves out what the account already has, keeps two identical teas, and sums what will be added', () => {
    const plan = planImport(lines, { accountId: 'bank', categories, transactions: [before, learnedFrom] });
    expect(plan.lines.map((l) => l.duplicate)).toEqual([false, false, false, true, false, false]);
    expect(plan.ready.map((l) => l.line)).toEqual([2, 3, 4, 6]);
    expect(plan).toMatchObject({ duplicates: 1, problems: 1, moneyOut: 260000, moneyIn: 8500000 });
    expect(new Set(plan.ready.map((l) => l.id)).size).toBe(4);
  });

  it('gives the same lines the same ids, so importing twice adds nothing', () => {
    const first = planImport(lines, { accountId: 'bank', categories, transactions: [] });
    const imported = first.ready.map(
      (l) => ({ id: l.id, spaceId: 's', accountId: 'bank', type: l.type, amount: l.amount, date: l.date, description: l.description }) as Transaction,
    );
    const again = planImport(lines, { accountId: 'bank', categories, transactions: imported });
    expect(again.ready).toEqual([]);
    expect(again.duplicates).toBe(5);
    expect(planImport(lines, { accountId: 'bank', categories, transactions: [] }).ready.map((l) => l.id)).toEqual(first.ready.map((l) => l.id));
    // In another account, the same lines are different transactions.
    expect(planImport(lines, { accountId: 'cash', categories, transactions: [] }).ready[0].id).not.toBe(first.ready[0].id);
  });

  it('takes categories from what the person chose before, then from everyday words', () => {
    const plan = planImport(lines, { accountId: 'cash', categories, transactions: [learnedFrom] });
    const byLine = new Map(plan.lines.map((l) => [l.line, l]));
    expect(byLine.get(5)).toMatchObject({ categoryId: 'bills', categoryFrom: 'history' });
    expect(byLine.get(2)).toMatchObject({ categoryId: 'food', subcategoryId: 'groc', categoryFrom: 'words' });
    expect(byLine.get(6)).toMatchObject({ categoryId: 'salary', categoryFrom: 'words' });
    // "Chai" is an everyday word for eating out; a word nobody uses gets no category.
    expect(byLine.get(3)).toMatchObject({ categoryId: 'food', categoryFrom: 'words' });
    const odd = planImport([{ line: 9, date: '2026-11-05', description: 'XQZ 0099', amount: 100, type: 'expense' }], { accountId: 'cash', categories, transactions: [] });
    expect(odd.ready[0].categoryId).toBeUndefined();
  });
});
