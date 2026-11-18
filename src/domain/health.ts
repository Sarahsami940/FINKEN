/**
 * Safe to Spend and Money Health.
 *
 * Both are estimates built only from recorded information. Neither is a bank
 * balance, a credit score or a judgement: they explain themselves line by
 * line so the user can see exactly where every figure comes from.
 */
import { completeMonths, budgetAdherence } from './analytics';
import { addDays, diffDays, inRange, monthRange, today } from './dates';
import { owedSummary, owedToYouKind, summarize, totalBalance } from './money';
import { budgetPeriod, budgetSpent, budgetStatus, goalStatus } from './planning';
import type { Account, Budget, Goal, GoalEntry, ISODate, Obligation, Recurring, Transaction } from './types';
import { expectedEvents, type ExpectedEvent } from './upcoming';

export interface PlanningInput {
  accounts: Account[];
  transactions: Transaction[];
  recurring: Recurring[];
  obligations: Obligation[];
  budgets: Budget[];
  goals: Goal[];
  goalEntries: GoalEntry[];
}

// ── Safe to Spend ──────────────────────────────────────────────────────────

export interface SafeToSpendOptions {
  /** Keep back what category budgets still plan to spend. */
  reserveBudgets: boolean;
  /** Keep back what goals still need this month. */
  reserveSavings: boolean;
  /** Treat money already set aside for goals as not spendable. */
  protectGoals: boolean;
}

export const DEFAULT_SAFE_OPTIONS: SafeToSpendOptions = { reserveBudgets: true, reserveSavings: true, protectGoals: true };

export type SafeLineKey = 'available' | 'goals' | 'bills' | 'owed' | 'budgets' | 'savings';

export interface SafeLine {
  key: SafeLineKey;
  label: string;
  /** Always positive; `available` adds, everything else is taken away. */
  amount: number;
  explanation: string;
  /** Lines that depend on a choice can be switched off. */
  optional?: keyof SafeToSpendOptions;
  included: boolean;
}

export interface SafeToSpend {
  /** The estimate covers today to this date: the end of the month. */
  until: ISODate;
  /** Days left, today included. */
  days: number;
  lines: SafeLine[];
  amount: number;
  /** Spread evenly over the days left; 0 when nothing is safe to spend. */
  perDay: number;
  /** Expected to arrive before `until`. Shown, never counted. */
  expectedIn: number;
  events: ExpectedEvent[];
}

const SPENDING_BUDGET = (b: Budget) => b.frequency === 'monthly' || b.frequency === 'weekly';

/**
 * What can realistically be spent between today and the end of the month,
 * once what is already committed is kept back. Expected income is never
 * counted, because it has not arrived.
 */
