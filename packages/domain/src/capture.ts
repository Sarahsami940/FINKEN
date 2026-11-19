/**
 * Intelligent capture, first pass: turns a short sentence such as
 * "Spent Rs. 850 on dinner yesterday" into a draft the user then confirms.
 *
 * This is deliberately simple pattern matching. It never saves anything: the
 * result only pre-fills the transaction form, and anything it had to guess
 * is listed in `guesses` so the form can say so.
 */
import { addDays, parseISODate, today, toISODate } from './dates';
import type { Account, Category, ID, ISODate } from './types';

export type CaptureType = 'expense' | 'income' | 'transfer';

export interface CaptureResult {
  type: CaptureType;
  amount?: number;
  date: ISODate;
  categoryId?: ID;
  subcategoryId?: ID;
  accountId?: ID;
  toAccountId?: ID;
  description: string;
  /** What was read from the text, in plain words, for the confirmation banner. */
  understood: string[];
  /** What could not be read and was assumed or left blank. */
  guesses: string[];
}

export interface CaptureContext {
  categories: Category[];
  accounts: Account[];
  now?: ISODate;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_PATTERN = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  lac: 100_000,
  lacs: 100_000,
  lakh: 100_000,
  lakhs: 100_000,
  m: 1_000_000,
  million: 1_000_000,
};

const TRANSFER_WORDS = /\b(transferr?ed|transfer|moved|withdrew|withdrawn|withdraw|withdrawal|deposited|deposit|topped up|top-?up)\b/;
const INCOME_WORDS = /\b(got paid|received|receive|earned|salary|income|got|credited)\b/;
const EXPENSE_WORDS = /\b(spent|spend|paid|pay|bought|buy|purchased|purchase|cost)\b/;

