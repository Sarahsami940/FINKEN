import { describe, expect, it } from 'vitest';
import { buildSeed } from '../data/seed';
import { monthRange } from './dates';
import { parseSearch, runSearch, suggestions, type SearchContext, type SearchData } from './search';

const NOW = '2026-11-17';
const seed = buildSeed('u1', NOW);
const personal = seed.spaceIdByType.personal!;
const business = seed.spaceIdByType.business!;
const data: SearchData = seed;
const ctx = (activeSpaceId = personal): SearchContext => ({ spaces: seed.spaces, activeSpaceId, categories: seed.categories, people: seed.people, accounts: seed.accounts });
const ask = (text: string, active = personal) => {
  const q = parseSearch(text, ctx(active), NOW);
  return { q, r: runSearch(q, data, NOW) };
};

describe('reading questions', () => {
  it('reads a subcategory, a period and a total', () => {
    const { q, r } = ask('How much did I spend on fuel last month?');
    expect(q.intent).toBe('total');
    expect(q.kind).toBe('expense');
    expect(q.rangeLabel).toBe('Last month');
    expect(q.range).toEqual(monthRange(NOW, -1));
    expect(q.subcategoryIds).toEqual([`${personal}:transport:fuel`]);
    expect(q.terms).toEqual([]);
    // The answer is exactly the matching records, after refunds.
    const expected = seed.transactions
      .filter((t) => t.spaceId === personal && t.subcategoryId === `${personal}:transport:fuel` && t.date >= q.range!.from && t.date <= q.range!.to)
      .reduce((s, t) => s + (t.type === 'expense' ? t.amount : t.type === 'refund' ? -t.amount : 0), 0);
    expect(r.kind === 'transactions' && r.total).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('searches descriptions for a shop name', () => {
    const { q, r } = ask('Show my Daraz transactions');
    expect(q.intent).toBe('list');
    expect(q.terms).toEqual(['daraz']);
    expect(r.kind === 'transactions' && r.count).toBeGreaterThan(0);
    expect(r.kind === 'transactions' && r.transactions.every((t) => /daraz/i.test(t.description))).toBe(true);
  });

  it('finds nothing for a word in no record, rather than guessing', () => {
    const { q, r } = ask('Show my Zalando transactions');
    expect(q.terms).toEqual(['zalando']);
    expect(r.kind === 'transactions' && r.count).toBe(0);
  });

  it('answers who owes what, by first name', () => {
    const { q, r } = ask('How much does Ahmed owe me?');
    expect(q.intent).toBe('owed');
    expect(q.owedDirection).toBe('to-you');
    expect(r.kind === 'owed' && r.total).toBe(15000);
    const mine = ask('What do I owe?');
    expect(mine.q.owedDirection).toBe('you-owe');
    expect(mine.r.kind === 'owed' && mine.r.positions.map((p) => p.obligation.title)).toEqual(['Borrowed from Bilal for the laptop']);
  });

  it('reports a name it does not know instead of answering for everyone', () => {
    const { r } = ask('How much does Zara owe me?');
    expect(r.kind === 'owed' && r.unknownName).toBe('zara');
    expect(r.kind === 'owed' && r.positions).toEqual([]);
  });

  it('lists payments due this week from the expected schedule', () => {
    const { q, r } = ask('What are my payments this week?', business);
    expect(q.intent).toBe('upcoming');
    expect(r.kind).toBe('upcoming');
  });

  it('finds the highest expense this month', () => {
    const { q, r } = ask('What was my highest expense this month?');
    expect(q.intent).toBe('largest');
    const mine = seed.transactions.filter((t) => t.spaceId === personal && t.type === 'expense' && t.date >= '2026-11-01' && t.date <= '2026-11-30');
    expect(r.kind === 'transactions' && r.pick?.amount).toBe(Math.max(...mine.map((t) => t.amount)));
  });

  it('searches another Space when the question names it', () => {
    const { q, r } = ask('How much did my business spend on marketing?');
    expect(q.spaceIds).toEqual([business]);
    expect(q.spaceScope).toBe('named');
    expect(q.categoryIds).toEqual([`${business}:marketing`]);
    const expected = seed.transactions.filter((t) => t.spaceId === business && t.categoryId === `${business}:marketing` && t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    expect(r.kind === 'transactions' && r.total).toBe(expected);
  });

  it('reads amount limits, month names and all Spaces', () => {
    const { q } = ask('Show expenses over Rs 10,000 in October across spaces');
    expect(q.min).toBe(10000);
    expect(q.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(q.spaceScope).toBe('all');
    expect(ask('spent under 2k').q.max).toBe(2000);
    // A later month with no year is last year's.
    expect(ask('income in december').q.range?.from).toBe('2025-12-01');
  });

  it('never mixes the active Space with others unless asked', () => {
    const { r } = ask('show all transactions this month');
    expect(r.kind === 'transactions' && r.transactions.every((t) => t.spaceId === personal)).toBe(true);
  });

  it('suggests only questions it can answer', () => {
    for (const s of suggestions(ctx())) {
      const { q } = ask(s);
      expect(q.terms).toEqual([]);
    }
  });
});
