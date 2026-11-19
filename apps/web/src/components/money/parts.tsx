import { formatMoney, formatPercent } from '@finken/domain/format';
import { DIRECTION, isPrincipal, transactionLabel } from '@finken/domain/money';
import { colorOf } from '@finken/domain/palette';
import type { Account, Category, Transaction } from '@finken/domain/types';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, HandCoins, type LucideIcon, RotateCcw, TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../ui/cn';
import { iconFor } from '../ui/icons';

interface CategoryIconProps {
  icon: string;
  color: string;
  size?: 'sm' | 'md';
}

export function CategoryIcon({ icon, color, size = 'md' }: CategoryIconProps) {
  const Icon = iconFor(icon);
  const { fg, bg } = colorOf(color);
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center rounded-xl', size === 'md' ? 'size-10' : 'size-8')} style={{ background: bg, color: fg }}>
      <Icon className={size === 'md' ? 'size-[18px]' : 'size-4'} />
    </span>
  );
}

/** Icon for a transaction: its category, or a direction marker when it has none. */
export function TransactionIcon({ transaction, category }: { transaction: Transaction; category?: Category }) {
  const { type } = transaction;
  const neutral: LucideIcon | null = type === 'transfer' ? ArrowLeftRight : isPrincipal(type) ? HandCoins : null;
  if (!neutral && category) return <CategoryIcon icon={category.icon} color={category.color} />;
  const Icon = neutral ?? (type === 'refund' ? RotateCcw : type === 'income' ? ArrowDownLeft : ArrowUpRight);
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sunken text-ink-2">
      <Icon className="size-[18px]" />
    </span>
  );
}

/** Signed, coloured amount for a transaction. Transfers stay neutral. */
export function TransactionAmount({ transaction, currency, className }: { transaction: Transaction; currency: string; className?: string }) {
  const direction = DIRECTION[transaction.type];
  const signed = direction === 0 ? null : direction * transaction.amount;
  return (
    <span className={cn('money whitespace-nowrap font-bold', transaction.type === 'income' || transaction.type === 'refund' ? 'text-positive' : 'text-ink', className)}>
      {signed === null ? formatMoney(transaction.amount, currency) : formatMoney(signed, currency, { signed: true })}
    </span>
  );
}

export function transactionTitle(t: Transaction, category?: Category, accounts: Account[] = []): string {
  if (t.description) return t.description;
  if (t.type === 'expense' || t.type === 'income') return category?.name ?? transactionLabel(t);
  return transactionLabel(t, accounts);
}

export function transactionMeta(t: Transaction, category: Category | undefined, accounts: Account[]): string {
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account';
  if (t.type === 'transfer') {
    const route = `${name(t.accountId)} → ${name(t.toAccountId)}`;
    const label = transactionLabel(t, accounts);
    return label === 'Transfer' ? route : `${label} · ${route}`;
  }
  if (isPrincipal(t.type)) return `Money owed · ${name(t.accountId)}`;
  const sub = category?.subcategories.find((s) => s.id === t.subcategoryId)?.name;
  const cat = category ? (sub ? `${category.name} · ${sub}` : category.name) : 'Uncategorised';
  return `${t.type === 'refund' ? 'Refund · ' : ''}${cat} · ${name(t.accountId)}`;
}

interface TransactionItemProps {
  transaction: Transaction;
  category?: Category;
  accounts: Account[];
  currency: string;
  onClick?: () => void;
  trailing?: string;
}

export function TransactionItem({ transaction, category, accounts, currency, onClick, trailing }: TransactionItemProps) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-canvas">
      <TransactionIcon transaction={transaction} category={category} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-ink">{transactionTitle(transaction, category, accounts)}</span>
        <span className="block truncate text-[13px] text-ink-3">{transactionMeta(transaction, category, accounts)}</span>
      </span>
      <span className="flex flex-col items-end">
        <TransactionAmount transaction={transaction} currency={currency} className="text-[15px]" />
        {trailing && <span className="text-xs text-ink-3">{trailing}</span>}
      </span>
    </button>
  );
}

interface SummaryCardProps {
  label: string;
  amount: number;
  currency: string;
  tone?: 'neutral' | 'positive' | 'negative';
  /** Relative change vs the comparison period; null hides the chip. */
  change?: number | null;
  /** Whether an increase is good news (income) or not (spending). */
  increaseIsGood?: boolean;
  caption?: string;
  to?: string;
  emphasis?: boolean;
  className?: string;
}

export function SummaryCard({ label, amount, currency, tone = 'neutral', change, increaseIsGood = true, caption, to, emphasis, className }: SummaryCardProps) {
  const body = (
    <>
      <span className={cn('text-[13px] font-semibold', emphasis ? 'text-white/70' : 'text-ink-3')}>{label}</span>
      <span
        className={cn(
          'money mt-2 block truncate font-extrabold leading-tight tracking-tight sm:text-[28px]',
          emphasis ? 'text-[26px]' : 'text-xl',
          emphasis ? 'text-white' : tone === 'positive' ? 'text-positive' : tone === 'negative' ? 'text-negative' : 'text-ink',
        )}
      >
        {formatMoney(amount, currency)}
      </span>
      <span className={cn('mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs', emphasis ? 'text-white/70' : 'text-ink-3')}>
        {change != null && Math.abs(change) >= 0.005 && (
          <span className={cn('inline-flex items-center gap-1 font-bold', emphasis ? 'text-white' : change > 0 === increaseIsGood ? 'text-positive' : 'text-negative')}>
            {change > 0 ? <TrendingUp aria-hidden className="size-3.5" /> : <TrendingDown aria-hidden className="size-3.5" />}
            {formatPercent(change)}
            <span className="sr-only">{change > 0 ? 'higher' : 'lower'}</span>
          </span>
        )}
        {caption}
      </span>
    </>
  );
  const cls = cn(
    'block min-w-0 rounded-card border p-4 shadow-card transition-[border-color,transform] duration-150 sm:p-5',
    emphasis ? 'border-ink bg-ink' : 'border-line bg-surface',
    to && (emphasis ? 'hover:bg-ink/92' : 'hover:border-line-strong'),
    className,
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