/** Everyday words mapped to the category (and subcategory) they usually mean. */
const HINTS: [RegExp, string[], string?][] = [
  [/\b(grocer(?:y|ies)|ration|vegetables?|fruits?)\b/, ['Food'], 'Groceries'],
  [/\b(dinner|lunch|breakfast|restaurant|cafe|coffee|chai|bbq|ate out)\b/, ['Food'], 'Dining Out'],
  [/\b(foodpanda|pizza|takeaway|food delivery)\b/, ['Food'], 'Delivery'],
  [/\b(snacks?)\b/, ['Food'], 'Snacks'],
  [/\b(fuel|petrol|diesel|cng)\b/, ['Transport', 'Logistics'], 'Fuel'],
  [/\b(uber|careem|indrive|taxi|rickshaw|ride)\b/, ['Transport'], 'Ride-hailing'],
  [/\b(bus|metro|train ticket)\b/, ['Transport'], 'Public Transport'],
  [/\b(electricity|electric bill|k-?electric|wapda)\b/, ['Bills', 'Utilities'], 'Electricity'],
  [/\b(internet|wifi|broadband)\b/, ['Bills', 'Utilities'], 'Internet'],
  [/\b(mobile package|mobile bill|phone bill|recharge)\b/, ['Bills', 'Utilities'], 'Mobile'],
  [/\b(water bill|gas bill)\b/, ['Bills', 'Utilities']],
  [/\b(rent)\b/, ['Housing', 'Rent'], 'Rent'],
  [/\b(doctor|medicines?|pharmacy|clinic|hospital|lab tests?)\b/, ['Health']],
  [/\b(school fees?|tuition|course|books?)\b/, ['Education']],
  [/\b(cinema|movie|netflix|concert|outing)\b/, ['Entertainment', 'Outings']],
  [/\b(clothes|shoes|daraz|shopping)\b/, ['Shopping']],
  [/\b(flight|hotel|trip)\b/, ['Travel']],
  [/\b(salar(?:y|ies)|wages|payroll)\b/, ['Salary', 'Payroll']],
  [/\b(freelance|client project)\b/, ['Freelance', 'Services']],
  [/\b(sales?|order|customer)\b/, ['Sales']],
  [/\b(ads?|advertising|campaign|flyers?)\b/, ['Marketing']],
  [/\b(courier|cargo|shipping)\b/, ['Logistics']],
  [/\b(stationery|printer ink)\b/, ['Office']],
  [/\b(refund)\b/, ['Refunds']],
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(word.toLowerCase())}([^a-z0-9]|$)`).test(text);

interface Found<T> {
  value: T;
  /** The exact text that was matched, so it can be removed from the description. */
  matched: string;
}

function findDate(text: string, now: ISODate): Found<ISODate> | null {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/\bday before yesterday\b/))) return { value: addDays(now, -2), matched: m[0] };
  if ((m = text.match(/\b(yesterday|last night)\b/))) return { value: addDays(now, -1), matched: m[0] };
  if ((m = text.match(/\b(today|tonight|this morning|just now)\b/))) return { value: now, matched: m[0] };
  if ((m = text.match(/\b(\d{1,3}|a|an|one|two|three) (day|week)s? ago\b/))) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };
    const n = words[m[1]] ?? Number(m[1]);
    return { value: addDays(now, -n * (m[2] === 'week' ? 7 : 1)), matched: m[0] };
  }
  if ((m = text.match(new RegExp(`\\b(?:last |on |this )?(${WEEKDAYS.join('|')})\\b`)))) {
    const target = WEEKDAYS.indexOf(m[1]);
    const current = parseISODate(now).getDay();
    // The most recent such day; "on monday" said on a Monday means today.
    let back = (current - target + 7) % 7;
    if (back === 0 && m[0].startsWith('last')) back = 7;
    return { value: addDays(now, -back), matched: m[0] };
  }
  const year = parseISODate(now).getFullYear();
  const build = (day: number, month: number, y?: number): ISODate | null => {
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const date = new Date(y ?? year, month, day);
    if (date.getMonth() !== month) return null;
    let iso = toISODate(date);
    // Without a year, a date still to come this year means the same date last year.
    if (y === undefined && iso > now) iso = toISODate(new Date(year - 1, month, day));
    return iso;
  };
  if ((m = text.match(new RegExp(`\\b(?:on )?(\\d{1,2})(?:st|nd|rd|th)? ${MONTH_PATTERN}\\b(?: (\\d{4}))?`)))) {
    const iso = build(Number(m[1]), MONTHS.indexOf(m[2].slice(0, 3)), m[3] ? Number(m[3]) : undefined);
    if (iso) return { value: iso, matched: m[0] };
  }
  if ((m = text.match(new RegExp(`\\b(?:on )?${MONTH_PATTERN} (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`)))) {
    const iso = build(Number(m[2]), MONTHS.indexOf(m[1].slice(0, 3)), m[3] ? Number(m[3]) : undefined);
    if (iso) return { value: iso, matched: m[0] };
  }
  // Day first, as dates are written in Pakistan and most of the world.
  if ((m = text.match(/\b(?:on )?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const iso = build(Number(m[1]), Number(m[2]) - 1, y);
    if (iso) return { value: iso, matched: m[0] };
  }
  return null;
}

function findAmount(text: string): Found<number> | null {
  const pattern = /(rs\.?|pkr|₨|\$|usd|aed|eur|gbp|£|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lacs?|lakhs?|m|million)?(?![a-z0-9])/g;
  let best: Found<number> | null = null;
  for (const m of text.matchAll(pattern)) {
    const value = Number(m[2].replace(/,/g, '')) * (m[3] ? MULTIPLIERS[m[3]] : 1);
    if (!Number.isFinite(value) || value <= 0) continue;
    const found = { value: Math.round(value * 100) / 100, matched: m[0].trim() };
    // A number with a currency in front of it is certainly the amount.
    if (m[1]) return found;
    best ??= found;
  }
  return best;
}

function findAccount(text: string, accounts: Account[], exclude?: ID): Account | undefined {
  const usable = accounts.filter((a) => !a.archived && a.id !== exclude);
  const byName = usable.find((a) => hasWord(text, a.name));
  if (byName) return byName;
  const kindWords: [RegExp, Account['kind']][] = [
    [/\b(cash)\b/, 'cash'],
    [/\b(bank|card|debit|credit card|atm)\b/, 'bank'],
    [/\b(wallet|easypaisa|jazzcash|sadapay|nayapay)\b/, 'wallet'],
  ];
  for (const [words, kind] of kindWords) {
    if (words.test(text)) {
      const match = usable.find((a) => a.kind === kind);
      if (match) return match;
    }
  }
  return undefined;
}

function findCategory(text: string, categories: Category[]): { category: Category; subId?: ID } | undefined {
  // The user's own names win over the built-in hints.
  for (const category of categories) {
    const sub = category.subcategories.find((s) => hasWord(text, s.name));
    if (sub) return { category, subId: sub.id };
  }
  const named = categories.find((c) => c.name.toLowerCase() !== 'other' && hasWord(text, c.name));
  if (named) return { category: named };
  for (const [words, names, subName] of HINTS) {
    if (!words.test(text)) continue;
    for (const name of names) {
      const category = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (category) return { category, subId: category.subcategories.find((s) => s.name.toLowerCase() === subName?.toLowerCase())?.id };
    }
  }
  return undefined;
}

const FILLER = /^(?:i|we|just|have|had|rs\.?|pkr|on|for|from|in|at|to|of|the|a|an|by|with|using|via|and|was|is)\b[\s,.-]*/;
const FILLER_END = /[\s,.-]*\b(?:on|for|from|in|at|to|of|by|with|using|via|and|the)$/;

function describe(original: string, remove: string[]): string {
  let text = original.toLowerCase();
  for (const part of remove) if (part) text = text.replace(part.toLowerCase(), ' ');
  text = text
    .replace(TRANSFER_WORDS, ' ')
    .replace(INCOME_WORDS, ' ')
    .replace(EXPENSE_WORDS, ' ')
    .replace(/[.!?]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(FILLER, '').replace(FILLER_END, '').trim();
  }
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function parseCapture(input: string, ctx: CaptureContext): CaptureResult {
  const now = ctx.now ?? today();
  const text = input.toLowerCase().replace(/\s+/g, ' ').trim();
  const understood: string[] = [];
  const guesses: string[] = [];

  const date = findDate(text, now);
  // Remove the date first so "12 nov" or "3 days ago" is never read as the amount.
  const amount = findAmount(date ? text.replace(date.matched, ' ') : text);

  let type: CaptureType;
  if (TRANSFER_WORDS.test(text)) type = 'transfer';
  else if (INCOME_WORDS.test(text)) type = 'income';
  else if (EXPENSE_WORDS.test(text)) type = 'expense';
  else {
    type = 'expense';
    guesses.push('Assumed this is an expense');
  }

  if (amount) understood.push(`Amount ${amount.value.toLocaleString('en-US')}`);
  else guesses.push('No amount found');
  if (!date) guesses.push('No date found, so today is used');

  const result: CaptureResult = { type, amount: amount?.value, date: date?.value ?? now, description: '', understood, guesses };
  const remove = [amount?.matched ?? '', date?.matched ?? ''];

  if (type === 'transfer') {
    const withdrew = /\b(withdrew|withdrawn|withdraw|withdrawal)\b/.test(text);
    const deposited = /\b(deposited|deposit)\b/.test(text);
    const active = ctx.accounts.filter((a) => !a.archived);
    const fromText = text.match(/\bfrom (.+?)(?= to | into |$)/)?.[1];
    const toText = text.match(/\b(?:to|into) (.+)$/)?.[1];
    let from = fromText ? findAccount(fromText, ctx.accounts) : undefined;
    let to = toText ? findAccount(toText, ctx.accounts, from?.id) : undefined;
    if (withdrew) {
      to ??= active.find((a) => a.kind === 'cash' && a.id !== from?.id);
      from ??= active.find((a) => a.kind === 'bank' && a.id !== to?.id);
    } else if (deposited) {
      from ??= active.find((a) => a.kind === 'cash' && a.id !== to?.id);
      to ??= active.find((a) => a.kind === 'bank' && a.id !== from?.id);
    }
    result.accountId = from?.id;
    result.toAccountId = to?.id;
    if (from && to) understood.push(`${from.name} to ${to.name}`);
    else guesses.push('Could not tell which accounts');
    result.description = withdrew ? 'Cash withdrawal' : deposited ? 'Cash deposit' : '';
    return result;
  }

  const found = findCategory(
    text,
    ctx.categories.filter((c) => c.kind === type),
  );
  if (found) {
    result.categoryId = found.category.id;
    result.subcategoryId = found.subId;
    const sub = found.category.subcategories.find((s) => s.id === found.subId)?.name;
    understood.push(sub ? `${found.category.name}, ${sub}` : found.category.name);
  } else {
    guesses.push('Could not tell the category');
  }

  // Only an explicit "from/by/with/in <account>" picks the account; otherwise the usual one is used.
  const accountPhrase = text.match(/\b(?:from|by|with|using|via|in|into|to) (?:my |the )?([a-z0-9 ]+)$/)?.[1] ?? text.match(/\b(cash|card|wallet|easypaisa|jazzcash)\b/)?.[0];
  const account = accountPhrase ? findAccount(accountPhrase, ctx.accounts) : undefined;
  if (account) {
    result.accountId = account.id;
    understood.push(account.name);
    const phrase = text.match(
      new RegExp(`\\b(?:from|by|with|using|via|in|into|to) (?:my |the )?(?:${escapeRegExp(account.name.toLowerCase())}|cash|card|bank|wallet)(?: account)?\\b`),
    );
    if (phrase) remove.push(phrase[0]);
  }

  result.description = describe(input, remove);
  return result;
}
