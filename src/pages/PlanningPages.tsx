import { Check, Minus, Pause, PiggyBank, Play, Plus, Repeat, SkipForward, Target, Trash2, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AmountInput, cleanAmount, FormShell } from '../components/money/OwedForms';
import { CategoryIcon } from '../components/money/parts';
import { Button, IconButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Input, Select, Textarea } from '../components/ui/Field';
import { iconFor } from '../components/ui/icons';
import { Badge, EmptyState, PageHeader, ProgressBar, Segmented } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useSpaceData, useSpaceRecords } from '../data/hooks';
import { store } from '../data/store';
import { formatDay, formatDueLabel, today } from '../domain/dates';
import { currencySymbol, formatMoney, formatPercent } from '../domain/format';
import { obligationPosition, owedToYouKind } from '../domain/money';
import {
  budgetMessage,
  budgetStatus,
  frequencyLabel,
  goalStatus,
  monthlyEquivalent,
  needsAttention,
  type BudgetAlert,
  type BudgetStatus,
  type GoalStatus,
} from '../domain/planning';
import type { Budget, BudgetFrequency, Goal, ID, Recurring, RecurringFrequency } from '../domain/types';
import { BackLink } from './MoneyPages';
import { ALERT_STYLE } from '../components/money/budgetStyle';

