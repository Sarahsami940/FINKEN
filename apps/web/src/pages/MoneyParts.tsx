import { formatDay, formatDueLabel } from '@finken/domain/dates';
import { currencySymbol, formatMoney } from '@finken/domain/format';
import { owedSummary, owedToYouKind } from '@finken/domain/money';
import type { Account, AccountKind, ID, ObligationKind } from '@finken/domain/types';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ObligationSheet } from '../components/money/OwedSheets';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Input } from '../components/ui/Field';
import { Badge, Segmented } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useSpaceData } from '../data/hooks';
import { store } from '../data/store';

const KIND_OPTIONS: { value: AccountKind; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'other', label: 'Other' },
];

/** Accepts digits, one decimal point and a leading minus (an overdrawn starting balance). */
function cleanBalance(raw: string): string {
  const negative = raw.trim().startsWith('-');
  const [whole, ...rest] = raw.replace(/[^\d.]/g, '').split('.');
  return `${negative ? '-' : ''}${rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole}`;
}

interface AccountEditorProps {
  spaceId: ID;
  currency: string;
  /** Null creates a new account. */
  account: Account | null;
  onClose: () => void;
}

export function AccountEditor({ spaceId, currency, account, onClose }: AccountEditorProps) {
  const toast = useToast();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'bank');
  const [balance, setBalance] = useState(account ? String(account.openingBalance) : '');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inUse = account ? store.accountInUse(account.id) : false;

  function submit(e: FormEvent) {
    e.preventDefault();
    const draft = { name, kind, openingBalance: balance === '' || balance === '-' ? 0 : Number(balance) };
    const result = account ? store.updateAccount(account.id, draft) : store.addAccount(spaceId, draft);
    if (!result.ok) return setError(result.error);
    toast(account ? 'Account updated' : `${name.trim()} added`);
    onClose();
  }

  function archive(archived: boolean) {
    if (!account) return;
    const result = store.setAccountArchived(account.id, archived);
    if (!result.ok) return setError(result.error);
    toast(archived ? `${account.name} archived` : `${account.name} restored`);
    onClose();
  }

  function remove() {
    if (!account) return;
    const result = store.deleteAccount(account.id);
    setDeleting(false);
    if (!result.ok) return setError(result.error);
    toast(`${account.name} deleted`);
    onClose();
  }

  return (
    <>
      <Modal
        open={!deleting}
        onClose={onClose}
        title={account ? 'Edit account' : 'New account'}
        description={account ? undefined : 'Somewhere your money sits: cash in hand, a bank account or a mobile wallet.'}
        footer={
          <div className="flex gap-2">
            <Button type="submit" form="account-form" variant="primary" size="lg" block>
              {account ? 'Save changes' : 'Add account'}
            </Button>
            {account &&
              (account.archived ? (
                <Button size="lg" icon={<ArchiveRestore className="size-4" />} onClick={() => archive(false)}>
                  Restore
                </Button>
              ) : (
                <Button size="lg" icon={<Archive className="size-4" />} onClick={() => archive(true)}>
                  Archive
                </Button>
              ))}
            {account && !inUse && (
              <Button size="lg" aria-label="Delete account" title="Delete" className="px-3.5 text-negative" onClick={() => setDeleting(true)}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        }
      >
        <form id="account-form" onSubmit={submit} noValidate className="space-y-5">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                data-autofocus
                value={name}
                maxLength={32}
                placeholder="e.g. Savings Account"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          <div>
            <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Type</p>
            <Segmented label="Account type" value={kind} onChange={setKind} options={KIND_OPTIONS} className="flex w-full" />
          </div>
          <Field
            label={`Starting balance (${currencySymbol(currency)})`}
            hint="What it held before your first recorded transaction. Finken adds and subtracts everything you record after that."
          >
            {(id) => (
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                className="money"
                value={balance}
                onChange={(e) => {
                  setBalance(cleanBalance(e.target.value));
                  setError(null);
                }}
              />
            )}
          </Field>
          {account && inUse && (
            <p className="text-[13px] leading-relaxed text-ink-3">
              This account has transactions, so it cannot be deleted. Archiving hides it from new entries and from your available money, and keeps its history.
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
              {error}
            </p>
          )}
        </form>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title={`Delete ${account?.name ?? 'account'}?`}
        message="This account has no transactions, so nothing else changes. It cannot be undone."
        confirmLabel="Delete account"
        destructive
        onConfirm={remove}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

const KIND_LABEL: Record<ObligationKind, string> = {
  receivable: 'To receive',
  lent: 'You lent',
  payable: 'To pay',
  borrowed: 'You borrowed',
};

/** What others owe this Space and what it owes, calculated from linked transactions. */
export function OwedCard() {
  const { currency, obligations, transactions, people } = useSpaceData();
  const summary = useMemo(() => owedSummary(obligations, transactions), [obligations, transactions]);
  const [openId, setOpenId] = useState<ID | null>(null);
  if (obligations.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader
        title="Money owed"
        subtitle="Worked out from what has been paid so far"
        action={
          <Link to="/money/people" className="shrink-0 text-sm font-bold text-accent hover:text-accent-strong">
            People
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            ['Owed to you', summary.owedToYou, 'text-positive'],
            ['You owe', summary.youOwe, 'text-ink'],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="min-w-0 rounded-control bg-canvas px-4 py-3.5">
            <p className="text-[13px] font-semibold text-ink-3">{label}</p>
            <p className={cn('money mt-1 truncate text-xl font-extrabold tracking-tight sm:text-2xl', tone)}>{formatMoney(value, currency)}</p>
          </div>
        ))}
      </div>
      {summary.open.length === 0 ? (
        <p className="mt-4 text-sm text-ink-3">Everything is settled.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {summary.open.map(({ obligation: o, outstanding, settled, overdue, nextDue }) => {
            const person = people.find((p) => p.id === o.personId);
            const toYou = owedToYouKind(o.kind);
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(o.id)}
                  className="-mx-2 flex w-[calc(100%+1rem)] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-3 text-left transition-colors hover:bg-canvas"
                >
                  <span className="min-w-0 flex-1 basis-48">
                    <span className="block truncate text-[15px] font-semibold text-ink">{person?.name ?? o.title}</span>
                    <span className="block truncate text-[13px] text-ink-3">{o.title}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={toYou ? 'positive' : 'neutral'}>{KIND_LABEL[o.kind]}</Badge>
                    {nextDue && <Badge tone={overdue ? 'negative' : 'neutral'}>{overdue ? formatDueLabel(nextDue) : `Due ${formatDay(nextDue)}`}</Badge>}
                  </span>
                  <span className="ml-auto text-right">
                    <span className="money block text-[15px] font-bold text-ink">{formatMoney(outstanding, currency)}</span>
                    {settled > 0 && <span className="money block text-xs text-ink-3">of {formatMoney(o.amount, currency)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ObligationSheet key={openId ?? 'none'} id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}
