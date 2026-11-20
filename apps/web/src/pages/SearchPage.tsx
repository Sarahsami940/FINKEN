import { transactionsLink } from '@finken/domain/dashboard';
import { formatDay, formatRelativeDay, today } from '@finken/domain/dates';
import { formatMoney, formatNumber } from '@finken/domain/format';
import { owedToYouKind } from '@finken/domain/money';
import { parseSearch, runSearch, type SearchQuery, type SearchResult, suggestions } from '@finken/domain/search';
import { ArrowRight, Search, SearchX, Sparkles } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { ExpectedRow } from '../components/money/DashboardParts';
import { TransactionItem } from '../components/money/parts';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Badge, EmptyState, PageHeader } from '../components/ui/Misc';
import { useAppState } from '../data/hooks';

const INTENT_LABEL: Record<SearchQuery['intent'], string> = {
  list: 'Find records',
  total: 'Add up',
  count: 'Count',
  largest: 'Find the largest',
  smallest: 'Find the smallest',
  average: 'Average',
  owed: 'Money owed',
  upcoming: 'What is due',
};
const KIND_LABEL = { expense: 'Spending', income: 'Income', transfer: 'Transfers', refund: 'Refunds' } as const;

/** "last month", "today", "in October 2026". */
function periodPhrase(label?: string): string {
  if (!label) return '';
  return /^(this|last|next|today|yesterday)/i.test(label) ? label.toLowerCase() : `in ${label}`;
}

export function SearchPage() {
  const state = useAppState();
  const { openDetail } = useAddFlow();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  const now = today();

  // Keep the box in step with the address, for back and forward.
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (!q) input.current?.focus();
  }, [q]);

  const ctx = useMemo(
    () => ({ spaces: state.spaces, activeSpaceId: state.activeSpaceId, categories: state.categories, people: state.people, accounts: state.accounts }),
    [state.spaces, state.activeSpaceId, state.categories, state.people, state.accounts],
  );
  const query = useMemo(() => (q.trim() ? parseSearch(q, ctx, now) : null), [q, ctx, now]);
  const result = useMemo(() => (query ? runSearch(query, state, now) : null), [query, state, now]);
  const examples = useMemo(() => suggestions(ctx), [ctx]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    setParams(value ? { q: value } : {});
  }

  return (
    <div>
      <PageHeader title="Search your money" subtitle="Ask in your own words. Answers come only from what you have recorded." />
      <form onSubmit={submit} role="search" className="mb-5 flex gap-2">
        <label htmlFor="money-search" className="sr-only">
          Search your money
        </label>
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" />
          <input
            ref={input}
            id="money-search"
            type="search"
            value={text}
            maxLength={160}
            autoComplete="off"
            enterKeyHint="search"
            onChange={(e) => setText(e.target.value)}
            placeholder="How much did I spend on fuel last month?"
            className="h-12 w-full rounded-control border border-line bg-surface pl-10 pr-3.5 text-[15px] text-ink shadow-card placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
          />
        </div>
        <Button type="submit" variant="primary" size="lg" disabled={!text.trim()} aria-label="Search">
          <ArrowRight className="size-5" />
        </Button>
      </form>

      {!query || !result ? (
        <Card>
          <p className="flex items-center gap-2 text-sm font-bold text-ink">
            <Sparkles aria-hidden className="size-4 text-accent" />
            Try asking
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {examples.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => setParams({ q: example })}
                  className="rounded-full border border-line bg-surface px-3.5 py-2 text-left text-[13px] font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs leading-relaxed text-ink-3">
            Finken understands periods (today, this week, last month, October, last 30 days), categories, people, accounts, amounts (over Rs 5,000) and your other Spaces (my
            business, all Spaces). Other words are looked for in descriptions and notes.
          </p>
        </Card>
      ) : (
        <>
          <Interpretation query={query} />
          <Answer query={query} result={result} onOpen={openDetail} />
        </>
      )}
    </div>
  );
}