function Totals({ items }: { items: [label: string, value: string, tone?: string][] }) {
  return (
    <div className={cn('grid gap-3', items.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2')}>
      {items.map(([label, value, tone]) => (
        <Card key={label} className="min-w-0 !p-5">
          <p className="text-[13px] font-semibold text-ink-3">{label}</p>
          <p className={cn('money mt-1.5 truncate text-2xl font-extrabold tracking-tight', tone ?? 'text-ink')}>{value}</p>
        </Card>
      ))}
    </div>
  );
}

// ══ Budgets ════════════════════════════════════════════════════════════════

const BUDGET_FREQUENCIES: { value: BudgetFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Set dates' },
];


function BudgetEditor({ spaceId, currency, budget, onClose }: { spaceId: ID; currency: string; budget: Budget | null; onClose: () => void }) {
  const { categories } = useSpaceData();
  const toast = useToast();
  const expense = categories.filter((c) => c.kind === 'expense');
  const [name, setName] = useState<string | null>(budget?.name ?? null);
  const [amount, setAmount] = useState(budget ? String(budget.amount) : '');
  const [categoryId, setCategoryId] = useState(budget?.categoryId ?? '');
  const [subcategoryId, setSubcategoryId] = useState(budget?.subcategoryId ?? '');
  const [frequency, setFrequency] = useState<BudgetFrequency>(budget?.frequency ?? 'monthly');
  const [startDate, setStartDate] = useState(budget?.startDate ?? `${today().slice(0, 8)}01`);
  const [endDate, setEndDate] = useState(budget?.endDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const category = expense.find((c) => c.id === categoryId);
  const sub = category?.subcategories.find((s) => s.id === subcategoryId);
  // The name follows what the budget covers until the user types their own.
  const shownName = name ?? sub?.name ?? category?.name ?? 'All spending';

  function submit(e: FormEvent) {
    e.preventDefault();
    const draft = {
      name: shownName,
      amount: Number(amount),
      frequency,
      startDate,
      endDate: endDate || undefined,
      categoryId: categoryId || undefined,
      subcategoryId: subcategoryId || undefined,
    };
    const result = budget ? store.updateBudget(budget.id, draft) : store.addBudget(spaceId, draft);
    if (!result.ok) return setError(result.error);
    toast(budget ? 'Budget updated' : 'Budget created');
    onClose();
  }

  function remove() {
    if (!budget) return;
    store.deleteBudget(budget.id);
    toast(`${budget.name} budget deleted`);
    onClose();
  }

  return (
    <>
      {!deleting && (
        <FormShell title={budget ? 'Edit budget' : 'New budget'} formId="budget-form" submitLabel={budget ? 'Save changes' : 'Create budget'} error={error} onClose={onClose} onSubmit={submit}>
          <AmountInput
            value={amount}
            currency={currency}
            onChange={(v) => {
              setAmount(v);
              setError(null);
            }}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="What it covers">
              {(id) => (
                <Select
                  id={id}
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value);
                    setSubcategoryId('');
                    setError(null);
                  }}
                >
                  <option value="">All spending</option>
                  {expense.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Subcategory">
              {(id) => (
                <Select id={id} value={subcategoryId} disabled={!category || category.subcategories.length === 0} onChange={(e) => setSubcategoryId(e.target.value)}>
                  <option value="">{category ? `All of ${category.name}` : 'Choose a category first'}</option>
                  {category?.subcategories.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={shownName}
                maxLength={32}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Repeats</p>
            <Segmented label="How often the budget repeats" value={frequency} onChange={setFrequency} options={BUDGET_FREQUENCIES} className="flex w-full" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date">{(id) => <Input id={id} type="date" value={startDate} max="9999-12-31" onChange={(e) => setStartDate(e.target.value)} />}</Field>
            <Field label={frequency === 'custom' ? 'End date' : 'End date (optional)'}>
              {(id) => <Input id={id} type="date" value={endDate} min={startDate} max="9999-12-31" onChange={(e) => setEndDate(e.target.value)} />}
            </Field>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-3">
            {frequency === 'custom' ? 'One budget for exactly these dates.' : `Starts fresh every ${frequency === 'weekly' ? 'Monday' : frequency === 'monthly' ? 'month' : 'year'}.`} Progress is
            worked out from the transactions you record.
          </p>
          {budget && (
            <Button icon={<Trash2 className="size-4" />} className="text-negative" onClick={() => setDeleting(true)}>
              Delete budget
            </Button>
          )}
        </FormShell>
      )}
      <ConfirmDialog
        open={deleting}
        title={`Delete the ${budget?.name ?? ''} budget?`}
        message="Only the budget is removed. Your transactions stay exactly as they are."
        confirmLabel="Delete budget"
        destructive
        onConfirm={remove}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

function BudgetCard({ status, currency, onEdit }: { status: BudgetStatus; currency: string; onEdit: () => void }) {
  const { categories } = useSpaceData();
  const { budget, period, spent, remaining, used, projected, expectedByNow, daysLeft, alert } = status;
  const category = categories.find((c) => c.id === budget.categoryId);
  const style = alert ? ALERT_STYLE[alert] : null;
  const money = (n: number) => formatMoney(n, currency);
  const message = budgetMessage(status, currency);
  const link = period
    ? `/transactions?type=expense&period=custom&from=${period.from}&to=${period.to}${budget.categoryId ? `&category=${encodeURIComponent(budget.categoryId)}` : ''}`
    : '/transactions';

  return (
    <Card className="flex h-full flex-col !p-5">
      <div className="flex items-start gap-3">
        <CategoryIcon icon={category?.icon ?? 'coins'} color={category?.color ?? 'cobalt'} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-ink">{budget.name}</h2>
          <p className="truncate text-[13px] text-ink-3">
            {period ? `${formatDay(period.from)} to ${formatDay(period.to)} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left` : 'Not running now'}
          </p>
        </div>
        {style && <Badge tone={style.tone}>{style.label}</Badge>}
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="money text-2xl font-extrabold tracking-tight text-ink">{money(spent)}</p>
        <p className="money text-sm text-ink-3">of {money(budget.amount)}</p>
      </div>
      <ProgressBar value={used} color={style?.bar} label={`${budget.name} budget used`} className="mt-2 !h-2" />
      <div className="mt-2 flex justify-between gap-3 text-[13px]">
        <span className="font-semibold text-ink-2">{formatPercent(used)} used</span>
        <span className={cn('money font-semibold', remaining < 0 ? 'text-negative' : 'text-ink-2')}>
          {remaining < 0 ? `${money(-remaining)} over` : `${money(remaining)} left`}
        </span>
      </div>

      {period && (
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-[13px]">
          <div className="min-w-0">
            <dt className="text-ink-3">Even pace by today</dt>
            <dd className="money truncate font-bold text-ink">{money(expectedByNow)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-3">Heading for</dt>
            <dd className={cn('money truncate font-bold', projected > budget.amount ? 'text-negative' : 'text-ink')}>{money(projected)}</dd>
          </div>
        </dl>
      )}
      {message && <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-2">{message}</p>}

      <div className={cn('flex items-center justify-between gap-2 border-t border-line pt-3', message ? 'mt-3' : 'mt-auto')}>
        <Link to={link} className="text-sm font-bold text-accent hover:text-accent-strong">
          See transactions
        </Link>
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
      </div>
    </Card>
  );
}

export function BudgetsPage() {
  const { space, currency, budgets, transactions } = useSpaceData();
  const [editor, setEditor] = useState<{ budget: Budget | null } | null>(null);
  const statuses = useMemo(() => budgets.map((b) => budgetStatus(b, transactions)), [budgets, transactions]);
  if (!space) return null;

  // Budgets that need a look come first.
  const order: (BudgetAlert | null)[] = ['exceeded', 'likely', 'approaching', null, 'below'];
  const running = statuses.filter((s) => s.period).sort((a, b) => order.indexOf(a.alert) - order.indexOf(b.alert) || b.used - a.used);
  const idle = statuses.filter((s) => !s.period);
  const warnings = running.filter((s) => s.alert && s.alert !== 'below');

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title="Budgets"
        subtitle={`Spending limits for ${space.name}, measured against what you record`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ budget: null })}>
            New budget
          </Button>
        }
      />

      {statuses.length === 0 ? (
        <Card>
          <EmptyState
            icon={PiggyBank}
            title="No budgets yet"
            message="Set a limit for a category, or for all your spending, and Finken will show how you are pacing against it."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ budget: null })}>
                New budget
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {warnings.length > 0 && (
            <Card className="mb-4 !p-5">
              <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-3">Worth a look</h2>
              <ul className="mt-2 space-y-1.5">
                {warnings.map((s) => (
                  <li key={s.budget.id} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink">
                    <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full" style={{ background: ALERT_STYLE[s.alert!].bar }} />
                    {budgetMessage(s, currency)}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
            {running.map((s) => (
              <li key={s.budget.id}>
                <BudgetCard status={s} currency={currency} onEdit={() => setEditor({ budget: s.budget })} />
              </li>
            ))}
          </ul>
          {idle.length > 0 && (
            <Card className="mt-4">
              <CardHeader title="Not running now" subtitle="These have not started yet, or have ended" />
              <ul className="divide-y divide-line">
                {idle.map(({ budget }) => (
                  <li key={budget.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{budget.name}</p>
                      <p className="text-[13px] text-ink-3">
                        {formatMoney(budget.amount, currency)} · {budget.startDate > today() ? `starts ${formatDay(budget.startDate)}` : `ended ${formatDay(budget.endDate ?? budget.startDate)}`}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setEditor({ budget })}>
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {editor && <BudgetEditor key={editor.budget?.id ?? 'new'} spaceId={space.id} currency={currency} budget={editor.budget} onClose={() => setEditor(null)} />}
    </div>
  );
}

// ══ Goals ══════════════════════════════════════════════════════════════════

const GOAL_ICONS = ['laptop', 'heart-pulse', 'plane', 'car', 'graduation-cap', 'home', 'gift', 'briefcase', 'scale', 'coins'];
const GOAL_IDEAS: [name: string, icon: string][] = [
  ['Emergency Fund', 'heart-pulse'],
  ['New Laptop', 'laptop'],
  ['Family Vacation', 'plane'],
  ['Car', 'car'],
  ['Education', 'graduation-cap'],
];

function GoalEditor({ spaceId, currency, goal, onClose }: { spaceId: ID; currency: string; goal: Goal | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState(goal ? String(goal.targetAmount) : '');
  const [saved, setSaved] = useState('');
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [icon, setIcon] = useState(goal?.icon ?? 'coins');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const draft = { name, targetAmount: Number(target), targetDate: targetDate || undefined, icon, description };
    const result = goal ? store.updateGoal(goal.id, draft) : store.addGoal(spaceId, draft, saved ? Number(saved) : 0);
    if (!result.ok) return setError(result.error);
    toast(goal ? 'Goal updated' : `${name.trim()} goal created`);
    onClose();
  }

  return (
    <FormShell title={goal ? 'Edit goal' : 'New goal'} formId="goal-form" submitLabel={goal ? 'Save changes' : 'Create goal'} error={error} onClose={onClose} onSubmit={submit}>
      <Field label="What are you saving for?">
        {(id) => (
          <Input
            id={id}
            data-autofocus
            value={name}
            maxLength={40}
            placeholder="e.g. New Laptop"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      {!goal && !name && (
        <div className="-mt-2 flex flex-wrap gap-2">
          {GOAL_IDEAS.map(([idea, ideaIcon]) => (
            <button
              key={idea}
              type="button"
              onClick={() => {
                setName(idea);
                setIcon(ideaIcon);
              }}
              className="h-8 rounded-full border border-line px-3 text-[13px] font-semibold text-ink-2 transition-colors hover:border-line-strong"
            >
              {idea}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Target (${currencySymbol(currency)})`}>
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              className="money"
              value={target}
              onChange={(e) => {
                setTarget(cleanAmount(e.target.value));
                setError(null);
              }}
            />
          )}
        </Field>
        {goal ? (
          <Field label="Target date">{(id) => <Input id={id} type="date" value={targetDate} max="9999-12-31" onChange={(e) => setTargetDate(e.target.value)} />}</Field>
        ) : (
          <Field label={`Already saved (${currencySymbol(currency)})`}>
            {(id) => <Input id={id} inputMode="decimal" autoComplete="off" placeholder="0" className="money" value={saved} onChange={(e) => setSaved(cleanAmount(e.target.value))} />}
          </Field>
        )}
      </div>
      {!goal && (
        <Field label="Target date" hint="Optional. With a date, Finken works out how much to set aside each month.">
          {(id) => <Input id={id} type="date" value={targetDate} min={today()} max="9999-12-31" onChange={(e) => setTargetDate(e.target.value)} />}
        </Field>
      )}
      <fieldset>
        <legend className="mb-2 text-[13px] font-semibold text-ink-2">Icon</legend>
        <div className="flex flex-wrap gap-1.5">
          {GOAL_ICONS.map((key) => {
            const Icon = iconFor(key);
            const active = key === icon;
            return (
              <button
                key={key}
                type="button"
                aria-label={key.replace(/-/g, ' ')}
                aria-pressed={active}
                onClick={() => setIcon(key)}
                className={cn(
                  'flex size-10 items-center justify-center rounded-xl border transition-colors',
                  active ? 'border-accent bg-accent text-white' : 'border-line text-ink-2 hover:border-line-strong',
                )}
              >
                <Icon aria-hidden className="size-[18px]" />
              </button>
            );
          })}
        </div>
      </fieldset>
      <Field label="Description">{(id) => <Textarea id={id} value={description} maxLength={200} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} />}</Field>
    </FormShell>
  );
}

function goalLine(s: GoalStatus, currency: string): { text: string; tone: string } {
  if (s.reached) return { text: 'Reached. Well done.', tone: 'text-positive' };
  if (s.late) return { text: `The target date of ${formatDay(s.goal.targetDate!)} has passed.`, tone: 'text-negative' };
  if (s.monthlyNeeded !== null) {
    return { text: `${formatMoney(s.monthlyNeeded, currency)} a month reaches it by ${formatDay(s.goal.targetDate!)}.`, tone: 'text-ink-2' };
  }
  return { text: 'No target date set.', tone: 'text-ink-3' };
}

type GoalAction = 'add' | 'take' | 'edit' | 'delete' | null;

function GoalSheet({ goalId, onClose }: { goalId: ID | null; onClose: () => void }) {
  const { currency, goals, goalEntries, space } = useSpaceData();
  const toast = useToast();
  const [action, setAction] = useState<GoalAction>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal || !space) return null;

  const status = goalStatus(goal, goalEntries);
  const entries = goalEntries.filter((e) => e.goalId === goal.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const money = (n: number) => formatMoney(n, currency);
  const line = goalLine(status, currency);
  const moving = action === 'add' || action === 'take';

  function start(next: 'add' | 'take') {
    setAction(next);
    setAmount('');
    setNote('');
    setDate(today());
    setError(null);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    const result = store.addGoalEntry(goal!.id, { amount: action === 'take' ? -value : value, date, note });
    if (!result.ok) return setError(result.error);
    toast(action === 'take' ? `${money(value)} taken out of ${goal!.name}` : `${money(value)} added to ${goal!.name}`);
    setAction(null);
  }

  function removeEntry(id: ID) {
    const result = store.deleteGoalEntry(id);
    toast(result.ok ? 'Entry removed' : result.error, result.ok ? undefined : { tone: 'error' });
  }

  function remove() {
    store.deleteGoal(goal!.id);
    toast(`${goal!.name} goal deleted`);
    onClose();
  }

  return (
    <>
      <Modal
        open={action !== 'edit' && action !== 'delete'}
        onClose={onClose}
        title={goal.name}
        description={goal.description || undefined}
        footer={
          moving ? undefined : (
            <div className="flex gap-2">
              <Button block variant="primary" size="lg" icon={<Plus className="size-4" />} onClick={() => start('add')}>
                Add money
              </Button>
              <Button block size="lg" icon={<Minus className="size-4" />} disabled={status.saved <= 0} onClick={() => start('take')}>
                Take out
              </Button>
            </div>
          )
        }
      >
        <div className="rounded-card bg-canvas px-4 py-5">
          <p className="text-[13px] font-semibold text-ink-3">Saved</p>
          <p className="money mt-1 text-[32px] font-extrabold leading-tight tracking-tight text-ink">{money(status.saved)}</p>
          <ProgressBar value={status.progress} color={status.reached ? 'var(--color-positive)' : undefined} label={`${goal.name} progress`} className="mt-4 !h-2" />
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {(
              [
                ['Target', money(goal.targetAmount)],
                ['Remaining', money(status.remaining)],
                ['Complete', formatPercent(status.progress)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd className="money truncate text-sm font-bold text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className={cn('mt-3 text-sm font-semibold', line.tone)}>{line.text}</p>

        {moving ? (
          <form onSubmit={save} noValidate className="mt-4 space-y-3 rounded-card border border-line p-4">
            <p className="text-sm font-bold text-ink">{action === 'add' ? 'Add money to this goal' : 'Take money out of this goal'}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Amount (${currencySymbol(currency)})`}>
                {(id) => (
                  <Input
                    id={id}
                    autoFocus
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    className="money"
                    value={amount}
                    onChange={(e) => {
                      setAmount(cleanAmount(e.target.value));
                      setError(null);
                    }}
                  />
                )}
              </Field>
              <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>
            </div>
            <Field label="Note">{(id) => <Input id={id} value={note} maxLength={80} placeholder="Optional" onChange={(e) => setNote(e.target.value)} />}</Field>
            {error && (
              <p role="alert" className="text-sm font-semibold text-negative">
                {error}
              </p>
            )}
            <p className="text-[13px] leading-relaxed text-ink-3">
              This marks money as set aside. It does not move anything between your accounts and is not counted as spending.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAction(null)}>Cancel</Button>
              <Button type="submit" variant="primary">
                {action === 'add' ? 'Add money' : 'Take out'}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-[13px] font-semibold text-ink-3">History</p>
              {entries.length === 0 ? (
                <p className="mt-1.5 text-sm text-ink-3">Nothing has been set aside yet.</p>
              ) : (
                <ul className="mt-1 divide-y divide-line">
                  {entries.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">{e.note || (e.amount > 0 ? 'Added' : 'Taken out')}</span>
                        <span className="block text-[13px] text-ink-3">{formatDay(e.date)}</span>
                      </span>
                      <span className={cn('money font-bold', e.amount > 0 ? 'text-positive' : 'text-ink')}>{formatMoney(e.amount, currency, { signed: true })}</span>
                      <IconButton label="Remove this entry" onClick={() => removeEntry(e.id)}>
                        <X className="size-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" onClick={() => setAction('edit')}>
                Edit goal
              </Button>
              <Button size="sm" icon={<Trash2 className="size-4" />} className="text-negative" onClick={() => setAction('delete')}>
                Delete
              </Button>
            </div>
          </>
        )}
      </Modal>
      {action === 'edit' && <GoalEditor spaceId={space.id} currency={currency} goal={goal} onClose={() => setAction(null)} />}
      <ConfirmDialog
        open={action === 'delete'}
        title={`Delete the ${goal.name} goal?`}
        message="The goal and its history are removed. Your account balances do not change, because setting money aside never moved it."
        confirmLabel="Delete goal"
        destructive
        onConfirm={remove}
        onCancel={() => setAction(null)}
      />
    </>
  );
}

export function GoalsPage() {
  const { space, currency, goals, goalEntries } = useSpaceData();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<ID | null>(null);
  const statuses = useMemo(
    () => goals.map((g) => goalStatus(g, goalEntries)).sort((a, b) => Number(a.reached) - Number(b.reached) || b.progress - a.progress),
    [goals, goalEntries],
  );
  if (!space) return null;
  const saved = statuses.reduce((sum, s) => sum + s.saved, 0);
  const monthly = statuses.reduce((sum, s) => sum + (s.monthlyNeeded ?? 0), 0);

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title="Goals"
        subtitle={`What ${space.name} is saving towards`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            New goal
          </Button>
        }
      />

      {statuses.length === 0 ? (
        <Card>
          <EmptyState
            icon={Target}
            title="No goals yet"
            message="Pick something to save for. Finken tracks how far you have come and what it takes each month to get there."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                New goal
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Totals
            items={[
              ['Set aside so far', formatMoney(saved, currency), 'text-positive'],
              ['Needed each month', formatMoney(monthly, currency)],
            ]}
          />
          <p className="mt-3 px-1 text-[13px] leading-relaxed text-ink-3">
            Money set aside for a goal is still in your accounts. It is kept separate from spending, so it never appears as an expense.
          </p>
          <ul className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
            {statuses.map((s) => {
              const line = goalLine(s, currency);
              return (
                <li key={s.goal.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(s.goal.id)}
                    className="block h-full w-full rounded-card border border-line bg-surface p-5 text-left shadow-card transition-colors hover:border-line-strong"
                  >
                    <span className="flex items-start gap-3">
                      <CategoryIcon icon={s.goal.icon} color={s.reached ? 'green' : 'cobalt'} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base font-bold text-ink">{s.goal.name}</span>
                        <span className="block truncate text-[13px] text-ink-3">{s.goal.targetDate ? `By ${formatDay(s.goal.targetDate)}` : 'No date set'}</span>
                      </span>
                      <span className="money text-sm font-bold text-ink-2">{formatPercent(s.progress)}</span>
                    </span>
                    <span className="mt-4 flex items-baseline justify-between gap-3">
                      <span className="money text-2xl font-extrabold tracking-tight text-ink">{formatMoney(s.saved, currency)}</span>
                      <span className="money text-sm text-ink-3">of {formatMoney(s.goal.targetAmount, currency)}</span>
                    </span>
                    <ProgressBar value={s.progress} color={s.reached ? 'var(--color-positive)' : undefined} label={`${s.goal.name} progress`} className="mt-2 !h-2" />
                    <span className="mt-2 block text-[13px] font-semibold text-ink-2">{s.reached ? 'Nothing left to save' : `${formatMoney(s.remaining, currency)} to go`}</span>
                    <span className={cn('mt-1 block text-[13px]', line.tone)}>{line.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <GoalSheet key={openId ?? 'none'} goalId={openId} onClose={() => setOpenId(null)} />
      {adding && <GoalEditor spaceId={space.id} currency={currency} goal={null} onClose={() => setAdding(false)} />}
    </div>
  );
}

// ══ Recurring ══════════════════════════════════════════════════════════════

const FREQUENCIES: { value: RecurringFrequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Every year' },
  { value: 'custom', label: 'Every few days…' },
];

const REMINDERS: { value: string; label: string }[] = [
  { value: '', label: 'No reminder' },
  { value: '0', label: 'On the day' },
  { value: '1', label: '1 day before' },
  { value: '3', label: '3 days before' },
  { value: '7', label: '1 week before' },
];

export function RecurringEditor({ spaceId, currency, item, onClose }: { spaceId: ID; currency: string; item: Recurring | null; onClose: () => void }) {
  const { categories, accounts, obligations, transactions, people } = useSpaceRecords(spaceId);
  const toast = useToast();
  const [type, setType] = useState<'expense' | 'income'>(item?.type ?? 'expense');
  const [name, setName] = useState(item?.name ?? '');
  const [amount, setAmount] = useState(item ? String(item.amount) : '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [obligationId, setObligationId] = useState(item?.obligationId ?? '');
  const [accountId, setAccountId] = useState(item?.accountId ?? '');
  const [frequency, setFrequency] = useState<RecurringFrequency>(item?.frequency ?? 'monthly');
  const [interval, setInterval] = useState(item?.intervalDays ? String(item.intervalDays) : '10');
  const [startDate, setStartDate] = useState(item?.startDate ?? today());
  const [endDate, setEndDate] = useState(item?.endDate ?? '');
  const [nextDue, setNextDue] = useState(item?.nextDueDate ?? '');
  const [reminder, setReminder] = useState(item?.reminderDays === undefined ? (item ? '' : '3') : String(item.reminderDays));
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const usable = accounts.filter((a) => !a.archived || a.id === item?.accountId);
  const account = usable.find((a) => a.id === accountId) ?? usable[0];
  const kindCategories = categories.filter((c) => c.kind === type);
  // What this could pay down: loans and bills for a payment, money owed to you for income.
  const payable = obligations
    .filter((o) => owedToYouKind(o.kind) === (type === 'income'))
    .map((o) => obligationPosition(o, transactions))
    .filter((p) => p.state === 'open' || p.obligation.id === item?.obligationId);

  function submit(e: FormEvent) {
    e.preventDefault();
    const draft = {
      name,
      amount: Number(amount),
      type,
      accountId: account?.id ?? '',
      frequency,
      intervalDays: frequency === 'custom' ? Number(interval) : undefined,
      startDate,
      endDate: endDate || undefined,
      reminderDays: reminder === '' ? undefined : Number(reminder),
      obligationId: obligationId || undefined,
      categoryId: obligationId ? undefined : categoryId || kindCategories[0]?.id,
    };
    const result = item ? store.updateRecurring(item.id, draft, nextDue || undefined) : store.addRecurring(spaceId, draft);
    if (!result.ok) return setError(result.error);
    toast(item ? 'Changes saved' : `${name.trim()} added`);
    onClose();
  }

  function setStatus(status: 'active' | 'paused' | 'cancelled') {
    if (!item) return;
    const result = store.setRecurringStatus(item.id, status);
    setConfirm(null);
    if (!result.ok) return setError(result.error);
    toast(status === 'active' ? `${item.name} resumed` : status === 'paused' ? `${item.name} paused` : `${item.name} cancelled`);
    onClose();
  }

  function remove() {
    if (!item) return;
    store.deleteRecurring(item.id);
    toast(`${item.name} deleted`);
    onClose();
  }

  return (
    <>
      {confirm === null && (
        <FormShell title={item ? 'Edit recurring item' : 'New recurring item'} formId="recurring-form" submitLabel={item ? 'Save changes' : 'Save'} error={error} onClose={onClose} onSubmit={submit}>
          <Segmented
            label="Direction"
            value={type}
            onChange={(v) => {
              setType(v);
              setCategoryId('');
              setObligationId('');
              setError(null);
            }}
            options={[
              { value: 'expense', label: 'Payment' },
              { value: 'income', label: 'Income' },
            ]}
            className="flex w-full"
          />
          <AmountInput
            value={amount}
            currency={currency}
            onChange={(v) => {
              setAmount(v);
              setError(null);
            }}
          />
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                maxLength={40}
                placeholder={type === 'expense' ? 'e.g. Rent, Internet, Insurance' : 'e.g. Salary'}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          {payable.length > 0 && (
            <Field label={type === 'expense' ? 'Pays towards' : 'Received towards'} hint={obligationId ? 'Confirming it records a repayment, which is never counted as spending or income by mistake.' : undefined}>
              {(id) => (
                <Select id={id} value={obligationId} onChange={(e) => setObligationId(e.target.value)}>
                  <option value="">Nothing in particular</option>
                  {payable.map((p) => (
                    <option key={p.obligation.id} value={p.obligation.id}>
                      {people.find((person) => person.id === p.obligation.personId)?.name ?? 'Someone'}: {p.obligation.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            {!obligationId && (
              <Field label={type === 'income' ? 'Income source' : 'Category'}>
                {(id) => (
                  <Select id={id} value={categoryId || kindCategories[0]?.id || ''} onChange={(e) => setCategoryId(e.target.value)}>
                    {kindCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label={type === 'income' ? 'Received in' : 'Paid from'} className={obligationId ? 'col-span-2' : undefined}>
              {(id) => (
                <Select id={id} value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                  {usable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Repeats" className={frequency === 'custom' ? undefined : 'col-span-2'}>
              {(id) => (
                <Select id={id} value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
                  {FREQUENCIES.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {frequency === 'custom' && (
              <Field label="Days apart">
                {(id) => <Input id={id} inputMode="numeric" autoComplete="off" className="money" value={interval} onChange={(e) => setInterval(e.target.value.replace(/\D/g, '').slice(0, 4))} />}
              </Field>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={item ? 'Started' : 'First due'}>{(id) => <Input id={id} type="date" value={startDate} max="9999-12-31" onChange={(e) => setStartDate(e.target.value)} />}</Field>
            <Field label="Ends (optional)">{(id) => <Input id={id} type="date" value={endDate} min={startDate} max="9999-12-31" onChange={(e) => setEndDate(e.target.value)} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {item && <Field label="Next due">{(id) => <Input id={id} type="date" value={nextDue} min={startDate} max="9999-12-31" onChange={(e) => setNextDue(e.target.value)} />}</Field>}
            <Field label="Reminder" className={item ? undefined : 'col-span-2'}>
              {(id) => (
                <Select id={id} value={reminder} onChange={(e) => setReminder(e.target.value)}>
                  {REMINDERS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-3">
            Finken never pays anything by itself. This is an expected {type === 'income' ? 'amount' : 'payment'}; you confirm each one when it actually happens. Reminders show
            inside Finken.
          </p>
          {item && (
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {item.status === 'active' ? (
                <Button size="sm" icon={<Pause className="size-4" />} onClick={() => setStatus('paused')}>
                  Pause
                </Button>
              ) : (
                <Button size="sm" icon={<Play className="size-4" />} onClick={() => setStatus('active')}>
                  Resume
                </Button>
              )}
              {item.status !== 'cancelled' && (
                <Button size="sm" icon={<X className="size-4" />} onClick={() => setConfirm('cancel')}>
                  Cancel it
                </Button>
              )}
              <Button size="sm" icon={<Trash2 className="size-4" />} className="text-negative" onClick={() => setConfirm('delete')}>
                Delete
              </Button>
            </div>
          )}
        </FormShell>
      )}
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`Cancel ${item?.name ?? 'this'}?`}
        message="It will stop appearing in what is coming up. Payments you already confirmed stay in your records, and you can resume it later."
        confirmLabel="Cancel it"
        onConfirm={() => setStatus('cancelled')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title={`Delete ${item?.name ?? 'this'}?`}
        message="The recurring item is removed for good. Payments you already confirmed stay in your records."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}

const STATUS_BADGE: Record<Recurring['status'], { label: string; tone: 'neutral' | 'warning' } | null> = {
  active: null,
  paused: { label: 'Paused', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  ended: { label: 'Ended', tone: 'neutral' },
};

export function RecurringPage() {
  const { space, currency, recurring, categories, accounts } = useSpaceData();
  const toast = useToast();
  const [editor, setEditor] = useState<{ item: Recurring | null } | null>(null);
  const [confirming, setConfirming] = useState<Recurring | null>(null);
  const attention = useMemo(() => needsAttention(recurring), [recurring]);
  if (!space) return null;

  const active = recurring.filter((r) => r.status === 'active').sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
  // Anything already listed under Due now is not repeated below.
  const dueIds = new Set(attention.map((item) => item.recurring.id));
  const later = active.filter((r) => !dueIds.has(r.id));
  const stopped = recurring.filter((r) => r.status !== 'active').sort((a, b) => a.name.localeCompare(b.name));
  const monthly = (type: Recurring['type']) => active.reduce((sum, r) => (r.type === type ? sum + monthlyEquivalent(r) : sum), 0);
  const money = (n: number) => formatMoney(n, currency);
  const paidWord = (r: Recurring) => (r.type === 'income' ? 'Mark received' : 'Mark paid');

  function confirm() {
    if (!confirming) return;
    const r = confirming;
    const saved = store.confirmRecurring(r.id);
    setConfirming(null);
    if (saved.ok) toast(r.type === 'income' ? `${r.name} marked as received` : `${r.name} marked as paid`);
    else toast(saved.error, { tone: 'error' });
  }

  function skip(r: Recurring) {
    const result = store.skipRecurring(r.id);
    toast(result.ok ? `Skipped ${r.name} this time` : result.error, result.ok ? undefined : { tone: 'error' });
  }

  const row = (r: Recurring, due: boolean) => {
    const category = categories.find((c) => c.id === r.categoryId);
    const account = accounts.find((a) => a.id === r.accountId);
    const badge = STATUS_BADGE[r.status];
    const overdue = r.status === 'active' && r.nextDueDate < today();
    return (
      <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
        <button type="button" onClick={() => setEditor({ item: r })} className="-m-1 flex min-w-0 flex-1 basis-56 items-center gap-3 rounded-xl p-1 text-left transition-colors hover:bg-canvas">
          <CategoryIcon icon={r.obligationId ? 'hand-coins' : (category?.icon ?? 'circle')} color={r.obligationId ? 'slate' : (category?.color ?? 'slate')} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-ink">{r.name}</span>
            <span className={cn('block truncate text-[13px]', overdue ? 'font-semibold text-negative' : 'text-ink-3')}>
              {frequencyLabel(r)}
              {r.status === 'active' ? ` · ${formatDay(r.nextDueDate)} · ${formatDueLabel(r.nextDueDate)}` : ''}
              {account ? ` · ${account.name}` : ''}
            </span>
          </span>
        </button>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        <span className={cn('money text-[15px] font-bold', r.type === 'income' ? 'text-positive' : 'text-ink')}>{formatMoney(r.type === 'income' ? r.amount : -r.amount, currency, { signed: true })}</span>
        {due && (
          <span className="flex gap-2 max-sm:w-full">
            <Button size="sm" variant="primary" icon={<Check className="size-4" />} onClick={() => setConfirming(r)} className="max-sm:flex-1">
              {paidWord(r)}
            </Button>
            <Button size="sm" icon={<SkipForward className="size-4" />} onClick={() => skip(r)}>
              Skip
            </Button>
          </span>
        )}
      </li>
    );
  };

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title="Recurring"
        subtitle={`Regular payments and income in ${space.name}. Nothing is recorded until you confirm it.`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ item: null })}>
            New recurring item
          </Button>
        }
      />

      {recurring.length === 0 ? (
        <Card>
          <EmptyState
            icon={Repeat}
            title="Nothing recurring yet"
            message="Add your salary, rent, bills and subscriptions once. Finken will show when each is due and let you confirm it with one tap."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ item: null })}>
                New recurring item
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Totals
            items={[
              ['Regular payments a month', money(monthly('expense'))],
              ['Regular income a month', money(monthly('income')), 'text-positive'],
              ['Left after regular payments', money(monthly('income') - monthly('expense'))],
            ]}
          />
          <div className="mt-4 space-y-4">
            {attention.length > 0 && (
              <Card>
                <CardHeader title="Due now" subtitle="Overdue, due today, or inside the reminder you set" />
                <ul className="divide-y divide-line">{attention.map((a) => row(a.recurring, true))}</ul>
              </Card>
            )}
            {later.length > 0 && (
              <Card>
                <CardHeader title="Coming later" subtitle={`${later.length} ${later.length === 1 ? 'item' : 'items'}, soonest first`} />
                <ul className="divide-y divide-line">{later.map((r) => row(r, false))}</ul>
              </Card>
            )}
            {stopped.length > 0 && (
              <Card>
                <CardHeader title="Paused and stopped" subtitle={`${stopped.length} ${stopped.length === 1 ? 'item' : 'items'}`} />
                <ul className="divide-y divide-line">{stopped.map((r) => row(r, false))}</ul>
              </Card>
            )}
          </div>
        </>
      )}

      {editor && <RecurringEditor key={editor.item?.id ?? 'new'} spaceId={space.id} currency={currency} item={editor.item} onClose={() => setEditor(null)} />}
      <ConfirmDialog
        open={Boolean(confirming)}
        title={confirming?.type === 'income' ? 'Mark as received?' : 'Mark as paid?'}
        message={
          confirming
            ? `Finken will record ${formatMoney(confirming.amount, currency)} for ${confirming.name} dated today, and move it to its next due date.${confirming.obligationId ? ' It is recorded as a repayment, not as ordinary spending.' : ''}`
            : ''
        }
        confirmLabel={confirming ? paidWord(confirming) : 'Confirm'}
        onConfirm={confirm}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
