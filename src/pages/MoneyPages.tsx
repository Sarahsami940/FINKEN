import { ArrowLeft, BriefcaseBusiness, ChevronRight, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MONEY_SECTIONS } from '../app/nav';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { accountIcon } from '../components/ui/icons';
import { PageHeader } from '../components/ui/Misc';
import { useSpaceData } from '../data/hooks';
import { formatMoney } from '../domain/format';
import { accountBalances } from '../domain/money';
import type { Account } from '../domain/types';
import { AccountEditor, OwedCard } from './MoneyParts';

export function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-3 hover:text-ink">
      <ArrowLeft aria-hidden className="size-4" />
      {children}
    </Link>
  );
}

export function MoneyPage() {
  const { space, currency, accounts, transactions } = useSpaceData();
  const all = useMemo(() => accountBalances(accounts, transactions), [accounts, transactions]);
  const [editor, setEditor] = useState<{ account: Account | null } | null>(null);
  if (!space) return null;
  // Archived accounts keep their history but are left out of available money.
  const balances = all.filter((b) => !b.account.archived);
  const archived = all.filter((b) => b.account.archived);
  const total = balances.reduce((sum, b) => sum + b.balance, 0);

  return (
    <div>
      <PageHeader title="Money" subtitle={`Where ${space.name} stands, and what to plan for`} />

      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold text-ink-3">Available money</p>
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditor({ account: null })}>
              Account
            </Button>
          </div>
          <p className={cn('money mt-2 text-[32px] font-extrabold leading-tight tracking-tight', total < 0 ? 'text-negative' : 'text-ink')}>
            {formatMoney(total, currency)}
          </p>
          <p className="mt-1 text-[13px] text-ink-3">Across {balances.length} {balances.length === 1 ? 'account' : 'accounts'}, based on what you have recorded.</p>
          <ul className="mt-5 divide-y divide-line border-t border-line">
            {balances.map(({ account, balance }) => {
              const Icon = accountIcon(account.kind);
              return (
                <li key={account.id} className="flex items-center gap-1">
                  <Link
                    to={`/transactions?account=${encodeURIComponent(account.id)}`}
                    className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-canvas"
                  >
                    <span aria-hidden className="flex size-9 items-center justify-center rounded-xl bg-sunken text-ink-2">
                      <Icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{account.name}</span>
                    <span className={cn('money text-sm font-bold', balance < 0 ? 'text-negative' : 'text-ink')}>{formatMoney(balance, currency)}</span>
                  </Link>
                  <IconButton label={`Edit ${account.name}`} onClick={() => setEditor({ account })} className="-mr-2">
                    <Pencil className="size-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          {archived.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-xs font-semibold text-ink-3">Archived, not counted above</p>
              <ul>
                {archived.map(({ account, balance }) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => setEditor({ account })}
                      className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-xl px-2 py-2 text-left text-sm text-ink-3 transition-colors hover:bg-canvas"
                    >
                      <span className="min-w-0 truncate font-semibold">{account.name}</span>
                      <span className="money font-semibold">{formatMoney(balance, currency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <div className="grid content-start gap-3 sm:grid-cols-2 xl:col-span-3">
          {MONEY_SECTIONS.map((section) => (
            <Link
              key={section.key}
              to={section.to}
              className="group flex items-start gap-3.5 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong"
            >
              <span
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong"
              >
                <section.icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-[15px] font-bold text-ink">{section.label}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{section.summary}</span>
              </span>
              <ChevronRight aria-hidden className="mt-2.5 size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      </div>

      {space.type === 'business' && (
        <div className="mt-4">
          <Link
              to="/business"
              className="flex items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong"
            >
              <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
                <BriefcaseBusiness className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">Business</span>
                <span className="block text-[13px] text-ink-3">Customers and suppliers, receivables and payables, profit and loss, cash flow and reports.</span>
              </span>
              <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" />
            </Link>
        </div>
      )}

      <OwedCard />

      {editor && (
        <AccountEditor key={editor.account?.id ?? 'new'} spaceId={space.id} currency={currency} account={editor.account} onClose={() => setEditor(null)} />
      )}
    </div>
  );
}
