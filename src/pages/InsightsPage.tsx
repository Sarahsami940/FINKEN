import { ArrowRight, Info, Lightbulb, ShieldCheck, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DonutChart } from '../components/charts/DonutChart';
import { MiniBars } from '../components/charts/MiniBars';
import { MonthlyBars } from '../components/charts/MonthlyBars';
import { TextLink } from '../components/money/DashboardParts';
import { CategoryIcon } from '../components/money/parts';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Input, Select } from '../components/ui/Field';
import { Badge, EmptyState, PageHeader, ProgressBar, Segmented } from '../components/ui/Misc';
import { useAppState, useSpaceData } from '../data/hooks';
import {
  ANALYTICS_RANGES,
  analyticsRange,
  budgetAdherence,
  categoryTrends,
  dailyStats,
  monthsIn,
  recurringBreakdown,
  weekdaySpending,
  type AnalyticsRange,
} from '../domain/analytics';
import { formatDay, formatMonth, formatMonthYear, monthRange, today } from '../domain/dates';
import { transactionsLink } from '../domain/dashboard';
import { formatMoney, formatPercent } from '../domain/format';
import {
  DEFAULT_SAFE_OPTIONS,
  HEALTH_LABEL,
  healthChange,
  moneyHealth,
  safeToSpend,
  type HealthLevel,
  type PlanningInput,
  type SafeToSpendOptions,
} from '../domain/health';
import { buildInsights, INSIGHT_SECTIONS, type Insight, type InsightSection } from '../domain/insights';
import { inPeriod, spendingByCategory, summarize } from '../domain/money';
import { colorOf } from '../domain/palette';
import { frequencyLabel } from '../domain/planning';
import type { Category, Transaction } from '../domain/types';

type Tab = 'overview' | 'analytics' | 'feed';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'feed', label: 'Finken noticed' },
];

const TONE: Record<Insight['tone'], string> = {
  neutral: 'bg-accent-soft text-accent-strong',
  positive: 'bg-positive-soft text-positive',
  attention: 'bg-warning-soft text-warning',
};

export function InsightsPage() {
  const { space } = useSpaceData();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.value === params.get('tab')) ? (params.get('tab') as Tab) : 'overview';

  function setTab(value: Tab) {
    const next = new URLSearchParams();
    if (value !== 'overview') next.set('tab', value);
    setParams(next, { replace: true });
  }

  if (!space) return null;
  return (
    <div>
      <PageHeader title="Insights" subtitle={`What ${space.name}'s records are showing, and what to do next`} />
      <div className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <Segmented value={tab} onChange={setTab} options={TABS} label="Insights view" />
      </div>
      {tab === 'overview' && <Overview onFeed={() => setTab('feed')} />}
      {tab === 'analytics' && <Analytics />}
      {tab === 'feed' && <Feed />}
    </div>
  );
}

// ── Overview: Safe to Spend, Money Health, top insights ───────────────────

function usePlanning(): { input: PlanningInput; currency: string } {
  const { currency, accounts, transactions, recurring, obligations, budgets, goals, goalEntries } = useSpaceData();
  const input = useMemo(
    () => ({ accounts, transactions, recurring, obligations, budgets, goals, goalEntries }),
    [accounts, transactions, recurring, obligations, budgets, goals, goalEntries],
  );
  return { input, currency };
}

function useInsights(): Insight[] {
  const { currency, transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries } = useSpaceData();
  const now = today();
  return useMemo(
    () => buildInsights({ transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries, currency, anchor: now }),
    [transactions, categories, recurring, budgets, obligations, people, accounts, goals, goalEntries, currency, now],
  );
}

