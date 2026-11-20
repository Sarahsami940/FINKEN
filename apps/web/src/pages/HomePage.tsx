import { comparisonFor, flowSeries, REPORT_PERIODS, type ReportPeriod, reportRange, transactionsLink } from '@finken/domain/dashboard';
import { currentHour, formatDay, formatDueLabel, formatFullDate, formatMonthYear, formatRelativeDay, parseISODate, today } from '@finken/domain/dates';
import { formatMoney, formatPercent } from '@finken/domain/format';
import { DEFAULT_SAFE_OPTIONS, safeToSpend } from '@finken/domain/health';
import { buildInsights } from '@finken/domain/insights';
import { accountBalances, changeRatio, inPeriod, owedSummary, owedToYouKind, sortByDateDesc, spendingByCategory, summarize } from '@finken/domain/money';
import { colorOf } from '@finken/domain/palette';
import { budgetStatus, goalStatus } from '@finken/domain/planning';
import type { DateRange, ID } from '@finken/domain/types';
import { daysFrom, expectedEvents, expectedTotals } from '@finken/domain/upcoming';
import { BriefcaseBusiness, CalendarClock, CalendarDays, ChevronRight, Handshake, Inbox, PiggyBank, Plus, Sun, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { UsageQuestion } from '../components/beta/Beta';
import { DonutChart } from '../components/charts/DonutChart';
import { FlowBars } from '../components/charts/FlowBars';
import { useAddFlow } from '../components/money/AddFlow';
import { ALERT_STYLE } from '../components/money/budgetStyle';
import { ExpectedRow, Figure, InsightCard, TextLink } from '../components/money/DashboardParts';
import { ObligationSheet } from '../components/money/OwedSheets';
import { CategoryIcon, SummaryCard, TransactionItem } from '../components/money/parts';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Input } from '../components/ui/Field';
import { iconFor } from '../components/ui/icons';
import { Badge, EmptyState, ProgressBar } from '../components/ui/Misc';
import { useAppState, useSpaceData } from '../data/hooks';

function greeting(): string {
  const hour = currentHour();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "Today", "17 – 23 Nov", "November 2026", "1 Oct – 17 Nov 2026". */
export function periodLabel(period: ReportPeriod, range: DateRange): string {
  if (period === 'today') return `Today, ${formatDay(range.from)}`;
  if (period === 'month' || period === 'last-month') return formatMonthYear(range.from);
  if (range.from === range.to) return formatDay(range.from);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const year = parseISODate(range.to).getFullYear();
  return `${formatDay(range.from)} – ${formatDay(range.to)}${sameYear && year === parseISODate(today()).getFullYear() ? '' : ` ${year}`}`;
}

const PERIOD_NOUN: Record<ReportPeriod, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  'last-month': 'last month',
  custom: 'in this period',
};

