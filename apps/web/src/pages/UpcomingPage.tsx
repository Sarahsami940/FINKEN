import { addDays, diffDays, formatDay, formatDueLabel, formatFullDate, formatMonthYear, formatRelativeDay, monthRange, parseISODate, today } from '@finken/domain/dates';
import { formatMoney, moneyToInput, parseMoney } from '@finken/domain/format';
import { accountBalances } from '@finken/domain/money';
import { frequencyLabel, occurrenceId } from '@finken/domain/planning';
import type { DateRange, ID, ISODate } from '@finken/domain/types';
import {
  DUE_SOON_DAYS,
  type EventKind,
  type ExpectedEvent,
  expectedEvents,
  expectedTotals,
  lastSettlement,
  needsReminder,
  recentlySettled,
  type SettledEvent,
  type UpcomingInput,
  undatedOwed,
} from '@finken/domain/upcoming';
import { AlarmClockOff, BellRing, CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, HandCoins, List, Pencil, Repeat } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { AmountInput, FormShell, ReceivePayForm } from '../components/money/OwedForms';
import { ObligationSheet } from '../components/money/OwedSheets';
import { CategoryIcon } from '../components/money/parts';
import { Button, IconButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Input, Select } from '../components/ui/Field';
import { Badge, EmptyState, PageHeader, Segmented } from '../components/ui/Misc';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import { BackLink } from './MoneyPages';
import { RecurringEditor } from './PlanningPages';

// ── Options ────────────────────────────────────────────────────────────────

type View = 'list' | 'week' | 'month';
type Filter = 'all' | 'in' | 'out' | 'soon' | 'overdue' | 'paid' | 'received';

const VIEWS: { value: View; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in', label: 'Incoming' },
  { value: 'out', label: 'Outgoing' },
  { value: 'soon', label: 'Due soon' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'received', label: 'Received' },
];

const HORIZONS = [
  { value: '7', label: 'Next 7 days' },
  { value: '30', label: 'Next 30 days' },
  { value: '90', label: 'Next 90 days' },
];

const KIND_LABEL: Record<EventKind, string> = {
  income: 'Expected income',
  bill: 'Recurring payment',
  instalment: 'Loan instalment',
  'to-receive': 'To receive',
  'to-pay': 'To pay',
};

const ALL_SPACES = 'all';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Monday of the week containing `iso`. */
function weekStart(iso: ISODate): ISODate {
  return addDays(iso, -((parseISODate(iso).getDay() + 6) % 7));
}

function matches(e: ExpectedEvent, filter: Filter): boolean {
  switch (filter) {
    case 'in':
      return e.direction === 'in';
    case 'out':
      return e.direction === 'out';
    case 'soon':
      return e.status === 'due-soon';
    case 'overdue':
      return e.status === 'overdue';
    default:
      return true;
  }
}

/** Everything a row or sheet needs to describe an event. */
interface Lookup {
  spaceName: (id: ID) => string;
  personName: (id?: ID) => string | undefined;
  category: (id?: ID) => { icon: string; color: string } | undefined;
  currencyOf: (spaceId: ID) => string;
  showSpace: boolean;
}

// ── Rows ───────────────────────────────────────────────────────────────────

function statusBadge(e: ExpectedEvent, now: ISODate) {
  if (e.snoozedUntil && e.snoozedUntil > now) return <Badge>Snoozed to {formatDay(e.snoozedUntil)}</Badge>;
  if (e.status === 'overdue') return <Badge tone="negative">Overdue</Badge>;
  if (e.status === 'due-soon') return <Badge tone="warning">Due soon</Badge>;
  return null;
}

function EventIcon({ e, lookup }: { e: ExpectedEvent; lookup: Lookup }) {
  const category = lookup.category(e.categoryId);
  if (e.obligationId || !category) {
    return (
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink-2">
        {e.obligationId ? <HandCoins className="size-[18px]" /> : <Repeat className="size-[18px]" />}
      </span>
    );
  }
  return <CategoryIcon icon={category.icon} color={category.color} />;
}

function signed(amount: number, direction: 'in' | 'out', currency: string) {
  return formatMoney(direction === 'in' ? amount : -amount, currency, { signed: true });
}

interface EventRowProps {
  e: ExpectedEvent;
  lookup: Lookup;
  now: ISODate;
  /** Show the date on the row, for lists not already grouped by day. */
  showDate?: boolean;
  onOpen: (e: ExpectedEvent) => void;
  onSettle: (e: ExpectedEvent) => void;
}