function Overview({ onFeed }: { onFeed: () => void }) {
  const insights = useInsights();
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <div className="min-w-0 xl:col-span-3">
        <SafeToSpendCard />
      </div>
      <div className="min-w-0 space-y-4 xl:col-span-2">
        <MoneyHealthCard />
        <Card>
          <CardHeader
            title="Finken noticed"
            subtitle={insights.length > 0 ? `${insights.length} ${insights.length === 1 ? 'thing' : 'things'} worth a look` : 'Based only on what you have recorded'}
            action={
              insights.length > 3 ? (
                <button type="button" onClick={onFeed} className="inline-flex items-center gap-1 text-[13px] font-bold text-accent hover:text-accent-strong">
                  See all <ArrowRight aria-hidden className="size-3.5" />
                </button>
              ) : undefined
            }
          />
          {insights.length === 0 ? (
            <EmptyState icon={Lightbulb} title="Nothing to point out yet" message="Finken needs a little more history in this Space before it can spot patterns." className="py-6" />
          ) : (
            <ul className="space-y-4">
              {insights.slice(0, 3).map((insight) => (
                <li key={insight.id} className="flex gap-3.5">
                  <span aria-hidden className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', TONE[insight.tone])}>
                    <Lightbulb className="size-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink">{insight.title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{insight.detail}</p>
                    {insight.action && (
                      <div className="mt-1.5">
                        <TextLink to={insight.action.to}>{insight.action.label}</TextLink>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function SafeToSpendCard() {
  const { input, currency } = usePlanning();
  const [options, setOptions] = useState<SafeToSpendOptions>(DEFAULT_SAFE_OPTIONS);
  const now = today();
  const safe = useMemo(() => safeToSpend(input, options, now), [input, options, now]);
  const money = (n: number) => formatMoney(n, currency);
  const negative = safe.amount < 0;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink-3">
            <ShieldCheck aria-hidden className="size-4 text-accent" />
            Safe to spend
          </p>
          <p className={cn('money mt-2 text-[34px] font-extrabold leading-tight tracking-tight sm:text-[40px]', negative ? 'text-negative' : 'text-ink')}>
            {negative ? `−${money(-safe.amount)}` : money(safe.amount)}
          </p>
          <p className="mt-1 text-sm text-ink-2">
            {negative ? (
              <>What is already committed is more than you have, until {formatDay(safe.until)}.</>
            ) : (
              <>
                Until {formatDay(safe.until)} ({safe.days} {safe.days === 1 ? 'day' : 'days'}), about <span className="money font-bold text-ink">{money(safe.perDay)}</span> a day.
              </>
            )}
          </p>
        </div>
      </div>

      <h3 className="mt-6 text-sm font-bold text-ink">How this is worked out</h3>
      <ul className="mt-2 divide-y divide-line border-y border-line">
        {safe.lines.map((line) => {
          const adds = line.key === 'available';
          return (
            <li key={line.key} className={cn('flex gap-3 py-3', !line.included && 'opacity-55')}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  {line.optional ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink">
                      <input
                        type="checkbox"
                        checked={line.included}
                        onChange={(e) => setOptions((o) => ({ ...o, [line.optional!]: e.target.checked }))}
                        className="size-4 accent-[var(--color-accent)]"
                      />
                      {line.label}
                    </label>
                  ) : (
                    <span className="text-sm font-semibold text-ink">{line.label}</span>
                  )}
                </span>
                <span className={cn('mt-0.5 block text-xs leading-relaxed text-ink-3', line.optional && 'pl-6')}>{line.explanation}</span>
              </span>
              <span className={cn('money shrink-0 text-sm font-bold', adds ? 'text-ink' : line.included && line.amount > 0 ? 'text-negative' : 'text-ink-3')}>
                {adds ? money(line.amount) : `−${money(line.amount)}`}
              </span>
            </li>
          );
        })}
        <li className="flex items-center justify-between gap-3 py-3">
          <span className="text-sm font-bold text-ink">Estimated safe to spend</span>
          <span className={cn('money text-base font-extrabold', negative ? 'text-negative' : 'text-ink')}>{negative ? `−${money(-safe.amount)}` : money(safe.amount)}</span>
        </li>
      </ul>

      {safe.expectedIn > 0 && (
        <p className="mt-4 rounded-control bg-positive-soft px-3.5 py-3 text-sm text-ink">
          <span className="money font-bold text-positive">{money(safe.expectedIn)}</span> is expected to come in before {formatDay(safe.until)}. It is not counted here
          until it actually arrives.{' '}
          <Link to="/money/upcoming?show=in" className="font-bold text-accent hover:text-accent-strong">
            See what is expected
          </Link>
        </p>
      )}
      <p className="mt-4 flex gap-2 text-xs leading-relaxed text-ink-3">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        This is an estimate based on recorded information, not a guaranteed available bank balance. Untick a line to see the figure without it.
      </p>
    </Card>
  );
}

const LEVEL_STYLE: Record<HealthLevel, { tone: 'positive' | 'warning' | 'negative'; ring: string }> = {
  steady: { tone: 'positive', ring: 'var(--color-positive)' },
  mixed: { tone: 'warning', ring: 'var(--color-warning)' },
  attention: { tone: 'negative', ring: 'var(--color-negative)' },
};

function factorColor(score: number) {
  return score >= 0.75 ? 'var(--color-positive)' : score >= 0.5 ? 'var(--color-warning)' : 'var(--color-negative)';
}

function MoneyHealthCard() {
  const { input } = usePlanning();
  const now = today();
  const { health, change } = useMemo(() => ({ health: moneyHealth(input, now), change: healthChange(input, now) }), [input, now]);
  const style = health.level ? LEVEL_STYLE[health.level] : null;

  return (
    <Card>
      <CardHeader title="Money Health" subtitle="A quick read of how things are going" />
      {!health.level ? (
        <EmptyState icon={Sparkles} title="Not enough to read yet" message="Money Health needs a few months of records, or a budget or goal, before it can say anything useful." className="py-6" />
      ) : (
        <>
          <div className="flex items-center gap-4">
            <span
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-full"
              style={{ background: `conic-gradient(${style!.ring} ${Math.round(health.score! * 360)}deg, var(--color-sunken) 0deg)` }}
            >
              <span className="size-10 rounded-full bg-surface" />
            </span>
            <div className="min-w-0">
              <Badge tone={style!.tone} className="text-[13px]">
                {HEALTH_LABEL[health.level]}
              </Badge>
              <p className="mt-1.5 text-[13px] leading-snug text-ink-2">
                {change.direction === 'better' && 'Better than 30 days ago.'}
                {change.direction === 'lower' && 'Lower than 30 days ago.'}
                {change.direction === 'same' && 'About the same as 30 days ago.'}
                {change.direction === null && 'Not enough history to compare with 30 days ago.'}
                {change.moved.length > 0 &&
                  ` ${change.moved
                    .slice(0, 2)
                    .map((m) => `${m.factor.label} ${m.delta > 0 ? 'improved' : 'slipped'}`)
                    .join(', and ')}.`}
              </p>
            </div>
          </div>
          <ul className="mt-5 space-y-3.5">
            {health.factors.map((f) => (
              <li key={f.key}>
                <Link to={f.to} className="group block">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-ink group-hover:text-accent">{f.label}</span>
                    {f.score === null && <span className="text-xs text-ink-3">Not measured</span>}
                  </span>
                  {f.score !== null && <ProgressBar value={f.score} color={factorColor(f.score)} label={`${f.label}`} className="mt-1.5" />}
                  <span className="mt-1 block text-xs leading-relaxed text-ink-3">{f.note}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-4 flex gap-2 text-xs leading-relaxed text-ink-3">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Worked out only from what you have recorded in this Space. It is not a credit score or a judgement.
      </p>
    </Card>
  );
}

// ── Finken noticed feed ────────────────────────────────────────────────────

function Feed() {
  const insights = useInsights();
  const [section, setSection] = useState<InsightSection | 'all'>('all');
  const present = INSIGHT_SECTIONS.filter((s) => insights.some((i) => i.section === s.value));
  const shown = section === 'all' ? insights : insights.filter((i) => i.section === section);

  if (insights.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Lightbulb}
          title="Nothing to point out yet"
          message="Finken only shares what your records support. Keep recording income and spending, and insights will appear here."
        />
      </Card>
    );
  }
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Insight topic">
        {[{ value: 'all' as const, label: `All (${insights.length})` }, ...present.map((s) => ({ value: s.value, label: s.label }))].map((s) => (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={section === s.value}
            onClick={() => setSection(s.value)}
            className={cn(
              'h-8 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              section === s.value ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink-2 hover:border-line-strong',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="grid gap-4 lg:grid-cols-2">
        {shown.map((insight) => (
          <li key={insight.id}>
            <Card className="flex h-full flex-col">
              <div className="flex items-start gap-3.5">
                <span aria-hidden className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', TONE[insight.tone])}>
                  <Lightbulb className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-wider text-ink-3">{INSIGHT_SECTIONS.find((s) => s.value === insight.section)?.label}</p>
                  <p className="mt-0.5 text-[15px] font-bold text-ink">{insight.title}</p>
                </div>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-2">{insight.detail}</p>
              {insight.why && (
                <p className="mt-2 text-sm leading-relaxed text-ink-2">
                  <span className="font-semibold text-ink">Why it matters: </span>
                  {insight.why}
                </p>
              )}
              {insight.facts && insight.facts.length > 0 && (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-control bg-canvas px-3.5 py-3 text-[13px]">
                  {insight.facts.map((f) => (
                    <div key={f.label} className="min-w-0">
                      <dt className="truncate text-ink-3">{f.label}</dt>
                      <dd className="money truncate font-bold text-ink">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {insight.action && (
                <div className="mt-auto pt-3">
                  <TextLink to={insight.action.to}>{insight.action.label}</TextLink>
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────

const ALL = 'all';
const PER: Record<string, string> = { weekly: 'a week', monthly: 'a month', yearly: 'a year', custom: 'in total' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Categories with the same name in different Spaces are shown as one. */
function mergeByName(transactions: Transaction[], categories: Category[]) {
  const canonical = new Map<string, Category>();
  const remap = new Map<string, string>();
  for (const c of categories) {
    const key = `${c.kind}:${c.name.toLowerCase()}`;
    if (!canonical.has(key)) canonical.set(key, c);
    remap.set(c.id, canonical.get(key)!.id);
  }
  return {
    categories: [...canonical.values()],
    transactions: transactions.map((t) => (t.categoryId && remap.get(t.categoryId) !== t.categoryId ? { ...t, categoryId: remap.get(t.categoryId) } : t)),
  };
}

function Analytics() {
  const state = useAppState();
  const active = useSpaceData();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const now = today();

  const activeSpaces = state.spaces.filter((s) => s.status === 'active');
  const currencies = new Set(activeSpaces.map((s) => s.currency));
  // Adding up Spaces only makes sense when they share a currency.
  const canCombine = activeSpaces.length > 1 && currencies.size === 1;
  const allSpaces = canCombine && params.get('space') === ALL;
  const range: AnalyticsRange = ANALYTICS_RANGES.some((r) => r.value === params.get('range')) ? (params.get('range') as AnalyticsRange) : '6m';
  const customFrom = params.get('from') ?? '';
  const customTo = params.get('to') ?? '';
  const dates = useMemo(() => analyticsRange(range, now, { from: customFrom, to: customTo }), [range, now, customFrom, customTo]);
  const [withIncome, setWithIncome] = useState<'spent' | 'both'>('both');

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    next.set('tab', 'analytics');
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  }

  const data = useMemo(() => {
    const ids = new Set(allSpaces ? activeSpaces.map((s) => s.id) : active.space ? [active.space.id] : []);
    const own = <T extends { spaceId: string }>(items: T[]) => items.filter((i) => ids.has(i.spaceId));
    const merged = allSpaces ? mergeByName(own(state.transactions), own(state.categories)) : { transactions: active.transactions, categories: active.categories };
    return {
      transactions: merged.transactions,
      categories: merged.categories,
      budgets: allSpaces ? own(state.budgets) : active.budgets,
      recurring: allSpaces ? own(state.recurring) : active.recurring,
      budgetTransactions: allSpaces ? own(state.transactions) : active.transactions,
    };
  }, [allSpaces, activeSpaces, active, state.transactions, state.categories, state.budgets, state.recurring]);

  const view = useMemo(() => {
    const list = inPeriod(data.transactions, dates);
    const months = monthsIn(data.transactions, dates);
    return {
      totals: summarize(list),
      months,
      byCategory: spendingByCategory(list, data.categories).filter((c) => c.amount > 0),
      trends: categoryTrends(data.transactions, data.categories, dates, 5, now),
      adherence: budgetAdherence(data.budgets, data.budgetTransactions, now, 6),
      recurring: recurringBreakdown(data.recurring),
      weekdays: weekdaySpending(data.transactions, dates),
      daily: dailyStats(data.transactions, dates, 12),
    };
  }, [data, dates, now]);

  const currency = allSpaces ? [...currencies][0] : active.currency;
  const money = (n: number) => formatMoney(n, currency);
  const spaceParam = allSpaces ? ALL : undefined;
  const link = (r: { from: string; to: string }, extra: Record<string, string | undefined> = {}) => transactionsLink(r, { ...extra, space: spaceParam });
  const monthCount = view.months.length;
  // Only finished months count towards a typical month; the current one is still going.
  const spentMonths = view.months.filter((m) => m.spent > 0 && m.to < now && m.from === monthRange(m.from).from && m.to === monthRange(m.from).to);
  const averageSpent = spentMonths.length ? spentMonths.reduce((s, m) => s + m.spent, 0) / spentMonths.length : 0;
  const hasData = view.totals.count > 0;
  const total = view.byCategory.reduce((s, c) => s + c.amount, 0);
  const segments = view.byCategory.slice(0, 6).map((c) => ({ key: c.categoryId ?? 'none', label: `${c.name}: ${money(c.amount)}`, value: c.amount, color: colorOf(c.color).fg }));
  const rest = view.byCategory.slice(6).reduce((s, c) => s + c.amount, 0);
  if (rest > 0) segments.push({ key: 'rest', label: `Everything else: ${money(rest)}`, value: rest, color: '#c9c5ba' });
  const maxWeekday = Math.max(1, ...view.weekdays.map((w) => w.average));
  const busiest = view.weekdays.reduce((a, b) => (b.average > a.average ? b : a), view.weekdays[0]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {activeSpaces.length > 1 && (
          <Select
            aria-label="Space"
            value={allSpaces ? ALL : active.space?.id}
            onChange={(e) => update({ space: e.target.value === ALL ? ALL : null })}
            className="!h-10 !w-auto"
          >
            <option value={active.space?.id}>{active.space?.name}</option>
            {canCombine && <option value={ALL}>All Spaces</option>}
          </Select>
        )}
        <div className="-mx-4 max-w-[calc(100%+2rem)] overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:px-0">
          <Segmented
            value={range}
            onChange={(v) => update(v === 'custom' ? { range: v, from: dates.from, to: dates.to } : { range: v === '6m' ? null : v, from: null, to: null })}
            options={ANALYTICS_RANGES}
            label="Date range"
          />
        </div>
        {range === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
            <label className="flex items-center gap-2">
              <span className="font-semibold">From</span>
              <Input type="date" value={customFrom} max={customTo || undefined} onChange={(e) => update({ from: e.target.value || null })} className="!h-9 !w-auto" />
            </label>
            <label className="flex items-center gap-2">
              <span className="font-semibold">to</span>
              <Input type="date" value={customTo} min={customFrom || undefined} onChange={(e) => update({ to: e.target.value || null })} className="!h-9 !w-auto" />
            </label>
          </div>
        )}
      </div>
      {activeSpaces.length > 1 && !canCombine && (
        <p className="mb-4 text-xs text-ink-3">Your Spaces use different currencies, so they are not added together.</p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: 'Income', value: view.totals.income, to: link(dates, { type: 'income' }), tone: 'text-positive' },
          { label: 'Spent', value: view.totals.spent, to: link(dates, { type: 'expense' }) },
          { label: 'Net', value: view.totals.net, to: link(dates), tone: view.totals.net < 0 ? 'text-negative' : undefined },
          { label: 'Typical full month spent', value: averageSpent },
        ].map((f) => {
          const body = (
            <>
              <span className="text-[13px] font-semibold text-ink-3">{f.label}</span>
              <span className={cn('money mt-1 block truncate text-xl font-extrabold tracking-tight', f.tone ?? 'text-ink')}>{money(f.value)}</span>
            </>
          );
          const cls = 'block min-w-0 rounded-card border border-line bg-surface p-4 shadow-card';
          return f.to ? (
            <Link key={f.label} to={f.to} className={cn(cls, 'hover:border-line-strong')}>
              {body}
            </Link>
          ) : (
            <div key={f.label} className={cls}>
              {body}
            </div>
          );
        })}
      </div>

      {!hasData ? (
        <Card>
          <EmptyState icon={Sparkles} title="Nothing recorded in this range" message="Pick a longer range, or record some income and spending first." />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard
            title={withIncome === 'both' ? 'Income and spending by month' : 'Monthly spending'}
            subtitle={`${formatDay(dates.from)} – ${formatDay(dates.to)} · ${monthCount} ${monthCount === 1 ? 'month' : 'months'}`}
            action={
              <Segmented
                value={withIncome}
                onChange={setWithIncome}
                options={[
                  { value: 'both', label: 'With income' },
                  { value: 'spent', label: 'Spending' },
                ]}
                label="Chart contents"
                className="[&>button]:h-8 [&>button]:px-2.5 [&>button]:text-xs"
              />
            }
          >
            <MonthlyBars
              data={view.months.map((m) => ({ month: m.from, income: m.income, spent: m.spent, net: m.net }))}
              currency={currency}
              showIncome={withIncome === 'both'}
              onSelect={(p) => {
                const m = view.months.find((x) => x.from === p.month)!;
                navigate(link(m, { type: withIncome === 'spent' ? 'expense' : undefined }));
              }}
            />
            {withIncome === 'both' && (
              <div className="mt-4 flex gap-2 overflow-x-auto border-t border-line pt-3 text-xs [scrollbar-width:none]">
                {view.months.map((m) => (
                  <span key={m.from} className="min-w-14 flex-1 text-center">
                    <span className="block text-ink-3">{formatMonth(m.from, 'short')} net</span>
                    <span className={cn('money block font-bold', m.net < 0 ? 'text-negative' : 'text-positive')}>{formatMoney(m.net, currency, { compact: true })}</span>
                  </span>
                ))}
              </div>
            )}
          </ChartCard>

          <ChartCard title="Where it went" subtitle="Spending by category over the range">
            {view.byCategory.length === 0 ? (
              <EmptyState icon={Sparkles} title="No spending in this range" message="Expenses are grouped here by category." className="py-6" />
            ) : (
              <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
                <div className="flex justify-center">
                  <DonutChart segments={segments} label="Spending by category">
                    <span className="text-xs font-semibold text-ink-3">Spent</span>
                    <span className="money text-lg font-extrabold text-ink">{formatMoney(total, currency, { compact: true })}</span>
                  </DonutChart>
                </div>
                <ul className="min-w-0 space-y-2.5">
                  {view.byCategory.slice(0, 7).map((c) => (
                    <li key={c.categoryId ?? 'none'}>
                      <Link
                        to={link(dates, { type: 'expense', category: allSpaces ? undefined : c.categoryId })}
                        className="flex items-center gap-3 rounded-lg text-sm hover:text-accent"
                      >
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(c.color).fg }} />
                        <span className="min-w-0 flex-1 truncate font-semibold text-ink">{c.name}</span>
                        <span className="text-xs text-ink-3">{formatPercent(c.amount / total)}</span>
                        <span className="money font-bold text-ink">{money(c.amount)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </ChartCard>

          <ChartCard title="Spending trends" subtitle="Your largest categories, month by month">
            {view.trends.length === 0 ? (
              <EmptyState icon={Sparkles} title="No trends yet" message="Trends appear once a category has spending in this range." className="py-6" />
            ) : (
              <ul className="divide-y divide-line">
                {view.trends.map((t) => (
                  <li key={t.category.categoryId ?? 'none'} className="flex items-center gap-3 py-2.5">
                    <CategoryIcon icon={t.category.icon} color={t.category.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{t.category.name}</span>
                      <span className="block text-xs text-ink-3">
                        {t.change === null ? (
                          'Not enough full months to compare'
                        ) : Math.abs(t.change) < 0.01 ? (
                          'About the same as earlier months'
                        ) : (
                          <span className={cn('inline-flex items-center gap-1 font-semibold', t.change > 0 ? 'text-negative' : 'text-positive')}>
                            {t.change > 0 ? <TrendingUp aria-hidden className="size-3.5" /> : <TrendingDown aria-hidden className="size-3.5" />}
                            {formatPercent(t.change)} {t.change > 0 ? 'above' : 'below'} earlier months
                          </span>
                        )}
                      </span>
                    </span>
                    <MiniBars
                      values={t.months}
                      color={colorOf(t.category.color).fg}
                      label={`${t.category.name} by month: ${t.months.map((v, i) => `${formatMonth(view.months[i].from, 'short')} ${money(v)}`).join(', ')}`}
                      titles={t.months.map((v, i) => `${formatMonthYear(view.months[i].from)}: ${money(v)}`)}
                      className="w-24 shrink-0 sm:w-32"
                    />
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>

          <ChartCard title="Budget adherence" subtitle="Each bar is one budget period; the dashed line is the limit" action={<TextLink to="/money/budgets">Budgets</TextLink>}>
            {view.adherence.length === 0 ? (
              <EmptyState icon={Sparkles} title="No budgets yet" message="Set a budget to see how often you stay within it." action={<TextLink to="/money/budgets">Create a budget</TextLink>} className="py-6" />
            ) : (
              <ul className="divide-y divide-line">
                {view.adherence.map((a) => (
                  <li key={a.budget.id} className="flex items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{a.budget.name}</span>
                      <span className="block text-xs text-ink-3">
                        {a.finished > 0 ? `Within the limit ${a.kept} of ${a.finished} times` : 'First period still running'} · {money(a.budget.amount)} {PER[a.budget.frequency]}
                      </span>
                    </span>
                    <MiniBars
                      values={a.periods.map((p) => p.spent)}
                      limit={a.budget.amount}
                      label={`${a.budget.name}: ${a.periods.map((p) => `${formatDay(p.range.from)} ${money(p.spent)}`).join(', ')}`}
                      titles={a.periods.map((p) => `${formatDay(p.range.from)} – ${formatDay(p.range.to)}${p.current ? ' (so far)' : ''}: ${money(p.spent)} of ${money(a.budget.amount)}`)}
                      className="w-24 shrink-0 sm:w-32"
                    />
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>

          <ChartCard title="Regular payments" subtitle="Active recurring expenses, as a monthly amount" action={<TextLink to="/money/recurring">Recurring</TextLink>}>
            {view.recurring.items.length === 0 ? (
              <EmptyState icon={Sparkles} title="No regular payments" message="Add bills and subscriptions to see what they cost each month." className="py-6" />
            ) : (
              <>
                <p className="mb-3 text-sm text-ink-2">
                  About <span className="money font-bold text-ink">{money(view.recurring.monthlyTotal)}</span> a month
                  {view.recurring.monthlyIncome > 0 && (
                    <>
                      , against <span className="money font-bold text-ink">{money(view.recurring.monthlyIncome)}</span> of regular income
                    </>
                  )}
                  .
                </p>
                <ul className="space-y-3">
                  {view.recurring.items.slice(0, 6).map(({ recurring: r, monthly }) => (
                    <li key={r.id}>
                      <span className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-semibold text-ink">{r.name}</span>
                        <span className="money shrink-0 font-bold text-ink">{money(monthly)}</span>
                      </span>
                      <span className="block text-xs text-ink-3">
                        {money(r.amount)} {frequencyLabel(r).toLowerCase()}
                      </span>
                      <ProgressBar value={monthly / view.recurring.monthlyTotal} label={`${r.name} share of regular payments`} className="mt-1.5" />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </ChartCard>

          <ChartCard title="Daily and weekly habits" subtitle="Average spending on each day of the week">
            <div role="img" aria-label={view.weekdays.map((w) => `${WEEKDAYS[w.day]}: ${money(w.average)} on average`).join('; ')} className="flex h-32 items-end gap-2 sm:gap-3">
              {view.weekdays.map((w) => (
                <span key={w.day} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${WEEKDAYS[w.day]}: ${money(w.average)} on average, ${money(w.total)} in total`}>
                  <span className="money mb-1 text-[10px] font-semibold text-ink-3">{formatMoney(w.average, currency, { compact: true }).replace(/^\S+\s/, '')}</span>
                  <span
                    className={cn('w-full max-w-8 rounded-t-md', w.day === busiest.day ? 'bg-accent' : 'bg-accent/30')}
                    style={{ height: `${w.average > 0 ? Math.max(3, (w.average / maxWeekday) * 100) : 2}%` }}
                  />
                </span>
              ))}
            </div>
            <div aria-hidden className="mt-2 flex gap-2 border-t border-line pt-2 sm:gap-3">
              {view.weekdays.map((w) => (
                <span key={w.day} className={cn('min-w-0 flex-1 text-center text-xs font-medium', w.day === busiest.day ? 'text-ink' : 'text-ink-3')}>
                  {WEEKDAYS[w.day]}
                </span>
              ))}
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
              <Stat label="Per day" value={money(view.daily.perDay)} />
              <Stat label="No-spend days" value={`${view.daily.noSpendDays} of ${view.daily.days}`} />
              <Stat label="Heaviest day" value={view.daily.peak ? `${formatDay(view.daily.peak.date)}, ${formatMoney(view.daily.peak.amount, currency, { compact: true })}` : '—'} />
            </dl>
            <h3 className="mt-5 text-[13px] font-semibold text-ink-3">Spending per week, last {view.daily.weeks.length} weeks</h3>
            <MiniBars
              values={view.daily.weeks.map((w) => w.spent)}
              label={`Weekly spending: ${view.daily.weeks.map((w) => `${formatDay(w.from)} ${money(w.spent)}`).join(', ')}`}
              titles={view.daily.weeks.map((w) => `${formatDay(w.from)} – ${formatDay(w.to)}: ${money(w.spent)}`)}
              className="mt-2 !h-16 [&>span]:!max-w-none"
            />
          </ChartCard>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-control bg-canvas px-3 py-2.5">
      <dt className="truncate text-ink-3">{label}</dt>
      <dd className="money truncate font-bold text-ink">{value}</dd>
    </div>
  );
}
