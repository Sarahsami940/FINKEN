import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';

interface DropdownProps {
  /** Renders the trigger. Spread `props` onto a button. */
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  /** Open above the trigger instead of below. */
  up?: boolean;
  className?: string;
  menuClassName?: string;
}

/** Anchored popover menu. Closes on outside click, Escape, or item selection. */
export function Dropdown({ trigger, children, align = 'left', up, className, menuClassName }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cn('relative', className)}>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 min-w-56 animate-pop-in rounded-2xl border border-line bg-surface p-1.5 shadow-raised',
            align === 'right' ? 'right-0' : 'left-0',
            up ? 'bottom-full mb-2' : 'top-full mt-2',
            menuClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

interface DropdownItemProps {
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export function DropdownItem({ onSelect, icon, children, hint, selected, danger, disabled }: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-50',
        danger ? 'text-negative hover:bg-negative-soft' : 'text-ink hover:bg-canvas',
        selected && 'bg-canvas',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint}
    </button>
  );
}