function Interpretation({ query }: { query: SearchQuery }) {
  const { spaces, categories, people, accounts } = useAppState();
  const chips: { label: string; value: string }[] = [{ label: 'Asking', value: INTENT_LABEL[query.intent] }];
  if (query.kind) chips.push({ label: 'Type', value: KIND_LABEL[query.kind] });
  if (query.intent === 'owed') chips.push({ label: 'Direction', value: query.owedDirection === 'you-owe' ? 'You owe' : 'Owed to you' });
  const catNames = [
    ...query.categoryIds.map((id) => categories.find((c) => c.id === id)?.name),
    ...query.subcategoryIds.map((id) => {
      const parent = categories.find((c) => c.subcategories.some((s) => s.id === id));
      const sub = parent?.subcategories.find((s) => s.id === id);
      return parent && sub ? `${parent.name} › ${sub.name}` : undefined;
    }),
  ].filter(Boolean);
  if (catNames.length) chips.push({ label: 'Category', value: catNames.join(', ') });
  if (query.personIds.length) chips.push({ label: 'Person', value: query.personIds.map((id) => people.find((p) => p.id === id)?.name).join(', ') });
  if (query.accountIds.length) chips.push({ label: 'Account', value: query.accountIds.map((id) => accounts.find((a) => a.id === id)?.name).join(', ') });
  if (query.range) chips.push({ label: 'Period', value: `${query.rangeLabel} (${formatDay(query.range.from)} – ${formatDay(query.range.to)})` });
  else if (query.intent === 'upcoming') chips.push({ label: 'Period', value: 'Next 30 days' });
  else chips.push({ label: 'Period', value: 'All time' });
  if (query.min !== undefined) chips.push({ label: 'Amount', value: `${formatMoney(query.min)} or more` });
  if (query.max !== undefined) chips.push({ label: 'Amount', value: `${formatMoney(query.max)} or less` });
  chips.push({
    label: 'Space',
    value: query.spaceScope === 'all' ? 'All Spaces' : query.spaceIds.map((id) => spaces.find((s) => s.id === id)?.name).join(', '),
  });
  if (query.terms.length) chips.push({ label: query.intent === 'owed' ? 'Name' : 'Words', value: query.terms.map((t) => `“${t}”`).join(' ') });

  return (
    <section aria-label="How Finken read your question" className="mb-4">
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-3">How Finken read it</p>
      <ul className="flex flex-wrap gap-2">
        {chips.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two chips can share a label
          <li key={`${c.label}-${i}`} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[13px]">
            <span className="text-ink-3">{c.label}: </span>
            <span className="font-semibold text-ink">{c.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Answer({ query, result, onOpen }: { query: SearchQuery; result: SearchResult; onOpen: (id: string) => void }) {
  const state = useAppState();
  const money = (n: number, currency: string | null) => (currency ? formatMoney(n, currency) : formatNumber(n));
  const when = periodPhrase(query.rangeLabel);
  const scopeNote = result.currency === null ? 'These Spaces use different currencies, so amounts are not added together.' : null;

  if (result.kind === 'owed') {
    if (result.unknownName) {
      return (
        <Card>
          <EmptyState
            icon={SearchX}
            title={`No one called “${result.unknownName}”`}
            message="Finken only answers about people you have added in this Space. Check the spelling, or add them from People."
            action={
              <Link to="/money/people" className="text-sm font-bold text-accent hover:text-accent-strong">
                Open People
              </Link>
            }
          />
        </Card>
      );
    }
    const toYou = query.owedDirection !== 'you-owe';
    const names = query.personIds
      .map((id) => state.people.find((p) => p.id === id)?.name)
      .filter(Boolean)
      .join(' and ');
    if (result.positions.length === 0) {
      return (
        <Card>
          <EmptyState
            icon={SearchX}
            title="Nothing outstanding"
            message={
              names
                ? toYou
                  ? `${names} does not owe you anything right now.`
                  : `You do not owe ${names} anything right now.`
                : toYou
                  ? 'No one owes you money right now.'
                  : 'You do not owe anyone right now.'
            }
          />
        </Card>
      );
    }
    const headline = names
      ? toYou
        ? `${names} owes you ${money(result.total ?? 0, result.currency)}`
        : `You owe ${names} ${money(result.total ?? 0, result.currency)}`
      : toYou
        ? `You are owed ${money(result.total ?? 0, result.currency)} in total`
        : `You owe ${money(result.total ?? 0, result.currency)} in total`;
    return (
      <Card>
        <p className="text-xl font-extrabold tracking-tight text-ink">{headline}</p>
        <p className="mt-1 text-sm text-ink-3">
          {result.positions.length} open {result.positions.length === 1 ? 'item' : 'items'}, worked out from what has been paid so far.
        </p>
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {result.positions.map((p) => {
            const person = state.people.find((x) => x.id === p.obligation.personId);
            return (
              <li key={p.obligation.id}>
                <Link to={`/money/people/${p.obligation.personId}`} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-canvas">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{person?.name ?? p.obligation.title}</span>
                    <span className={cn('block truncate text-xs', p.overdue ? 'font-semibold text-negative' : 'text-ink-3')}>
                      {p.obligation.title}
                      {p.nextDue ? ` · ${p.overdue ? 'was due' : 'due'} ${formatDay(p.nextDue)}` : ''}
                    </span>
                  </span>
                  <span className={cn('money text-sm font-bold', owedToYouKind(p.obligation.kind) ? 'text-positive' : 'text-ink')}>
                    {money(p.outstanding, result.currency ?? 'PKR')}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    );
  }

  if (result.kind === 'upcoming') {
    const period = query.rangeLabel ? periodPhrase(query.rangeLabel) : 'in the next 30 days';
    if (result.events.length === 0) {
      return (
        <Card>
          <EmptyState
            icon={SearchX}
            title="Nothing expected"
            message={`No payments or receipts are expected ${period}.`}
            action={
              <Link to="/money/upcoming" className="text-sm font-bold text-accent hover:text-accent-strong">
                Open Coming up
              </Link>
            }
          />
        </Card>
      );
    }
    const out = result.events.filter((e) => e.direction === 'out').length;
    return (
      <Card>
        <p className="text-xl font-extrabold tracking-tight text-ink">
          {out} {out === 1 ? 'payment' : 'payments'} {period}: {money(result.outgoing, result.currency)}
        </p>
        <p className="mt-1 text-sm text-ink-3">
          {result.incoming > 0 ? `And ${money(result.incoming, result.currency)} expected to come in. ` : ''}Anything overdue is included. Expected amounts change no balance until
          they are marked paid.
        </p>
        <ul className="mt-3 space-y-0.5">
          {result.events.map((e) => (
            <li key={e.key}>
              <ExpectedRow e={e} people={state.people} currency={result.currency ?? 'PKR'} to="/money/upcoming" />
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  // Transactions.
  const subject = [
    ...query.categoryIds.map((id) => state.categories.find((c) => c.id === id)?.name),
    ...query.subcategoryIds.map((id) => state.categories.flatMap((c) => c.subcategories).find((s) => s.id === id)?.name),
    ...query.terms.map((t) => `“${t}”`),
  ]
    .filter(Boolean)
    .join(', ');
  const on = subject ? ` on ${subject}` : '';
  if (result.count === 0) {
    return (
      <Card>
        <EmptyState
          icon={SearchX}
          title="No matching records"
          message={`Nothing${subject ? ` for ${subject}` : ''} was recorded${when ? ` ${when}` : ''}${query.spaceScope === 'all' ? ' in any Space' : ''}. Finken only answers from what you have recorded.`}
        />
      </Card>
    );
  }
  const total = result.total;
  let headline: string;
  if (query.intent === 'largest' || query.intent === 'smallest') {
    const t = result.pick!;
    headline = `Your ${query.intent === 'largest' ? 'highest' : 'smallest'} ${query.kind === 'income' ? 'income' : 'expense'}${on}${when ? ` ${when}` : ''} was ${money(t.amount, result.currency)}: ${t.description || 'no description'} on ${formatDay(t.date)}`;
  } else if (query.intent === 'count') {
    headline = `${result.count} ${result.count === 1 ? 'transaction' : 'transactions'}${on}${when ? ` ${when}` : ''}`;
  } else if (query.intent === 'average' && total !== null) {
    headline = `On average ${money(Math.round(total / result.count), result.currency)} per ${query.kind === 'income' ? 'payment' : 'expense'}${on}${when ? ` ${when}` : ''}`;
  } else if (query.kind === 'expense' && total !== null) {
    headline = `You spent ${money(total, result.currency)}${on}${when ? ` ${when}` : ''}`;
  } else if (query.kind === 'income' && total !== null) {
    headline = `You received ${money(total, result.currency)}${subject ? ` from ${subject}` : ''}${when ? ` ${when}` : ''}`;
  } else {
    headline = `${result.count} matching ${result.count === 1 ? 'transaction' : 'transactions'}${when ? ` ${when}` : ''}`;
  }
  const shown = result.transactions.slice(0, 50);
  const singleCategory = query.categoryIds.length === 1 && query.subcategoryIds.length === 0 && query.personIds.length === 0 && query.accountIds.length === 0;
  const canOpenList =
    query.spaceIds.length === 1 &&
    query.spaceIds[0] === state.activeSpaceId &&
    query.min === undefined &&
    query.max === undefined &&
    query.terms.length <= 1 &&
    (singleCategory || (query.categoryIds.length === 0 && query.subcategoryIds.length === 0 && query.personIds.length === 0 && query.accountIds.length === 0));
  const listLink = canOpenList
    ? query.range
      ? transactionsLink(query.range, { type: query.kind, category: query.categoryIds[0], q: query.terms[0] })
      : `/transactions?${new URLSearchParams(Object.entries({ type: query.kind ?? '', category: query.categoryIds[0] ?? '', q: query.terms[0] ?? '' }).filter(([, v]) => v)).toString()}`
    : null;

  return (
    <Card>
      <p className="text-xl font-extrabold tracking-tight text-ink">{headline}.</p>
      {(() => {
        // The count is already the headline for "find" and "how many" questions.
        const countLine = query.intent === 'list' || query.intent === 'count' ? '' : `${result.count} ${result.count === 1 ? 'transaction' : 'transactions'}`;
        const refundLine =
          result.refunds > 0 && result.currency && (query.intent === 'total' || query.intent === 'average') ? `after ${money(result.refunds, result.currency)} of refunds` : '';
        const line = [countLine, refundLine].filter(Boolean).join(', ');
        return line || scopeNote ? (
          <p className="mt-1 text-sm text-ink-3">
            {line ? `${line[0].toUpperCase()}${line.slice(1)}. ` : ''}
            {scopeNote}
          </p>
        ) : null;
      })()}
      {listLink && (
        <Link to={listLink} className="mt-2 inline-flex items-center gap-1 text-[13px] font-bold text-accent hover:text-accent-strong">
          Open in Transactions <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      )}
      <ul className="-mx-2 mt-3 border-t border-line pt-2">
        {shown.map((t) => {
          const space = state.spaces.find((s) => s.id === t.spaceId);
          return (
            <li key={t.id}>
              <TransactionItem
                transaction={t}
                category={state.categories.find((c) => c.id === t.categoryId)}
                accounts={state.accounts.filter((a) => a.spaceId === t.spaceId)}
                currency={space?.currency ?? 'PKR'}
                trailing={query.spaceIds.length > 1 ? `${formatRelativeDay(t.date)} · ${space?.name ?? ''}` : formatRelativeDay(t.date)}
                onClick={() => onOpen(t.id)}
              />
            </li>
          );
        })}
      </ul>
      {result.transactions.length > shown.length && (
        <p className="mt-2 text-center text-xs text-ink-3">
          Showing the first {shown.length} of {result.transactions.length}. <Badge>Narrow the question to see fewer</Badge>
        </p>
      )}
    </Card>
  );
}
