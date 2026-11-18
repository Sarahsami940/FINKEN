import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  block?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-white hover:bg-ink/88 active:bg-ink',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-canvas',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  danger: 'bg-negative text-white hover:bg-negative/90',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-[15px] gap-2',
};

export function Button({ variant = 'secondary', size = 'md', icon, block, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-control font-semibold transition-[background-color,border-color,transform] duration-150 active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        // Block buttons share a row evenly; others keep their natural width.
        block ? 'w-full min-w-0' : 'shrink-0',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

/** Square icon-only button. `label` is required for screen readers. */
export function IconButton({ label, className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