export function safeToSpend(input: PlanningInput, options: SafeToSpendOptions = DEFAULT_SAFE_OPTIONS, anchor: ISODate = today()): SafeToSpend {
  const until = monthRange(anchor).to;
  const days = diffDays(anchor, until) + 1;
  const accounts = input.accounts.filter((a) => !a.archived);
  const available = totalBalance(accounts, input.transactions);
  const events = expectedEvents({ recurring: input.recurring, obligations: input.obligations, transactions: input.transactions }, { from: anchor, to: until }, anchor);
  const out = events.filter((e) => e.direction === 'out');
  const bills = out.filter((e) => e.kind === 'bill');
  const billsTotal = bills.reduce((s, e) => s + e.amount, 0);
  const owedTotal = out.filter((e) => e.kind !== 'bill').reduce((s, e) => s + e.amount, 0);
  const expectedIn = events.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0);

  // Budgets: what they still plan to spend, less the bills already counted
  // above, so a rent payment inside a Housing budget is never kept back twice.
  const billsIn = (range: { from: ISODate; to: ISODate }, categoryId?: string) =>
    bills.filter((e) => inRange(e.date, range) && (!categoryId || e.categoryId === categoryId)).reduce((s, e) => s + e.amount, 0);
  let budgetReserve = 0;
  const running = input.budgets.filter((b) => SPENDING_BUDGET(b) && budgetPeriod(b, anchor));
  const overall = running.find((b) => !b.categoryId);
  if (overall) {
    const period = budgetPeriod(overall, anchor)!;
    const left = overall.amount - budgetSpent(overall, input.transactions, period);
    budgetReserve = Math.max(0, left - billsIn({ from: anchor, to: period.to }));
  } else {
    const withCategory = new Set(running.filter((b) => b.categoryId && !b.subcategoryId).map((b) => b.categoryId));
    for (const b of running) {
      // A subcategory budget sits inside its category's budget when there is one.
      if (!b.categoryId || (b.subcategoryId && withCategory.has(b.categoryId))) continue;
      const period = budgetPeriod(b, anchor)!;
      const left = b.amount - budgetSpent(b, input.transactions, period);
      budgetReserve += Math.max(0, left - (b.subcategoryId ? 0 : billsIn({ from: anchor, to: period.to }, b.categoryId)));
    }
  }

  // Savings: what each dated goal still needs this month.
  const month = monthRange(anchor);
  let savings = 0;
  let setAside = 0;
  for (const g of input.goals) {
    const s = goalStatus(g, input.goalEntries, anchor);
    setAside += Math.max(0, Math.min(s.saved, g.targetAmount));
    if (!s.monthlyNeeded) continue;
    const thisMonth = input.goalEntries.filter((e) => e.goalId === g.id && inRange(e.date, month)).reduce((sum, e) => sum + e.amount, 0);
    savings += Math.max(0, Math.min(s.monthlyNeeded - thisMonth, s.remaining));
  }

  const lines: SafeLine[] = [
    {
      key: 'available',
      label: 'Available money',
      amount: available,
      explanation: `What your ${accounts.length} ${accounts.length === 1 ? 'account holds' : 'accounts hold'} according to your records.`,
      included: true,
    },
    {
      key: 'goals',
      label: 'Already set aside for goals',
      amount: setAside,
      explanation: 'Money you have put towards savings goals. It is still in your accounts, but it is spoken for.',
      optional: 'protectGoals',
      included: options.protectGoals,
    },
    {
      key: 'bills',
      label: 'Bills and regular payments',
      amount: billsTotal,
      explanation:
        bills.length === 0
          ? 'Nothing from your recurring bills falls due before the end of the month.'
          : `${bills.length} ${bills.length === 1 ? 'payment' : 'payments'} due by the end of the month, including anything overdue.`,
      included: true,
    },
    {
      key: 'owed',
      label: 'Repayments and money you owe',
      amount: owedTotal,
      explanation: 'Loan instalments and amounts owed to others that fall due by the end of the month.',
      included: true,
    },
    {
      key: 'budgets',
      label: 'Still planned in budgets',
      amount: budgetReserve,
      explanation: overall
        ? `What is left in your ${overall.name} budget, less the bills already counted above.`
        : 'What your category budgets still allow this period, less the bills already counted above.',
      optional: 'reserveBudgets',
      included: options.reserveBudgets,
    },
    {
      key: 'savings',
      label: 'Planned savings this month',
      amount: savings,
      explanation: 'What your goals with a target date still need this month to stay on schedule.',
      optional: 'reserveSavings',
      included: options.reserveSavings,
    },
  ];
  const amount = lines.reduce((sum, l) => (!l.included ? sum : l.key === 'available' ? sum + l.amount : sum - l.amount), 0);
  return { until, days, lines, amount, perDay: amount > 0 ? Math.floor(amount / days) : 0, expectedIn, events };
}

// ── Money Health ───────────────────────────────────────────────────────────

export type HealthFactorKey = 'budgets' | 'kept' | 'goals' | 'commitments' | 'steadiness' | 'owed';
export type HealthLevel = 'steady' | 'mixed' | 'attention';

export interface HealthFactor {
  key: HealthFactorKey;
  label: string;
  /** 0–1, or null when there is not enough recorded to say. */
  score: number | null;
  /** One plain sentence about what the records show. */
  note: string;
  /** Where to look or act. */
  to: string;
}

export interface MoneyHealth {
  level: HealthLevel | null;
  /** Average of the factors that could be measured, 0–1. */
  score: number | null;
  factors: HealthFactor[];
}

export const HEALTH_LABEL: Record<HealthLevel, string> = { steady: 'Steady', mixed: 'Mixed', attention: 'Needs attention' };

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Factors that can be worked out again for an earlier date from the records alone. */
const HISTORICAL: HealthFactorKey[] = ['budgets', 'kept', 'goals', 'steadiness', 'owed'];

