import { cn } from '../ui/cn';

interface MiniBarsProps {
  values: number[];
  /** Accessible description of the series. */
  label: string;
  /** Per-bar hover text. */
  titles?: string[];
  color?: string;
  /** Emphasise the last bar. */
  highlightLast?: boolean;
  /** Values above this line are drawn in the warning colour. */
  limit?: number;
  className?: string;
}

/** A small row of bars for trends inside a list row. */
export function MiniBars({ values, label, titles, color = 'var(--color-accent)', highlightLast = true, limit, className }: MiniBarsProps) {
  const max = Math.max(1, ...values, limit ?? 0);
  return (
    <div role="img" aria-label={label} className={cn('relative flex h-9 items-end gap-[3px]', className)}>
      {limit !== undefined && (
        <span aria-hidden className="absolute inset-x-0 border-t border-dashed border-ink-3/50" style={{ bottom: `${(limit / max) * 100}%` }} />
      )}
      {values.map((v, i) => {
        const over = limit !== undefined && v > limit;
        const last = i === values.length - 1;
        return (
          <span
            key={i}
            title={titles?.[i]}
            className="w-full min-w-[4px] max-w-3 rounded-t-[2px]"
            style={{
              height: `${v > 0 ? Math.max(6, (v / max) * 100) : 4}%`,
              background: v <= 0 ? 'var(--color-line)' : over ? 'var(--color-negative)' : color,
              opacity: highlightLast && !last && !over ? 0.45 : 1,
            }}
          />
        );
      })}
    </div>
  );
}
