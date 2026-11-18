import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDay, formatDueLabel } from '../../domain/dates';
import { formatMoney } from '../../domain/format';
import type { Insight } from '../../domain/insights';
import type { Person } from '../../domain/types';
import type { ExpectedEvent } from '../../domain/upcoming';
import { Card } from '../ui/Card';
import { cn } from '../ui/cn';

export const TextLink = ({ to, children }: { to: string; children: string }) => (
  <Link to={to} className="inline-flex shrink-0 items-center gap-1 text-[13px] font-bold text-accent hover:text-accent-strong">
    {children}
    <ArrowRight aria-hidden className="size-3.5" />
  </Link>
);

const INSIGHT_TONE: Record<Insight['tone'], string> = {
  neutral: 'bg-accent-soft text-accent-strong',
  positive: 'bg-positive-soft text-positive',
  attention: 'bg-warning-soft text-warning',
};

/**
 * "Finken noticed": one insight at a time, with arrows to step through the
 * rest so the dashboard never fills up with them.
 */
export function InsightCard({ insights, single }: { insights: Insight[]; /** Show only the first one. */ single?: boolean }) {
  const [index, setIndex] = useState(0);
  if (insights.length === 0) return null;
  const at = Math.min(index, insights.length - 1);
  const insight = insights[at];
  const many = !single && insights.length > 1;
  return (
    <Card className="flex items-start gap-4">
      <span aria-hidden className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', INSIGHT_TONE[insight.tone])}>
        <Lightbulb className="size-5" />
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-wider text-ink-3">Finken noticed</p>
          {many && (
            <div className="-my-1.5 -mr-2 flex items-center">
              <button
                type="button"
                aria-label="Previous insight"
                onClick={() => setIndex((at - 1 + insights.length) % insights.length)}
                className="flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-canvas hover:text-ink"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="min-w-9 text-center text-xs font-semibold text-ink-3">
                {at + 1} of {insights.length}
              </span>
              <button
                type="button"
                aria-label="Next insight"
                onClick={() => setIndex((at + 1) % insights.length)}
                className="flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-canvas hover:text-ink"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          )}
        </div>
        <p className="mt-1 text-[15px] font-bold text-ink">{insight.title}</p>
        {insight.detail && <p className="mt-0.5 text-sm text-ink-2">{insight.detail}</p>}
        {insight.action && (
          <div className="mt-2.5">
            <TextLink to={insight.action.to}>{insight.action.label}</TextLink>
          </div>
        )}
      </div>
    </Card>
  );
}

/** One expected payment or receipt, linking to Coming up. */
export function ExpectedRow({ e, people, currency, to }: { e: ExpectedEvent; people: Person[]; currency: string; to: string }) {
  const person = e.personId ? people.find((p) => p.id === e.personId) : undefined;
  const incoming = e.direction === 'in';
  return (
    <Link to={to} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-canvas">
      <span
        aria-hidden
        className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', incoming ? 'bg-positive-soft text-positive' : 'bg-sunken text-ink-2')}
      >
        {incoming ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{e.title}</span>
        <span className={cn('block truncate text-xs', e.status === 'overdue' ? 'font-semibold text-negative' : 'text-ink-3')}>
          {formatDay(e.date)} · {formatDueLabel(e.date)}
          {person ? ` · ${person.name}` : ''}
        </span>
      </span>
      <span className={cn('money shrink-0 text-sm font-bold', incoming ? 'text-positive' : 'text-ink')}>
        {incoming ? '+' : ''}
        {formatMoney(e.amount, currency)}
      </span>
    </Link>
  );
}

/** A label and amount, optionally linking to the records behind it. */
export function Figure({ label, amount, currency, to, tone, hint }: { label: string; amount: number; currency: string; to?: string; tone?: 'positive' | 'negative'; hint?: string }) {
  const body = (
    <>
      <span className="block text-[13px] font-semibold text-ink-3">{label}</span>
      <span className={cn('money mt-1 block truncate text-lg font-extrabold tracking-tight xl:text-base 2xl:text-lg', tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-ink')}>
        {formatMoney(amount, currency)}
      </span>
      {hint && <span className="mt-0.5 block truncate text-xs text-ink-3">{hint}</span>}
    </>
  );
  const cls = 'block min-w-0 rounded-xl border border-line px-3.5 py-3';
  return to ? (
    <Link to={to} className={cn(cls, 'transition-colors hover:border-line-strong hover:bg-canvas')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
