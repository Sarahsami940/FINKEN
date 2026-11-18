import { formatDay, formatMonth, parseISODate } from '../../domain/dates';
import type { FlowBucket, FlowUnit } from '../../domain/dashboard';
import { formatMoney } from '../../domain/format';
import { cn } from '../ui/cn';

interface FlowBarsProps {
  buckets: FlowBucket[];
  unit: FlowUnit;
  currency: string;
  /** Highlights the bucket containing this date. */
  highlight?: string;
  onSelect?: (bucket: FlowBucket) => void;
  className?: string;
}

function bucketLabel(b: FlowBucket, unit: FlowUnit, many: boolean): string {
  if (unit === 'month') return formatMonth(b.from, 'short');
  if (unit === 'week') return formatDay(b.from);
  // A week of days reads best as weekday names; a month of days as dates.
  return many ? String(parseISODate(b.from).getDate()) : parseISODate(b.from).toLocaleDateString('en-GB', { weekday: 'short' });
}

function bucketTitle(b: FlowBucket, unit: FlowUnit): string {
  if (unit === 'day') return formatDay(b.from);
  if (unit === 'month' || b.from === b.to) return unit === 'month' ? formatMonth(b.from) : formatDay(b.from);
  return `${formatDay(b.from)} – ${formatDay(b.to)}`;
}

/** Income and spending side by side for each day, week or month of a period. */
export function FlowBars({ buckets, unit, currency, highlight, onSelect, className }: FlowBarsProps) {
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.income, b.spent)));
  const many = buckets.length > 10;
  // Long day ranges only label every few days so the axis stays legible.
  const every = buckets.length > 20 ? 5 : buckets.length > 10 ? 2 : 1;
  const summary = buckets.map((b) => `${bucketTitle(b, unit)}: income ${formatMoney(b.income, currency)}, spent ${formatMoney(b.spent, currency)}`).join('; ');

  return (
    <div className={className}>
      <div role="img" aria-label={`Income and spending. ${summary}`} className={cn('flex h-44 items-end', many ? 'gap-0.5 sm:gap-1' : 'gap-2 sm:gap-3')}>
        {buckets.map((b) => {
          const current = highlight !== undefined && highlight >= b.from && highlight <= b.to;
          const title = `${bucketTitle(b, unit)}\nIncome ${formatMoney(b.income, currency)}\nSpent ${formatMoney(b.spent, currency)}`;
          const bars = (
            <span className="flex h-full w-full items-end justify-center gap-px sm:gap-0.5">
              <span
                className={cn('w-full rounded-t-[3px] transition-[height] duration-500 ease-out', many ? 'max-w-2' : 'max-w-4', current ? 'bg-positive/60' : 'bg-positive/30')}
                style={{ height: `${b.income > 0 ? Math.max(2, (b.income / max) * 100) : 0}%` }}
              />
              <span
                className={cn('w-full rounded-t-[3px] transition-[height] duration-500 ease-out', many ? 'max-w-2' : 'max-w-4', current ? 'bg-accent' : 'bg-accent/40 group-hover:bg-accent/60')}
                style={{ height: `${b.spent > 0 ? Math.max(2, (b.spent / max) * 100) : 0}%` }}
              />
            </span>
          );
          const cls = 'group flex h-full min-w-0 flex-1 items-end rounded-md';
          return onSelect ? (
            <button key={b.from} type="button" title={title} aria-label={`Show transactions for ${bucketTitle(b, unit)}`} onClick={() => onSelect(b)} className={cn(cls, 'hover:bg-canvas')}>
              {bars}
            </button>
          ) : (
            <div key={b.from} title={title} className={cls}>
              {bars}
            </div>
          );
        })}
      </div>
      <div aria-hidden className={cn('mt-2 flex border-t border-line pt-2', many ? 'gap-0.5 sm:gap-1' : 'gap-2 sm:gap-3')}>
        {buckets.map((b, i) => {
          const current = highlight !== undefined && highlight >= b.from && highlight <= b.to;
          return (
            <span key={b.from} className={cn('min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[11px] font-medium', current ? 'text-ink' : 'text-ink-3')}>
              {i % every === 0 ? bucketLabel(b, unit, many) : ''}
            </span>
          );
        })}
      </div>
      <div aria-hidden className="mt-3 flex gap-4 text-xs font-medium text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-positive/50" /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-accent" /> Spent
        </span>
      </div>
    </div>
  );
}
