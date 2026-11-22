/**
 * Importing transactions from a CSV file: a bank or wallet statement, or a
 * spreadsheet someone kept by hand.
 *
 * 1. `parseCsv` reads the file: commas, semicolons or tabs, quoted fields,
 *    Excel's byte-order mark, Windows or Unix line endings.
 * 2. `detectColumns` finds the header row and which column is the date,
 *    description and amount (or separate money-out and money-in columns),
 *    from the names banks use. The person can change any of it.
 * 3. `detectDateFormat` decides how dates are written. Day-first is chosen
 *    when both day-first and month-first would work, as in Pakistan, and the
 *    screen says so.
 * 4. `readRows` turns each line into a transaction, or explains what is wrong
 *    with it, in words.
 * 5. `planImport` matches lines against what the account already has, so
 *    importing the same statement twice adds nothing, and gives each line a
 *    fixed id made from its contents, so even a second device importing the
 *    same file cannot add it twice.
 *
 * Amounts are read digit by digit into paisa, never through floating point.
 */
import { guessCategory } from './capture';
import type { Category, ID, ISODate, Transaction } from './types';

// ── Reading the file ───────────────────────────────────────────────────────

/** The most lines one import takes: one save on the server holds at most 5,000 records. */
export const MAX_IMPORT_ROWS = 5000;

function guessDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = [',', ';', '\t'].map((d) => [d, sample.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

/** Rows of cells. Empty lines are dropped; cells are trimmed. */
export function parseCsv(input: string, delimiter = guessDelimiter(input)): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// ── Amounts ────────────────────────────────────────────────────────────────

/**
 * Reads an amount as it appears in statements: "1,250.50", "Rs. 1,250",
 * "PKR -500", "(500.00)", "500-", "1,000 Dr", "2,000 CR". Returns signed
 * paisa (negative for money out when the text says so), or null.
 */
export function parseStatementAmount(raw: string): number | null {
  let text = raw.trim().replace(/ /g, ' ');
  if (!text) return null;
  let sign = 1;
  const drcr = text.match(/\s*\b(dr|cr)\.?$/i);
  if (drcr) {
    if (drcr[1].toLowerCase() === 'dr') sign = -1;
    text = text.slice(0, drcr.index).trim();
  }
  if (/^\(.*\)$/.test(text)) {
    sign = -sign;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^(rs\.?|pkr|usd|\$|₨)\s*/i, '').replace(/\s*(rs\.?|pkr)$/i, '');
  if (text.startsWith('-')) {
    sign = -sign;
    text = text.slice(1).trim();
  } else if (text.endsWith('-')) {
    sign = -sign;
    text = text.slice(0, -1).trim();
  } else if (text.startsWith('+')) text = text.slice(1).trim();
  text = text.replace(/^(rs\.?|pkr)\s*/i, '');
  const m = text.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const paisa = whole * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paisa)) return null;
  return sign * paisa;
}

// ── Dates ──────────────────────────────────────────────────────────────────

export type DateFormat = 'DMY' | 'MDY' | 'YMD';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number) => String(n).padStart(2, '0');
function isoOf(y: number, m: number, d: number): ISODate | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : null;
}

/** A date as written in `format`; dates with a month name are read whatever the format. Times after the date are ignored. */
export function parseStatementDate(raw: string, format: DateFormat): ISODate | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[t\s]\d{1,2}:\d{2}.*$/, '');
  // 12-Nov-2026, 12 November 2026, Nov 12, 2026
  const named = text.match(/^(\d{1,2})[\s\-/.]+([a-z]{3,9})\.?[\s\-/.,]+(\d{2,4})$/) ?? null;
  if (named) {
    const m = MONTHS.indexOf(named[2].slice(0, 3)) + 1;
    return m ? isoOf(Number(named[3]), m, Number(named[1])) : null;
  }
  const us = text.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (us) {
    const m = MONTHS.indexOf(us[1].slice(0, 3)) + 1;
    return m ? isoOf(Number(us[3]), m, Number(us[2])) : null;
  }
  const parts = text.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!parts) return null;
  const [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (parts[1].length === 4) return isoOf(a, b, c);
  if (format === 'YMD') return null;
  return format === 'DMY' ? isoOf(c, b, a) : isoOf(c, a, b);
}

export interface DateDetection {
  format: DateFormat;
  /** Both day-first and month-first read every date: the person should confirm. */
  ambiguous: boolean;
}

/** How the dates in this column are written. Day-first wins a tie, as Pakistani banks write them. */
export function detectDateFormat(values: string[]): DateDetection {
  const filled = values.filter((v) => v.trim());
  const works = (f: DateFormat) => filled.every((v) => parseStatementDate(v, f) !== null);
  const dmy = works('DMY');
  const mdy = works('MDY');
  if (dmy) return { format: 'DMY', ambiguous: mdy && filled.some((v) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(v.trim())) };
  if (mdy) return { format: 'MDY', ambiguous: false };
  return { format: works('YMD') ? 'YMD' : 'DMY', ambiguous: false };
}

