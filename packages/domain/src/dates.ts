import type { DateRange, Frequency, ISODate } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses YYYY-MM-DD as a local date (never UTC, so days do not shift). */
export function parseISODate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today(): ISODate {
  return toISODate(new Date());
}

export function addDays(iso: ISODate, days: number): ISODate {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Adds months, clamping to the last day when the target month is shorter. */
export function addMonths(iso: ISODate, months: number): ISODate {
  const d = parseISODate(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISODate(d);
}

export function diffDays(from: ISODate, to: ISODate): number {
  const ms = parseISODate(to).getTime() - parseISODate(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** The calendar month containing `iso`, shifted by `offset` months. */
export function monthRange(iso: ISODate = today(), offset = 0): DateRange {
  const d = parseISODate(iso);
  const start = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { from: toISODate(start), to: toISODate(end) };
}

/** Monday to Sunday, the week containing `iso`. */
export function weekRange(iso: ISODate): DateRange {
  const day = (parseISODate(iso).getDay() + 6) % 7;
  const from = addDays(iso, -day);
  return { from, to: addDays(from, 6) };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A custom range typed by the user, repaired rather than rejected: one
 * missing end becomes a single day, reversed ends are swapped, and with no
 * valid date at all the fallback is used.
 */
export function customRange(custom: { from?: string; to?: string }, fallback: DateRange): DateRange {
  const from = custom.from && ISO_DATE.test(custom.from) ? custom.from : undefined;
  const to = custom.to && ISO_DATE.test(custom.to) ? custom.to : undefined;
  if (!from && !to) return fallback;
  const a = from ?? to!;
  const b = to ?? from!;
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export function inRange(iso: ISODate, range: DateRange): boolean {
  return iso >= range.from && iso <= range.to;
}

export function nextOccurrence(iso: ISODate, frequency: Frequency): ISODate {
  switch (frequency) {
    case 'weekly':
      return addDays(iso, 7);
    case 'monthly':
      return addMonths(iso, 1);
    case 'quarterly':
      return addMonths(iso, 3);
    case 'yearly':
      return addMonths(iso, 12);
  }
}

const LOCALE = 'en-GB';

export function formatMonth(iso: ISODate, style: 'short' | 'long' = 'long'): string {
  return parseISODate(iso).toLocaleDateString(LOCALE, { month: style });
}

export function formatMonthYear(iso: ISODate): string {
  return parseISODate(iso).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
}

export function formatDay(iso: ISODate): string {
  return parseISODate(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
}

export function formatFullDate(iso: ISODate): string {
  return parseISODate(iso).toLocaleDateString(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** "Today", "Yesterday", or a readable date. Used for list group headings. */
export function formatRelativeDay(iso: ISODate): string {
  const delta = diffDays(today(), iso);
  if (delta === 0) return 'Today';
  if (delta === -1) return 'Yesterday';
  if (delta === 1) return 'Tomorrow';
  const d = parseISODate(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "Due today", "In 3 days", "2 days overdue". */
export function formatDueLabel(iso: ISODate): string {
  const delta = diffDays(today(), iso);
  if (delta === 0) return 'Due today';
  if (delta === 1) return 'Due tomorrow';
  if (delta > 1) return `In ${delta} days`;
  if (delta === -1) return '1 day overdue';
  return `${-delta} days overdue`;
}
