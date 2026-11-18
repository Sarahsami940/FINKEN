/**
 * Behavioural analytics: how money moves over a chosen date range.
 * Pure calculations over records; nothing is stored or estimated here.
 */
import { addDays, addMonths, customRange, diffDays, inRange, monthRange, parseISODate, today } from './dates';
import { inPeriod, spendingByCategory, summarize, type CategorySpend } from './money';
import { budgetHistory, monthlyEquivalent, type BudgetPeriodResult } from './planning';
import type { Budget, Category, DateRange, ISODate, Recurring, Transaction } from './types';

export type AnalyticsRange = '3m' | '6m' | '12m' | 'ytd' | 'custom';

export const ANALYTICS_RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '3m', label: '3 months' },
  { value: '6m', label: '6 months' },
  { value: '12m', label: '12 months' },
  { value: 'ytd', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

/** Whole calendar months ending with the current one, or the dates given. */
export function analyticsRange(range: AnalyticsRange, anchor: ISODate = today(), custom: { from?: string; to?: string } = {}): DateRange {
  const months = range === '3m' ? 3 : range === '12m' ? 12 : 6;
  switch (range) {
    case 'ytd':
      return { from: `${anchor.slice(0, 4)}-01-01`, to: anchor };
    case 'custom':
      return customRange(custom, { from: monthRange(anchor, -5).from, to: anchor });
    default:
      return { from: monthRange(anchor, -(months - 1)).from, to: anchor };
  }
}

export interface MonthTotals {
  /** First day of the month, or the range start for a partial first month. */
  from: ISODate;
  to: ISODate;
  income: number;
  spent: number;
  net: number;
}

/** One entry per calendar month the range touches, clipped to the range. */
export function monthsIn(transactions: Transaction[], range: DateRange): MonthTotals[] {
  const out: MonthTotals[] = [];
  for (let m = monthRange(range.from); m.from <= range.to; m = monthRange(m.from, 1)) {
    const r = { from: m.from < range.from ? range.from : m.from, to: m.to > range.to ? range.to : m.to };
    const s = summarize(transactions, r);
    out.push({ from: r.from, to: r.to, income: s.income, spent: s.spent, net: s.net });
  }
  return out;
}

export interface CategoryTrend {
  category: CategorySpend;
  /** Spending in each month of the range, oldest first. */
  months: number[];
  /** Change from the average of the earlier months to the latest complete one; null without a baseline. */
  change: number | null;
}

/** Monthly spending for the largest categories in the range. */
export function categoryTrends(transactions: Transaction[], categories: Category[], range: DateRange, limit = 5, anchor: ISODate = today()): CategoryTrend[] {
  const list = inPeriod(transactions, range);
  const top = spendingByCategory(list, categories)
    .filter((c) => c.amount > 0)
    .slice(0, limit);
  const months: DateRange[] = [];
  for (let m = monthRange(range.from); m.from <= range.to; m = monthRange(m.from, 1)) {
    months.push({ from: m.from < range.from ? range.from : m.from, to: m.to > range.to ? range.to : m.to });
  }
  return top.map((category) => {
    const values = months.map((r) => {
      const own = inPeriod(list, r).filter((t) => (category.categoryId ? t.categoryId === category.categoryId : !categories.some((c) => c.id === t.categoryId)));
      return spendingByCategory(own, categories).reduce((s, c) => s + c.amount, 0);
    });
    // Compare the latest finished month with the ones before it; a month in progress is not finished.
    const finished = months.map((r, i) => ({ r, v: values[i] })).filter(({ r }) => r.to < anchor && r.to === monthRange(r.from).to);
    let change: number | null = null;
    if (finished.length >= 3) {
      const latest = finished[finished.length - 1].v;
      const earlier = finished.slice(0, -1).map((f) => f.v);
      const avg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
      change = avg > 0 ? (latest - avg) / avg : null;
    }
    return { category, months: values, change };
  });
}

export interface WeekdaySpend {
  /** 0 = Monday … 6 = Sunday. */
  day: number;
  total: number;
  /** Average over every such weekday in the range, including ones with no spending. */
  average: number;
}

const DAY_MS_INDEX = (iso: ISODate) => (parseISODate(iso).getDay() + 6) % 7;

/** Spending by day of the week, Monday first. */
export function weekdaySpending(transactions: Transaction[], range: DateRange): WeekdaySpend[] {
  const totals = new Array<number>(7).fill(0);
  const occurrences = new Array<number>(7).fill(0);
  const end = range.to;
  for (let d = range.from, i = 0; d <= end && i < 4000; d = addDays(d, 1), i++) occurrences[DAY_MS_INDEX(d)]++;
  for (const t of transactions) {
    if (!inRange(t.date, range)) continue;
    if (t.type === 'expense') totals[DAY_MS_INDEX(t.date)] += t.amount;
    else if (t.type === 'refund') totals[DAY_MS_INDEX(t.date)] -= t.amount;
  }
  return totals.map((total, day) => ({ day, total, average: occurrences[day] > 0 ? total / occurrences[day] : 0 }));
}

export interface DailyStats {
  days: number;
  /** Average spending per calendar day. */
  perDay: number;
  /** Days with no spending recorded. */
  noSpendDays: number;
  /** The single heaviest day. */
  peak: { date: ISODate; amount: number } | null;
  /** Spending per week, oldest first, for the last weeks of the range. */
  weeks: { from: ISODate; to: ISODate; spent: number }[];
}

export function dailyStats(transactions: Transaction[], range: DateRange, weeks = 12): DailyStats {
  const byDay = new Map<ISODate, number>();
  for (const t of transactions) {
    if (!inRange(t.date, range)) continue;
    if (t.type === 'expense') byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.amount);
    else if (t.type === 'refund') byDay.set(t.date, (byDay.get(t.date) ?? 0) - t.amount);
  }
  const days = diffDays(range.from, range.to) + 1;
  const total = [...byDay.values()].reduce((a, b) => a + b, 0);
  let peak: DailyStats['peak'] = null;
  for (const [date, amount] of byDay) if (!peak || amount > peak.amount) peak = { date, amount };
  const spendDays = [...byDay.values()].filter((v) => v > 0).length;
  const out: DailyStats['weeks'] = [];
  // Whole weeks ending on the range's last day.
  for (let i = weeks - 1; i >= 0; i--) {
    const to = addDays(range.to, -7 * i);
    const from = addDays(to, -6);
    if (to < range.from) continue;
    const r = { from: from < range.from ? range.from : from, to };
    let spent = 0;
    for (const [date, amount] of byDay) if (inRange(date, r)) spent += amount;
    out.push({ ...r, spent });
  }
  return { days, perDay: days > 0 ? total / days : 0, noSpendDays: days - spendDays, peak, weeks: out };
}

