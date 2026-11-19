import { formatMonth, formatMonthYear } from '@finken/domain/dates';
import { formatMoney } from '@finken/domain/format';
import type { MonthPoint } from '@finken/domain/money';
import { cn } from '../ui/cn';

interface MonthlyBarsProps {
  data: MonthPoint[];
  currency: string;
  /** Show income beside spending. */
  showIncome?: boolean;
  onSelect?: (point: MonthPoint) => void;
  className?: string;
}

/** Month-by-month bars. The latest month is emphasised; earlier ones recede. */
export function MonthlyBars({ data, currency, showIncome = false, onSelect, className }: MonthlyBarsProps) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.spent, showIncome ? d.income : 0)));
  const summary = data.map((d) => `${formatMonthYear(d.month)}: spent ${formatMoney(d.spent, currency)}`).join('; ');

  return (
    <div className={className}>
      <div role="img" aria-label={`Monthly overview. ${summary}`} className="flex h-44 items-end gap-2 sm:gap-4">
        {data.map((point, i) => {
          const latest = i === data.length - 1;
          const title = `${formatMonthYear(point.month)}\nSpent ${formatMoney(point.spent, currency)}${showIncome ? `\nIncome ${formatMoney(point.income, currency)}` : ''}`;
          const bars = (
            <>
              <span className={cn('money mb-1.5 text-[11px] font-semibold', latest ? 'text-ink' : 'text-ink-3')}>
                {formatMoney(point.spent, currency, { compact: true }).replace(/^\S+\s/, '')}
              </span>
              <span className="flex w-full flex-1 items-end justify-center gap-1">
                {showIncome && (
                  <span
                    className="w-full max-w-5 rounded-t-md bg-positive/25 transition-[height] duration-500 ease-out"
                    style={{ height: `${Math.max(2, (point.income / max) * 100)}%` }}
                  />
                )}
                <span
                  className={cn(
                    'w-full rounded-t-md transition-[height,background-color] duration-500 ease-out',
                    showIncome ? 'max-w-5' : 'max-w-10',
                    latest ? 'bg-accent' : 'bg-accent/25 group-hover:bg-accent/45',
                  )}
                  style={{ height: `${Math.max(2, (point.spent / max) * 100)}%` }}
                />
              </span>
            </>
          );
          const cls = 'group flex h-full min-w-0 flex-1 flex-col items-center';
          return onSelect ? (
            <button key={point.month} type="button" title={title} onClick={() => onSelect(point)} className={cn(cls, 'rounded-lg')}>
              {bars}
            </button>
          ) : (
            <div key={point.month} title={title} className={cls}>
              {bars}
            </div>
          );
        })}
      </div>
      <div aria-hidden className="mt-2 flex gap-2 border-t border-line pt-2 sm:gap-4">
        {data.map((point, i) => (
          <span key={point.month} className={cn('min-w-0 flex-1 text-center text-xs font-medium', i === data.length - 1 ? 'text-ink' : 'text-ink-3')}>
            {formatMonth(point.month, 'short')}
          </span>
        ))}
      </div>
      {showIncome && (
        <div aria-hidden className="mt-3 flex gap-4 text-xs font-medium text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-positive/35" /> Income
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-accent" /> Spent
          </span>
        </div>
      )}
    </div>
  );
}
