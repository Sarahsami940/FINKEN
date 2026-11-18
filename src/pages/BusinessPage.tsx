import { AlertCircle, Download, FileText, Info, Pencil, Plus, Users } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ExpectedRow, TextLink } from '../components/money/DashboardParts';
import { ReceivePayForm } from '../components/money/OwedForms';
import { ObligationEditor, PersonEditor } from '../components/money/OwedSheets';
import { CategoryIcon } from '../components/money/parts';
import { Button, IconButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Input, Select } from '../components/ui/Field';
import { Badge, EmptyState, PageHeader, Segmented } from '../components/ui/Misc';
import { useToast } from '../components/ui/Toast';
import { useSpaceData } from '../data/hooks';
import { store } from '../data/store';
import {
  AGE_BUCKETS,
  ageing,
  BUSINESS_RANGES,
  businessRange,
  comparableRanges,
  byContact,
  cashFlow,
  cashForecast,
  contactSummaries,
  monthlyCashFlow,
  previousRange,
  profitAndLoss,
  ROLE_LABEL,
  type AgeingSummary,
  type BusinessRange,
} from '../domain/business';
import { formatDay, formatDueLabel, formatMonthYear, today } from '../domain/dates';
import { transactionsLink } from '../domain/dashboard';
import { formatMoney, formatPercent } from '../domain/format';
import { changeRatio } from '../domain/money';
import { buildReport, REPORTS, reportToCsv, type ReportKey } from '../domain/reports';
import type { Category, CostType, DateRange, Obligation, Person, PersonRole } from '../domain/types';

type Tab = 'overview' | 'contacts' | 'owed' | 'pnl' | 'cash' | 'reports';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'contacts', label: 'Customers & suppliers' },
  { value: 'owed', label: 'Receivables & payables' },
  { value: 'pnl', label: 'Profit & loss' },
  { value: 'cash', label: 'Cash flow' },
  { value: 'reports', label: 'Reports' },
];
/** Tabs that look at a period; the others show where things stand today. */
const USES_RANGE = new Set<Tab>(['overview', 'contacts', 'pnl', 'cash', 'reports']);

function useBusinessParams() {
  const [params, setParams] = useSearchParams();
  const now = today();
  const tab: Tab = TABS.some((t) => t.value === params.get('tab')) ? (params.get('tab') as Tab) : 'overview';
  const range: BusinessRange = BUSINESS_RANGES.some((r) => r.value === params.get('range')) ? (params.get('range') as BusinessRange) : 'month';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const dates = useMemo(() => businessRange(range, now, { from, to }), [range, now, from, to]);
  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  }
  return { tab, range, from, to, dates, now, update };
}

export function BusinessPage() {
  const { space } = useSpaceData();
  const p = useBusinessParams();
  if (!space) return null;
  // Business Mode belongs to business Spaces; anywhere else, Money has the same records.
  if (space.type !== 'business') return <Navigate to="/money" replace />;

  return (
    <div>
      <PageHeader title="Business" subtitle={`${space.name}: sales, costs, cash and who owes what`} />
      <div className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
        <Segmented value={p.tab} onChange={(v) => p.update({ tab: v === 'overview' ? null : v })} options={TABS} label="Business view" />
      </div>
      {USES_RANGE.has(p.tab) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="-mx-4 max-w-[calc(100%+2rem)] overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:px-0">
            <Segmented
              value={p.range}
              onChange={(v) => p.update(v === 'custom' ? { range: v, from: p.dates.from, to: p.dates.to } : { range: v === 'month' ? null : v, from: null, to: null })}
              options={BUSINESS_RANGES}
              label="Period"
            />
          </div>
          {p.range === 'custom' ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-3">
              <label className="flex items-center gap-2">
                <span className="font-semibold">From</span>
                <Input type="date" value={p.from} max={p.to || undefined} onChange={(e) => p.update({ from: e.target.value || null })} className="!h-9 !w-auto" />
              </label>
              <label className="flex items-center gap-2">
                <span className="font-semibold">to</span>
                <Input type="date" value={p.to} min={p.from || undefined} onChange={(e) => p.update({ to: e.target.value || null })} className="!h-9 !w-auto" />
              </label>
            </div>
          ) : (
            <span className="text-sm font-semibold text-ink-3">
              {formatDay(p.dates.from)} – {formatDay(p.dates.to)} {p.dates.to.slice(0, 4)}
            </span>
          )}
        </div>
      )}
      {p.tab === 'overview' && <Overview dates={p.dates} now={p.now} onTab={(tab) => p.update({ tab })} />}
      {p.tab === 'contacts' && <Contacts dates={p.dates} now={p.now} />}
      {p.tab === 'owed' && <Owed now={p.now} />}
      {p.tab === 'pnl' && <Pnl dates={p.dates} />}
      {p.tab === 'cash' && <Cash dates={p.dates} now={p.now} />}
      {p.tab === 'reports' && <Reports dates={p.dates} now={p.now} />}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────

