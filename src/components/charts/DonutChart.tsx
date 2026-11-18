import type { ReactNode } from 'react';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  label: string;
  children?: ReactNode;
  size?: number;
}

const R = 42;
const CIRCUMFERENCE = 2 * Math.PI * R;
const GAP = 1.6; // visual gap between segments, in path units

/** Ring chart. `children` render in the centre. */
export function DonutChart({ segments, label, children, size = 168 }: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="size-full -rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-sunken)" strokeWidth="11" />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.value / total) * CIRCUMFERENCE;
            const visible = Math.max(0.5, length - (segments.length > 1 ? GAP : 0));
            const el = (
              <circle
                key={segment.key}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                stroke={segment.color}
                strokeWidth="11"
                strokeDasharray={`${visible} ${CIRCUMFERENCE - visible}`}
                strokeDashoffset={-offset}
              >
                <title>{segment.label}</title>
              </circle>
            );
            offset += length;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}
