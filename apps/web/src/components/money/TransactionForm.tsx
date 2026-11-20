import type { CaptureResult } from '@finken/domain/capture';
import { today } from '@finken/domain/dates';
import { currencySymbol, moneyToInput, parseMoney } from '@finken/domain/format';
import { habits, isPrincipal, refundedAmount, transactionLabel, validateDraft } from '@finken/domain/money';
import type { ID, Transaction, TransactionType } from '@finken/domain/types';
import { type FormEvent, useMemo, useState } from 'react';
import { useAppState } from '../../data/hooks';
import { store } from '../../data/store';
import { track } from '../../data/usage';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Segmented } from '../ui/Misc';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useRequestId } from '../ui/useRequestId';
import { CategoryIcon } from './parts';

export interface FormRequest {
  type: TransactionType;
  /** Edit this transaction in place. */
  edit?: Transaction;
  /** Start a new transaction pre-filled from this one. */
  copyFrom?: Transaction;
  /** Record a refund of this expense. */
  refundOf?: Transaction;
  /** Start from what was understood from a typed sentence. Nothing is saved until the user confirms. */
  capture?: CaptureResult;
}

interface TransactionFormProps {
  request: FormRequest;
  onClose: () => void;
}

const TYPE_OPTIONS: { value: TransactionType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
  { value: 'transfer', label: 'Transfer' },
];

const SAVED: Record<TransactionType, string> = {
  expense: 'Expense saved',
  income: 'Income saved',
  transfer: 'Transfer saved',
  refund: 'Refund saved',
  principal_in: 'Saved',
  principal_out: 'Saved',
};

/** Keeps digits and a single decimal point. */
function cleanAmount(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const [whole, ...rest] = cleaned.split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole;
}