export function HomePage() {
  const { user } = useAppState();
  const { space, currency, transactions, categories, accounts, recurring, budgets, goals, goalEntries, people, obligations } = useSpaceData();
  const { openMenu, openDetail } = useAddFlow();
  const navigate = useNavigate();
  // The period lives in the URL so the browser's back button returns to it.
  const [params, setParams] = useSearchParams();
  const [openObligation, setOpenObligation] = useState<ID | null>(null);
  const now = today();

  const period: ReportPeriod = REPORT_PERIODS.some((p) => p.value === params.get('period')) ? (params.get('period') as ReportPeriod) : 'month';
  const customFrom = params.get('from') ?? '';
  const customTo = params.get('to') ?? '';
  const range = useMemo(() => reportRange(period, now, { from: customFrom, to: customTo }), [period, now, customFrom, customTo]);

  function setPeriod(value: ReportPeriod) {
    const next = new URLSearchParams(params);
    if (value === 'month') next.delete('period');
    else next.set('period', value);
    if (value === 'custom') {
      // Start a custom range from whatever was on screen.
      next.set('from', range.from);
      next.set('to', range.to);
    } else {
      next.delete('from');
      next.delete('to');
    }
    setParams(next, { replace: true });
  }

  function setCustom(key: 'from' | 'to', value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const view = useMemo(() => {
    const list = inPeriod(transactions, range);
    const cmp = comparisonFor(period, range, now);
    const balances = accountBalances(accounts, transactions).filter((b) => !b.account.archived);
    const input = { recurring, obligations, transactions };
    const next30 = expectedEvents(input, daysFrom(now, 30), now);
    return {
      current: summarize(list),
      soFar: cmp ? summarize(transactions, cmp.current) : null,
      before: cmp ? summarize(transactions, cmp.previous) : null,
      cmpLabel: cmp?.label,
      byCategory: spendingByCategory(list, categories),
      flow: flowSeries(transactions, range),
      recent: sortByDateDesc(list).slice(0, 6),
      available: balances.reduce((sum, b) => sum + b.balance, 0),
      accountCount: balances.length,
      expected: next30,
      expectedTotals: expectedTotals(next30),
      owed: owedSummary(obligations, transactions, now),
      budgets: budgets
        .map((b) => budgetStatus(b, transactions, now))
        .filter((s) => s.period)
        .sort((a, b) => b.used - a.used),
      goals: goals.map((g) => goalStatus(g, goalEntries, now)).sort((a, b) => Number(a.reached) - Number(b.reached) || b.progress - a.progress),
      insights: buildInsights({ transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries, currency, anchor: now }),
      safe: safeToSpend({ accounts, transactions, recurring, obligations, budgets, goals, goalEntries }, DEFAULT_SAFE_OPTIONS, now),
    };
  }, [transactions, categories, accounts, recurring, budgets, goals, goalEntries, obligations, people, currency, range, period, now]);

  if (!space) return null;
  const isBusiness = space.type === 'business';

  const { current, soFar, before } = view;
  // While a period is still running, nothing recorded yet is not "100% lower".
  const running = range.from <= now && range.to >= now;
  const compare = (current: number, previous: number) => (running && current === 0 ? null : changeRatio(current, previous));
  const incomeChange = soFar && before ? compare(soFar.income, before.income) : null;
  const spentChange = soFar && before ? compare(soFar.spent, before.spent) : null;
  const versus = (change: number | null) => (change === null ? undefined : view.cmpLabel);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const label = periodLabel(period, range);
  const noun = PERIOD_NOUN[period];
  // A category whose refunds outweigh its spending has nothing to draw.
  const spending = view.byCategory.filter((c) => c.amount > 0);
  const topCategories = spending.slice(0, 5);
  const otherAmount = spending.slice(5).reduce((sum, c) => sum + c.amount, 0);
  const spentTotal = view.byCategory.reduce((sum, c) => sum + c.amount, 0);
  const segments = [
    ...topCategories.map((c) => ({ key: c.categoryId ?? 'none', label: `${c.name}: ${formatMoney(c.amount, currency)}`, value: c.amount, color: colorOf(c.color).fg })),
    ...(otherAmount > 0 ? [{ key: 'other', label: `Everything else: ${formatMoney(otherAmount, currency)}`, value: otherAmount, color: '#c9c5ba' }] : []),
  ];
  const dueSoon = view.expected.slice(0, 5);
  const overdueCount = view.expected.filter((e) => e.status === 'overdue').length;
  const openOwed = view.owed.open.slice(0, 4);

  return (
    <div>
      <UsageQuestion className="mb-5" />
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-3">{formatFullDate(now)}</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">
            {greeting()}
            {user?.name ? `, ${user.name}` : ''}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent" className="px-3 py-1.5 text-[13px]">
            {space.name} · {label}
          </Badge>
          <Link
            to="/today"
            className="inline-flex h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-semibold text-ink shadow-card hover:border-line-strong"
          >
            <Sun aria-hidden className="size-4" />
            Today view
          </Link>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="-mx-4 max-w-[calc(100%+2rem)] overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:px-0">
          <div role="radiogroup" aria-label="Reporting period" className="inline-flex rounded-control bg-sunken p-1">
            {REPORT_PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                role="radio"
                aria-checked={p.value === period}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  'h-9 whitespace-nowrap rounded-[0.55rem] px-3.5 text-sm font-semibold transition-colors',
                  p.value === period ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
            <label className="flex items-center gap-2">
              <span className="font-semibold">From</span>
              <Input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustom('from', e.target.value)} className="!h-9 !w-auto" />
            </label>
            <label className="flex items-center gap-2">
              <span className="font-semibold">to</span>
              <Input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustom('to', e.target.value)} className="!h-9 !w-auto" />
            </label>
          </div>
        )}
      </div>

      {/* 1. The period at a glance */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <SummaryCard
          label={isBusiness ? 'Revenue' : 'Income'}
          amount={current.income}
          currency={currency}
          change={incomeChange}
          caption={versus(incomeChange)}
          to={transactionsLink(range, { type: 'income' })}
        />
        <SummaryCard
          label={isBusiness ? 'Expenses' : 'Spent'}
          amount={current.spent}
          currency={currency}
          change={spentChange}
          increaseIsGood={false}
          caption={versus(spentChange)}
          to={transactionsLink(range, { type: 'expense' })}
        />
        <SummaryCard
          label={isBusiness ? 'Net position' : 'Net'}
          amount={current.net}
          currency={currency}
          emphasis
          className="order-first col-span-2 sm:order-none sm:col-span-1"
          caption={current.income > 0 && current.net >= 0 ? `${formatPercent(current.net / current.income)} of income kept` : 'Income minus spending'}
          to={transactionsLink(range)}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          {/* 9. Finken noticed */}
          <InsightCard key={space.id} insights={view.insights} />

          {/* 2. Income versus expenses */}
          <Card>
            <CardHeader
              title="Income and spending"
              subtitle={view.flow.widened ? `The 7 days to ${formatDay(range.to)}` : `${label}, by ${view.flow.unit}`}
              action={<TextLink to="/insights">Insights</TextLink>}
            />
            {view.flow.buckets.some((b) => b.income > 0 || b.spent > 0) ? (
              <FlowBars
                buckets={view.flow.buckets}
                unit={view.flow.unit}
                currency={currency}
                highlight={view.flow.unit === 'month' ? undefined : now}
                onSelect={(b) => navigate(transactionsLink({ from: b.from, to: b.to }))}
              />
            ) : (
              <EmptyState icon={Inbox} title={`Nothing recorded ${noun}`} message="Income and spending will appear here as you record them." className="py-6" />
            )}
          </Card>

          {/* 3. Spending by category */}
          <Card>
            <CardHeader title="Where it went" subtitle={label} />
            {view.byCategory.length === 0 ? (
              <EmptyState icon={Inbox} title={`No spending ${noun}`} message="Expenses you record are grouped here by category." className="py-6" />
            ) : (
              <div className="grid items-center gap-6 md:grid-cols-[auto_1fr]">
                <div className="flex justify-center">
                  <DonutChart segments={segments} label={`Spending by category, ${label}`}>
                    <span className="text-xs font-semibold text-ink-3">Spent</span>
                    <span className="money text-lg font-extrabold text-ink">{formatMoney(spentTotal, currency, { compact: true })}</span>
                  </DonutChart>
                </div>
                <ul className="min-w-0 space-y-3.5">
                  {topCategories.map((c) => (
                    <li key={c.categoryId ?? 'none'}>
                      <Link to={transactionsLink(range, { type: 'expense', category: c.categoryId })} className="group block">
                        <span className="flex items-center gap-3">
                          <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink group-hover:text-accent">{c.name}</span>
                          <span className="text-xs font-semibold text-ink-3">{formatPercent(c.share)}</span>
                          <span className="money text-sm font-bold text-ink">{formatMoney(c.amount, currency)}</span>
                        </span>
                        <ProgressBar value={c.share} color={colorOf(c.color).fg} label={`${c.name} share of spending`} className="ml-11 mt-2" />
                      </Link>
                    </li>
                  ))}
                  {otherAmount > 0 && (
                    <li>
                      <Link to={transactionsLink(range, { type: 'expense' })} className="flex items-center justify-between gap-3 text-sm text-ink-3 hover:text-ink">
                        <span className="font-semibold">{spending.length - topCategories.length} more categories</span>
                        <span className="money font-bold">{formatMoney(otherAmount, currency)}</span>
                      </Link>
                    </li>
                  )}
                </ul>
              </div>
            )}
          </Card>

          {/* 4. Recent transactions */}
          <Card>
            <CardHeader title="Recent transactions" subtitle={label} action={<TextLink to={transactionsLink(range)}>See all</TextLink>} />
            {view.recent.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title={transactions.length === 0 ? 'No transactions yet' : `Nothing recorded ${noun}`}
                message={transactions.length === 0 ? 'Record your first expense or income. It only takes a few seconds.' : 'Pick another period above, or add what you have spent.'}
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={openMenu}>
                    Add transaction
                  </Button>
                }
              />
            ) : (
              <ul className="-mx-2">
                {view.recent.map((t) => (
                  <li key={t.id}>
                    <TransactionItem
                      transaction={t}
                      category={categoryById.get(t.categoryId ?? '')}
                      accounts={accounts}
                      currency={currency}
                      trailing={formatRelativeDay(t.date)}
                      onClick={() => openDetail(t.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1 [&>*]:min-w-0">
          {isBusiness && (
            <Link
              to="/business"
              className="md:col-span-2 xl:col-span-1 flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong"
            >
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
                <BriefcaseBusiness className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">Business</span>
                <span className="block text-[13px] text-ink-3">Customers and suppliers, receivables and payables, profit and loss, cash flow and reports.</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" />
            </Link>
          )}

          {/* 1b. Financial overview: what is real now, and what is expected */}
          <Card>
            <CardHeader title="Financial overview" subtitle="Now, and the next 30 days" action={<TextLink to="/money">Money</TextLink>} />
            <div className="grid grid-cols-2 gap-2.5">
              <Figure
                label="Available now"
                amount={view.available}
                currency={currency}
                tone={view.available < 0 ? 'negative' : undefined}
                to="/money"
                hint={`${view.accountCount} ${view.accountCount === 1 ? 'account' : 'accounts'}`}
              />
              <Figure
                label="Safe to spend"
                amount={view.safe.amount}
                currency={currency}
                tone={view.safe.amount < 0 ? 'negative' : undefined}
                to="/insights"
                hint={`Estimate to ${formatDay(view.safe.until)}`}
              />
              <Figure label="Expected in" amount={view.expectedTotals.incoming} currency={currency} tone="positive" to="/money/upcoming?show=in" />
              <Figure label="Expected out" amount={view.expectedTotals.outgoing} currency={currency} to="/money/upcoming?show=out" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              Safe to spend keeps back bills, repayments, budgets and savings until the end of the month, and never counts expected income. Expected amounts change no balance until
              they are marked paid or received.
            </p>
          </Card>

          {/* 7. Upcoming payments */}
          <Card>
            <CardHeader
              title="Coming up"
              subtitle={view.expected.length > 0 ? `${view.expected.length} in the next 30 days${overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}` : 'Next 30 days'}
              action={<TextLink to="/money/upcoming">View all</TextLink>}
            />
            {dueSoon.length === 0 ? (
              <EmptyState icon={CalendarClock} title="Nothing expected" message="No payments or receipts are expected in the next 30 days." className="py-6" />
            ) : (
              <ul className="space-y-0.5">
                {dueSoon.map((e) => (
                  <li key={e.key}>
                    <ExpectedRow
                      e={e}
                      people={people}
                      currency={currency}
                      to={e.status === 'overdue' ? '/money/upcoming?show=overdue' : e.direction === 'in' ? '/money/upcoming?show=in' : '/money/upcoming?show=out'}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 5. Budget progress */}
          <Card>
            <CardHeader title="Budgets" subtitle="Each over its own period" action={<TextLink to="/money/budgets">Budgets</TextLink>} />
            {view.budgets.length === 0 ? (
              <EmptyState
                icon={PiggyBank}
                title="No budgets running"
                message="Set a limit for a category or for all spending."
                action={<TextLink to="/money/budgets">Create a budget</TextLink>}
                className="py-6"
              />
            ) : (
              <ul className="space-y-4">
                {view.budgets.slice(0, 4).map((s) => {
                  const style = s.alert ? ALERT_STYLE[s.alert] : null;
                  const category = categoryById.get(s.budget.categoryId ?? '');
                  return (
                    <li key={s.budget.id}>
                      <Link to={transactionsLink(s.period!, { type: 'expense', category: s.budget.categoryId })} className="group block">
                        <span className="flex items-center gap-3">
                          <CategoryIcon icon={category?.icon ?? 'coins'} color={category?.color ?? 'cobalt'} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-ink group-hover:text-accent">{s.budget.name}</span>
                            <span className={cn('block truncate text-xs', s.remaining < 0 ? 'font-semibold text-negative' : 'text-ink-3')}>
                              {s.remaining < 0 ? `${formatMoney(-s.remaining, currency)} over` : `${formatMoney(s.remaining, currency)} left`} · {s.daysLeft}{' '}
                              {s.daysLeft === 1 ? 'day' : 'days'} to go
                            </span>
                          </span>
                          {style && style.tone !== 'positive' ? (
                            <Badge tone={style.tone}>{style.label}</Badge>
                          ) : (
                            <span className="text-xs font-semibold text-ink-3">{formatPercent(s.used)}</span>
                          )}
                        </span>
                        <ProgressBar value={s.used} color={style?.bar} label={`${s.budget.name} budget used`} className="ml-11 mt-2" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 6. Savings goals */}
          <Card>
            <CardHeader title="Savings goals" action={<TextLink to="/money/goals">Goals</TextLink>} />
            {view.goals.length === 0 ? (
              <EmptyState
                icon={Target}
                title="No goals yet"
                message="Save towards something and watch it fill up."
                action={<TextLink to="/money/goals">Add a goal</TextLink>}
                className="py-6"
              />
            ) : (
              <ul className="space-y-4">
                {view.goals.slice(0, 3).map((s) => {
                  const Icon = iconFor(s.goal.icon);
                  return (
                    <li key={s.goal.id}>
                      <Link to="/money/goals" className="group block">
                        <span className="flex items-center gap-3">
                          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-strong">
                            <Icon className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-ink group-hover:text-accent">{s.goal.name}</span>
                            <span className={cn('block truncate text-xs', s.late ? 'font-semibold text-negative' : 'text-ink-3')}>
                              {s.reached
                                ? 'Reached'
                                : s.late
                                  ? 'Target date has passed'
                                  : s.monthlyNeeded
                                    ? `${formatMoney(s.monthlyNeeded, currency)} a month to reach it`
                                    : `${formatMoney(s.remaining, currency)} to go`}
                            </span>
                          </span>
                          <span className="money text-right text-xs font-semibold text-ink-3">
                            <span className="block text-sm font-bold text-ink">{formatMoney(s.saved, currency)}</span>
                            of {formatMoney(s.goal.targetAmount, currency, { compact: true })}
                          </span>
                        </span>
                        <ProgressBar value={s.progress} color={s.reached ? 'var(--color-positive)' : undefined} label={`${s.goal.name} progress`} className="ml-11 mt-2" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* 8. Receivables and payables */}
          <Card>
            <CardHeader title="Money owed" subtitle="To receive and to pay" action={<TextLink to="/money/people">People</TextLink>} />
            {obligations.length === 0 ? (
              <EmptyState
                icon={Handshake}
                title="Nothing owed"
                message="Record money someone owes you, or money you owe."
                action={<TextLink to="/money/receivables">Money to receive</TextLink>}
                className="py-6"
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <Figure label="Owed to you" amount={view.owed.owedToYou} currency={currency} tone="positive" to="/money/receivables" />
                  <Figure label="You owe" amount={view.owed.youOwe} currency={currency} to="/money/payables" />
                </div>
                {openOwed.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-3">Everything is settled.</p>
                ) : (
                  <ul className="mt-2">
                    {openOwed.map(({ obligation: o, outstanding, overdue, nextDue }) => {
                      const person = people.find((p) => p.id === o.personId);
                      const toYou = owedToYouKind(o.kind);
                      return (
                        <li key={o.id}>
                          <button
                            type="button"
                            onClick={() => setOpenObligation(o.id)}
                            className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-canvas"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-ink">{person?.name ?? o.title}</span>
                              <span className={cn('block truncate text-xs', overdue ? 'font-semibold text-negative' : 'text-ink-3')}>
                                {toYou ? 'Owes you' : 'You owe'}
                                {nextDue ? ` · ${overdue ? formatDueLabel(nextDue) : `due ${formatDay(nextDue)}`}` : ''}
                              </span>
                            </span>
                            <span className={cn('money shrink-0 text-sm font-bold', toYou ? 'text-positive' : 'text-ink')}>{formatMoney(outstanding, currency)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </Card>

          <Link
            to="/today"
            className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong md:col-span-2 xl:col-span-1"
          >
            <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
              <CalendarDays className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-ink">Today</span>
              <span className="block text-[13px] text-ink-3">Spent and received today, what is due, and what is left in your budget.</span>
            </span>
          </Link>
        </div>
      </div>

      <ObligationSheet key={openObligation ?? 'none'} id={openObligation} onClose={() => setOpenObligation(null)} />
    </div>
  );
}
