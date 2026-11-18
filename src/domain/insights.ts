/**
 * "Finken noticed" — short observations derived from real records.
 *
 * Every rule returns nothing when the data is too thin to support it, so an
 * empty Space gets no insights rather than invented ones. Each insight says
 * what was noticed, why it matters, the figures behind it, and one action.
 */
import { completeMonths } from './analytics';
import { addDays, formatDay, formatMonthYear, monthRange, today } from './dates';
import { formatMoney, formatPercent } from './format';
import {
  busiestSpendingDay,
  changeRatio,
  inPeriod,
  monthToDateComparison,
  owedSummary,
  owedToYouKind,
  spendingByCategory,
  summarize,
  totalBalance,
} from './money';
import { budgetMessage, budgetStatus, goalStatus, monthlyEquivalent } from './planning';
import type { Account, Budget, Category, Goal, GoalEntry, ISODate, Obligation, Person, Recurring, Transaction } from './types';
import { expectedEvents, expectedTotals } from './upcoming';

export type InsightTone = 'neutral' | 'positive' | 'attention';

export type InsightSection = 'spending' | 'income' | 'category' | 'budget' | 'recurring' | 'cashflow' | 'unusual' | 'owed' | 'goals';

export const INSIGHT_SECTIONS: { value: InsightSection; label: string }[] = [
  { value: 'spending', label: 'Spending trends' },
  { value: 'income', label: 'Income trends' },
  { value: 'category', label: 'Categories' },
  { value: 'budget', label: 'Budgets' },
  { value: 'recurring', label: 'Regular payments' },
  { value: 'cashflow', label: 'Cash flow' },
  { value: 'unusual', label: 'Unusual spending' },
  { value: 'owed', label: 'Money owed' },
  { value: 'goals', label: 'Savings goals' },
];

