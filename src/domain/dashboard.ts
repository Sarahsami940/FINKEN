/**
 * Reporting periods and figures for Home and Today. Everything is derived
 * from records at the moment it is shown; nothing here is stored.
 */
import { addDays, customRange, diffDays, monthRange, today, weekRange } from './dates';
import { summarize } from './money';
import { budgetStatus, type BudgetStatus } from './planning';
import type { Budget, DateRange, ISODate, Transaction } from './types';

export type ReportPeriod = 'today' | 'week' | 'month' | 'last-month' | 'custom';

export const REPORT_PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

export { weekRange };

/**
 * The dates a period covers. A custom range with missing or reversed dates
 * is repaired rather than rejected: one missing end becomes a single day,
 * and reversed ends are swapped.
 */
export function reportRange(period: ReportPeriod, anchor: ISODate = today(), custom: { from?: string; to?: string } = {}): DateRange {
  switch (period) {
    case 'today':
      return { from: anchor, to: anchor };
    case 'week':
      return weekRange(anchor);
    case 'last-month':
      return monthRange(anchor, -1);
    case 'custom':
      return customRange(custom, monthRange(anchor));
    default:
      return monthRange(anchor);
  }
}

export interface PeriodComparison {
  /** The part of the period that has happened so far. */
  current: DateRange;
  /** The same stretch of the period before. */
  previous: DateRange;
  /** "vs yesterday", "vs this point last month"… */
  label: string;
}

/**
 * What a period is fairly compared with. A period still in progress is
 * compared up to today against the same number of days before, so half a
 * month is never measured against a whole one.
 */
export function comparisonFor(period: ReportPeriod, range: DateRange, anchor: ISODate = today()): PeriodComparison | null {
  const soFar = (r: DateRange): DateRange => ({ from: r.from, to: r.to > anchor ? anchor : r.to });
  switch (period) {
    case 'today':
      return { current: range, previous: { from: addDays(anchor, -1), to: addDays(anchor, -1) }, label: 'vs yesterday' };
    case 'week': {
      const current = soFar(range);
      return { current, previous: { from: addDays(current.from, -7), to: addDays(current.to, -7) }, label: 'vs this point last week' };
    }
    case 'month': {
      const current = soFar(range);
      const before = monthRange(range.from, -1);
      const sameDay = addDays(before.from, diffDays(current.from, current.to));
      return { current, previous: { from: before.from, to: sameDay < before.to ? sameDay : before.to }, label: 'vs this point last month' };
    }
    case 'last-month':
      return { current: range, previous: monthRange(range.from, -1), label: 'vs the month before' };
    case 'custom': {
      // A range that lies entirely in the future has nothing to compare yet.
      if (range.from > anchor) return null;
      const current = soFar(range);
      const days = diffDays(current.from, current.to) + 1;
      return {
        current,
        previous: { from: addDays(current.from, -days), to: addDays(current.from, -1) },
        label: `vs the ${days === 1 ? 'day' : `${days} days`} before`,
      };
    }
  }
}

export type FlowUnit = 'day' | 'week' | 'month';

export interface FlowBucket {
  from: ISODate;
  to: ISODate;
  income: number;
  spent: number;
}

export interface FlowSeries {
  unit: FlowUnit;
  buckets: FlowBucket[];
  /** True when a short period was widened so the chart has something to compare. */
  widened: boolean;
}

/**
 * Income and spending split into days (up to two weeks), weeks (up to three
 * months) or months, whichever keeps the
 * chart readable. A period shorter than a week is shown as the seven days
 * ending with it.
 */
export function flowSeries(transactions: Transaction[], range: DateRange): FlowSeries {
  let span = diffDays(range.from, range.to) + 1;
  let from = range.from;
  let widened = false;
  if (span < 7) {
    from = addDays(range.to, -6);
    span = 7;
    widened = true;
  }
  const buckets: FlowBucket[] = [];
  const push = (r: DateRange) => {
    const s = summarize(transactions, r);
    buckets.push({ from: r.from, to: r.to, income: s.income, spent: s.spent });
  };
  let unit: FlowUnit;
  if (span <= 14) {
    unit = 'day';
    for (let d = from; d <= range.to; d = addDays(d, 1)) push({ from: d, to: d });
  } else if (span <= 92) {
    unit = 'week';
    for (let d = from; d <= range.to; d = addDays(d, 7)) {
      const end = addDays(d, 6);
      push({ from: d, to: end > range.to ? range.to : end });
    }
  } else {
    unit = 'month';
    for (let m = monthRange(from); m.from <= range.to; m = monthRange(m.from, 1)) {
      push({ from: m.from < from ? from : m.from, to: m.to > range.to ? range.to : m.to });
    }
  }
  return { unit, buckets, widened };
}

export interface BudgetToday {
  status: BudgetStatus;
  /** What is left to spend each remaining day, today included. Null once nothing is left. */
  perDay: number | null;
}

/**
 * The budget that best answers "how much can I still spend": an overall
 * budget running today, preferring the monthly one. Null when there is none.
 */
export function overallBudget(budgets: Budget[], transactions: Transaction[], anchor: ISODate = today()): BudgetToday | null {
  const rank: Record<Budget['frequency'], number> = { monthly: 0, weekly: 1, custom: 2, yearly: 3 };
  const running = budgets
    .filter((b) => !b.categoryId)
    .map((b) => budgetStatus(b, transactions, anchor))
    .filter((s) => s.period !== null)
    .sort((a, b) => rank[a.budget.frequency] - rank[b.budget.frequency]);
  const status = running[0];
  if (!status) return null;
  const days = status.daysLeft + 1;
  return { status, perDay: status.remaining > 0 ? Math.floor(status.remaining / days) : null };
}

/** Builds the Transactions link that shows exactly the records behind a figure. */
export function transactionsLink(range: DateRange, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  const month = monthRange(range.from);
  if (month.from === range.from && month.to === range.to) params.set('month', range.from.slice(0, 7));
  else {
    params.set('period', 'custom');
    params.set('from', range.from);
    params.set('to', range.to);
  }
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return `/transactions?${params.toString()}`;
}