export function moneyHealth(input: PlanningInput, anchor: ISODate = today(), only?: HealthFactorKey[]): MoneyHealth {
  const factors: HealthFactor[] = [];
  const want = (k: HealthFactorKey) => !only || only.includes(k);

  // 1. Budget consistency: finished periods kept within the limit, and nothing over right now.
  if (want('budgets')) {
    const adherence = budgetAdherence(input.budgets, input.transactions, anchor, 4);
    const finished = adherence.reduce((s, a) => s + a.finished, 0);
    const kept = adherence.reduce((s, a) => s + a.kept, 0);
    const now = input.budgets.map((b) => budgetStatus(b, input.transactions, anchor)).filter((s) => s.period);
    const over = now.filter((s) => s.alert === 'exceeded').length;
    let score: number | null = null;
    let note = 'No budgets to measure yet.';
    if (finished > 0 || now.length > 0) {
      const keptRatio = finished > 0 ? kept / finished : 1;
      const nowRatio = now.length > 0 ? 1 - over / now.length : 1;
      score = clamp(0.6 * keptRatio + 0.4 * nowRatio);
      note =
        finished > 0
          ? `${kept} of ${finished} recent budget periods stayed within the limit${over > 0 ? `, and ${over} ${over === 1 ? 'budget is' : 'budgets are'} over right now` : ''}.`
          : over > 0
            ? `${over} of ${now.length} budgets ${over === 1 ? 'is' : 'are'} over this period.`
            : 'Every budget is within its limit so far.';
    }
    factors.push({ key: 'budgets', label: 'Budget consistency', score, note, to: '/money/budgets' });
  }

  // 2. Money kept: share of income left after spending over the last three full months.
  if (want('kept')) {
    const months = completeMonths(anchor, 3).map((r) => summarize(input.transactions, r));
    const withIncome = months.filter((m) => m.income > 0);
    let score: number | null = null;
    let note = 'Not enough income recorded over the last three months to say.';
    if (withIncome.length >= 2) {
      const income = withIncome.reduce((s, m) => s + m.income, 0);
      const net = withIncome.reduce((s, m) => s + m.net, 0);
      const rate = net / income;
      // Keeping a fifth of income scores fully; spending more than comes in scores low.
      score = clamp((rate + 0.1) / 0.3);
      note = rate >= 0 ? `You kept ${pct(rate)} of your income over the last three full months.` : `Spending was ${pct(-rate)} more than income over the last three full months.`;
    }
    factors.push({ key: 'kept', label: 'Money kept', score, note, to: '/insights?tab=analytics' });
  }

  // 3. Savings progress: goals on schedule, judged by what was set aside lately.
  if (want('goals')) {
    const since = addDays(anchor, -90);
    const statuses = input.goals.map((g) => goalStatus(g, input.goalEntries, anchor));
    let score: number | null = null;
    let note = 'No savings goals yet.';
    if (statuses.length > 0) {
      let onTrack = 0;
      for (const s of statuses) {
        const recent = input.goalEntries.filter((e) => e.goalId === s.goal.id && e.date > since && e.date <= anchor).reduce((sum, e) => sum + e.amount, 0);
        if (s.reached) onTrack++;
        else if (s.late) continue;
        else if (s.monthlyNeeded) {
          if (recent / 3 >= s.monthlyNeeded * 0.9) onTrack++;
        } else if (recent > 0) onTrack++;
      }
      score = onTrack / statuses.length;
      note = `On schedule: ${onTrack} of ${statuses.length} ${statuses.length === 1 ? 'goal' : 'goals'}, judged by what was set aside in the last three months.`;
    }
    factors.push({ key: 'goals', label: 'Savings progress', score, note, to: '/money/goals' });
  }

  // 4. Upcoming obligations: what is due in 30 days against what is available.
  if (want('commitments')) {
    const available = totalBalance(
      input.accounts.filter((a) => !a.archived),
      input.transactions,
    );
    const due = expectedEvents({ recurring: input.recurring, obligations: input.obligations, transactions: input.transactions }, { from: anchor, to: addDays(anchor, 30) }, anchor)
      .filter((e) => e.direction === 'out')
      .reduce((s, e) => s + e.amount, 0);
    let score: number;
    let note: string;
    if (due === 0) {
      score = 1;
      note = 'Nothing is due in the next 30 days.';
    } else if (available <= 0) {
      score = 0;
      note = 'Payments are due in the next 30 days and your recorded balance does not cover them.';
    } else {
      const ratio = due / available;
      // Up to 30% of available money is comfortable; all of it or more is tight.
      score = clamp(1 - (ratio - 0.3) / 0.7);
      note = `What is due in the next 30 days comes to ${pct(ratio)} of the money you have available.`;
    }
    factors.push({ key: 'commitments', label: 'Upcoming obligations', score, note, to: '/money/upcoming' });
  }

  // 5. Spending steadiness: how much monthly spending moves around.
  if (want('steadiness')) {
    const spent = completeMonths(anchor, 6)
      .map((r) => summarize(input.transactions, r).spent)
      .filter((v) => v > 0);
    let score: number | null = null;
    let note = 'Needs at least three full months of spending to judge.';
    if (spent.length >= 3) {
      const mean = spent.reduce((a, b) => a + b, 0) / spent.length;
      const sd = Math.sqrt(spent.reduce((s, v) => s + (v - mean) ** 2, 0) / spent.length);
      const cv = mean > 0 ? sd / mean : 0;
      score = clamp(1 - (cv - 0.15) / 0.45);
      note = cv <= 0.15 ? 'Monthly spending has been steady.' : `Monthly spending has typically moved by about ${pct(cv)} from month to month.`;
    }
    factors.push({ key: 'steadiness', label: 'Spending steadiness', score, note, to: '/insights?tab=analytics' });
  }

  // 6. Money owed: anything overdue, either way.
  if (want('owed')) {
    const open = owedSummary(input.obligations, input.transactions, anchor).open;
    const overdueOut = open.filter((p) => p.overdue && !owedToYouKind(p.obligation.kind));
    const overdueIn = open.filter((p) => p.overdue && owedToYouKind(p.obligation.kind));
    let score = 1;
    const parts: string[] = [];
    if (overdueOut.length > 0) {
      score -= 0.6;
      parts.push(`${overdueOut.length} ${overdueOut.length === 1 ? 'payment you owe is' : 'payments you owe are'} overdue`);
    }
    if (overdueIn.length > 0) {
      score -= 0.3;
      parts.push(`${overdueIn.length} ${overdueIn.length === 1 ? 'amount owed to you is' : 'amounts owed to you are'} overdue`);
    }
    const note = parts.length > 0 ? `${parts.join(', and ')}.` : open.length > 0 ? 'Nothing owed is overdue.' : 'Nothing is owed either way.';
    // With nothing ever recorded as owed there is nothing to measure.
    factors.push({ key: 'owed', label: 'Money owed', score: input.obligations.length > 0 ? clamp(score) : null, note, to: '/money/people' });
  }

  const measured = factors.filter((f) => f.score !== null);
  // Two or more measurable factors are needed before saying anything overall.
  if (measured.length < 2) return { level: null, score: null, factors };
  const score = measured.reduce((s, f) => s + f.score!, 0) / measured.length;
  return { level: score >= 0.75 ? 'steady' : score >= 0.5 ? 'mixed' : 'attention', score, factors };
}