export interface BudgetAdherence {
  budget: Budget;
  periods: BudgetPeriodResult[];
  /** Finished periods that stayed within the limit. */
  kept: number;
  finished: number;
}

/** How each budget went over its recent periods. */
export function budgetAdherence(budgets: Budget[], transactions: Transaction[], anchor: ISODate = today(), count = 6): BudgetAdherence[] {
  return budgets
    .filter((b) => b.startDate <= anchor)
    .map((budget) => {
      const periods = budgetHistory(budget, transactions, anchor, count);
      const done = periods.filter((p) => !p.current);
      return { budget, periods, kept: done.filter((p) => p.spent <= budget.amount).length, finished: done.length };
    });
}

export interface RecurringBreakdown {
  items: { recurring: Recurring; monthly: number }[];
  /** All active regular payments, as a monthly amount. */
  monthlyTotal: number;
  /** Regular income, as a monthly amount. */
  monthlyIncome: number;
}

/** Active regular payments, converted to what they cost in an average month. */
export function recurringBreakdown(recurring: Recurring[]): RecurringBreakdown {
  const active = recurring.filter((r) => r.status === 'active');
  const items = active
    .filter((r) => r.type === 'expense')
    .map((r) => ({ recurring: r, monthly: monthlyEquivalent(r) }))
    .sort((a, b) => b.monthly - a.monthly);
  return {
    items,
    monthlyTotal: items.reduce((s, i) => s + i.monthly, 0),
    monthlyIncome: active.filter((r) => r.type === 'income').reduce((s, r) => s + monthlyEquivalent(r), 0),
  };
}

/** The complete calendar months before the one containing `anchor`, oldest first. */
export function completeMonths(anchor: ISODate, count: number): DateRange[] {
  const out: DateRange[] = [];
  for (let i = count; i >= 1; i--) out.push(monthRange(addMonths(monthRange(anchor).from, -i)));
  return out;
}
