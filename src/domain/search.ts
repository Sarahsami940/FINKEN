/**
 * Search Your Money: plain-language questions answered from local records.
 *
 * The parser turns a sentence into a structured interpretation that is
 * always shown to the user; the runner answers only from records that
 * match it. Anything the parser does not recognise becomes a text search,
 * so an unsupported question returns "nothing found", never a made-up figure.
 */
import { addDays, addMonths, monthRange, parseISODate, today, weekRange } from './dates';
import { owedToYouKind, obligationPosition, type ObligationPosition } from './money';
import type { Account, Category, DateRange, ID, ISODate, Obligation, Person, Recurring, Space, Transaction } from './types';
import { expectedEvents, type ExpectedEvent } from './upcoming';

export type SearchIntent = 'list' | 'total' | 'count' | 'largest' | 'smallest' | 'average' | 'owed' | 'upcoming';
export type SearchKind = 'expense' | 'income' | 'transfer' | 'refund';

export interface SearchContext {
  spaces: Space[];
  activeSpaceId: ID | null;
  categories: Category[];
  people: Person[];
  accounts: Account[];
}

export interface SearchQuery {
  raw: string;
  intent: SearchIntent;
  kind?: SearchKind;
  spaceIds: ID[];
  /** How the Spaces were chosen. */
  spaceScope: 'active' | 'named' | 'all';
  categoryIds: ID[];
  subcategoryIds: ID[];
  personIds: ID[];
  accountIds: ID[];
  range?: DateRange;
  rangeLabel?: string;
  min?: number;
  max?: number;
  /** Words that matched nothing else; searched in descriptions, notes and names. */
  terms: string[];
  owedDirection?: 'to-you' | 'you-owe';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const STOP = new Set(
  `a an the my me i we our us you your it its is are was were be been being am do does did done have has had how much many what which who whom where when why
   show find list give get tell see view display all any every some of on in at for from to by with and or about over into than this that these those
   transaction transactions record records money payment payments spend spent spending spends expense expenses cost costs paid pay bought buy
   earn earned earning income received receive receives made make revenue total sum altogether overall please can could would will
   highest biggest largest most top smallest lowest cheapest least average avg typical many number count times there was were rs pkr rupees
   owe owes owed owing due upcoming coming up bill bills next last this week month year day days weeks months years today yesterday
   just only also same per each like is was`.split(/\s+/),
);

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Singular and plural forms a name may be typed as. */
function forms(name: string): string[] {
  const n = name.toLowerCase().trim();
  const out = new Set([n]);
  if (n.endsWith('ies')) out.add(`${n.slice(0, -3)}y`);
  else if (n.endsWith('es')) out.add(n.slice(0, -2));
  else if (n.endsWith('s')) out.add(n.slice(0, -1));
  else if (n.endsWith('y')) out.add(`${n.slice(0, -1)}ies`);
  else out.add(`${n}s`);
  return [...out].filter((f) => f.length >= 3);
}

/** Removes the first whole-word match of any form; returns true when one was found. */
function take(state: { text: string }, phrases: string[]): boolean {
  for (const phrase of [...phrases].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|\\s)${escape(phrase)}(?=\\s|$)`);
    if (re.test(state.text)) {
      state.text = state.text.replace(re, ' ').replace(/\s+/g, ' ');
      return true;
    }
  }
  return false;
}

function amountOf(digits: string, k?: string): number {
  const n = Number(digits.replace(/,/g, ''));
  return k ? n * 1000 : n;
}

function rangeFor(text: string, anchor: ISODate): { range: DateRange; label: string; match: string } | null {
  const year = parseISODate(anchor).getFullYear();
  const patterns: [RegExp, (m: RegExpMatchArray) => { range: DateRange; label: string }][] = [
    [/\b(?:in the |over the )?(last|past|next) (\d{1,3}) (day|week|month)s?\b/, (m) => {
      const n = Number(m[2]);
      const days = m[3] === 'day' ? n : m[3] === 'week' ? n * 7 : 0;
      if (m[1] === 'next') {
        return { range: { from: anchor, to: days ? addDays(anchor, days) : addMonths(anchor, n) }, label: `Next ${n} ${m[3]}${n === 1 ? '' : 's'}` };
      }
      return { range: { from: days ? addDays(anchor, -(days - 1)) : addMonths(anchor, -n), to: anchor }, label: `Last ${n} ${m[3]}${n === 1 ? '' : 's'}` };
    }],
    [/\btoday\b/, () => ({ range: { from: anchor, to: anchor }, label: 'Today' })],
    [/\byesterday\b/, () => ({ range: { from: addDays(anchor, -1), to: addDays(anchor, -1) }, label: 'Yesterday' })],
    [/\bthis week\b/, () => ({ range: weekRange(anchor), label: 'This week' })],
    [/\blast week\b/, () => ({ range: weekRange(addDays(anchor, -7)), label: 'Last week' })],
    [/\bnext week\b/, () => ({ range: weekRange(addDays(anchor, 7)), label: 'Next week' })],
    [/\bthis month\b/, () => ({ range: monthRange(anchor), label: 'This month' })],
    [/\blast month\b/, () => ({ range: monthRange(anchor, -1), label: 'Last month' })],
    [/\bnext month\b/, () => ({ range: monthRange(anchor, 1), label: 'Next month' })],
    [/\bthis year\b/, () => ({ range: { from: `${year}-01-01`, to: `${year}-12-31` }, label: 'This year' })],
    [/\blast year\b/, () => ({ range: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }, label: 'Last year' })],
    [new RegExp(`\\b(?:in |during |for )?${MONTH_RE}(?: (\\d{4}))?\\b`), (m) => {
      const index = MONTHS.findIndex((name) => name.startsWith(m[1].slice(0, 3)));
      // A month later than this one, with no year, means last year's.
      const y = m[2] ? Number(m[2]) : index > parseISODate(anchor).getMonth() ? year - 1 : year;
      const first = `${y}-${String(index + 1).padStart(2, '0')}-01`;
      const name = MONTHS[index][0].toUpperCase() + MONTHS[index].slice(1);
      return { range: monthRange(first), label: `${name} ${y}` };
    }],
  ];
  for (const [re, build] of patterns) {
    const m = text.match(re);
    // "may" is also an ordinary word; only treat it as the month with a cue.
    if (m && !(m[1] === 'may' && !/\b(in|during|for) may\b|\bmay \d{4}\b/.test(text))) return { ...build(m), match: m[0] };
  }
  return null;
}

export function parseSearch(input: string, ctx: SearchContext, anchor: ISODate = today()): SearchQuery {
  const raw = input.trim();
  const state = {
    text: ` ${raw
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/[^a-z0-9.'\s-]/g, ' ')
      .replace(/'s\b/g, '')
      .replace(/\s+/g, ' ')} `,
  };
  const q: SearchQuery = { raw, intent: 'list', spaceIds: [], spaceScope: 'active', categoryIds: [], subcategoryIds: [], personIds: [], accountIds: [], terms: [] };

  // Amounts: "over Rs 5,000", "under 2k".
  const amountRe = /\b(over|above|more than|greater than|at least|min(?:imum)?|under|below|less than|at most|max(?:imum)?)\s+(?:rs\.?\s*|pkr\s*)?(\d+(?:\.\d+)?)(k)?\b/;
  for (let i = 0; i < 2; i++) {
    const m = state.text.match(amountRe);
    if (!m) break;
    const value = amountOf(m[2], m[3]);
    if (/over|above|more|greater|least|min/.test(m[1])) q.min = value;
    else q.max = value;
    state.text = state.text.replace(m[0], ' ');
  }

  // Dates.
  const r = rangeFor(state.text, anchor);
  if (r) {
    q.range = r.range;
    q.rangeLabel = r.label;
    state.text = state.text.replace(r.match, ' ');
  }

  // Spaces: "my business", "family", a Space's own name, or everywhere.
  const active = ctx.spaces.filter((s) => s.status === 'active');
  if (take(state, ['all spaces', 'all my spaces', 'every space', 'everywhere', 'across spaces', 'all of my spaces'])) {
    q.spaceIds = active.map((s) => s.id);
    q.spaceScope = 'all';
  } else {
    for (const s of active) {
      const words = [s.name.toLowerCase(), `${s.name.toLowerCase()} space`];
      const typeWord = s.type === 'other' ? [] : [s.type, `my ${s.type}`, `the ${s.type}`];
      if (take(state, [...words, ...(active.filter((x) => x.type === s.type).length === 1 ? typeWord : [])])) {
        if (!q.spaceIds.includes(s.id)) q.spaceIds.push(s.id);
        q.spaceScope = 'named';
      }
    }
    if (q.spaceIds.length === 0 && ctx.activeSpaceId) q.spaceIds = [ctx.activeSpaceId];
  }
  const inScope = new Set(q.spaceIds);

  // What is being asked.
  const t = state.text;
  if (/\b(owes?|owed|owing)\b/.test(t)) {
    q.intent = 'owed';
    q.owedDirection = /\b(i|we) (still )?owe\b|\bdo i owe\b|\bowe to\b|\bi owe\b/.test(t) && !/\bowes? me\b|\bowed to me\b|\bowe us\b/.test(t) ? 'you-owe' : 'to-you';
  } else if (/\b(due|upcoming|coming up|bills? (this|next)|payments? (this|next|due)|what('s| is) due)\b/.test(t) || /\bnext (week|month)\b/.test(raw.toLowerCase()) || (q.range && q.range.to >= anchor && /\b(payments?|bills?)\b/.test(t) && !q.kind)) {
    q.intent = 'upcoming';
  } else if (/\b(highest|biggest|largest|most expensive|top)\b/.test(t)) q.intent = 'largest';
  else if (/\b(smallest|lowest|cheapest|least)\b/.test(t)) q.intent = 'smallest';
  else if (/\b(average|avg|typical)\b/.test(t)) q.intent = 'average';
  else if (/\bhow many\b|\bnumber of\b|\bcount\b/.test(t)) q.intent = 'count';
  else if (/\bhow much\b|\btotal\b|\bsum\b|\baltogether\b/.test(t)) q.intent = 'total';

  if (/\b(refunds?|refunded)\b/.test(t)) q.kind = 'refund';
  else if (/\btransfers?|transferred|moved\b/.test(t)) q.kind = 'transfer';
  else if (/\b(spend|spent|spending|expenses?|costs?|bought|buy|purchases?)\b/.test(t) || (/\bpaid\b/.test(t) && q.intent !== 'upcoming')) q.kind = 'expense';
  else if (/\b(earn|earned|earning|income|received|receive|revenue|made)\b/.test(t)) q.kind = 'income';
  if (!q.kind && (q.intent === 'largest' || q.intent === 'smallest' || q.intent === 'average')) q.kind = 'expense';

  // Categories and subcategories in the Spaces being searched.
  for (const c of ctx.categories.filter((x) => inScope.has(x.spaceId))) {
    for (const sub of c.subcategories) {
      if (take(state, forms(sub.name))) q.subcategoryIds.push(sub.id);
    }
    if (take(state, forms(c.name))) q.categoryIds.push(c.id);
  }
  // People: full name, or a first name of three letters or more.
  for (const p of ctx.people.filter((x) => inScope.has(x.spaceId))) {
    const name = p.name.toLowerCase();
    const first = name.split(/\s+/)[0];
    if (take(state, [name, ...(first.length >= 3 && first !== name ? [first] : [])])) q.personIds.push(p.id);
  }
  // Accounts by name.
  for (const a of ctx.accounts.filter((x) => inScope.has(x.spaceId) && !x.archived)) {
    const name = a.name.toLowerCase();
    if (take(state, [name])) q.accountIds.push(a.id);
  }

  q.terms = state.text
    .split(/\s+/)
    .map((w) => w.replace(/^[-.']+|[-.']+$/g, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return q;
}

// ── Running a query ────────────────────────────────────────────────────────

export interface SearchData {
  spaces: Space[];
  categories: Category[];
  people: Person[];
  accounts: Account[];
  transactions: Transaction[];
  obligations: Obligation[];
  recurring: Recurring[];
}

export type SearchResult =
  | {
      kind: 'transactions';
      transactions: Transaction[];
      count: number;
      /** Net for spending (expenses less matching refunds), plain sum otherwise; null across currencies. */
      total: number | null;
      refunds: number;
      currency: string | null;
      /** The single record a "largest" or "smallest" question is about. */
      pick?: Transaction;
    }
  | { kind: 'owed'; positions: ObligationPosition[]; total: number | null; currency: string | null; unknownName?: string }
  | { kind: 'upcoming'; events: ExpectedEvent[]; incoming: number; outgoing: number; currency: string | null; range: DateRange };

function currencyOf(spaceIds: ID[], spaces: Space[]): string | null {
  const set = new Set(spaces.filter((s) => spaceIds.includes(s.id)).map((s) => s.currency));
  return set.size === 1 ? [...set][0] : null;
}

function textMatches(t: Transaction, terms: string[], data: SearchData): boolean {
  if (terms.length === 0) return true;
  const category = data.categories.find((c) => c.id === t.categoryId);
  const sub = category?.subcategories.find((s) => s.id === t.subcategoryId);
  const person = data.people.find((p) => p.id === t.personId);
  const haystack = [t.description, t.notes, category?.name, sub?.name, person?.name].filter(Boolean).join(' ').toLowerCase();
  return terms.every((term) => forms(term).concat(term).some((f) => haystack.includes(f)));
}

export function runSearch(q: SearchQuery, data: SearchData, anchor: ISODate = today()): SearchResult {
  const scope = new Set(q.spaceIds);
  const currency = currencyOf(q.spaceIds, data.spaces);

  if (q.intent === 'owed') {
    const people = new Set(q.personIds);
    const positions = data.obligations
      .filter((o) => scope.has(o.spaceId))
      .filter((o) => (q.owedDirection === 'you-owe' ? !owedToYouKind(o.kind) : owedToYouKind(o.kind)))
      .filter((o) => people.size === 0 || people.has(o.personId))
      .map((o) => obligationPosition(o, data.transactions, anchor))
      .filter((p) => p.state === 'open')
      .sort((a, b) => b.outstanding - a.outstanding);
    // A name Finken does not know is reported, not guessed.
    const unknownName = people.size === 0 && q.terms.length > 0 ? q.terms.join(' ') : undefined;
    return { kind: 'owed', positions: unknownName ? [] : positions, total: currency ? positions.reduce((s, p) => s + p.outstanding, 0) : null, currency, unknownName };
  }

  if (q.intent === 'upcoming') {
    const range = q.range ? { from: q.range.from < anchor ? anchor : q.range.from, to: q.range.to < anchor ? anchor : q.range.to } : { from: anchor, to: addDays(anchor, 30) };
    const people = new Set(q.personIds);
    const cats = new Set(q.categoryIds);
    const events = expectedEvents(
      { recurring: data.recurring.filter((r) => scope.has(r.spaceId)), obligations: data.obligations.filter((o) => scope.has(o.spaceId)), transactions: data.transactions },
      range,
      anchor,
    )
      .filter((e) => (q.kind === 'income' ? e.direction === 'in' : q.kind === 'expense' ? e.direction === 'out' : true))
      .filter((e) => people.size === 0 || (e.personId && people.has(e.personId)))
      .filter((e) => cats.size === 0 || (e.categoryId && cats.has(e.categoryId)))
      .filter((e) => q.terms.length === 0 || q.terms.every((term) => e.title.toLowerCase().includes(term)));
    return {
      kind: 'upcoming',
      events,
      incoming: events.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0),
      outgoing: events.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0),
      currency,
      range,
    };
  }

  const owner = new Map(data.obligations.map((o) => [o.id, o.personId]));
  const cats = new Set(q.categoryIds);
  const subs = new Set(q.subcategoryIds);
  const people = new Set(q.personIds);
  const accounts = new Set(q.accountIds);
  const base = data.transactions.filter((t) => {
    if (!scope.has(t.spaceId)) return false;
    if (q.range && (t.date < q.range.from || t.date > q.range.to)) return false;
    if ((cats.size || subs.size) && !(cats.has(t.categoryId ?? '') || subs.has(t.subcategoryId ?? ''))) return false;
    if (people.size && !people.has(t.personId ?? (t.obligationId ? owner.get(t.obligationId) : '') ?? '')) return false;
    if (accounts.size && !accounts.has(t.accountId) && !accounts.has(t.toAccountId ?? '')) return false;
    return textMatches(t, q.terms, data);
  });
  const sized = (t: Transaction) => (q.min === undefined || t.amount >= q.min) && (q.max === undefined || t.amount <= q.max);
  const matching = base.filter((t) => (q.kind ? t.type === q.kind : true) && sized(t));
  // Spending is counted after refunds, the same way everywhere in Finken.
  const refunds = q.kind === 'expense' ? base.filter((t) => t.type === 'refund').reduce((s, t) => s + t.amount, 0) : 0;
  const sum = matching.reduce((s, t) => s + t.amount, 0);

  let list = [...matching].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  let pick: Transaction | undefined;
  if (q.intent === 'largest' || q.intent === 'smallest') {
    list = [...matching].sort((a, b) => (q.intent === 'largest' ? b.amount - a.amount : a.amount - b.amount));
    pick = list[0];
  }
  const plainTotal = q.kind === undefined ? null : sum - refunds;
  return {
    kind: 'transactions',
    transactions: list,
    count: matching.length,
    total: currency ? (plainTotal ?? sum) : null,
    refunds,
    currency,
    pick,
  };
}

/** Example questions built from the user's own categories and people, so every one can be answered. */
export function suggestions(ctx: SearchContext): string[] {
  const out: string[] = [];
  const own = (spaceId: ID | null) => ({
    cats: ctx.categories.filter((c) => c.spaceId === spaceId),
    people: ctx.people.filter((p) => p.spaceId === spaceId),
  });
  const { cats, people } = own(ctx.activeSpaceId);
  const sub = cats.flatMap((c) => (c.kind === 'expense' ? c.subcategories : []))[0];
  const cat = cats.find((c) => c.kind === 'expense');
  if (sub) out.push(`How much did I spend on ${sub.name.toLowerCase()} last month?`);
  else if (cat) out.push(`How much did I spend on ${cat.name.toLowerCase()} last month?`);
  out.push('What was my highest expense this month?');
  out.push('What are my payments this week?');
  const person = people[0];
  if (person) out.push(`How much does ${person.name.split(/\s+/)[0]} owe me?`);
  const business = ctx.spaces.find((s) => s.type === 'business' && s.status === 'active');
  const marketing = business && ctx.categories.find((c) => c.spaceId === business.id && c.kind === 'expense' && c.name === 'Marketing');
  if (business && marketing) out.push('How much did my business spend on marketing?');
  out.push('Show expenses over Rs 10,000 this month');
  return out;
}