function EventRow({ e, lookup, now, showDate = true, onOpen, onSettle }: EventRowProps) {
  const person = lookup.personName(e.personId);
  const meta = [KIND_LABEL[e.kind], person, lookup.showSpace ? lookup.spaceName(e.spaceId) : undefined].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <button type="button" onClick={() => onOpen(e)} className="-m-1 flex min-w-0 flex-1 basis-56 items-center gap-3 rounded-xl p-1 text-left transition-colors hover:bg-canvas">
        <EventIcon e={e} lookup={lookup} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">{e.title}</span>
          <span className={cn('block truncate text-[13px]', e.status === 'overdue' ? 'font-semibold text-negative' : 'text-ink-3')}>
            {showDate ? `${formatDay(e.date)} · ${formatDueLabel(e.date)} · ` : ''}
            {meta}
          </span>
        </span>
      </button>
      {statusBadge(e, now)}
      <span className={cn('money text-[15px] font-bold', e.direction === 'in' ? 'text-positive' : 'text-ink')}>{signed(e.amount, e.direction, lookup.currencyOf(e.spaceId))}</span>
      {e.actionable ? (
        <Button size="sm" icon={<Check className="size-4" />} onClick={() => onSettle(e)} className="max-sm:w-full">
          {e.direction === 'in' ? 'Mark received' : 'Mark paid'}
        </Button>
      ) : (
        <span className="text-xs font-semibold text-ink-3 max-sm:w-full">Expected</span>
      )}
    </li>
  );
}

function SettledRow({ s, lookup, onOpen }: { s: SettledEvent; lookup: Lookup; onOpen: (id: ID) => void }) {
  const t = s.transaction;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(t.id)}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-canvas"
      >
        <span
          aria-hidden
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', s.direction === 'in' ? 'bg-positive-soft text-positive' : 'bg-sunken text-ink-2')}
        >
          <Check className="size-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink">{t.description || (s.direction === 'in' ? 'Received' : 'Paid')}</span>
          <span className="block truncate text-[13px] text-ink-3">
            {s.direction === 'in' ? 'Received' : 'Paid'}{' '}
            {formatRelativeDay(t.date).toLowerCase().startsWith('to') || formatRelativeDay(t.date) === 'Yesterday'
              ? formatRelativeDay(t.date).toLowerCase()
              : `on ${formatDay(t.date)}`}
            {lookup.personName(t.personId) ? ` · ${lookup.personName(t.personId)}` : ''}
            {lookup.showSpace ? ` · ${lookup.spaceName(t.spaceId)}` : ''}
          </span>
        </span>
        <span className={cn('money text-[15px] font-bold', s.direction === 'in' ? 'text-positive' : 'text-ink')}>{signed(t.amount, s.direction, t.currency)}</span>
      </button>
    </li>
  );
}

// ── Mark paid / received ───────────────────────────────────────────────────

function ConfirmRecurring({ e, currency, onClose }: { e: ExpectedEvent; currency: string; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(moneyToInput(e.amount));
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const received = e.direction === 'in';

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const value = parseMoney(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    const result = store.confirmRecurring(e.sourceId, date, value, occurrenceId(e.sourceId, e.date));
    if (!result.ok) return setError(result.error);
    toast(received ? `${e.title} marked as received` : `${e.title} marked as paid`);
    onClose();
  }

  return (
    <FormShell
      title={received ? 'Mark as received' : 'Mark as paid'}
      formId="confirm-recurring"
      submitLabel={received ? 'Mark received' : 'Mark paid'}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="rounded-control bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink-2">
        <strong className="font-bold text-ink">{e.title}</strong> was due {formatDay(e.date)}. Change the amount if it was different this time.
      </p>
      <AmountInput
        value={amount}
        currency={currency}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
      />
      <Field label={received ? 'Received on' : 'Paid on'}>{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(ev) => setDate(ev.target.value)} />}</Field>
      <p className="text-[13px] leading-relaxed text-ink-3">
        {e.obligationId ? 'This is recorded as a repayment, so it is not counted as ordinary spending or income. ' : ''}
        Finken records the transaction and moves this to its next date.
      </p>
    </FormShell>
  );
}

// ── Details ────────────────────────────────────────────────────────────────

const SNOOZES = [
  { days: 1, label: 'Until tomorrow' },
  { days: 3, label: 'For 3 days' },
  { days: 7, label: 'For a week' },
];

interface EventSheetProps {
  e: ExpectedEvent;
  input: UpcomingInput;
  lookup: Lookup;
  now: ISODate;
  onClose: () => void;
  onSettle: (e: ExpectedEvent) => void;
  onEdit: (e: ExpectedEvent) => void;
}

