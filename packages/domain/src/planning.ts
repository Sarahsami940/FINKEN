/**
 * Planning: budgets, savings goals and recurring commitments.
 *
 * Like the rest of the Money Engine these are pure calculations over the
 * records of one Space. Budgets read actual transactions; goals are money
 * set aside, kept apart from spending; recurring items are expectations
 * that only become transactions when the user confirms them.
 */
import { addDays, addMonths, diffDays, inRange, monthRange, parseISODate, today, toISODate, weekRange } from './dates';
import { formatMoney, MINOR_UNITS } from './format';
import type { Budget, DateRange, Goal, GoalEntry, ID, ISODate, Recurring, Transaction } from './types';

// ── Budgets ────────────────────────────────────────────────────────────────

function periodAt(budget: Budget, anchor: ISODate, offset = 0): DateRange {
  switch (budget.frequency) {
    case 'weekly':
      return weekRange(addDays(anchor, offset * 7));
    case 'monthly':
      return monthRange(anchor, offset);
    case 'yearly': {
      const year = parseISODate(anchor).getFullYear() + offset;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case 'custom':
      return { from: budget.startDate, to: budget.endDate ?? budget.startDate };
  }
}

/**
 * The budget period that contains `anchor`, or null when the budget has not
 * started yet or has finished. A repeating budget is clipped to its own
 * start and end dates.
 */
export function budgetPeriod(budget: Budget, anchor: ISODate = today()): DateRange | null {
  if (anchor < budget.startDate || (budget.endDate && anchor > budget.endDate)) return null;
  const period = periodAt(budget, anchor);
  return {
    from: period.from < budget.startDate ? budget.startDate : period.from,
    to: budget.endDate && period.to > budget.endDate ? budget.endDate : period.to,
  };
}

/** Spending that counts against a budget: expenses less refunds, in its category and dates. */
export function budgetSpent(budget: Budget, transactions: Transaction[], range: DateRange): number {
  let total = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' && t.type !== 'refund') continue;
    if (!inRange(t.date, range)) continue;
    if (budget.categoryId && t.categoryId !== budget.categoryId) continue;
    if (budget.subcategoryId && t.subcategoryId !== budget.subcategoryId) continue;
    total += t.type === 'expense' ? t.amount : -t.amount;
  }
  return total;
}

export type BudgetAlert = 'exceeded' | 'likely' | 'approaching' | 'below';

export interface BudgetStatus {
  budget: Budget;
  /** Null when the budget is not running today. */
  period: DateRange | null;
  spent: number;
  /** Negative once the budget is exceeded. */
  remaining: number;
  /** spent / amount. Can go above 1. */
  used: number;
  /** How far through the period today is, 0–1. */
  elapsed: number;
  /** What an even pace would have spent by today. */
  expectedByNow: number;
  /** Where spending is heading by the end of the period. */
  projected: number;
  /** True when the projection is based on how earlier periods went, not a straight line. */
  fromHistory: boolean;
  daysLeft: number;
  alert: BudgetAlert | null;
}

/** Earlier periods to learn the usual shape of spending from. */
const HISTORY_PERIODS = 3;

export function budgetStatus(budget: Budget, transactions: Transaction[], anchor: ISODate = today()): BudgetStatus {
  const period = budgetPeriod(budget, anchor);
  if (!period) {
    return { budget, period, spent: 0, remaining: budget.amount, used: 0, elapsed: 0, expectedByNow: 0, projected: 0, fromHistory: false, daysLeft: 0, alert: null };
  }
  const totalDays = diffDays(period.from, period.to) + 1;
  const elapsedDays = diffDays(period.from, anchor) + 1;
  const elapsed = Math.min(1, elapsedDays / totalDays);
  const spent = budgetSpent(budget, transactions, period);

  // Money rarely leaves evenly: rent goes on one day, groceries every week.
  // So when earlier periods exist, the rest of this one is assumed to cost
  // what the same stretch cost before. Only a brand-new budget falls back to
  // a straight line.
  let projected = elapsedDays > 0 ? (spent / elapsedDays) * totalDays : spent;
  let fromHistory = false;
  if (budget.frequency !== 'custom') {
    const tails: number[] = [];
    for (let i = 1; i <= HISTORY_PERIODS; i++) {
      const earlier = periodAt(budget, anchor, -i);
      if (budgetSpent(budget, transactions, earlier) <= 0) continue;
      const tailFrom = addDays(earlier.from, elapsedDays);
      tails.push(tailFrom > earlier.to ? 0 : budgetSpent(budget, transactions, { from: tailFrom, to: earlier.to }));
    }
    if (tails.length > 0) {
      projected = spent + tails.reduce((a, b) => a + b, 0) / tails.length;
      fromHistory = true;
    }
  }
  projected = Math.max(projected, spent);

  const expectedByNow = budget.amount * elapsed;
  const used = budget.amount > 0 ? spent / budget.amount : 0;
  let alert: BudgetAlert | null = null;
  if (spent > budget.amount) alert = 'exceeded';
  // A straight-line guess is too jumpy in the first few days to act on.
  else if (projected > budget.amount * 1.02 && (fromHistory || elapsed >= 0.2)) alert = 'likely';
  else if (used >= 0.85) alert = 'approaching';
  else if (elapsed >= 0.25 && spent < expectedByNow * 0.8 && projected <= budget.amount) alert = 'below';

  return { budget, period, spent, remaining: budget.amount - spent, used, elapsed, expectedByNow, projected, fromHistory, daysLeft: totalDays - elapsedDays, alert };
}