// ── Columns ────────────────────────────────────────────────────────────────

export interface ColumnMap {
  date: number;
  description: number;
  /** One signed amount column... */
  amount?: number;
  /** ...or separate money-out and money-in columns. */
  debit?: number;
  credit?: number;
  /** A column saying "Dr"/"Cr" (or debit/credit) for each line. */
  direction?: number;
}

export interface Detected {
  /** Index of the header row in the parsed rows (-1 when the file has none). */
  headerRow: number;
  headers: string[];
  columns: ColumnMap | null;
}

const NAMES: Record<keyof ColumnMap, RegExp> = {
  date: /^(txn |transaction |value |posting |booking )?date$|^date\b/,
  description: /^(description|narration|details?|particulars|remarks?|memo|payee|transaction details|note|notes|title|item|items|name|merchant|purpose|for)\b/,
  amount: /^(amount|amt|value)\b|^transaction amount\b/,
  debit: /^(debit|withdrawals?|dr|paid out|money out|out|spent|expense)\b/,
  credit: /^(credit|deposits?|cr|paid in|money in|in|received|income)\b/,
  direction: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|type|transaction type)$/,
};

/** Finds the header row (banks often put account details above it) and which column holds what. */
export function detectColumns(rows: string[][]): Detected {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const headers = rows[r].map((h) => h.toLowerCase().replace(/\s+/g, ' ').trim());
    const find = (key: keyof ColumnMap, taken: number[]) => headers.findIndex((h, i) => !taken.includes(i) && NAMES[key].test(h));
    const date = find('date', []);
    if (date < 0) continue;
    const description = find('description', [date]);
    const direction = find('direction', [date, description]);
    const debit = find('debit', [date, description, direction]);
    const credit = find('credit', [date, description, direction, debit]);
    const amount = find('amount', [date, description, direction, debit, credit]);
    if (amount < 0 && (debit < 0 || credit < 0)) continue;
    // Without a named description column, the first other column that holds words is taken.
    const used = [date, direction, debit, credit, amount];
    const wordy = description >= 0 ? description : headers.findIndex((_, i) => !used.includes(i) && rows.slice(r + 1, r + 6).some((row) => /[a-z]{2}/i.test(row[i] ?? '')));
    const columns: ColumnMap = { date, description: wordy };
    if (debit >= 0 && credit >= 0) Object.assign(columns, { debit, credit });
    else columns.amount = amount;
    if (direction >= 0) columns.direction = direction;
    return { headerRow: r, headers: rows[r], columns };
  }
  return { headerRow: -1, headers: [], columns: null };
}

// ── Lines into transactions ────────────────────────────────────────────────

/** For a single amount column: which way plain numbers go. */
export type AmountSign = 'negative-is-out' | 'all-out' | 'all-in';

export interface ReadOptions {
  columns: ColumnMap;
  dateFormat: DateFormat;
  sign: AmountSign;
}

export interface ImportLine {
  /** Line number in the file, counting from 1, as a spreadsheet shows it. */
  line: number;
  date?: ISODate;
  description: string;
  /** Always positive, in paisa. */
  amount?: number;
  type?: 'expense' | 'income';
  /** Why this line cannot be imported, if it cannot. */
  problem?: string;
}

/** Each line after the header, read with the chosen columns and formats. */
export function readRows(rows: string[][], headerRow: number, { columns, dateFormat, sign }: ReadOptions): ImportLine[] {
  const out: ImportLine[] = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r];
    const at = (i?: number) => (i === undefined || i < 0 ? '' : (cells[i] ?? '').trim());
    const line: ImportLine = { line: r + 1, description: at(columns.description).replace(/\s+/g, ' ').slice(0, 200) };
    // Statement footers ("Closing balance", "Total") have no date: skip them quietly.
    const rawDate = at(columns.date);
    if (!rawDate && cells.every((c, i) => i === columns.description || !/\d/.test(c))) continue;
    const date = parseStatementDate(rawDate, dateFormat);
    if (!date) {
      if (/^(opening|closing|total|balance)/i.test(cells.join(' ').trim())) continue;
      out.push({ ...line, problem: rawDate ? `The date "${rawDate}" could not be read.` : 'This line has no date.' });
      continue;
    }
    line.date = date;

    let signed: number | null;
    if (columns.debit !== undefined && columns.credit !== undefined) {
      const debit = at(columns.debit) ? parseStatementAmount(at(columns.debit)) : 0;
      const credit = at(columns.credit) ? parseStatementAmount(at(columns.credit)) : 0;
      if (debit === null || credit === null) {
        out.push({ ...line, problem: `The amount "${at(debit === null ? columns.debit : columns.credit)}" could not be read.` });
        continue;
      }
      if (debit && credit) {
        out.push({ ...line, problem: 'This line has money both out and in.' });
        continue;
      }
      signed = debit ? -Math.abs(debit) : Math.abs(credit);
    } else {
      const raw = at(columns.amount);
      signed = parseStatementAmount(raw);
      if (signed === null) {
        out.push({ ...line, problem: raw ? `The amount "${raw}" could not be read.` : 'This line has no amount.' });
        continue;
      }
      const dir = at(columns.direction).toLowerCase();
      if (/^(dr|debit|d|withdrawal|out|expense)/.test(dir)) signed = -Math.abs(signed);
      else if (/^(cr|credit|c|deposit|in|income)/.test(dir)) signed = Math.abs(signed);
      else if (sign === 'all-out') signed = -Math.abs(signed);
      else if (sign === 'all-in') signed = Math.abs(signed);
    }
    if (signed === 0) {
      out.push({ ...line, problem: 'The amount is zero.' });
      continue;
    }
    out.push({ ...line, amount: Math.abs(signed), type: signed < 0 ? 'expense' : 'income' });
  }
  return out;
}

