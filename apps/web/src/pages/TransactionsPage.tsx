import { addDays, formatMonthYear, formatRelativeDay, monthRange, today } from '@finken/domain/dates';
import { formatMoney } from '@finken/domain/format';
import { filterTransactions, groupByDate, sortTransactions, summarize, type TransactionSort } from '@finken/domain/money';
import type { DateRange, TransactionType } from '@finken/domain/types';
import { Inbox, Plus, SearchX } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { TransactionItem } from '../components/money/parts';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input, SearchField, Select } from '../components/ui/Field';
import { EmptyState, PageHeader, Segmented } from '../components/ui/Misc';
import { useAppState, useSpaceData } from '../data/hooks';
import { store } from '../data/store';

type TypeFilter = TransactionType | 'owed' | 'all';

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'expense', label: 'Expenses' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfers' },
  { value: 'refund', label: 'Refunds' },
  { value: 'owed', label: 'Money owed' },
];
const TYPES = new Set<string>(TYPE_OPTIONS.map((o) => o.value));

const SORT_OPTIONS: { value: TransactionSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest amount' },
  { value: 'smallest', label: 'Smallest amount' },
];
const SORTS = new Set<string>(SORT_OPTIONS.map((o) => o.value));

const PERIODS: { value: string; label: string; range: (now: string) => DateRange }[] = [
  { value: 'this-month', label: 'This month', range: (now) => monthRange(now) },
  { value: 'last-month', label: 'Last month', range: (now) => monthRange(now, -1) },
  { value: 'last-7', label: 'Last 7 days', range: (now) => ({ from: addDays(now, -6), to: now }) },
  { value: 'last-90', label: 'Last 90 days', range: (now) => ({ from: addDays(now, -89), to: now }) },
  { value: 'this-year', label: 'This year', range: (now) => ({ from: `${now.slice(0, 4)}-01-01`, to: `${now.slice(0, 4)}-12-31` }) },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ALL_SPACES = 'all';

export function TransactionsPage() {
  const state = useAppState();
  const active = useSpaceData();
  const { openMenu, openDetail, canAdd } = useAddFlow();
  // Filters live in the URL so dashboards can link straight to a filtered list.
  const [params, setParams] = useSearchParams();

  const activeSpaces = useMemo(() => state.spaces.filter((s) => s.status === 'active'), [state.spaces]);
  // "All Spaces" is a view across everything; records still belong to their own Space.
  const allSpaces = params.get('space') === ALL_SPACES && activeSpaces.length > 1;
  const spaceIds = useMemo(() => new Set(allSpaces ? activeSpaces.map((s) => s.id) : active.space ? [active.space.id] : []), [allSpaces, activeSpaces, active.space]);
  const transactions = useMemo(() => state.transactions.filter((t) => spaceIds.has(t.spaceId)), [state.transactions, spaceIds]);
  const categories = useMemo(() => state.categories.filter((c) => spaceIds.has(c.spaceId)), [state.categories, spaceIds]);
  const accounts = useMemo(() => state.accounts.filter((a) => spaceIds.has(a.spaceId)), [state.accounts, spaceIds]);
  const currencies = new Set(activeSpaces.filter((s) => spaceIds.has(s.id)).map((s) => s.currency));
  // Totals only make sense in one currency.
  const currency = currencies.size === 1 ? [...currencies][0] : null;

  const search = params.get('q') ?? '';
  const type: TypeFilter = TYPES.has(params.get('type') ?? '') ? (params.get('type') as TypeFilter) : 'all';
  const sort: TransactionSort = SORTS.has(params.get('sort') ?? '') ? (params.get('sort') as TransactionSort) : 'newest';
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : '';
  const period = month || (params.get('period') === 'custom' || PERIODS.some((p) => p.value === params.get('period')) ? params.get('period')! : '');
  const from = ISO.test(params.get('from') ?? '') ? params.get('from')! : '';
  const to = ISO.test(params.get('to') ?? '') ? params.get('to')! : '';
  // Categories and accounts belong to one Space, so those filters apply only inside a single Space.
  const categoryId = !allSpaces && categories.some((c) => c.id === params.get('category')) ? params.get('category')! : '';
  const accountId = !allSpaces && accounts.some((a) => a.id === params.get('account')) ? params.get('account')! : '';

  function update(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value && value !== 'all' && value !== 'newest') next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  }

  function setPeriod(value: string) {
    if (/^\d{4}-\d{2}$/.test(value)) update({ month: value, period: '', from: '', to: '' });
    else update({ month: '', period: value, from: '', to: '' });
  }

  function setSpace(value: string) {
    if (value === ALL_SPACES) {
      const next = new URLSearchParams(params);
      next.set('space', ALL_SPACES);
      next.delete('category');
      next.delete('account');
      setParams(next, { replace: true });
    } else {
      store.setActiveSpace(value);
      update({ space: '', category: '', account: '' });
    }
  }

  /** Months that actually contain transactions, newest first. */
  const months = useMemo(() => {
    const set = new Set(transactions.map((t) => t.date.slice(0, 7)));
    set.add(today().slice(0, 7));
    return [...set].sort().reverse();
  }, [transactions]);

  const range = useMemo<DateRange | undefined>(() => {
    if (month) return monthRange(`${month}-01`);
    if (period === 'custom') return from || to ? { from: from || '0000-01-01', to: to || '9999-12-31' } : undefined;
    return PERIODS.find((p) => p.value === period)?.range(today());
  }, [month, period, from, to]);

  const filtered = useMemo(
    () => filterTransactions(transactions, { search, type, categoryId: categoryId || undefined, accountId: accountId || undefined, range }, categories),
    [transactions, categories, search, type, categoryId, accountId, range],
  );

  const byAmount = sort === 'largest' || sort === 'smallest';
  // By date the list is grouped into days; by amount it is one ranked list.
  const groups = useMemo(
    () => (byAmount ? [{ date: '', items: sortTransactions(filtered, sort) }].filter((g) => g.items.length > 0) : groupByDate(filtered, sort === 'oldest')),
    [filtered, sort, byAmount],
  );
  const totals = useMemo(() => summarize(filtered), [filtered]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const spaceById = useMemo(() => new Map(state.spaces.map((s) => [s.id, s])), [state.spaces]);
  const filtersActive = Boolean(search || type !== 'all' || period || categoryId || accountId || allSpaces || sort !== 'newest');
  const clear = () => setParams({}, { replace: true });

  if (!active.space) return null;
  const scope = allSpaces ? 'all your Spaces' : active.space.name;

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle={`Everything recorded in ${scope}`}
        action={
          canAdd && (
            <div className="hidden lg:block">
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={openMenu}>
                Add
              </Button>
            </div>
          )
        }
      />

      <div className="space-y-3">
        <SearchField value={search} onChange={(v) => update({ q: v })} placeholder="Search by description, category, note or amount" />
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Segmented label="Type" value={type} onChange={(v) => update({ type: v })} options={TYPE_OPTIONS} />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5 [&>*]:min-w-0">
          <Select aria-label="Dates" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">All time</option>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
            <optgroup label="By month">
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonthYear(`${m}-01`)}
                </option>
              ))}
            </optgroup>
          </Select>
          {activeSpaces.length > 1 && (
            <Select aria-label="Space" value={allSpaces ? ALL_SPACES : active.space.id} onChange={(e) => setSpace(e.target.value)}>
              {activeSpaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value={ALL_SPACES}>All Spaces</option>
            </Select>
          )}
          <Select aria-label="Category" value={categoryId} disabled={allSpaces} onChange={(e) => update({ category: e.target.value })}>
            <option value="">{allSpaces ? 'Categories (one Space)' : 'All categories'}</option>
            {!allSpaces &&
              categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
          <Select aria-label="Account" value={accountId} disabled={allSpaces} onChange={(e) => update({ account: e.target.value })}>
            <option value="">{allSpaces ? 'Accounts (one Space)' : 'All accounts'}</option>
            {!allSpaces &&
              accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archived ? ' (archived)' : ''}
                </option>
              ))}
          </Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {period === 'custom' && (
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <label className="text-[13px] font-semibold text-ink-2">
              From
              <Input type="date" value={from} max={to || '9999-12-31'} onChange={(e) => update({ from: e.target.value })} className="mt-1.5" />
            </label>
            <label className="text-[13px] font-semibold text-ink-2">
              To
              <Input type="date" value={to} min={from || undefined} max="9999-12-31" onChange={(e) => update({ to: e.target.value })} className="mt-1.5" />
            </label>
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1 text-sm">
        <p className="font-semibold text-ink-2">
          {filtered.length} {filtered.length === 1 ? 'transaction' : 'transactions'}
          {filtersActive && (
            <button type="button" onClick={clear} className="ml-3 font-bold text-accent hover:text-accent-strong">
              Clear filters
            </button>
          )}
        </p>
        {currency ? (
          <p className="money flex gap-4 text-ink-3">
            <span>
              In <strong className="font-bold text-positive">{formatMoney(totals.income, currency)}</strong>
            </span>
            <span>
              Out <strong className="font-bold text-ink">{formatMoney(totals.spent, currency)}</strong>
            </span>
          </p>
        ) : (
          <p className="text-ink-3">Totals are hidden because these Spaces use different currencies.</p>
        )}
      </div>

      <div className="mt-3 space-y-4">
        {groups.length === 0 ? (
          <Card>
            {filtersActive ? (
              <EmptyState
                icon={SearchX}
                title="No matching transactions"
                message="Nothing matches those filters. Try widening the dates or clearing a filter."
                action={<Button onClick={clear}>Clear filters</Button>}
              />
            ) : (
              <EmptyState
                icon={Inbox}
                title="No transactions yet"
                message={`Record the first expense or income for ${active.space.name}.`}
                action={
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={openMenu}>
                    Add transaction
                  </Button>
                }
              />
            )}
          </Card>
        ) : (
          groups.map((group) => {
            const day = summarize(group.items);
            const heading = group.date ? formatRelativeDay(group.date) : SORT_OPTIONS.find((o) => o.value === sort)!.label;
            return (
              <section key={group.date || 'ranked'} aria-label={heading}>
                <div className="mb-1.5 flex items-baseline justify-between px-1">
                  <h2 className="text-[13px] font-bold text-ink-2">{heading}</h2>
                  {group.date && currency && (day.income > 0 || day.spent > 0) && (
                    <span className="money text-[13px] font-semibold text-ink-3">{formatMoney(day.net, currency, { signed: true })}</span>
                  )}
                </div>
                <Card padded={false} className="p-2">
                  <ul>
                    {group.items.map((t) => {
                      const space = spaceById.get(t.spaceId);
                      // Outside a day group the date is shown on the row; across Spaces, so is the Space.
                      const trailing = [allSpaces ? space?.name : '', group.date ? '' : formatRelativeDay(t.date)].filter(Boolean).join(' · ');
                      return (
                        <li key={t.id}>
                          <TransactionItem
                            transaction={t}
                            category={categoryById.get(t.categoryId ?? '')}
                            accounts={accounts}
                            currency={t.currency}
                            onClick={() => openDetail(t.id)}
                            trailing={trailing || undefined}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