export interface HealthChange {
  /** Compared with this date. */
  since: ISODate;
  direction: 'better' | 'same' | 'lower' | null;
  /** Factors that moved noticeably, largest first. */
  moved: { factor: HealthFactor; before: number; delta: number }[];
}

/**
 * How Money Health compares with 30 days ago, using only what had been
 * recorded by then. Upcoming obligations depend on schedules that have since
 * moved on, so that factor is left out of the comparison.
 */
export function healthChange(input: PlanningInput, anchor: ISODate = today(), days = 30): HealthChange {
  const since = addDays(anchor, -days);
  const past: PlanningInput = {
    ...input,
    transactions: input.transactions.filter((t) => t.date <= since),
    goalEntries: input.goalEntries.filter((e) => e.date <= since),
    obligations: input.obligations.filter((o) => o.date <= since),
    budgets: input.budgets.filter((b) => b.startDate <= since),
    // A goal existed then if it was created by then or already had money in it.
    goals: input.goals.filter((g) => (g.createdAt && g.createdAt.slice(0, 10) <= since) || input.goalEntries.some((e) => e.goalId === g.id && e.date <= since)),
  };
  const now = moneyHealth(input, anchor, HISTORICAL);
  const then = moneyHealth(past, since, HISTORICAL);
  if (now.score === null || then.score === null) return { since, direction: null, moved: [] };
  const moved = now.factors
    .map((f) => {
      const before = then.factors.find((x) => x.key === f.key)?.score;
      return f.score !== null && before !== null && before !== undefined ? { factor: f, before, delta: f.score - before } : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && Math.abs(m.delta) >= 0.1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const delta = now.score - then.score;
  return { since, direction: Math.abs(delta) < 0.05 ? 'same' : delta > 0 ? 'better' : 'lower', moved };
}