function withSeparators(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function TransactionForm({ request, onClose }: TransactionFormProps) {
  const [requestId, nextRequest] = useRequestId();
  const state = useAppState();
  const toast = useToast();
  const { refundOf, capture } = request;
  const source = request.edit ?? request.copyFrom;
  const editing = Boolean(request.edit);
  // What is left to refund on the original expense, used as the starting amount.
  const refundable = refundOf ? refundOf.amount - refundedAmount(refundOf.id, state.transactions) : 0;

  const [type, setType] = useState<TransactionType>(source?.type ?? request.type);
  const [spaceId, setSpaceId] = useState<ID>(source?.spaceId ?? refundOf?.spaceId ?? state.activeSpaceId ?? '');
  const [amount, setAmount] = useState(source ? moneyToInput(source.amount) : refundOf ? moneyToInput(refundable) : capture?.amount ? moneyToInput(capture.amount) : '');
  const [date, setDate] = useState(request.edit?.date ?? capture?.date ?? today());
  const [description, setDescription] = useState(source?.description ?? capture?.description ?? (refundOf ? `Refund: ${refundOf.description || 'expense'}` : ''));
  const [notes, setNotes] = useState(source?.notes ?? '');
  const [categoryId, setCategoryId] = useState<ID | undefined>(source?.categoryId ?? capture?.categoryId);
  const [subcategoryId, setSubcategoryId] = useState<ID | undefined>(source?.subcategoryId ?? capture?.subcategoryId);
  const [accountId, setAccountId] = useState<ID | undefined>(source?.accountId ?? refundOf?.accountId ?? capture?.accountId);
  const [toAccountId, setToAccountId] = useState<ID | undefined>(source?.toAccountId ?? capture?.toAccountId);
  const [error, setError] = useState<string | null>(null);

  const space = state.spaces.find((s) => s.id === spaceId);
  const activeSpaces = state.spaces.filter((s) => s.status === 'active' || s.id === spaceId);
  // Refunds and money-owed entries keep their type, category and links; only the basics are edited here.
  const fixedType = type === 'refund' || isPrincipal(type);
  const linked = source ?? refundOf;
  // Archived accounts are offered only when this transaction already uses them.
  const accounts = useMemo(
    () => state.accounts.filter((a) => a.spaceId === spaceId && (!a.archived || a.id === source?.accountId || a.id === source?.toAccountId)),
    [state.accounts, spaceId, source],
  );
  // Remember what the user usually picks in this Space: their most used
  // categories come first, and each category brings its usual account.
  const usual = useMemo(
    () =>
      habits(
        state.transactions.filter((t) => t.spaceId === spaceId),
        type,
      ),
    [state.transactions, spaceId, type],
  );
  const categories = useMemo(() => {
    const rank = new Map(usual.categoryOrder.map((id, i) => [id, i]));
    return state.categories
      .filter((c) => c.spaceId === spaceId && c.kind === type)
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (rank.get(a.c.id) ?? 999) - (rank.get(b.c.id) ?? 999) || a.i - b.i)
      .map(({ c }) => c);
  }, [state.categories, spaceId, type, usual]);

  const category = categories.find((c) => c.id === categoryId) ?? categories[0];
  const account =
    accounts.find((a) => a.id === accountId) ??
    accounts.find((a) => a.id === (category && usual.accountByCategory.get(category.id))) ??
    accounts.find((a) => a.id === usual.account) ??
    accounts[0];
  const subcategory = category?.subcategories.find((s) => s.id === subcategoryId);
  const destination = accounts.find((a) => a.id === toAccountId && a.id !== account?.id) ?? accounts.find((a) => a.id !== account?.id);

  function submit(e: FormEvent) {
    e.preventDefault();
    const draft = {
      spaceId,
      type,
      amount: parseMoney(amount),
      date,
      description,
      notes,
      accountId: account?.id ?? '',
      toAccountId: type === 'transfer' ? destination?.id : undefined,
      categoryId: fixedType ? linked?.categoryId : type === 'transfer' ? undefined : category?.id,
      subcategoryId: fixedType ? linked?.subcategoryId : type === 'transfer' ? undefined : subcategory?.id,
      refundOfId: type === 'refund' ? (refundOf?.id ?? source?.refundOfId) : undefined,
      obligationId: fixedType ? source?.obligationId : undefined,
      personId: fixedType ? source?.personId : undefined,
    };
    const invalid = validateDraft(draft);
    if (invalid) return setError(invalid);

    const result = request.edit ? store.updateTransaction(request.edit.id, draft) : store.addTransaction(draft, requestId);
    if (!result.ok) return setError(result.error);
    nextRequest();
    if (!editing && (type === 'expense' || type === 'income' || type === 'transfer')) track(`add:${type}`);

    const elsewhere = spaceId !== state.activeSpaceId && space ? ` in ${space.name}` : '';
    toast(editing ? 'Changes saved' : `${SAVED[type]}${elsewhere}`);
    onClose();
  }

  const obligation = state.obligations.find((o) => o.id === source?.obligationId);
  const fixedLabel = source ? transactionLabel(source, accounts, obligation) : 'Refund';
  const title = capture
    ? 'Confirm and save'
    : refundOf
      ? 'Record a refund'
      : editing
        ? fixedType
          ? `Edit ${fixedLabel.toLowerCase()}`
          : 'Edit transaction'
        : request.copyFrom
          ? 'Duplicate transaction'
          : 'Add transaction';

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <Button type="submit" form="transaction-form" variant="primary" size="lg" block>
          {editing ? 'Save changes' : 'Save'}
        </Button>
      }
    >
      <form id="transaction-form" onSubmit={submit} noValidate className="space-y-5">
        {capture && (
          <div className="rounded-control border border-accent/25 bg-accent-soft px-3.5 py-3 text-sm leading-relaxed text-ink-2">
            <p className="font-bold text-accent-strong">Check this before saving</p>
            {capture.understood.length > 0 && <p className="mt-0.5">Understood: {capture.understood.join(' · ')}.</p>}
            {capture.guesses.length > 0 && <p className="mt-0.5">{capture.guesses.join('. ')}.</p>}
          </div>
        )}

        {fixedType ? (
          refundOf && (
            <p className="rounded-control bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink-2">
              Money back for <strong className="font-bold text-ink">{refundOf.description || 'this expense'}</strong>. It lowers your spending in the same category and is not
              counted as income.
            </p>
          )
        ) : (
          <Segmented
            label="Transaction type"
            value={type}
            onChange={(v) => {
              setType(v);
              setError(null);
            }}
            options={TYPE_OPTIONS}
            className="flex w-full"
          />
        )}

        <div>
          <label htmlFor="amount" className="sr-only">
            Amount
          </label>
          <div className="flex items-baseline justify-center gap-2 rounded-card bg-canvas px-4 py-5">
            <span className="text-xl font-bold text-ink-3">{currencySymbol(space?.currency ?? 'PKR')}</span>
            <input
              id="amount"
              data-autofocus
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={withSeparators(amount)}
              onChange={(e) => {
                setAmount(cleanAmount(e.target.value));
                setError(null);
              }}
              // Sized to its content so the currency prefix stays next to the digits.
              style={{ width: `${Math.max(1, withSeparators(amount).length)}ch` }}
              className="money min-w-[1ch] max-w-full bg-transparent text-center text-[40px] font-extrabold leading-none text-ink placeholder:text-ink-3/50 focus:outline-none"
            />
          </div>
        </div>

        {type !== 'transfer' && !fixedType && (
          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-ink-2">{type === 'income' ? 'Income source' : 'Category'}</legend>
            {categories.length === 0 ? (
              <p className="text-sm text-ink-3">This Space has no {type} categories yet.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {categories.map((c) => {
                  const active = c.id === category?.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setCategoryId(c.id);
                        setSubcategoryId(undefined);
                      }}
                      className={cn(
                        'flex flex-col items-center gap-1.5 rounded-xl border px-1 py-2.5 transition-colors',
                        active ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-canvas',
                      )}
                    >
                      <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                      <span className={cn('w-full truncate text-center text-[11px] font-semibold', active ? 'text-accent-strong' : 'text-ink-2')}>{c.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {category && category.subcategories.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`${category.name} subcategory`}>
                {category.subcategories.map((s) => {
                  const active = s.id === subcategory?.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setSubcategoryId(active ? undefined : s.id)}
                      className={cn(
                        'h-8 rounded-full border px-3 text-[13px] font-semibold transition-colors',
                        active ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:border-line-strong',
                      )}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={type === 'transfer' ? 'From' : type === 'expense' || type === 'principal_out' ? 'Paid from' : 'Received in'}>
            {(id) => (
              <Select id={id} value={account?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'transfer' ? (
            <Field label="To">
              {(id) => (
                <Select id={id} value={destination?.id ?? ''} onChange={(e) => setToAccountId(e.target.value)}>
                  {accounts
                    .filter((a) => a.id !== account?.id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>
          )}
        </div>

        {type === 'transfer' && <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>}

        <Field label="Description">
          {(id) => (
            <Input
              id={id}
              value={description}
              maxLength={80}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={type === 'expense' ? 'e.g. Family dinner' : type === 'income' ? 'e.g. Monthly salary' : 'e.g. ATM withdrawal'}
            />
          )}
        </Field>

        {<Field label="Notes">{(id) => <Textarea id={id} value={notes} maxLength={400} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />}</Field>}

        {!editing && !fixedType && activeSpaces.length > 1 && (
          <Field label="Space" hint="Each Space keeps its own records.">
            {(id) => (
              <Select
                id={id}
                value={spaceId}
                onChange={(e) => {
                  // Categories and accounts belong to a Space, so clear them.
                  setSpaceId(e.target.value);
                  setCategoryId(undefined);
                  setSubcategoryId(undefined);
                  setAccountId(undefined);
                  setToAccountId(undefined);
                }}
              >
                {activeSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {error && (
          <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
