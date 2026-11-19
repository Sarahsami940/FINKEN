import { today } from '@finken/domain/dates';
import { currencySymbol, formatMoney } from '@finken/domain/format';
import { habits, obligationPosition, owedToYouKind, settlementType } from '@finken/domain/money';
import type { Frequency, ID, Obligation, PersonRole, TransactionType } from '@finken/domain/types';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useAppState } from '../../data/hooks';
import { store } from '../../data/store';
import { Button } from '../ui/Button';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Segmented } from '../ui/Misc';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

export const NEW_PERSON = '__new__';

/** Keeps digits and a single decimal point. */
export function cleanAmount(raw: string): string {
  const [whole, ...rest] = raw.replace(/[^\d.]/g, '').split('.');
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole;
}

function withSeparators(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** The large amount box at the top of every capture form. */
export function AmountInput({ value, onChange, currency }: { value: string; onChange: (value: string) => void; currency: string }) {
  const shown = withSeparators(value);
  return (
    <div>
      <label htmlFor="owed-amount" className="sr-only">
        Amount
      </label>
      <div className="flex items-baseline justify-center gap-2 rounded-card bg-canvas px-4 py-5">
        <span className="text-xl font-bold text-ink-3">{currencySymbol(currency)}</span>
        <input
          id="owed-amount"
          data-autofocus
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={shown}
          onChange={(e) => onChange(cleanAmount(e.target.value))}
          style={{ width: `${Math.max(1, shown.length)}ch` }}
          className="money min-w-[1ch] max-w-full bg-transparent text-center text-[40px] font-extrabold leading-none text-ink placeholder:text-ink-3/50 focus:outline-none"
        />
      </div>
    </div>
  );
}

interface PersonPickerProps {
  /** What to call the person: Person, Customer, Supplier… */
  label?: string;
  spaceId: ID;
  personId: string;
  newName: string;
  onPerson: (id: string) => void;
  onNewName: (name: string) => void;
}

/** Choose someone already known in this Space, or add a new person by name. */
export function PersonPicker({ spaceId, personId, newName, onPerson, onNewName, label = 'Person' }: PersonPickerProps) {
  const { people } = useAppState();
  const list = useMemo(() => people.filter((p) => p.spaceId === spaceId).sort((a, b) => a.name.localeCompare(b.name)), [people, spaceId]);
  return (
    <div className="space-y-2">
      <Field label={label}>
        {(id) => (
          <Select id={id} value={personId} onChange={(e) => onPerson(e.target.value)}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NEW_PERSON}>New {label.toLowerCase()}…</option>
          </Select>
        )}
      </Field>
      {personId === NEW_PERSON && <Input aria-label="New person's name" value={newName} maxLength={40} placeholder="Their name" onChange={(e) => onNewName(e.target.value)} />}
    </div>
  );
}

/** Returns the chosen person's id, creating them first when they are new. */
export function resolvePerson(spaceId: ID, personId: string, newName: string, role?: PersonRole): { ok: true; id: ID; name: string } | { ok: false; error: string } {
  if (personId !== NEW_PERSON) {
    const person = store.getState().people.find((p) => p.id === personId);
    return person ? { ok: true, id: person.id, name: person.name } : { ok: false, error: 'Choose a person.' };
  }
  const name = newName.trim();
  if (!name) return { ok: false, error: "Enter the person's name." };
  const existing = store.getState().people.find((p) => p.spaceId === spaceId && p.name.toLowerCase() === name.toLowerCase());
  if (existing) return { ok: true, id: existing.id, name: existing.name };
  const created = store.addPerson(spaceId, { name, role });
  return created.ok ? { ok: true, id: created.person.id, name: created.person.name } : created;
}