function Tile({ label, amount, currency, hint, to, onClick, tone }: { label: string; amount: number; currency: string; hint?: ReactNode; to?: string; onClick?: () => void; tone?: 'positive' | 'negative' }) {
  const body = (
    <>
      <span className="block text-[13px] font-semibold text-ink-3">{label}</span>
      <span className={cn('money mt-1.5 block truncate text-xl font-extrabold tracking-tight', tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-ink')}>
        {formatMoney(amount, currency)}
      </span>
      {hint && <span className="mt-1 block truncate text-xs text-ink-3">{hint}</span>}
    </>
  );
  const cls = 'block min-w-0 rounded-card border border-line bg-surface p-4 text-left shadow-card transition-colors';
  if (to)
    return (
      <Link to={to} className={cn(cls, 'hover:border-line-strong')}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cn(cls, 'hover:border-line-strong')}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}

function Disclaimer({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 flex gap-2 text-xs leading-relaxed text-ink-3">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Amount({ value, currency, strong, className }: { value: number; currency: string; strong?: boolean; className?: string }) {
  return (
    <span className={cn('money whitespace-nowrap text-right', strong ? 'font-extrabold text-ink' : 'font-semibold text-ink-2', value < 0 && 'text-negative', className)}>
      {value < 0 ? `−${formatMoney(-value, currency)}` : formatMoney(value, currency)}
    </span>
  );
}

function rangeLabel(r: DateRange) {
  return `${formatDay(r.from)} – ${formatDay(r.to)}`;
}

// ── Overview: the business dashboard ──────────────────────────────────────

function Overview({ dates, now, onTab }: { dates: DateRange; now: string; onTab: (tab: Tab) => void }) {
  const { currency, accounts, transactions, categories, obligations, people, recurring } = useSpaceData();
  const view = useMemo(() => {
    const active = accounts.filter((a) => !a.archived);
    const pnl = profitAndLoss(transactions, categories, dates);
    const cmp = comparableRanges(dates, now);
    const soFar = profitAndLoss(transactions, categories, cmp.current);
    const before = profitAndLoss(transactions, categories, cmp.previous);
    return {
      pnl,
      soFar,
      before,
      partial: cmp.partial,
      forecast: cashForecast(active, { recurring, obligations, transactions }, 30, now),
      receivables: ageing(obligations, transactions, people, 'receivable', now),
      payables: ageing(obligations, transactions, people, 'payable', now),
      customers: byContact(transactions, obligations, people, dates, 'income').filter((c) => c.personId).slice(0, 4),
    };
  }, [accounts, transactions, categories, obligations, people, recurring, dates, now]);
  const money = (n: number) => formatMoney(n, currency);
  const expenses = view.pnl.costOfSales + view.pnl.operating;
  const change = (a: number, b: number) => {
    const r = changeRatio(a, b);
    return r === null || Math.abs(r) < 0.005 ? null : `${r > 0 ? 'Up' : 'Down'} ${formatPercent(r)} on ${view.partial ? 'the same point last period' : 'the period before'}`;
  };
  const commitments = view.forecast.events.filter((e) => e.direction === 'out');
  const overdueItems = [...view.receivables.items, ...view.payables.items].filter((i) => i.daysLate > 0).slice(0, 4);

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Revenue" amount={view.pnl.revenue} currency={currency} to={transactionsLink(dates, { type: 'income' })} hint={change(view.soFar.revenue, view.before.revenue) ?? 'Income received'} />
        <Tile label="Expenses" amount={expenses} currency={currency} to={transactionsLink(dates, { type: 'expense' })} hint={change(view.soFar.costOfSales + view.soFar.operating, view.before.costOfSales + view.before.operating) ?? 'Costs paid, less refunds'} />
        <Tile
          label="Net position"
          amount={view.pnl.netProfit}
          currency={currency}
          tone={view.pnl.netProfit < 0 ? 'negative' : 'positive'}
          onClick={() => onTab('pnl')}
          hint={view.pnl.netMargin !== null ? `${formatPercent(view.pnl.netMargin)} of revenue` : 'Revenue less expenses'}
        />
        <Tile label="Cash position" amount={view.forecast.now} currency={currency} to="/money" hint="In your business accounts now" />
        <Tile
          label="Receivables"
          amount={view.receivables.total}
          currency={currency}
          onClick={() => onTab('owed')}
          hint={view.receivables.overdue > 0 ? <span className="font-semibold text-negative">{money(view.receivables.overdue)} overdue</span> : 'Customers still owe'}
        />
        <Tile
          label="Payables"
          amount={view.payables.total}
          currency={currency}
          onClick={() => onTab('owed')}
          hint={view.payables.overdue > 0 ? <span className="font-semibold text-negative">{money(view.payables.overdue)} overdue</span> : 'You still owe suppliers'}
        />
        <Tile
          label="Upcoming commitments"
          amount={view.forecast.outflow}
          currency={currency}
          to="/money/upcoming?show=out"
          hint={`${commitments.length} in the next 30 days`}
        />
        <Tile label="Cash in 30 days" amount={view.forecast.projected} currency={currency} onClick={() => onTab('cash')} hint="An estimate from what is expected" tone={view.forecast.projected < 0 ? 'negative' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader title="Profit and loss" subtitle={rangeLabel(dates)} action={<button type="button" onClick={() => onTab('pnl')} className="text-[13px] font-bold text-accent hover:text-accent-strong">Details</button>} />
          <dl className="space-y-2.5 text-sm">
            {[
              ['Revenue', view.pnl.revenue, false],
              ['Cost of goods sold', -view.pnl.costOfSales, false],
              ['Gross profit', view.pnl.grossProfit, true],
              ['Operating expenses', -view.pnl.operating, false],
              ['Net profit', view.pnl.netProfit, true],
            ].map(([label, value, strong]) => (
              <div key={label as string} className={cn('flex justify-between gap-3', strong ? 'border-t border-line pt-2.5' : '')}>
                <dt className={strong ? 'font-bold text-ink' : 'text-ink-2'}>{label as string}</dt>
                <dd>
                  <Amount value={value as number} currency={currency} strong={strong as boolean} />
                </dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Coming up" subtitle="Expected in the next 30 days" action={<TextLink to="/money/upcoming">View all</TextLink>} />
          {view.forecast.events.length === 0 ? (
            <EmptyState icon={FileText} title="Nothing expected" message="No bills, invoices or repayments are expected in the next 30 days." className="py-6" />
          ) : (
            <ul className="space-y-0.5">
              {view.forecast.events.slice(0, 5).map((e) => (
                <li key={e.key}>
                  <ExpectedRow e={e} people={people} currency={currency} to={e.status === 'overdue' ? '/money/upcoming?show=overdue' : '/money/upcoming'} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Needs attention" subtitle="Overdue invoices and bills" action={<button type="button" onClick={() => onTab('owed')} className="text-[13px] font-bold text-accent hover:text-accent-strong">Ageing</button>} />
          {overdueItems.length === 0 ? (
            <EmptyState icon={AlertCircle} title="Nothing overdue" message="Every invoice and bill is within its due date." className="py-6" />
          ) : (
            <ul className="divide-y divide-line">
              {overdueItems.map((i) => (
                <li key={i.position.obligation.id} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{i.person?.name ?? i.position.obligation.title}</span>
                    <span className="block truncate text-xs font-semibold text-negative">
                      {i.position.obligation.kind === 'receivable' ? 'Owes you' : 'You owe'} · {i.daysLate} {i.daysLate === 1 ? 'day' : 'days'} late
                    </span>
                  </span>
                  <span className="money text-sm font-bold text-ink">{money(i.position.outstanding)}</span>
                </li>
              ))}
            </ul>
          )}
          {view.customers.length > 0 && (
            <>
              <h3 className="mt-4 border-t border-line pt-3 text-[13px] font-semibold text-ink-3">Top customers this period</h3>
              <ul className="mt-1.5 space-y-1.5 text-sm">
                {view.customers.map((c) => (
                  <li key={c.personId} className="flex justify-between gap-3">
                    <Link to={`/money/people/${c.personId}`} className="min-w-0 truncate font-semibold text-ink hover:text-accent">
                      {c.name}
                    </Link>
                    <span className="money font-bold text-ink">{money(c.amount)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>
      <Disclaimer>Revenue and expenses count money when it is received or paid. Loans received and repaid are never revenue or expenses.</Disclaimer>
    </div>
  );
}

// ── Customers and suppliers ───────────────────────────────────────────────

const ROLE_FILTERS: { value: PersonRole | 'all'; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'customer', label: 'Customers' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'lender', label: 'Lenders' },
  { value: 'other', label: 'Others' },
];

function Contacts({ dates, now }: { dates: DateRange; now: string }) {
  const { space, currency, people, obligations, transactions } = useSpaceData();
  const [filter, setFilter] = useState<PersonRole | 'all'>('all');
  const [editor, setEditor] = useState<{ person: Person | null } | null>(null);
  const rows = useMemo(() => contactSummaries(people, obligations, transactions, dates, now), [people, obligations, transactions, dates, now]);
  const shown = rows
    .filter((r) => filter === 'all' || (r.person.role ?? 'other') === filter)
    .sort((a, b) => b.owedToYou + b.youOwe - (a.owedToYou + a.youOwe) || a.person.name.localeCompare(b.person.name));
  const money = (n: number) => formatMoney(n, currency);

  return (
    <Card>
      <CardHeader
        title="Customers and suppliers"
        subtitle={`Balances today; money in and out for ${rangeLabel(dates)}`}
        action={
          <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ person: null })}>
            Add
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Show">
        {ROLE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            aria-checked={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'h-8 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              filter === f.value ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink-2 hover:border-line-strong',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filter === 'all' ? 'No customers or suppliers yet' : `No ${ROLE_FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} yet`}
          message="Add the people you sell to and buy from to track what they owe and what you owe them."
          action={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ person: null })}>
              Add someone
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((r) => (
            <li key={r.person.id} className="flex items-center gap-1">
              <Link to={`/money/people/${r.person.id}`} className="-ml-2 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-3 hover:bg-canvas">
                <span className="min-w-0 flex-1 basis-48">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-ink">{r.person.name}</span>
                    {r.person.role && <Badge tone={r.person.role === 'customer' ? 'positive' : 'neutral'}>{ROLE_LABEL[r.person.role]}</Badge>}
                  </span>
                  <span className="block truncate text-xs text-ink-3">
                    {[r.person.phone, r.person.email].filter(Boolean).join(' · ') || r.person.notes || 'No contact details'}
                  </span>
                </span>
                <span className="text-right text-xs text-ink-3">
                  {r.received > 0 && <span className="block">In {money(r.received)}</span>}
                  {r.paid > 0 && <span className="block">Out {money(r.paid)}</span>}
                  {r.received === 0 && r.paid === 0 && <span className="block">{r.lastActivity ? `Last ${formatDay(r.lastActivity)}` : 'No activity'}</span>}
                </span>
                <span className="w-32 text-right">
                  {r.owedToYou > 0 && <span className={cn('money block text-sm font-bold', r.overdue ? 'text-negative' : 'text-positive')}>Owes {money(r.owedToYou)}</span>}
                  {r.youOwe > 0 && <span className={cn('money block text-sm font-bold', r.overdue ? 'text-negative' : 'text-ink')}>You owe {money(r.youOwe)}</span>}
                  {r.owedToYou === 0 && r.youOwe === 0 && <span className="block text-xs text-ink-3">Settled</span>}
                </span>
              </Link>
              <IconButton label={`Edit ${r.person.name}`} onClick={() => setEditor({ person: r.person })} className="-mr-2">
                <Pencil className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {editor && space && (
        <PersonEditor
          key={editor.person?.id ?? 'new'}
          person={editor.person}
          spaceId={space.id}
          defaultRole={filter === 'all' ? 'customer' : filter}
          onClose={() => setEditor(null)}
        />
      )}
    </Card>
  );
}

// ── Receivables and payables, with ageing ─────────────────────────────────

function Owed({ now }: { now: string }) {
  const { currency, obligations, transactions, people } = useSpaceData();
  const receivables = useMemo(() => ageing(obligations, transactions, people, 'receivable', now), [obligations, transactions, people, now]);
  const payables = useMemo(() => ageing(obligations, transactions, people, 'payable', now), [obligations, transactions, people, now]);
  const [creating, setCreating] = useState<'receivable' | 'payable' | null>(null);
  const [settling, setSettling] = useState<Obligation | null>(null);

  return (
    <div className="space-y-4">
      <AgeingCard kind="receivable" summary={receivables} currency={currency} onNew={() => setCreating('receivable')} onSettle={setSettling} />
      <AgeingCard kind="payable" summary={payables} currency={currency} onNew={() => setCreating('payable')} onSettle={setSettling} />
      <Disclaimer>Ageing is counted from each item's due date. Paying part of an invoice or bill lowers what is owed; it counts as revenue or a cost only for the part that was paid.</Disclaimer>
      {creating && <ObligationEditor kind={creating} onClose={() => setCreating(null)} />}
      {settling && <ReceivePayForm settle={settling} onClose={() => setSettling(null)} />}
    </div>
  );
}

const BUCKET_COLOR: Record<string, string> = {
  current: 'var(--color-positive)',
  d30: 'var(--color-warning)',
  d60: '#d97706',
  d90: 'var(--color-negative)',
  older: '#7f1d1d',
  undated: 'var(--color-line-strong)',
};

function AgeingCard({ kind, summary, currency, onNew, onSettle }: { kind: 'receivable' | 'payable'; summary: AgeingSummary; currency: string; onNew: () => void; onSettle: (o: Obligation) => void }) {
  const money = (n: number) => formatMoney(n, currency);
  const isIn = kind === 'receivable';
  return (
    <Card>
      <CardHeader
        title={isIn ? 'Receivables: customers owe you' : 'Payables: you owe suppliers'}
        subtitle={summary.total > 0 ? `${money(summary.total)} outstanding${summary.overdue > 0 ? `, ${money(summary.overdue)} overdue` : ''}` : 'Nothing outstanding'}
        action={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={onNew}>
            {isIn ? 'New invoice' : 'New bill'}
          </Button>
        }
      />
      {summary.total > 0 && (
        <>
          <div role="img" aria-label={AGE_BUCKETS.map((b) => `${b.label}: ${money(summary.totals[b.key])}`).join('; ')} className="flex h-3 overflow-hidden rounded-full bg-sunken">
            {AGE_BUCKETS.map((b) =>
              summary.totals[b.key] > 0 ? <span key={b.key} title={`${b.label}: ${money(summary.totals[b.key])}`} style={{ width: `${(summary.totals[b.key] / summary.total) * 100}%`, background: BUCKET_COLOR[b.key] }} /> : null,
            )}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3 lg:grid-cols-6">
            {AGE_BUCKETS.map((b) => (
              <div key={b.key} className="min-w-0">
                <dt className="flex items-center gap-1.5 truncate text-ink-3">
                  <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: BUCKET_COLOR[b.key] }} />
                  {b.label}
                </dt>
                <dd className={cn('money font-bold', summary.totals[b.key] > 0 ? 'text-ink' : 'text-ink-3')}>{money(summary.totals[b.key])}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {summary.items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={isIn ? 'No unpaid invoices' : 'No unpaid bills'}
          message={isIn ? 'Record what a customer owes you, and Finken tracks it until it is paid.' : 'Record a supplier bill you will pay later, and Finken tracks it until it is paid.'}
          className="py-6"
        />
      ) : (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {summary.items.map((i) => {
            const o = i.position.obligation;
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <Link to={`/money/people/${o.personId}`} className="min-w-0 flex-1 basis-56 hover:text-accent">
                  <span className="block truncate text-sm font-semibold text-ink">{i.person?.name ?? 'Unknown'}</span>
                  <span className="block truncate text-xs text-ink-3">
                    {o.title} · from {formatDay(o.date)}
                  </span>
                </Link>
                <Badge tone={i.daysLate > 0 ? 'negative' : i.bucket === 'undated' ? 'neutral' : 'positive'}>
                  {i.position.nextDue ? (i.daysLate > 0 ? formatDueLabel(i.position.nextDue) : `Due ${formatDay(i.position.nextDue)}`) : 'No due date'}
                </Badge>
                <span className="w-32 text-right">
                  <span className="money block text-sm font-bold text-ink">{money(i.position.outstanding)}</span>
                  {i.position.settled > 0 && <span className="money block text-xs text-ink-3">of {money(o.amount)}</span>}
                </span>
                <Button size="sm" onClick={() => onSettle(o)}>
                  {isIn ? 'Record payment' : 'Pay'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ── Profit and loss ────────────────────────────────────────────────────────

function Pnl({ dates }: { dates: DateRange }) {
  const { currency, transactions, categories } = useSpaceData();
  const toast = useToast();
  const prev = previousRange(dates);
  const pnl = useMemo(() => profitAndLoss(transactions, categories, dates), [transactions, categories, dates]);
  const before = useMemo(() => profitAndLoss(transactions, categories, prev), [transactions, categories, prev.from, prev.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = new Map(categories.map((c) => [c.id, c]));
  const prevLine = (lines: { categoryId?: string; amount: number }[], id?: string) => lines.find((l) => l.categoryId === id)?.amount ?? 0;

  function setCostType(category: Category, costType: CostType) {
    const result = store.updateCategory(category.id, {
      name: category.name,
      kind: category.kind,
      icon: category.icon,
      color: category.color,
      costType,
      subcategories: category.subcategories.map((s) => ({ id: s.id, name: s.name })),
    });
    if (result.ok) toast(`${category.name} now counts as ${costType === 'direct' ? 'cost of goods sold' : 'an operating expense'}`);
    else toast(result.error, { tone: 'error' });
  }

  const header = (
    <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-line pb-2 text-xs font-semibold text-ink-3 sm:grid-cols-[1fr_9rem_9rem]">
      <span />
      <span className="text-right">{rangeLabel(dates)}</span>
      <span className="text-right">{rangeLabel(prev)}</span>
    </div>
  );
  const total = (label: string, now: number, then: number, emphasis?: boolean) => (
    <div className={cn('grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 py-2.5 sm:grid-cols-[1fr_9rem_9rem]', emphasis ? 'border-y-2 border-ink/80' : 'border-b border-line')}>
      <span className={cn('text-sm', emphasis ? 'font-extrabold text-ink' : 'font-bold text-ink')}>{label}</span>
      <Amount value={now} currency={currency} strong />
      <Amount value={then} currency={currency} className="text-ink-3" />
    </div>
  );
  const lines = (items: typeof pnl.revenueLines, prevItems: typeof pnl.revenueLines, editable: boolean, sign: 1 | -1) =>
    items.map((l) => {
      const category = l.categoryId ? byId.get(l.categoryId) : undefined;
      return (
        <div key={l.categoryId ?? 'none'} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-1.5 sm:grid-cols-[1fr_9rem_9rem]">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-3">
            {category && <CategoryIcon icon={category.icon} color={category.color} size="sm" />}
            <Link to={transactionsLink(dates, { type: sign > 0 ? 'income' : 'expense', category: l.categoryId })} className="truncate text-sm text-ink-2 hover:text-accent">
              {l.name}
            </Link>
            {editable && category && (
              <Select
                aria-label={`Where ${category.name} counts`}
                value={category.costType ?? 'operating'}
                onChange={(e) => setCostType(category, e.target.value as CostType)}
                className="!h-7 !w-auto !py-0 !text-xs"
              >
                <option value="direct">Cost of goods sold</option>
                <option value="operating">Operating expense</option>
              </Select>
            )}
          </span>
          <Amount value={sign * l.amount} currency={currency} />
          <Amount value={sign * prevLine(prevItems, l.categoryId)} currency={currency} className="text-ink-3" />
        </div>
      );
    });

  return (
    <Card>
      <CardHeader title="Profit and loss" subtitle="Revenue, less what it cost to make or buy what you sold, less running costs" />
      <div className="overflow-x-auto">
        <div className="min-w-[30rem]">
          {header}
          {total('Revenue', pnl.revenue, before.revenue)}
          {lines(pnl.revenueLines, before.revenueLines, false, 1)}
          {total('Cost of goods sold', -pnl.costOfSales, -before.costOfSales)}
          {pnl.costOfSalesLines.length === 0 ? (
            <p className="py-2 pl-3 text-xs text-ink-3">No category counts as cost of goods sold. Use the menus below to move one here.</p>
          ) : (
            lines(pnl.costOfSalesLines, before.costOfSalesLines, true, -1)
          )}
          {total('Gross profit', pnl.grossProfit, before.grossProfit, true)}
          {pnl.grossMargin !== null && <p className="py-1 pl-3 text-xs text-ink-3">Gross margin {formatPercent(pnl.grossMargin)}</p>}
          {total('Operating expenses', -pnl.operating, -before.operating)}
          {lines(pnl.operatingLines, before.operatingLines, true, -1)}
          {total('Net profit', pnl.netProfit, before.netProfit, true)}
          {pnl.netMargin !== null && <p className="py-1 pl-3 text-xs text-ink-3">Net margin {formatPercent(pnl.netMargin)}</p>}
        </div>
      </div>
      <Disclaimer>
        A simple summary from what you have recorded, counted when money is received or paid. It is not an audited or tax-compliant financial statement. Loans received and
        repaid are left out; loan interest you record as an expense is included.
      </Disclaimer>
    </Card>
  );
}

// ── Cash flow ──────────────────────────────────────────────────────────────

const HORIZONS = [
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
] as const;

function Cash({ dates, now }: { dates: DateRange; now: string }) {
  const { currency, accounts, transactions, obligations, recurring, people } = useSpaceData();
  const [horizon, setHorizon] = useState<'30' | '60' | '90'>('30');
  const active = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  const flow = useMemo(() => cashFlow(active, transactions, obligations, dates), [active, transactions, obligations, dates]);
  const months = useMemo(() => monthlyCashFlow(active, transactions, obligations, dates), [active, transactions, obligations, dates]);
  const forecast = useMemo(() => cashForecast(active, { recurring, obligations, transactions }, Number(horizon), now), [active, recurring, obligations, transactions, horizon, now]);
  const money = (n: number) => formatMoney(n, currency);
  const row = (label: string, value: number, opts: { strong?: boolean; indent?: boolean; to?: string } = {}) => (
    <div className={cn('flex items-baseline justify-between gap-3 py-2', opts.strong ? 'border-t border-line font-bold' : '', opts.indent && 'pl-3')}>
      {opts.to ? (
        <Link to={opts.to} className="text-sm text-ink-2 hover:text-accent">
          {label}
        </Link>
      ) : (
        <span className={cn('text-sm', opts.strong ? 'font-bold text-ink' : 'text-ink-2')}>{label}</span>
      )}
      <Amount value={value} currency={currency} strong={opts.strong} />
    </div>
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="min-w-0">
        <CardHeader title="Cash flow" subtitle={`${rangeLabel(dates)}, across ${active.length} ${active.length === 1 ? 'account' : 'accounts'}`} />
        {row('Opening cash', flow.opening, { strong: true })}
        <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Money received</p>
        {flow.receivedLines.length === 0 ? <p className="py-2 pl-3 text-sm text-ink-3">Nothing received</p> : flow.receivedLines.map((l) => <div key={l.key}>{row(l.label, l.amount, { indent: true })}</div>)}
        {row('Total received', flow.received, { strong: true })}
        <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Money paid</p>
        {flow.paidLines.length === 0 ? <p className="py-2 pl-3 text-sm text-ink-3">Nothing paid</p> : flow.paidLines.map((l) => <div key={l.key}>{row(l.label, -l.amount, { indent: true })}</div>)}
        {row('Total paid', -flow.paid, { strong: true })}
        {row('Net cash movement', flow.net, { strong: true })}
        <div className="mt-1 flex items-baseline justify-between gap-3 rounded-control bg-canvas px-3 py-3">
          <span className="text-sm font-extrabold text-ink">Closing cash</span>
          <Amount value={flow.closing} currency={currency} strong />
        </div>
      </Card>

      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader
            title="Expected ahead"
            subtitle="From recurring items, invoices, bills and loans"
            action={<Segmented value={horizon} onChange={setHorizon} options={[...HORIZONS]} label="Look ahead" className="[&>button]:h-8 [&>button]:px-2.5 [&>button]:text-xs" />}
          />
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              ['Cash now', forecast.now, ''],
              ['Expected in', forecast.inflow, 'text-positive'],
              ['Expected out', -forecast.outflow, ''],
              ['Estimated cash', forecast.projected, ''],
            ].map(([label, value, tone]) => (
              <div key={label as string} className="min-w-0 rounded-control bg-canvas px-3 py-2.5">
                <dt className="truncate text-xs text-ink-3">{label as string}</dt>
                <dd className={cn('money truncate font-bold', (value as number) < 0 ? 'text-negative' : (tone as string) || 'text-ink')}>
                  {(value as number) < 0 ? `−${money(-(value as number))}` : money(value as number)}
                </dd>
              </div>
            ))}
          </dl>
          {forecast.events.length > 0 && (
            <ul className="mt-3 max-h-80 space-y-0.5 overflow-y-auto">
              {forecast.events.map((e) => (
                <li key={e.key}>
                  <ExpectedRow e={e} people={people} currency={currency} to="/money/upcoming" />
                </li>
              ))}
            </ul>
          )}
          <Disclaimer>Expected money is an estimate. Nothing changes your balances until it is marked paid or received.</Disclaimer>
        </Card>

        {months.length > 1 && (
          <Card>
            <CardHeader title="Month by month" />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-3">
                    <th className="py-2 font-semibold">Month</th>
                    <th className="py-2 text-right font-semibold">Received</th>
                    <th className="py-2 text-right font-semibold">Paid</th>
                    <th className="py-2 text-right font-semibold">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.range.from} className="border-b border-line last:border-0">
                      <td className="py-2 font-semibold text-ink">{formatMonthYear(m.range.from)}</td>
                      <td className="py-2 text-right">
                        <Amount value={m.received} currency={currency} />
                      </td>
                      <td className="py-2 text-right">
                        <Amount value={-m.paid} currency={currency} />
                      </td>
                      <td className="py-2 text-right">
                        <Amount value={m.closing} currency={currency} strong />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Reports ────────────────────────────────────────────────────────────────

function Reports({ dates, now }: { dates: DateRange; now: string }) {
  const { space, currency, accounts, categories, transactions, obligations, people } = useSpaceData();
  const toast = useToast();
  const [key, setKey] = useState<ReportKey>('revenue');
  const report = useMemo(() => buildReport(key, { accounts, categories, transactions, obligations, people }, dates, now), [key, accounts, categories, transactions, obligations, people, dates, now]);
  const money = (n: number) => formatMoney(n, currency);

  function download() {
    const csv = reportToCsv(report, { space: space?.name ?? '', range: dates, currency });
    // A byte-order mark lets spreadsheet apps read the text correctly.
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finken-${key}-${dates.from}-to-${dates.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${report.title} downloaded`);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="radiogroup" aria-label="Report">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            type="button"
            role="radio"
            aria-checked={key === r.key}
            onClick={() => setKey(r.key)}
            className={cn(
              'h-8 rounded-full border px-3.5 text-[13px] font-semibold transition-colors',
              key === r.key ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink-2 hover:border-line-strong',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <Card>
        <CardHeader
          title={report.title}
          subtitle={report.description}
          action={
            <Button size="sm" variant="primary" icon={<Download className="size-4" />} onClick={download}>
              CSV
            </Button>
          }
        />
        <div className="space-y-6">
          {report.sections.map((section) => (
            <section key={section.title}>
              <h3 className="mb-2 text-sm font-bold text-ink">{section.title}</h3>
              {section.rows.length === 0 ? (
                <p className="text-sm text-ink-3">Nothing to show for this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs text-ink-3">
                        {section.columns.map((c, i) => (
                          <th key={c} className={cn('whitespace-nowrap py-2 pr-4 font-semibold last:pr-0', section.money.includes(i) || i > 0 ? 'text-right' : 'text-left')}>
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...section.rows, ...(section.total ? [section.total] : [])].map((row, r) => {
                        const isTotal = section.total && r === section.rows.length;
                        return (
                          <tr key={r} className={cn('border-b border-line last:border-0', isTotal && 'font-bold')}>
                            {row.map((cell, i) => (
                              <td key={i} className={cn('whitespace-nowrap py-2 pr-4 last:pr-0', i === 0 ? 'text-left font-semibold text-ink' : 'text-right text-ink-2', isTotal && 'text-ink')}>
                                {typeof cell === 'number' && section.money.includes(i)
                                  ? cell < 0
                                    ? `−${money(-cell)}`
                                    : money(cell)
                                  : typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell)
                                    ? formatDay(cell)
                                    : String(cell)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
        <Disclaimer>For your own records. These reports are not audited or tax-compliant statements.</Disclaimer>
      </Card>
    </div>
  );
}