export interface Insight {
  id: string;
  section: InsightSection;
  /** What Finken noticed. */
  title: string;
  detail: string;
  /** Why it matters, in one sentence. */
  why?: string;
  /** The figures behind it. */
  facts?: { label: string; value: string }[];
  tone: InsightTone;
  /** In-app route that lets the user act on the insight. */
  action?: { label: string; to: string };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface InsightInput {
  transactions: Transaction[];
  categories: Category[];
  recurring: Recurring[];
  budgets?: Budget[];
  obligations?: Obligation[];
  people?: Person[];
  accounts?: Account[];
  goals?: Goal[];
  goalEntries?: GoalEntry[];
  currency: string;
  anchor?: ISODate;
}

/** Attention first, then neutral, then good news; the rule order breaks ties. */
const TONE_ORDER: Record<InsightTone, number> = { attention: 0, neutral: 1, positive: 2 };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildInsights({
  transactions,
  categories,
  recurring,
  budgets = [],
  obligations = [],
  people = [],
  accounts = [],
  goals = [],
  goalEntries = [],
  currency,
  anchor = today(),
}: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const money = (n: number) => formatMoney(n, currency);
  const cmp = monthToDateComparison(transactions, anchor);
  const monthParam = anchor.slice(0, 7);
  const personName = (id?: string) => people.find((p) => p.id === id)?.name;

  // ── Budgets ──
  const statuses = budgets.map((b) => budgetStatus(b, transactions, anchor)).filter((s) => s.period);
  const pressing = statuses
    .filter((s) => s.alert === 'exceeded' || s.alert === 'likely')
    .sort((a, b) => b.projected - b.budget.amount - (a.projected - a.budget.amount))[0];
  const nearly = pressing ? undefined : statuses.filter((s) => s.alert === 'approaching').sort((a, b) => b.used - a.used)[0];
  const budgetNote = pressing ?? nearly;
  if (budgetNote) {
    const { budget } = budgetNote;
    insights.push({
      id: `budget-${budget.id}`,
      section: 'budget',
      title:
        budgetNote.alert === 'exceeded'
          ? `${budget.name} is over budget`
          : budgetNote.alert === 'likely'
            ? `${budget.name} is heading over budget`
            : `Your ${budget.name} budget is nearly used up`,
      detail: budgetMessage(budgetNote, currency) ?? '',
      why: 'Spotting it now leaves time to slow down, or to raise the limit if it was set too low.',
      facts: [
        { label: 'Budget', value: money(budget.amount) },
        { label: 'Spent so far', value: money(budgetNote.spent) },
        { label: 'Heading for', value: money(budgetNote.projected) },
        { label: 'Days left', value: String(budgetNote.daysLeft) },
      ],
      tone: 'attention',
      action: { label: `Adjust your ${budget.name} budget`, to: '/money/budgets' },
    });
  }
  const underPace = statuses.filter((s) => s.alert === 'below').sort((a, b) => b.expectedByNow - b.spent - (a.expectedByNow - a.spent))[0];
  if (underPace) {
    insights.push({
      id: `budget-under-${underPace.budget.id}`,
      section: 'budget',
      title: `${underPace.budget.name} is under its usual pace`,
      detail: budgetMessage(underPace, currency) ?? '',
      why: 'Money not needed here could go towards a goal or another budget.',
      facts: [
        { label: 'Spent so far', value: money(underPace.spent) },
        { label: 'Even pace by today', value: money(underPace.expectedByNow) },
      ],
      tone: 'positive',
      action: { label: 'Open budgets', to: '/money/budgets' },
    });
  }

  // ── Categories: biggest movement, month to date against the same days last month ──
  const nowCats = spendingByCategory(inPeriod(transactions, cmp.current), categories);
  const beforeCats = new Map(spendingByCategory(inPeriod(transactions, cmp.previous), categories).map((c) => [c.categoryId, c.amount]));
  let mover: { name: string; ratio: number; now: number; before: number; categoryId?: string } | null = null;
  for (const c of nowCats) {
    const before = beforeCats.get(c.categoryId) ?? 0;
    const ratio = changeRatio(c.amount, before);
    // Ignore small categories so a tiny base cannot produce a dramatic percentage.
    // A refund larger than this month's spending is not a trend, and would give an impossible percentage.
    if (ratio === null || c.amount < 0 || before < 1000 || Math.abs(ratio) < 0.1) continue;
    if (!mover || Math.abs(c.amount - before) > Math.abs(mover.now - mover.before)) {
      mover = { name: c.name, ratio, now: c.amount, before, categoryId: c.categoryId };
    }
  }
  if (mover) {
    const up = mover.ratio > 0;
    insights.push({
      id: 'category-mover',
      section: 'category',
      title: `${mover.name} spending is ${up ? 'up' : 'down'} ${formatPercent(mover.ratio)}`,
      detail: `That is ${money(Math.abs(mover.now - mover.before))} ${up ? 'more' : 'less'} than the same point last month.`,
      why: up ? 'A category growing quickly is often the easiest place to find savings.' : 'A lower category frees up money for something else.',
      facts: [
        { label: 'This month so far', value: money(mover.now) },
        { label: 'Same point last month', value: money(mover.before) },
      ],
      tone: up ? 'attention' : 'positive',
      action: { label: `Review your ${mover.name} expenses`, to: `/transactions?type=expense&month=${monthParam}${mover.categoryId ? `&category=${mover.categoryId}` : ''}` },
    });
  }

  // ── Spending trend: the whole month so far ──
  const spendRatio = cmp.before.spent >= 1000 ? changeRatio(cmp.now.spent, cmp.before.spent) : null;
  if (spendRatio !== null && Math.abs(spendRatio) >= 0.1) {
    const up = spendRatio > 0;
    insights.push({
      id: 'spending-trend',
      section: 'spending',
      title: `Spending is ${up ? 'up' : 'down'} ${formatPercent(spendRatio)} on last month`,
      detail: `${money(cmp.now.spent)} so far this month, against ${money(cmp.before.spent)} by the same day last month.`,
      why: 'Comparing the same number of days keeps a half-finished month fair.',
      facts: [
        { label: 'This month so far', value: money(cmp.now.spent) },
        { label: 'Same point last month', value: money(cmp.before.spent) },
      ],
      tone: up ? 'attention' : 'positive',
      action: { label: 'See this month’s spending', to: `/transactions?type=expense&month=${monthParam}` },
    });
  }

  // ── Income trend: last full month against the months before it ──
  const full = completeMonths(anchor, 4).map((r) => ({ r, s: summarize(transactions, r) }));
  const last = full[full.length - 1];
  const earlier = full.slice(0, -1).filter((m) => m.s.income > 0);
  if (last.s.income > 0 && earlier.length >= 2) {
    const usual = earlier.reduce((s, m) => s + m.s.income, 0) / earlier.length;
    const ratio = changeRatio(last.s.income, usual);
    if (ratio !== null && Math.abs(ratio) >= 0.1) {
      const up = ratio > 0;
      insights.push({
        id: 'income-trend',
        section: 'income',
        title: `Income in ${formatMonthYear(last.r.from)} was ${formatPercent(ratio)} ${up ? 'above' : 'below'} usual`,
        detail: `${money(last.s.income)} came in, against about ${money(usual)} in the ${earlier.length} months before.`,
        why: up ? 'A stronger month is a good moment to add to savings.' : 'With less coming in, it helps to check what is due before spending more.',
        facts: [
          { label: formatMonthYear(last.r.from), value: money(last.s.income) },
          { label: 'Usual month', value: money(usual) },
        ],
        tone: up ? 'positive' : 'attention',
        action: { label: 'See income', to: `/transactions?type=income&month=${last.r.from.slice(0, 7)}` },
      });
    }
  }

  // ── Unusual spending: one expense far above what its category usually costs ──
  const recentFrom = addDays(anchor, -30);
  let unusual: { t: Transaction; usual: number; ratio: number } | null = null;
  for (const t of transactions) {
    if (t.type !== 'expense' || t.date < recentFrom || t.date > anchor || !t.categoryId) continue;
    const history = transactions
      .filter((x) => x.type === 'expense' && x.categoryId === t.categoryId && x.date < recentFrom && x.date >= addDays(recentFrom, -120))
      .map((x) => x.amount);
    if (history.length < 4) continue;
    const usual = median(history);
    const ratio = usual > 0 ? t.amount / usual : 0;
    if (ratio >= 2.5 && t.amount - usual >= 1000 && (!unusual || ratio > unusual.ratio)) unusual = { t, usual, ratio };
  }
  if (unusual) {
    const category = categories.find((c) => c.id === unusual.t.categoryId);
    const what = unusual.t.description || category?.name || 'An expense';
    insights.push({
      id: `unusual-${unusual.t.id}`,
      section: 'unusual',
      title: `An unusually large ${category?.name ?? ''} expense`.replace('  ', ' '),
      detail: `${what} on ${formatDay(unusual.t.date)} was ${money(unusual.t.amount)}. ${category?.name ?? 'This category'} expenses are usually around ${money(unusual.usual)}.`,
      why: 'One-off costs are easy to forget when looking back at a month.',
      facts: [
        { label: 'This expense', value: money(unusual.t.amount) },
        { label: 'Usual amount', value: money(unusual.usual) },
        { label: 'About', value: `${unusual.ratio.toFixed(1)}× usual` },
      ],
      tone: 'neutral',
      action: {
        label: 'Check this expense',
        to: `/transactions?type=expense&period=custom&from=${unusual.t.date}&to=${unusual.t.date}${unusual.t.categoryId ? `&category=${unusual.t.categoryId}` : ''}`,
      },
    });
  }

  // ── Money owed ──
  const owed = owedSummary(obligations, transactions, anchor);
  const toYou = owed.open.filter((p) => owedToYouKind(p.obligation.kind));
  const lateIn = toYou.filter((p) => p.overdue).sort((a, b) => b.outstanding - a.outstanding)[0];
  const biggestIn = lateIn ?? [...toYou].sort((a, b) => b.outstanding - a.outstanding)[0];
  const inName = biggestIn && personName(biggestIn.obligation.personId);
  if (biggestIn && inName) {
    insights.push({
      id: `owed-${biggestIn.obligation.id}`,
      section: 'owed',
      title: lateIn ? `Follow up with ${inName}` : `${inName} still owes you ${money(biggestIn.outstanding)}`,
      detail: lateIn
        ? `${inName} still owes you ${money(biggestIn.outstanding)} for ${biggestIn.obligation.title}. It was due on ${formatDay(biggestIn.nextDue!)}.`
        : `For ${biggestIn.obligation.title}.`,
      why: lateIn ? 'Overdue amounts are easier to collect while they are recent.' : 'Money owed to you is not in your accounts until it is paid.',
      facts: [
        { label: 'Still owed', value: money(biggestIn.outstanding) },
        ...(biggestIn.settled > 0 ? [{ label: 'Already received', value: money(biggestIn.settled) }] : []),
        ...(biggestIn.nextDue ? [{ label: lateIn ? 'Was due' : 'Due', value: formatDay(biggestIn.nextDue) }] : []),
      ],
      tone: lateIn ? 'attention' : 'neutral',
      action: { label: `Open ${inName}`, to: `/money/people/${biggestIn.obligation.personId}` },
    });
  }
  const lateOut = owed.open.filter((p) => p.overdue && !owedToYouKind(p.obligation.kind)).sort((a, b) => b.outstanding - a.outstanding)[0];
  const outName = lateOut && personName(lateOut.obligation.personId);
  if (lateOut) {
    insights.push({
      id: `owed-out-${lateOut.obligation.id}`,
      section: 'owed',
      title: `A payment${outName ? ` to ${outName}` : ''} is overdue`,
      detail: `${money(lateOut.outstanding)} for ${lateOut.obligation.title} was due on ${formatDay(lateOut.nextDue!)}.`,
      why: 'Settling, or agreeing a new date, keeps things clear with the people you owe.',
      facts: [
        { label: 'Still to pay', value: money(lateOut.outstanding) },
        { label: 'Was due', value: formatDay(lateOut.nextDue!) },
      ],
      tone: 'attention',
      action: { label: 'See what you owe', to: '/money/payables' },
    });
  }
  if (owed.owedToYou > 0 && owed.youOwe > 0) {
    const net = owed.owedToYou - owed.youOwe;
    insights.push({
      id: 'owed-position',
      section: 'owed',
      title: net >= 0 ? `Others owe you ${money(net)} more than you owe` : `You owe ${money(-net)} more than you are owed`,
      detail: `${money(owed.owedToYou)} is owed to you and you owe ${money(owed.youOwe)}.`,
      why: 'Neither side is in your balances yet, so it is worth knowing where you stand.',
      facts: [
        { label: 'Owed to you', value: money(owed.owedToYou) },
        { label: 'You owe', value: money(owed.youOwe) },
      ],
      tone: 'neutral',
      action: { label: 'Open People', to: '/money/people' },
    });
  }

  // ── Cash flow ──
  const input = { recurring, obligations, transactions };
  const month = monthRange(anchor);
  const toMonthEnd = expectedTotals(expectedEvents(input, { from: anchor, to: month.to }, anchor).filter((e) => e.direction === 'out'));
  const active = accounts.filter((a) => !a.archived);
  if (active.length > 0 && toMonthEnd.outgoing > 0) {
    const available = totalBalance(active, transactions);
    const left = available - toMonthEnd.outgoing;
    insights.push({
      id: 'after-commitments',
      section: 'cashflow',
      title: left >= 0 ? `You have ${money(left)} remaining after recorded commitments` : `Recorded commitments are ${money(-left)} more than you have`,
      detail: `${money(available)} available now, less ${money(toMonthEnd.outgoing)} still to pay by the end of the month.`,
      why: 'Knowing what is already spoken for shows what is really free to use.',
      facts: [
        { label: 'Available now', value: money(available) },
        { label: 'Still to pay this month', value: money(toMonthEnd.outgoing) },
      ],
      tone: left >= 0 ? 'neutral' : 'attention',
      action: { label: 'See Safe to Spend', to: '/insights' },
    });
  }

  const week = expectedEvents(input, { from: anchor, to: addDays(anchor, 7) }, anchor).filter((e) => e.direction === 'out');
  if (week.length > 0) {
    const { outgoing } = expectedTotals(week);
    const late = week.filter((e) => e.status === 'overdue').length;
    insights.push({
      id: 'due-this-week',
      section: 'cashflow',
      title: `${week.length} ${week.length === 1 ? 'payment' : 'payments'} coming up this week`,
      detail: `${money(outgoing)} is due in the next 7 days${late > 0 ? `, including ${late} already overdue` : ''}.`,
      why: 'Checking ahead avoids a payment catching you short.',
      facts: [
        { label: 'Due in 7 days', value: money(outgoing) },
        { label: 'Payments', value: String(week.length) },
      ],
      tone: late > 0 ? 'attention' : 'neutral',
      action: { label: 'See what is coming up', to: late > 0 ? '/money/upcoming?show=overdue' : '/money/upcoming?show=out' },
    });
  }

  if (cmp.now.count >= 3 && cmp.now.income > 0) {
    const positive = cmp.now.net >= 0;
    insights.push({
      id: 'net-position',
      section: 'cashflow',
      title: positive ? `You have kept ${money(cmp.now.net)} of this month's income` : `Spending is ${money(-cmp.now.net)} ahead of income this month`,
      detail: positive ? `${formatPercent(cmp.now.net / cmp.now.income)} of what came in is still unspent.` : 'More has gone out than come in so far this month.',
      why: positive ? 'Money kept this month can go towards a goal before it gets spent.' : 'Spending ahead of income draws on what you had before.',
      facts: [
        { label: 'Income', value: money(cmp.now.income) },
        { label: 'Spent', value: money(cmp.now.spent) },
      ],
      tone: positive ? 'positive' : 'attention',
      action: { label: 'View this month', to: `/transactions?month=${monthParam}` },
    });
  }

  // ── Regular payments ──
  const regular = recurring.filter((r) => r.status === 'active' && r.type === 'expense');
  if (regular.length >= 2) {
    const monthly = regular.reduce((s, r) => s + monthlyEquivalent(r), 0);
    const incomeMonths = completeMonths(anchor, 3)
      .map((r) => summarize(transactions, r).income)
      .filter((v) => v > 0);
    const typicalIncome = incomeMonths.length >= 2 ? incomeMonths.reduce((a, b) => a + b, 0) / incomeMonths.length : 0;
    const biggest = [...regular].sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a))[0];
    const share = typicalIncome > 0 ? monthly / typicalIncome : null;
    insights.push({
      id: 'recurring-share',
      section: 'recurring',
      title: `Regular payments come to about ${money(monthly)} a month`,
      detail:
        share !== null
          ? `That is ${formatPercent(share)} of a typical month's income, across ${regular.length} items.`
          : `Across ${regular.length} items. The largest is ${biggest.name}.`,
      why: 'Regular payments are spent before the month starts, so they are worth reviewing now and then.',
      facts: [
        { label: 'Each month', value: money(monthly) },
        { label: 'Largest', value: `${biggest.name}, ${money(monthlyEquivalent(biggest))}` },
        ...(share !== null ? [{ label: 'Share of income', value: formatPercent(share) }] : []),
      ],
      tone: share !== null && share > 0.6 ? 'attention' : 'neutral',
      action: { label: 'Review regular payments', to: '/money/recurring' },
    });
  }

  // ── Savings goals ──
  const since = addDays(anchor, -90);
  const behind = goals
    .map((g) => {
      const s = goalStatus(g, goalEntries, anchor);
      const recent = goalEntries.filter((e) => e.goalId === g.id && e.date > since && e.date <= anchor).reduce((sum, e) => sum + e.amount, 0);
      return { s, pace: recent / 3 };
    })
    .filter(({ s, pace }) => !s.reached && (s.late || (s.monthlyNeeded !== null && pace < s.monthlyNeeded * 0.9)))
    .sort((a, b) => b.s.remaining - a.s.remaining)[0];
  if (behind) {
    const { s, pace } = behind;
    insights.push({
      id: `goal-${s.goal.id}`,
      section: 'goals',
      title: s.late ? `${s.goal.name} has passed its target date` : `Your ${s.goal.name} goal is behind schedule`,
      detail: s.late
        ? `${money(s.remaining)} is still to go. A new target date would give it a fresh plan.`
        : `To reach it on time you need about ${money(s.monthlyNeeded!)} a month; lately you have set aside about ${money(pace)} a month.`,
      why: 'Small, regular amounts are easier than a large catch-up at the end.',
      facts: [
        { label: 'Saved', value: money(s.saved) },
        { label: 'Target', value: money(s.goal.targetAmount) },
        ...(s.monthlyNeeded ? [{ label: 'Needed each month', value: money(s.monthlyNeeded) }] : []),
      ],
      tone: 'attention',
      action: { label: s.late ? 'Update the goal' : 'Increase savings contributions', to: '/money/goals' },
    });
  }

  // ── Spending habits: heaviest day of the week, last 3 months ──
  const recent = inPeriod(transactions, { from: monthRange(anchor, -2).from, to: anchor });
  const busiest = busiestSpendingDay(recent);
  if (busiest) {
    insights.push({
      id: 'busiest-day',
      section: 'spending',
      title: `${DAYS[busiest.day]} is your highest spending day`,
      detail: `${money(busiest.amount)} spent on ${DAYS[busiest.day]}s over the last three months.`,
      why: 'Knowing when money tends to go makes it easier to plan around.',
      facts: [{ label: `Spent on ${DAYS[busiest.day]}s`, value: money(busiest.amount) }],
      tone: 'neutral',
      action: { label: 'See spending by day', to: '/insights?tab=analytics' },
    });
  }

  return insights
    .map((insight, i) => ({ insight, i }))
    .sort((a, b) => TONE_ORDER[a.insight.tone] - TONE_ORDER[b.insight.tone] || a.i - b.i)
    .map(({ insight }) => insight);
}