function EventSheet({ e, input, lookup, now, onClose, onSettle, onEdit }: EventSheetProps) {
  const toast = useToast();
  const { openDetail } = useAddFlow();
  const state = useAppState();
  const currency = lookup.currencyOf(e.spaceId);
  const recurring = e.source === 'recurring' ? state.recurring.find((r) => r.id === e.sourceId) : undefined;
  const account = state.accounts.find((a) => a.id === e.accountId);
  const last = lastSettlement(e.source, e.sourceId, input);
  const snoozed = e.snoozedUntil && e.snoozedUntil > now;

  const rows: [string, string][] = [
    ['Due', `${formatFullDate(e.date)} · ${formatDueLabel(e.date)}`],
    ['Type', KIND_LABEL[e.kind]],
  ];
  const person = lookup.personName(e.personId);
  if (person) rows.push([e.direction === 'in' ? 'From' : 'To', person]);
  rows.push(['Space', lookup.spaceName(e.spaceId)]);
  if (account) rows.push([e.direction === 'in' ? 'Into' : 'From account', account.name]);
  if (recurring) rows.push(['Repeats', frequencyLabel(recurring)]);
  if (snoozed) rows.push(['Reminder', `Snoozed until ${formatDay(e.snoozedUntil!)}`]);

  function snooze(days: number | null) {
    const result = store.snoozeReminder(e.source, e.sourceId, days === null ? null : addDays(now, days));
    toast(
      result.ok ? (days === null ? 'Reminder is back on' : `Reminder snoozed until ${formatDay(addDays(now, days))}`) : result.error,
      result.ok ? undefined : { tone: 'error' },
    );
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={e.title}
      description={e.actionable ? undefined : 'A later occurrence. It can be marked once the earlier ones are done.'}
      footer={
        <div className="flex gap-2">
          {e.actionable && (
            <Button block variant="primary" size="lg" icon={<Check className="size-4" />} onClick={() => onSettle(e)}>
              {e.direction === 'in' ? 'Mark received' : 'Mark paid'}
            </Button>
          )}
          <Button block={!e.actionable} size="lg" icon={<Pencil className="size-4" />} onClick={() => onEdit(e)}>
            Edit
          </Button>
        </div>
      }
    >
      <div className="rounded-card bg-canvas px-4 py-5 text-center">
        <p className="text-[13px] font-semibold text-ink-3">{e.direction === 'in' ? 'Expected in' : 'Expected out'}</p>
        <p className={cn('money mt-1 text-[32px] font-extrabold leading-tight tracking-tight', e.direction === 'in' ? 'text-positive' : 'text-ink')}>
          {signed(e.amount, e.direction, currency)}
        </p>
        <div className="mt-2 flex justify-center">{statusBadge(e, now)}</div>
      </div>
      <dl className="mt-4 divide-y divide-line">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-6 py-3 text-sm">
            <dt className="shrink-0 text-ink-3">{label}</dt>
            <dd className="text-right font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-line pt-3">
        <p className="text-[13px] font-semibold text-ink-3">Related</p>
        <ul className="mt-1 space-y-0.5 text-sm">
          <li>
            <button
              type="button"
              onClick={() => onEdit(e)}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-xl px-2 py-2 text-left hover:bg-canvas"
            >
              <span className="font-semibold text-ink">{e.source === 'recurring' ? 'The recurring item' : 'The money-owed record'}</span>
              <ChevronRight aria-hidden className="size-4 text-ink-3" />
            </button>
          </li>
          {last && (
            <li>
              <button
                type="button"
                onClick={() => openDetail(last.id)}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-xl px-2 py-2 text-left hover:bg-canvas"
              >
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">Last {e.direction === 'in' ? 'received' : 'paid'}</span>
                  <span className="block text-[13px] text-ink-3">{formatDay(last.date)}</span>
                </span>
                <span className="money font-bold text-ink">{formatMoney(last.amount, last.currency)}</span>
              </button>
            </li>
          )}
        </ul>
      </div>

      {e.actionable && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="text-[13px] font-semibold text-ink-3">Reminder</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {snoozed ? (
              <Button size="sm" icon={<BellRing className="size-4" />} onClick={() => snooze(null)}>
                Turn reminder back on
              </Button>
            ) : (
              SNOOZES.map((option) => (
                <Button key={option.days} size="sm" icon={<AlarmClockOff className="size-4" />} onClick={() => snooze(option.days)}>
                  {option.label}
                </Button>
              ))
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">Snoozing hides the reminder only. The amount is still expected and still counted below.</p>
        </div>
      )}
    </Modal>
  );
}

// ── Calendar views ─────────────────────────────────────────────────────────

interface Placed {
  expected: ExpectedEvent[];
  settled: SettledEvent[];
}

function byDay(expected: ExpectedEvent[], settled: SettledEvent[]): Map<ISODate, Placed> {
  const map = new Map<ISODate, Placed>();
  const at = (d: ISODate) => {
    let entry = map.get(d);
    if (!entry) map.set(d, (entry = { expected: [], settled: [] }));
    return entry;
  };
  for (const e of expected) at(e.date).expected.push(e);
  for (const s of settled) at(s.transaction.date).settled.push(s);
  return map;
}

function DayNet({ placed, currency }: { placed: Placed; currency: string | null }) {
  if (!currency) return null;
  const net = placed.expected.reduce((sum, e) => sum + (e.direction === 'in' ? e.amount : -e.amount), 0);
  if (placed.expected.length === 0 || net === 0) return null;
  return <span className={cn('money text-[11px] font-bold', net > 0 ? 'text-positive' : 'text-ink-2')}>{formatMoney(net, currency, { signed: true, compact: true })}</span>;
}

interface PeriodNavProps {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
}

function PeriodNav({ label, onPrev, onNext, onToday }: PeriodNavProps) {
  return (
    <div className="flex items-center gap-2">
      <IconButton label="Previous" onClick={onPrev}>
        <ChevronLeft className="size-4" />
      </IconButton>
      <h2 className="min-w-0 flex-1 text-center text-[15px] font-bold text-ink sm:flex-none sm:text-left">{label}</h2>
      <IconButton label="Next" onClick={onNext}>
        <ChevronRight className="size-4" />
      </IconButton>
      {onToday && (
        <Button size="sm" onClick={onToday}>
          Today
        </Button>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function UpcomingPage() {
  const state = useAppState();
  const { openDetail } = useAddFlow();
  const [params, setParams] = useSearchParams();
  const now = today();

  const view: View = VIEWS.some((v) => v.value === params.get('view')) ? (params.get('view') as View) : 'list';
  const filter: Filter = FILTERS.some((f) => f.value === params.get('show')) ? (params.get('show') as Filter) : 'all';
  const horizon = HORIZONS.some((h) => h.value === params.get('days')) ? params.get('days')! : '30';
  const [cursor, setCursor] = useState(now);
  const [selectedDay, setSelectedDay] = useState<ISODate | null>(null);
  const [open, setOpen] = useState<ExpectedEvent | null>(null);
  const [settling, setSettling] = useState<ExpectedEvent | null>(null);
  const [editing, setEditing] = useState<ExpectedEvent | null>(null);

  function update(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      const fallback = { view: 'list', show: 'all', days: '30', space: '' }[key];
      if (value && value !== fallback) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }

  const activeSpaces = useMemo(() => state.spaces.filter((s) => s.status === 'active'), [state.spaces]);
  const allSpaces = params.get('space') === ALL_SPACES && activeSpaces.length > 1;
  const scope = useMemo(
    () => new Set(allSpaces ? activeSpaces.map((s) => s.id) : state.activeSpaceId ? [state.activeSpaceId] : []),
    [allSpaces, activeSpaces, state.activeSpaceId],
  );
  const input = useMemo<UpcomingInput>(
    () => ({
      recurring: state.recurring.filter((r) => scope.has(r.spaceId)),
      obligations: state.obligations.filter((o) => scope.has(o.spaceId)),
      transactions: state.transactions.filter((t) => scope.has(t.spaceId)),
    }),
    [state.recurring, state.obligations, state.transactions, scope],
  );
  const currencies = new Set(activeSpaces.filter((s) => scope.has(s.id)).map((s) => s.currency));
  // Totals only make sense in one currency.
  const currency = currencies.size === 1 ? [...currencies][0] : null;

  // The dates on screen: the list horizon, or the week or month being viewed.
  const range = useMemo<DateRange>(() => {
    if (view === 'week') {
      const from = weekStart(cursor);
      return { from, to: addDays(from, 6) };
    }
    if (view === 'month') return monthRange(cursor);
    return { from: now, to: addDays(now, Number(horizon) - 1) };
  }, [view, cursor, horizon, now]);

  const showingSettled = filter === 'paid' || filter === 'received';
  const all = useMemo(() => expectedEvents(input, { from: range.from < now ? now : range.from, to: range.to }, now), [input, range, now]);
  // Calendar views show what falls inside them; overdue items belong to the list and to today.
  const inView = view === 'list' ? all : all.filter((e) => e.date >= range.from && e.date <= range.to);
  const expected = showingSettled ? [] : inView.filter((e) => matches(e, filter));
  const settledRange = view === 'list' ? { from: addDays(now, -30), to: now } : range;
  // biome-ignore lint/correctness/useExhaustiveDependencies: settledRange is derived from view, range and now
  const settled = useMemo(
    () => (showingSettled ? recentlySettled(input, settledRange).filter((s) => s.direction === (filter === 'received' ? 'in' : 'out')) : []),
    [showingSettled, input, view, range, now, filter],
  );

  const totals = expectedTotals(all);
  const balances = useMemo(
    () =>
      accountBalances(
        state.accounts.filter((a) => scope.has(a.spaceId) && !a.archived),
        input.transactions,
      ),
    [state.accounts, scope, input.transactions],
  );
  const available = balances.reduce((sum, b) => sum + b.balance, 0);
  const reminders = useMemo(() => needsReminder(all, input.recurring, now), [all, input.recurring, now]);
  const undated = useMemo(() => undatedOwed(input, now), [input, now]);

  const space = activeSpaces.find((s) => s.id === state.activeSpaceId);
  const lookup: Lookup = {
    spaceName: (id) => state.spaces.find((s) => s.id === id)?.name ?? 'Unknown Space',
    personName: (id) => (id ? state.people.find((p) => p.id === id)?.name : undefined),
    category: (id) => (id ? state.categories.find((c) => c.id === id) : undefined),
    currencyOf: (id) => state.spaces.find((s) => s.id === id)?.currency ?? currency ?? 'PKR',
    showSpace: allSpaces,
  };
  if (!space) return null;

  const money = (n: number) => (currency ? formatMoney(n, currency) : '—');
  const periodLabel = view === 'list' ? HORIZONS.find((h) => h.value === horizon)!.label.toLowerCase() : view === 'week' ? 'this week view' : formatMonthYear(range.from);
  const rowProps = { lookup, now, onOpen: setOpen, onSettle: setSettling };

  // ── List view groups ──
  const groups: { key: string; title: string; subtitle?: string; items: ExpectedEvent[] }[] = [
    { key: 'overdue', title: 'Overdue', items: expected.filter((e) => e.status === 'overdue') },
    { key: 'soon', title: `Next ${DUE_SOON_DAYS} days`, items: expected.filter((e) => e.status === 'due-soon') },
    { key: 'later', title: 'Later', items: expected.filter((e) => e.status === 'upcoming') },
  ];

  const editingObligation = editing?.source === 'obligation' ? editing : null;
  const editingRecurring = editing?.source === 'recurring' ? state.recurring.find((r) => r.id === editing.sourceId) : undefined;
  const settlingObligation = settling?.source === 'obligation' ? state.obligations.find((o) => o.id === settling.sourceId) : undefined;

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title="Coming up"
        subtitle={`What is expected in ${allSpaces ? 'all your Spaces' : space.name}. Nothing is paid until you confirm it.`}
        action={
          <Link to="/money/recurring" className="text-sm font-bold text-accent hover:text-accent-strong">
            Manage recurring
          </Link>
        }
      />

      {/* Actual money now, kept visibly apart from what is only expected. */}
      <div className="grid gap-3 lg:grid-cols-5 [&>*]:min-w-0">
        <Card className="!p-5 lg:col-span-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Actual</p>
          <p className="mt-2 text-[13px] font-semibold text-ink-3">Available now</p>
          <p className={cn('money mt-1 truncate text-2xl font-extrabold tracking-tight', available < 0 ? 'text-negative' : 'text-ink')}>{money(available)}</p>
          <p className="mt-1 text-[13px] text-ink-3">What your accounts hold today, from recorded transactions.</p>
        </Card>
        <Card className="border-dashed !p-5 lg:col-span-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink-3">
            Expected · {view === 'list' ? periodLabel : 'from today to the end of this view'}, plus overdue
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ['Coming in', totals.incoming, 'text-positive'],
                ['Going out', totals.outgoing, 'text-ink'],
                ['Net expected', totals.net, totals.net < 0 ? 'text-negative' : 'text-ink'],
                ['Available after', available + totals.net, available + totals.net < 0 ? 'text-negative' : 'text-ink'],
              ] as const
            ).map(([label, value, tone]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[13px] font-semibold text-ink-3">{label}</dt>
                <dd className={cn('money truncate text-lg font-extrabold tracking-tight', tone)}>
                  {label === 'Net expected' && currency ? formatMoney(value, currency, { signed: true }) : money(value)}
                </dd>
              </div>
            ))}
          </dl>
          {!currency && <p className="mt-2 text-[13px] text-ink-3">Totals are hidden because these Spaces use different currencies.</p>}
        </Card>
      </div>

      {/* Controls */}
      <div className="mt-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="View"
            value={view}
            onChange={(v) => {
              update({ view: v });
              setCursor(now);
              setSelectedDay(null);
            }}
            options={VIEWS}
          />
          {view === 'list' && (
            <div className="w-40">
              <Select aria-label="How far ahead" value={horizon} onChange={(ev) => update({ days: ev.target.value })}>
                {HORIZONS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {activeSpaces.length > 1 && (
            <div className="w-44">
              <Select
                aria-label="Space"
                value={allSpaces ? ALL_SPACES : space.id}
                onChange={(ev) => {
                  if (ev.target.value === ALL_SPACES) return update({ space: ALL_SPACES });
                  store.setActiveSpace(ev.target.value);
                  update({ space: '' });
                }}
              >
                {activeSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={ALL_SPACES}>All Spaces</option>
              </Select>
            </div>
          )}
        </div>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Segmented label="Show" value={filter} onChange={(v) => update({ show: v })} options={FILTERS} />
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {/* ── List ── */}
        {view === 'list' &&
          (showingSettled ? (
            <Card>
              <CardHeader
                title={filter === 'paid' ? 'Paid in the last 30 days' : 'Received in the last 30 days'}
                subtitle="Expected payments you have confirmed, and payments towards money owed"
              />
              {settled.length === 0 ? (
                <EmptyState icon={Check} title="Nothing yet" message={`Nothing was ${filter} in the last 30 days.`} className="py-6" />
              ) : (
                <ul>
                  {settled.map((s) => (
                    <SettledRow key={s.transaction.id} s={s} lookup={lookup} onOpen={openDetail} />
                  ))}
                </ul>
              )}
            </Card>
          ) : (
            <>
              {/* Overdue items already lead the list, so this holds only reminders for what is coming. */}
              {filter === 'all' && reminders.some((e) => e.status !== 'overdue') && (
                <Card className="border-warning/30 bg-warning-soft/40">
                  <CardHeader title="Reminders" subtitle="Inside the reminder you set. Snooze any you already have in hand." />
                  <ul className="divide-y divide-line">
                    {reminders
                      .filter((e) => e.status !== 'overdue')
                      .map((e) => (
                        <EventRow key={`r-${e.key}`} e={e} {...rowProps} />
                      ))}
                  </ul>
                </Card>
              )}
              {expected.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={CalendarClock}
                    title="Nothing expected"
                    message={filter === 'all' ? `Nothing is expected ${periodLabel}.` : 'Nothing matches this filter. Try another, or look further ahead.'}
                  />
                </Card>
              ) : (
                groups
                  .filter((g) => g.items.length > 0)
                  .map((g) => {
                    const t = expectedTotals(g.items);
                    return (
                      <Card key={g.key}>
                        <CardHeader
                          title={g.title}
                          subtitle={`${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}${currency ? ` · in ${formatMoney(t.incoming, currency)} · out ${formatMoney(t.outgoing, currency)}` : ''}`}
                        />
                        <ul className="divide-y divide-line">
                          {g.items.map((e) => (
                            <EventRow key={e.key} e={e} {...rowProps} />
                          ))}
                        </ul>
                      </Card>
                    );
                  })
              )}
              {filter === 'all' && undated.length > 0 && (
                <Card>
                  <CardHeader title="Owed, with no date set" subtitle="Not counted in the expected totals above until you give them a date" />
                  <ul className="divide-y divide-line">
                    {undated.map((p) => (
                      <li key={p.obligation.id}>
                        <button
                          type="button"
                          onClick={() => setEditing({ key: `o:${p.obligation.id}`, source: 'obligation', sourceId: p.obligation.id } as ExpectedEvent)}
                          className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-canvas"
                        >
                          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink-2">
                            <HandCoins className="size-[18px]" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[15px] font-semibold text-ink">{lookup.personName(p.obligation.personId) ?? p.obligation.title}</span>
                            <span className="block truncate text-[13px] text-ink-3">{p.obligation.title}</span>
                          </span>
                          <span className="money text-[15px] font-bold text-ink">{formatMoney(p.outstanding, p.obligation.currency)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          ))}

        {/* ── Week ── */}
        {view === 'week' && (
          <Card>
            <PeriodNav
              label={`${formatDay(range.from)} to ${formatDay(range.to)}`}
              onPrev={() => setCursor(addDays(range.from, -7))}
              onNext={() => setCursor(addDays(range.from, 7))}
              onToday={weekStart(now) === range.from ? undefined : () => setCursor(now)}
            />
            <WeekGrid range={range} placed={byDay(expected, settled)} now={now} currency={currency} lookup={lookup} onOpen={setOpen} onOpenTransaction={openDetail} />
          </Card>
        )}

        {/* ── Month ── */}
        {view === 'month' && (
          <MonthView
            range={range}
            placed={byDay(expected, settled)}
            now={now}
            currency={currency}
            selected={selectedDay}
            onSelect={setSelectedDay}
            onPrev={() => {
              setCursor(addDays(range.from, -1));
              setSelectedDay(null);
            }}
            onNext={() => {
              setCursor(addDays(range.to, 1));
              setSelectedDay(null);
            }}
            onToday={range.from === monthRange(now).from ? undefined : () => setCursor(now)}
            rowProps={rowProps}
            onOpenTransaction={openDetail}
          />
        )}
        {view !== 'list' && all.some((e) => e.status === 'overdue') && !showingSettled && (
          <p className="px-1 text-[13px] text-ink-3">
            Overdue items are listed in the{' '}
            <button type="button" onClick={() => update({ view: 'list', show: 'overdue' })} className="font-bold text-accent hover:text-accent-strong">
              list view
            </button>
            .
          </p>
        )}
      </div>

      {open && (
        <EventSheet
          e={open}
          input={input}
          lookup={lookup}
          now={now}
          onClose={() => setOpen(null)}
          onSettle={(e) => {
            setOpen(null);
            setSettling(e);
          }}
          onEdit={(e) => {
            setOpen(null);
            setEditing(e);
          }}
        />
      )}
      {settling?.source === 'recurring' && <ConfirmRecurring e={settling} currency={lookup.currencyOf(settling.spaceId)} onClose={() => setSettling(null)} />}
      {settlingObligation && <ReceivePayForm settle={settlingObligation} amount={settling!.amount} onClose={() => setSettling(null)} />}
      {editingRecurring && (
        <RecurringEditor spaceId={editingRecurring.spaceId} currency={lookup.currencyOf(editingRecurring.spaceId)} item={editingRecurring} onClose={() => setEditing(null)} />
      )}
      <ObligationSheet key={editingObligation?.sourceId ?? 'none'} id={editingObligation?.sourceId ?? null} onClose={() => setEditing(null)} />
    </div>
  );
}

// ── Week grid ──────────────────────────────────────────────────────────────

interface WeekGridProps {
  range: DateRange;
  placed: Map<ISODate, Placed>;
  now: ISODate;
  currency: string | null;
  lookup: Lookup;
  onOpen: (e: ExpectedEvent) => void;
  onOpenTransaction: (id: ID) => void;
}

function WeekGrid({ range, placed, now, currency, lookup, onOpen, onOpenTransaction }: WeekGridProps) {
  const days = Array.from({ length: diffDays(range.from, range.to) + 1 }, (_, i) => addDays(range.from, i));
  return (
    <ol className="mt-4 grid gap-2 md:grid-cols-7">
      {days.map((day, i) => {
        const entry = placed.get(day) ?? { expected: [], settled: [] };
        const empty = entry.expected.length === 0 && entry.settled.length === 0;
        return (
          <li key={day} className={cn('min-w-0 rounded-xl border p-2.5', day === now ? 'border-accent bg-accent-soft/40' : 'border-line', empty && 'max-md:hidden')}>
            <div className="flex items-baseline justify-between gap-2">
              <span className={cn('text-xs font-bold', day === now ? 'text-accent-strong' : 'text-ink-2')}>
                {WEEKDAYS[i]} {parseISODate(day).getDate()}
              </span>
              <DayNet placed={entry} currency={currency} />
            </div>
            <ul className="mt-2 space-y-1.5">
              {entry.expected.map((e) => (
                <li key={e.key}>
                  <button
                    type="button"
                    onClick={() => onOpen(e)}
                    className={cn(
                      'w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors',
                      e.direction === 'in' ? 'bg-positive-soft hover:bg-positive-soft/70' : 'bg-sunken hover:bg-line',
                    )}
                  >
                    <span className="block truncate font-semibold text-ink">{e.title}</span>
                    <span className={cn('money block font-bold', e.direction === 'in' ? 'text-positive' : 'text-ink-2')}>
                      {signed(e.amount, e.direction, lookup.currencyOf(e.spaceId))}
                    </span>
                  </button>
                </li>
              ))}
              {entry.settled.map((s) => (
                <li key={s.transaction.id}>
                  <button
                    type="button"
                    onClick={() => onOpenTransaction(s.transaction.id)}
                    className="w-full rounded-lg border border-line px-2 py-1.5 text-left text-xs hover:bg-canvas"
                  >
                    <span className="flex items-center gap-1 truncate font-semibold text-ink">
                      <Check aria-hidden className="size-3 shrink-0 text-positive" />
                      {s.transaction.description || 'Settled'}
                    </span>
                    <span className="money block font-bold text-ink-2">{signed(s.transaction.amount, s.direction, s.transaction.currency)}</span>
                  </button>
                </li>
              ))}
              {empty && <li className="text-xs text-ink-3">Nothing</li>}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

// ── Month view ─────────────────────────────────────────────────────────────

interface MonthViewProps {
  range: DateRange;
  placed: Map<ISODate, Placed>;
  now: ISODate;
  currency: string | null;
  selected: ISODate | null;
  onSelect: (day: ISODate | null) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  rowProps: Omit<EventRowProps, 'e'>;
  onOpenTransaction: (id: ID) => void;
}

function MonthView({ range, placed, now, currency, selected, onSelect, onPrev, onNext, onToday, rowProps, onOpenTransaction }: MonthViewProps) {
  const first = weekStart(range.from);
  const last = addDays(weekStart(range.to), 6);
  const cells = Array.from({ length: diffDays(first, last) + 1 }, (_, i) => addDays(first, i));
  // With nothing picked, the list below shows the whole month.
  const daysInList = selected ? [selected] : [...placed.keys()].filter((d) => d >= range.from && d <= range.to).sort();

  return (
    <>
      <Card>
        <PeriodNav label={formatMonthYear(range.from)} onPrev={onPrev} onNext={onNext} onToday={onToday} />
        <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] font-bold uppercase tracking-wide text-ink-3">
          {WEEKDAYS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <ol className="mt-1 grid grid-cols-7 gap-1">
          {cells.map((day) => {
            const inMonth = day >= range.from && day <= range.to;
            const entry = placed.get(day);
            const count = (entry?.expected.length ?? 0) + (entry?.settled.length ?? 0);
            const isSelected = day === selected;
            return (
              <li key={day} className="min-w-0">
                <button
                  type="button"
                  disabled={!inMonth}
                  aria-pressed={isSelected}
                  aria-label={`${formatFullDate(day)}${count ? `, ${count} ${count === 1 ? 'item' : 'items'}` : ''}`}
                  onClick={() => onSelect(isSelected ? null : day)}
                  className={cn(
                    'flex h-14 w-full flex-col items-center justify-start gap-1 rounded-lg border p-1 transition-colors sm:h-20 sm:items-stretch sm:p-1.5',
                    !inMonth && 'invisible',
                    isSelected ? 'border-accent bg-accent-soft' : day === now ? 'border-accent/50' : 'border-transparent hover:bg-canvas',
                  )}
                >
                  <span className={cn('text-xs font-bold sm:text-left', day === now ? 'text-accent-strong' : 'text-ink-2')}>{parseISODate(day).getDate()}</span>
                  {entry && count > 0 && (
                    <>
                      <span className="flex justify-center gap-0.5 sm:hidden">
                        {entry.expected.slice(0, 3).map((e) => (
                          <span key={e.key} className={cn('size-1.5 rounded-full', e.direction === 'in' ? 'bg-positive' : e.status === 'overdue' ? 'bg-negative' : 'bg-ink-3')} />
                        ))}
                        {entry.settled.length > 0 && <span className="size-1.5 rounded-full bg-accent" />}
                      </span>
                      <span className="hidden min-w-0 text-left sm:block">
                        <DayNet placed={entry} currency={currency} />
                        <span className="block truncate text-left text-[11px] text-ink-3">
                          {count} {count === 1 ? 'item' : 'items'}
                        </span>
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card>
        <CardHeader
          title={selected ? formatFullDate(selected) : `Everything in ${formatMonthYear(range.from)}`}
          action={
            selected ? (
              <Button size="sm" icon={<CalendarDays className="size-4" />} onClick={() => onSelect(null)}>
                Whole month
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
                <List aria-hidden className="size-3.5" />
                Pick a day to narrow this
              </span>
            )
          }
        />
        {daysInList.every((d) => !placed.get(d)) ? (
          <p className="text-sm text-ink-3">{selected ? 'Nothing on this day.' : 'Nothing in this month for this filter.'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {daysInList.flatMap((d) => [
              ...(placed.get(d)?.expected ?? []).map((e) => <EventRow key={e.key} e={e} {...rowProps} />),
              ...(placed.get(d)?.settled ?? []).map((s) => (
                <li key={s.transaction.id} className="py-1 first:pt-0 last:pb-0">
                  <ul>
                    <SettledRow s={s} lookup={rowProps.lookup} onOpen={onOpenTransaction} />
                  </ul>
                </li>
              )),
            ])}
          </ul>
        )}
      </Card>
    </>
  );
}
