import { overallBudget, transactionsLink } from '@finken/domain/dashboard';
import { addDays, formatDay, formatFullDate, formatRelativeDay, today } from '@finken/domain/dates';
import { formatMoney } from '@finken/domain/format';
import { buildInsights } from '@finken/domain/insights';
import { inPeriod, sortByDateDesc, summarize } from '@finken/domain/money';
import { expectedEvents, expectedTotals } from '@finken/domain/upcoming';
import { CalendarCheck, Inbox, PiggyBank, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { ALERT_STYLE } from '../components/money/budgetStyle';
import { ExpectedRow, InsightCard, TextLink } from '../components/money/DashboardParts';
import { TransactionItem } from '../components/money/parts';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { EmptyState, ProgressBar } from '../components/ui/Misc';
import { useSpaceData } from '../data/hooks';

/** A dedicated view of one day: what happened, what is due, and what is left. */
export function TodayPage() {
  const { space, currency, transactions, categories, accounts, recurring, budgets, people, obligations, goals, goalEntries } = useSpaceData();
  const { openMenu, openDetail } = useAddFlow();
  const now = today();

  const view = useMemo(() => {
    const day = { from: now, to: now };
    const todays = inPeriod(transactions, day);
    const yesterday = summarize(transactions, { from: addDays(now, -1), to: addDays(now, -1) });
    const input = { recurring, obligations, transactions };
    // Anything overdue still needs dealing with today, so it is listed with today's items.
    const due = expectedEvents(input, day, now);
    return {
      summary: summarize(todays),
      yesterday,
      todays: sortByDateDesc(todays),
      latest: sortByDateDesc(transactions).slice(0, 5),
      due,
      dueOut: expectedTotals(due.filter((e) => e.direction === 'out')),
      dueIn: expectedTotals(due.filter((e) => e.direction === 'in')),
      budget: overallBudget(budgets, transactions, now),
      insights: buildInsights({ transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries, currency, anchor: now }),
    };
  }, [transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries, currency, now]);

  if (!space) return null;
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const { summary, budget } = view;
  const overdue = view.due.filter((e) => e.status === 'overdue');
  const dueToday = view.due.filter((e) => e.status !== 'overdue');
  const day = { from: now, to: now };

  const tiles: { label: string; amount: number; hint: string; to: string; tone?: string }[] = [
    {
      label: 'Spent today',
      amount: summary.spent,
      hint: view.yesterday.spent > 0 ? `${formatMoney(view.yesterday.spent, currency)} yesterday` : 'None yesterday',
      to: transactionsLink(day, { type: 'expense' }),
    },
    {
      label: 'Received today',
      amount: summary.income,
      hint: view.yesterday.income > 0 ? `${formatMoney(view.yesterday.income, currency)} yesterday` : 'None yesterday',
      to: transactionsLink(day, { type: 'income' }),
      tone: 'text-positive',
    },
    {
      label: 'Due today',
      amount: view.dueOut.outgoing,
      hint: (() => {
        const late = overdue.filter((e) => e.direction === 'out').length;
        const onTime = view.dueOut.count - late;
        if (view.dueOut.count === 0) return 'No payments due';
        return [onTime > 0 ? `${onTime} due today` : 'None due today', late > 0 ? `${late} overdue` : ''].filter(Boolean).join(' · ');
      })(),
      to: overdue.length > 0 ? '/money/upcoming?show=overdue' : '/money/upcoming?show=out',
      tone: overdue.some((e) => e.direction === 'out') ? 'text-negative' : undefined,
    },
  ];

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link to="/" className="text-sm font-semibold text-ink-3 hover:text-ink">
            Home
          </Link>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">Today</h1>
          <p className="mt-0.5 text-sm text-ink-3">
            {formatFullDate(now)} · {space.name}
          </p>
        </div>
        {/* Phones already have the floating add button. */}
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={openMenu} className="max-sm:hidden">
          Add
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {tiles.map((t, i) => (
          <Link
            key={t.label}
            to={t.to}
            className={cn(
              'block min-w-0 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong sm:p-5',
              i === 2 && 'col-span-2 sm:col-span-1',
            )}
          >
            <span className="text-[13px] font-semibold text-ink-3">{t.label}</span>
            <span className={cn('money mt-2 block truncate text-xl font-extrabold tracking-tight sm:text-[28px]', t.tone ?? 'text-ink')}>{formatMoney(t.amount, currency)}</span>
            <span className="mt-2 block truncate text-xs text-ink-3">{t.hint}</span>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <InsightCard insights={view.insights} single />

          {/* Budget remaining */}
          <Card>
            <CardHeader title="Budget remaining" action={<TextLink to="/money/budgets">Budgets</TextLink>} />
            {!budget ? (
              <EmptyState
                icon={PiggyBank}
                title="No overall budget"
                message="Set a budget for all spending to see what is left each day."
                action={<TextLink to="/money/budgets">Create a budget</TextLink>}
                className="py-6"
              />
            ) : (
              (() => {
                const s = budget.status;
                const style = s.alert ? ALERT_STYLE[s.alert] : null;
                return (
                  <div>
                    <p className="text-[13px] font-semibold text-ink-3">
                      {s.budget.name} · {formatDay(s.period!.from)} to {formatDay(s.period!.to)}
                    </p>
                    <p className={cn('money mt-1 text-[28px] font-extrabold leading-tight tracking-tight', s.remaining < 0 ? 'text-negative' : 'text-ink')}>
                      {s.remaining < 0 ? `${formatMoney(-s.remaining, currency)} over` : `${formatMoney(s.remaining, currency)} left`}
                    </p>
                    <ProgressBar value={s.used} color={style?.bar} label={`${s.budget.name} budget used`} className="mt-3 !h-2" />
                    <p className="mt-2 text-sm text-ink-2">
                      {formatMoney(s.spent, currency)} of {formatMoney(s.budget.amount, currency)} spent, {s.daysLeft + 1} {s.daysLeft === 0 ? 'day' : 'days'} including today.
                    </p>
                    <p className="mt-3 rounded-control bg-canvas px-3.5 py-3 text-sm text-ink">
                      {budget.perDay !== null ? (
                        <>
                          About <span className="money font-bold">{formatMoney(budget.perDay, currency)}</span> a day keeps you within it.
                        </>
                      ) : (
                        'Nothing is left in this budget for the rest of the period.'
                      )}
                    </p>
                  </div>
                );
              })()
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {/* Payments due today */}
          <Card>
            <CardHeader
              title="Due today"
              subtitle={view.due.length === 0 ? 'Nothing due' : `${dueToday.length} today${overdue.length > 0 ? ` · ${overdue.length} overdue` : ''}`}
              action={<TextLink to="/money/upcoming">Coming up</TextLink>}
            />
            {view.due.length === 0 ? (
              <EmptyState icon={CalendarCheck} title="Nothing due today" message="No payments or receipts are expected today, and nothing is overdue." className="py-6" />
            ) : (
              <ul className="space-y-0.5">
                {[...overdue, ...dueToday].map((e) => (
                  <li key={e.key}>
                    <ExpectedRow e={e} people={people} currency={currency} to={e.status === 'overdue' ? '/money/upcoming?show=overdue' : '/money/upcoming?show=soon'} />
                  </li>
                ))}
              </ul>
            )}
            {view.dueIn.count > 0 && (
              <p className="mt-3 text-xs text-ink-3">
                Expected to come in: <span className="money font-semibold text-positive">{formatMoney(view.dueIn.incoming, currency)}</span>
              </p>
            )}
          </Card>

          {/* Recent activity */}
          <Card>
            <CardHeader
              title="Recent activity"
              subtitle={view.todays.length > 0 ? `${view.todays.length} recorded today` : 'Nothing recorded today yet'}
              action={<TextLink to="/transactions">All transactions</TextLink>}
            />
            {(view.todays.length > 0 ? view.todays : view.latest).length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No transactions yet"
                message="Record what you spend or receive. It only takes a few seconds."
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={openMenu}>
                    Add transaction
                  </Button>
                }
              />
            ) : (
              <>
                {view.todays.length === 0 && <p className="mb-1 text-xs font-semibold text-ink-3">Your latest entries</p>}
                <ul className="-mx-2">
                  {(view.todays.length > 0 ? view.todays : view.latest).map((t) => (
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
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