// ── Matching and categories ────────────────────────────────────────────────

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/\d{4,}/g, ' ')
    .replace(/[^a-z؀-ۿ]+/g, ' ')
    .trim();

/** A short, stable hash for ids. Not for security. */
function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export interface PlannedLine extends ImportLine {
  /** Fixed for this account and line contents, so the same line never arrives twice. */
  id: ID;
  /** Already in the account (an earlier import, or added by hand), so it is left out. */
  duplicate: boolean;
  categoryId?: ID;
  subcategoryId?: ID;
  /** Where the category came from. */
  categoryFrom?: 'history' | 'words';
}

export interface ImportPlan {
  lines: PlannedLine[];
  /** Lines that will be added. */
  ready: PlannedLine[];
  duplicates: number;
  problems: number;
  moneyIn: number;
  moneyOut: number;
}

/**
 * Decides what each readable line becomes in `accountId`. A line matches a
 * transaction already in the account when the date, amount and direction are
 * the same; descriptions are not compared, because banks shorten them. Two
 * identical lines on the same day stay two, as long as the account does not
 * already have both.
 */
export function planImport(lines: ImportLine[], ctx: { accountId: ID; categories: Category[]; transactions: Transaction[] }): ImportPlan {
  const inAccount = ctx.transactions.filter((t) => t.accountId === ctx.accountId && (t.type === 'expense' || t.type === 'income'));
  const existing = new Map<string, number>();
  for (const t of inAccount) existing.set(`${t.date}|${t.type}|${t.amount}`, (existing.get(`${t.date}|${t.type}|${t.amount}`) ?? 0) + 1);

  // What this person called the same thing before decides its category.
  const learned = new Map<string, Map<string, number>>();
  for (const t of ctx.transactions) {
    if (!t.categoryId || !t.description) continue;
    const key = `${t.type}|${normal(t.description)}`;
    const counts = learned.get(key) ?? new Map<string, number>();
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
    learned.set(key, counts);
  }
  const live = new Set(ctx.categories.map((c) => c.id));

  const seen = new Map<string, number>();
  const out: PlannedLine[] = lines.map((line) => {
    if (line.problem || !line.date || !line.amount || !line.type) return { ...line, id: '', duplicate: false };
    const key = `${line.date}|${line.type}|${line.amount}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    const contents = `${key}|${normal(line.description)}`;
    const id = `imp-${hash(`${ctx.accountId}|${contents}|${nth}`)}`;
    const planned: PlannedLine = { ...line, id, duplicate: nth <= (existing.get(key) ?? 0) };
    const history = learned.get(`${line.type}|${normal(line.description)}`);
    const fromHistory = history && [...history].filter(([c]) => live.has(c)).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (fromHistory) Object.assign(planned, { categoryId: fromHistory, categoryFrom: 'history' });
    else {
      const guess = guessCategory(
        line.description,
        ctx.categories.filter((c) => c.kind === line.type),
      );
      if (guess) Object.assign(planned, { categoryId: guess.category.id, subcategoryId: guess.subId, categoryFrom: 'words' });
    }
    return planned;
  });
  const ready = out.filter((l) => !l.problem && !l.duplicate);
  return {
    lines: out,
    ready,
    duplicates: out.filter((l) => l.duplicate).length,
    problems: out.filter((l) => l.problem).length,
    moneyIn: ready.filter((l) => l.type === 'income').reduce((n, l) => n + l.amount!, 0),
    moneyOut: ready.filter((l) => l.type === 'expense').reduce((n, l) => n + l.amount!, 0),
  };
}