const PERIOD_WORDS: Record<Budget['frequency'], string> = { weekly: 'this week', monthly: 'this month', yearly: 'this year', custom: 'by the end of this budget' };

/** One plain sentence about where a budget stands, or null when there is nothing to say. */
export function budgetMessage(status: BudgetStatus, currency: string): string | null {
  const { budget, alert, spent, projected, expectedByNow } = status;
  const money = (n: number) => formatMoney(n, currency);
  switch (alert) {
    case 'exceeded':
      return `You are ${money(spent - budget.amount)} over your ${budget.name} budget.`;
    case 'likely':
      return `You're likely to exceed your ${budget.name} budget by ${money(projected - budget.amount)} ${PERIOD_WORDS[budget.frequency]}.`;
    case 'approaching':
      return `You have used ${Math.round(status.used * 100)}% of your ${budget.name} budget, with ${status.daysLeft} ${status.daysLeft === 1 ? 'day' : 'days'} to go.`;
    case 'below':
      return `You are ${money(expectedByNow - spent)} under the usual pace for your ${budget.name} budget.`;
    default:
      return null;
  }
}

// ── Goals ──────────────────────────────────────────────────────────────────

export interface GoalStatus {
  goal: Goal;
  saved: number;
  remaining: number;
  /** 0–1. */
  progress: number;
  reached: boolean;
  /** What to set aside each month to arrive on time; null without a target date or once reached. */
  monthlyNeeded: number | null;
  monthsLeft: number | null;
  /** The target date has passed and the goal is not reached. */
  late: boolean;
}

export function goalSaved(goalId: string, entries: GoalEntry[]): number {
  return entries.reduce((sum, e) => (e.goalId === goalId ? sum + e.amount : sum), 0);
}

export function goalStatus(goal: Goal, entries: GoalEntry[], anchor: ISODate = today()): GoalStatus {
  const saved = goalSaved(goal.id, entries);
  const remaining = Math.max(0, goal.targetAmount - saved);
  const reached = remaining === 0;
  let monthsLeft: number | null = null;
  let monthlyNeeded: number | null = null;
  const late = !reached && Boolean(goal.targetDate) && goal.targetDate! < anchor;
  if (goal.targetDate && !reached && !late) {
    // Part of a month still needs a full month's saving, so round up, and never divide by zero.
    monthsLeft = Math.max(1, Math.ceil(diffDays(anchor, goal.targetDate) / 30.4375));
    monthlyNeeded = Math.ceil(remaining / monthsLeft / MINOR_UNITS) * MINOR_UNITS;
  }
  return { goal, saved, remaining, progress: goal.targetAmount > 0 ? Math.min(1, saved / goal.targetAmount) : 0, reached, monthlyNeeded, monthsLeft, late };
}

// ── Recurring ──────────────────────────────────────────────────────────────

const STEP_MONTHS: Partial<Record<Recurring['frequency'], number>> = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * The occurrence after `after`, counted from the start date so a payment on
 * the 31st stays on the last day of each month instead of drifting earlier.
 */