export function FormShell({
  title,
  formId,
  submitLabel,
  error,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  formId: string;
  submitLabel: string;
  error: string | null;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <Button type="submit" form={formId} variant="primary" size="lg" block>
          {submitLabel}
        </Button>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
        {children}
        {error && (
          <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

const HOW_COUNTED: Record<TransactionType, string> = {
  income: 'This will count as income.',
  expense: 'This will count as spending.',
  refund: 'This is their share of a cost you already paid. It lowers that spending and is not counted as income.',
  principal_in: 'This is a repayment of money you lent. It is not counted as income.',
  principal_out: 'This is a repayment of money you borrowed. It is not counted as spending.',
  transfer: '',
};

type Direction = 'received' | 'paid';

/** Receive / Pay: money that came from, or went to, a particular person. */
export function ReceivePayForm({
  onClose,
  settle,
  amount: presetAmount,
  direction: presetDirection,
}: {
  onClose: () => void;
  /** Start as money received or money paid. */
  direction?: 'received' | 'paid';
  /** Open ready to record a payment against this. */
  settle?: Obligation;
  /** Start with this amount instead of everything still outstanding. */
  amount?: number;
}) {
  const state = useAppState();
  const toast = useToast();
  const spaceId = settle?.spaceId ?? state.activeSpaceId ?? '';
  const space = state.spaces.find((s) => s.id === spaceId);
  const currency = space?.currency ?? 'PKR';
  const people = state.people.filter((p) => p.spaceId === spaceId).sort((a, b) => a.name.localeCompare(b.name));

  const [direction, setDirection] = useState<Direction>(settle ? (owedToYouKind(settle.kind) ? 'received' : 'paid') : (presetDirection ?? 'received'));
  const isBusiness = space?.type === 'business';
  // In a business, money comes from customers and goes to suppliers.
  const role: PersonRole | undefined = isBusiness ? (direction === 'received' ? 'customer' : 'supplier') : undefined;
  const [amount, setAmount] = useState(() => (presetAmount ? String(presetAmount) : settle ? String(obligationPosition(settle, state.transactions).outstanding) : ''));
  const [personId, setPersonId] = useState<string>(settle?.personId ?? people[0]?.id ?? NEW_PERSON);
  const [newName, setNewName] = useState('');
  const [obligationId, setObligationId] = useState(settle?.id ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Only what this person still owes (or is owed) in this direction can be linked.
  const related = useMemo(
    () =>
      state.obligations
        .filter((o) => o.spaceId === spaceId && o.personId === personId && owedToYouKind(o.kind) === (direction === 'received'))
        .map((o) => obligationPosition(o, state.transactions))
        .filter((p) => p.state === 'open'),
    [state.obligations, state.transactions, spaceId, personId, direction],
  );
  const linked = related.find((p) => p.obligation.id === obligationId);
  const type: TransactionType = linked ? settlementType(linked.obligation) : direction === 'received' ? 'income' : 'expense';
  const needsCategory = type === 'income' || type === 'expense';

  const accounts = state.accounts.filter((a) => a.spaceId === spaceId && !a.archived);
  const usual = useMemo(
    () =>
      habits(
        state.transactions.filter((t) => t.spaceId === spaceId),
        type,
      ),
    [state.transactions, spaceId, type],
  );
  const categories = state.categories.filter((c) => c.spaceId === spaceId && c.kind === (type === 'income' ? 'income' : 'expense'));
  const category = categories.find((c) => c.id === categoryId) ?? categories.find((c) => c.id === usual.categoryOrder[0]) ?? categories[0];
  const account = accounts.find((a) => a.id === accountId) ?? accounts.find((a) => a.id === usual.account) ?? accounts[0];

  function reset() {
    setObligationId('');
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    if (!account) return setError('Choose an account.');
    const person = resolvePerson(spaceId, personId, newName, role);
    if (!person.ok) return setError(person.error);

    const fallback = direction === 'received' ? `Received from ${person.name}` : `Paid to ${person.name}`;
    const result = linked
      ? store.settleObligation(linked.obligation.id, {
          amount: value,
          date,
          accountId: account.id,
          description: description.trim() || undefined,
          categoryId: needsCategory ? category?.id : undefined,
        })
      : store.addTransaction({
          spaceId,
          type,
          amount: value,
          date,
          description: description.trim() || fallback,
          accountId: account.id,
          categoryId: category?.id,
          personId: person.id,
        });
    if (!result.ok) return setError(result.error);
    toast(direction === 'received' ? `${formatMoney(value, currency)} received from ${person.name}` : `${formatMoney(value, currency)} paid to ${person.name}`);
    onClose();
  }

  return (
    <FormShell
      title={
        settle
          ? direction === 'received'
            ? 'Record money received'
            : 'Record a payment'
          : isBusiness
            ? direction === 'received'
              ? 'Customer payment'
              : 'Supplier payment'
            : 'Receive / Pay'
      }
      formId="receive-pay-form"
      submitLabel="Save"
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      {settle ? (
        <p className="rounded-control bg-canvas px-3.5 py-3 text-sm leading-relaxed text-ink-2">
          For <strong className="font-bold text-ink">{settle.title}</strong>. Enter less than the full amount to record a part payment.
        </p>
      ) : (
        <Segmented
          label="Direction"
          value={direction}
          onChange={(v) => {
            setDirection(v);
            reset();
          }}
          options={[
            { value: 'received', label: isBusiness ? 'From a customer' : 'I received' },
            { value: 'paid', label: isBusiness ? 'To a supplier' : 'I paid' },
          ]}
          className="flex w-full"
        />
      )}
      <AmountInput
        value={amount}
        currency={currency}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
      />
      {!settle && (
        <PersonPicker
          label={role === 'customer' ? 'Customer' : role === 'supplier' ? 'Supplier' : 'Person'}
          spaceId={spaceId}
          personId={personId}
          newName={newName}
          onPerson={(id) => {
            setPersonId(id);
            reset();
          }}
          onNewName={(name) => {
            setNewName(name);
            setError(null);
          }}
        />
      )}

      {!settle && related.length > 0 && (
        <Field label="This is for">
          {(id) => (
            <Select
              id={id}
              value={obligationId}
              onChange={(e) => {
                setObligationId(e.target.value);
                setError(null);
                // Picking what it is for suggests the amount still outstanding.
                const picked = related.find((p) => p.obligation.id === e.target.value);
                if (picked && !amount) setAmount(String(picked.outstanding));
              }}
            >
              <option value="">Something else</option>
              {related.map((p) => (
                <option key={p.obligation.id} value={p.obligation.id}>
                  {p.obligation.title} ({formatMoney(p.outstanding, currency)} left)
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      {needsCategory && categories.length > 0 && (
        <Field label={type === 'income' ? 'Income source' : 'Category'}>
          {(id) => (
            <Select id={id} value={category?.id ?? ''} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label={direction === 'received' ? 'Received in' : 'Paid from'}>
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
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>
      </div>

      <Field label="Description">
        {(id) => <Input id={id} value={description} maxLength={80} placeholder={linked ? linked.obligation.title : 'Optional'} onChange={(e) => setDescription(e.target.value)} />}
      </Field>

      <p className="text-[13px] leading-relaxed text-ink-3">
        {HOW_COUNTED[type]} Recorded in {space?.name ?? 'this Space'}.
      </p>
    </FormShell>
  );
}

type LoanDirection = 'borrowed' | 'lent';

/** Loan: money borrowed or lent, tracked until it is paid back. */
export function LoanForm({ onClose, personId: presetPerson }: { onClose: () => void; personId?: ID }) {
  const state = useAppState();
  const toast = useToast();
  const spaceId = state.activeSpaceId ?? '';
  const space = state.spaces.find((s) => s.id === spaceId);
  const currency = space?.currency ?? 'PKR';
  const people = state.people.filter((p) => p.spaceId === spaceId).sort((a, b) => a.name.localeCompare(b.name));
  const accounts = state.accounts.filter((a) => a.spaceId === spaceId && !a.archived);

  const [direction, setDirection] = useState<LoanDirection>('borrowed');
  const [amount, setAmount] = useState('');
  const [personId, setPersonId] = useState<string>(presetPerson ?? people[0]?.id ?? NEW_PERSON);
  const [newName, setNewName] = useState('');
  const [interest, setInterest] = useState('');
  const [instalment, setInstalment] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [accountId, setAccountId] = useState(accounts.find((a) => a.kind === 'bank')?.id ?? accounts[0]?.id ?? '');
  const [date, setDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    if (!accountId) return setError('Choose an account.');
    if (dueDate && dueDate < date) return setError('The repayment date cannot be before the loan itself.');
    const person = resolvePerson(spaceId, personId, newName);
    if (!person.ok) return setError(person.error);

    const title = description.trim() || (direction === 'borrowed' ? `Borrowed from ${person.name}` : `Loan to ${person.name}`);
    const result = store.addObligation(
      {
        spaceId,
        kind: direction,
        personId: person.id,
        title,
        amount: value,
        date,
        dueDate: dueDate || undefined,
        notes,
        interestRate: interest ? Number(interest) : undefined,
        instalmentAmount: instalment ? Number(instalment) : undefined,
        instalmentFrequency: instalment ? frequency : undefined,
      },
      { accountId },
    );
    if (!result.ok) return setError(result.error);
    toast(direction === 'borrowed' ? `${formatMoney(value, currency)} borrowed from ${person.name}` : `${formatMoney(value, currency)} lent to ${person.name}`);
    onClose();
  }

  return (
    <FormShell title="Loan" formId="loan-form" submitLabel="Save loan" error={error} onClose={onClose} onSubmit={submit}>
      <Segmented
        label="Direction"
        value={direction}
        onChange={(v) => {
          setDirection(v);
          setError(null);
        }}
        options={[
          { value: 'borrowed', label: 'I borrowed' },
          { value: 'lent', label: 'I lent' },
        ]}
        className="flex w-full"
      />
      <AmountInput
        value={amount}
        currency={currency}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
      />
      <PersonPicker
        spaceId={spaceId}
        personId={personId}
        newName={newName}
        onPerson={(id) => {
          setPersonId(id);
          setError(null);
        }}
        onNewName={(name) => {
          setNewName(name);
          setError(null);
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label={direction === 'borrowed' ? 'Received in' : 'Paid from'}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>
      </div>
      <Field label={direction === 'borrowed' ? 'Repay by' : 'Expected back by'} hint="Optional. Finken will show it as overdue after this date.">
        {(id) => <Input id={id} type="date" value={dueDate} min={date} max="9999-12-31" onChange={(e) => setDueDate(e.target.value)} />}
      </Field>
      <Field label="Description">
        {(id) => <Input id={id} value={description} maxLength={80} placeholder="e.g. For the car repair" onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <LoanTerms
        interest={interest}
        instalment={instalment}
        frequency={frequency}
        currency={currency}
        onInterest={setInterest}
        onInstalment={setInstalment}
        onFrequency={setFrequency}
      />
      <Field label="Notes">
        {(id) => <Textarea id={id} value={notes} maxLength={400} placeholder="e.g. 10,000 a month from January" onChange={(e) => setNotes(e.target.value)} />}
      </Field>
      <p className="text-[13px] leading-relaxed text-ink-3">
        {direction === 'borrowed' ? 'Borrowed money is not counted as income.' : 'Money you lend is not counted as spending.'} Finken keeps track of what is still owed. Recorded in{' '}
        {space?.name ?? 'this Space'}.
      </p>
    </FormShell>
  );
}

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'quarterly', label: 'Every 3 months' },
  { value: 'yearly', label: 'Every year' },
];

interface LoanTermsProps {
  interest: string;
  instalment: string;
  frequency: Frequency;
  currency: string;
  onInterest: (value: string) => void;
  onInstalment: (value: string) => void;
  onFrequency: (value: Frequency) => void;
}

/** Optional loan terms: instalments drive the next due date; interest is a reminder of what was agreed. */
export function LoanTerms({ interest, instalment, frequency, currency, onInterest, onInstalment, onFrequency }: LoanTermsProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[13px] font-semibold text-ink-2">Repayment terms (optional)</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Instalment (${currencySymbol(currency)})`}>
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 10,000"
              className="money"
              value={instalment}
              onChange={(e) => onInstalment(cleanAmount(e.target.value))}
            />
          )}
        </Field>
        <Field label="How often">
          {(id) => (
            <Select id={id} value={frequency} disabled={!instalment} onChange={(e) => onFrequency(e.target.value as Frequency)}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Interest (% a year)" hint="Kept as a reminder. Record interest you actually pay or receive from the loan's page.">
        {(id) => (
          <Input id={id} inputMode="decimal" autoComplete="off" placeholder="0" className="money" value={interest} onChange={(e) => onInterest(cleanAmount(e.target.value))} />
        )}
      </Field>
    </fieldset>
  );
}