export function nextRecurringDate(r: Pick<Recurring, 'frequency' | 'startDate' | 'intervalDays'>, after: ISODate): ISODate {
  const months = STEP_MONTHS[r.frequency];
  if (months) {
    const start = parseISODate(r.startDate);
    const from = parseISODate(after);
    // Jump close to the answer, then step forward to the first date after `after`.
    let k = Math.max(0, Math.floor(((from.getFullYear() - start.getFullYear()) * 12 + from.getMonth() - start.getMonth()) / months) - 1);
    let next = addMonths(r.startDate, k * months);
    while (next <= after) next = addMonths(r.startDate, ++k * months);
    return next;
  }
  const days = r.frequency === 'daily' ? 1 : r.frequency === 'weekly' ? 7 : Math.max(1, Math.round(r.intervalDays ?? 1));
  const gap = diffDays(r.startDate, after);
  const steps = gap < 0 ? 0 : Math.floor(gap / days) + 1;
  return addDays(r.startDate, steps * days);
}

/** "Every month", "Every 10 days". */
export function frequencyLabel(r: Pick<Recurring, 'frequency' | 'intervalDays'>): string {
  switch (r.frequency) {
    case 'daily':
      return 'Every day';
    case 'weekly':
      return 'Every week';
    case 'monthly':
      return 'Every month';
    case 'quarterly':
      return 'Every 3 months';
    case 'yearly':
      return 'Every year';
    case 'custom':
      return `Every ${Math.max(1, r.intervalDays ?? 1)} days`;
  }
}

/** Roughly what a recurring item costs or brings in per month, to compare items on different schedules. */
export function monthlyEquivalent(r: Pick<Recurring, 'amount' | 'frequency' | 'intervalDays'>): number {
  const perYear = { daily: 365.25, weekly: 52.18, monthly: 12, quarterly: 4, yearly: 1, custom: 365.25 / Math.max(1, r.intervalDays ?? 1) }[r.frequency];
  return (r.amount * perYear) / 12;
}

export interface RecurringAttention {
  recurring: Recurring;
  overdue: boolean;
  /** Days until it is due; negative when overdue. */
  inDays: number;
}

/** Active items that are overdue, due today, or inside their reminder window. */
export function needsAttention(recurring: Recurring[], anchor: ISODate = today()): RecurringAttention[] {
  return recurring
    .filter((r) => r.status === 'active' && !(r.snoozedUntil && r.snoozedUntil > anchor))
    .map((r) => ({ recurring: r, inDays: diffDays(anchor, r.nextDueDate), overdue: r.nextDueDate < anchor }))
    .filter((item) => item.inDays <= (item.recurring.reminderDays ?? 0))
    .sort((a, b) => a.inDays - b.inDays);
}

/** Today's date clamped into a range, as a convenience for defaults. */
export function clampDate(iso: ISODate, range: DateRange): ISODate {
  return iso < range.from ? range.from : iso > range.to ? range.to : iso;
}

export { toISODate };

// ── Budget history ─────────────────────────────────────────────────────────

export interface BudgetPeriodResult {
  range: DateRange;
  spent: number;
  /** spent / amount. */
  used: number;
  /** True for the period running today, which is not finished yet. */
  current: boolean;
}

/**
 * How a repeating budget went in its recent periods, oldest first, ending
 * with the period running at `anchor`. Periods before the budget started
 * are left out, so a new budget has a short history rather than an invented one.
 */
export function budgetHistory(budget: Budget, transactions: Transaction[], anchor: ISODate = today(), count = 6): BudgetPeriodResult[] {
  if (budget.frequency === 'custom') {
    const range = budgetPeriod(budget, anchor) ?? { from: budget.startDate, to: budget.endDate ?? budget.startDate };
    const spent = budgetSpent(budget, transactions, range);
    return [{ range, spent, used: budget.amount > 0 ? spent / budget.amount : 0, current: inRange(anchor, range) }];
  }
  const out: BudgetPeriodResult[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const period = periodAt(budget, anchor, -i);
    if (period.to < budget.startDate || (budget.endDate && period.from > budget.endDate)) continue;
    const range = { from: period.from < budget.startDate ? budget.startDate : period.from, to: budget.endDate && period.to > budget.endDate ? budget.endDate : period.to };
    const spent = budgetSpent(budget, transactions, range);
    out.push({ range, spent, used: budget.amount > 0 ? spent / budget.amount : 0, current: i === 0 });
  }
  return out;
}

/**
 * The id of the transaction that pays one occurrence of a recurring item.
 * Marking the same occurrence paid twice gives the same id, so it is only
 * ever recorded once.
 */
export function occurrenceId(recurringId: ID, dueDate: ISODate): ID {
  return `${recurringId}@${dueDate}`;
}
