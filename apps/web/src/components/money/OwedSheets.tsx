import { formatDay, formatDueLabel, today } from '@finken/domain/dates';
import { currencySymbol, formatMoney, moneyToInput, parseMoney } from '@finken/domain/format';
import { habits, interestPaid, obligationPosition, obligationStatus, owedToYouKind, sharedAmount, sortByDateDesc, splitEqually, transactionLabel } from '@finken/domain/money';
import type { Frequency, ID, Obligation, ObligationKind, Person, PersonRole, Transaction } from '@finken/domain/types';
import { Ban, Pencil, Percent, RotateCcw, Trash2, Wallet } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useAppState } from '../../data/hooks';
import { store } from '../../data/store';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { Field, Input, Select, Textarea } from '../ui/Field';
import { Badge, ProgressBar, Segmented } from '../ui/Misc';
import { ConfirmDialog, Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useRequestId } from '../ui/useRequestId';
import { useAddFlow } from './AddFlow';
import { AmountInput, cleanAmount, FormShell, LoanTerms, NEW_PERSON, PersonPicker, ReceivePayForm, resolvePerson } from './OwedForms';

/** Plain-language wording for each kind of money owed. */
export const KIND_WORDS: Record<ObligationKind, { noun: string; done: string; verb: string; settle: string }> = {
  receivable: { noun: 'To receive', done: 'Received', verb: 'owes you', settle: 'Record money received' },
  lent: { noun: 'You lent', done: 'Repaid to you', verb: 'owes you', settle: 'Record a repayment' },
  payable: { noun: 'To pay', done: 'Paid', verb: 'you owe', settle: 'Record a payment' },
  borrowed: { noun: 'You borrowed', done: 'Repaid', verb: 'you owe', settle: 'Record a repayment' },
};

const FREQUENCY_WORDS: Record<Frequency, string> = { weekly: 'a week', monthly: 'a month', quarterly: 'every 3 months', yearly: 'a year' };

// ── Create or edit ─────────────────────────────────────────────────────────

interface EditorProps {
  /** Edit this record, or… */
  obligation?: Obligation;
  /** …create a new receivable or payable. */
  kind?: 'receivable' | 'payable';
  personId?: ID;
  onClose: () => void;
}

/** Creates a receivable or payable, or edits the terms of any obligation. */
export function ObligationEditor({ obligation, kind: newKind = 'receivable', personId: presetPerson, onClose }: EditorProps) {
  const [requestId, nextRequest] = useRequestId();
  const state = useAppState();
  const toast = useToast();
  const kind = obligation?.kind ?? newKind;
  const spaceId = obligation?.spaceId ?? state.activeSpaceId ?? '';
  const space = state.spaces.find((s) => s.id === spaceId);
  const currency = space?.currency ?? 'PKR';
  const people = state.people.filter((p) => p.spaceId === spaceId).sort((a, b) => a.name.localeCompare(b.name));
  const isLoan = kind === 'lent' || kind === 'borrowed';
  const toYou = owedToYouKind(kind);

  const [amount, setAmount] = useState(obligation ? moneyToInput(obligation.amount) : '');
  const [personId, setPersonId] = useState<string>(obligation?.personId ?? presetPerson ?? people[0]?.id ?? NEW_PERSON);
  const [newName, setNewName] = useState('');
  const [title, setTitle] = useState(obligation?.title ?? '');
  const [date, setDate] = useState(obligation?.date ?? today());
  const [dueDate, setDueDate] = useState(obligation?.dueDate ?? '');
  const [notes, setNotes] = useState(obligation?.notes ?? '');
  const [interest, setInterest] = useState(obligation?.interestRate ? String(obligation.interestRate) : '');
  const [instalment, setInstalment] = useState(obligation?.instalmentAmount ? moneyToInput(obligation.instalmentAmount) : '');
  const [frequency, setFrequency] = useState<Frequency>(obligation?.instalmentFrequency ?? 'monthly');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = parseMoney(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter an amount greater than zero.');
    if (!title.trim()) return setError('Add a short description, such as what it is for.');
    const terms = {
      title,
      amount: value,
      date,
      dueDate: dueDate || undefined,
      notes,
      interestRate: isLoan && interest ? Number(interest) : undefined,
      instalmentAmount: isLoan && instalment ? parseMoney(instalment) : undefined,
      instalmentFrequency: isLoan && instalment ? frequency : undefined,
    };
    if (obligation) {
      const result = store.updateObligation(obligation.id, terms);
      if (!result.ok) return setError(result.error);
      toast('Changes saved');
      return onClose();
    }
    if (dueDate && dueDate < date) return setError('The due date cannot be before the start date.');
    const person = resolvePerson(
      spaceId,
      personId,
      newName,
      space?.type === 'business' ? (kind === 'receivable' ? 'customer' : kind === 'payable' ? 'supplier' : 'lender') : undefined,
    );
    if (!person.ok) return setError(person.error);
    const result = store.addObligation({ spaceId, kind, personId: person.id, ...terms }, undefined, requestId);
    if (!result.ok) return setError(result.error);
    nextRequest();
    toast(toYou ? `${person.name} owes you ${formatMoney(value, currency)}` : `You owe ${person.name} ${formatMoney(value, currency)}`);
    onClose();
  }

  const heading = obligation ? 'Edit details' : toYou ? 'Money to receive' : 'Money to pay';
  return (
    <FormShell title={heading} formId="obligation-form" submitLabel={obligation ? 'Save changes' : 'Save'} error={error} onClose={onClose} onSubmit={submit}>
      <AmountInput
        value={amount}
        currency={currency}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
      />
      {!obligation && (
        <PersonPicker
          label={space?.type === 'business' && kind === 'receivable' ? 'Customer' : space?.type === 'business' && kind === 'payable' ? 'Supplier' : 'Person'}
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
      )}
      <Field label="What it is for">
        {(id) => (
          <Input
            id={id}
            value={title}
            maxLength={80}
            placeholder={toYou ? 'e.g. Invoice 1042, website design' : 'e.g. Fabric delivery on credit'}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} max="9999-12-31" onChange={(e) => setDate(e.target.value)} />}</Field>
        <Field label={toYou ? 'Expected by' : 'Due by'}>
          {(id) => <Input id={id} type="date" value={dueDate} min={date} max="9999-12-31" onChange={(e) => setDueDate(e.target.value)} />}
        </Field>
      </div>
      {isLoan && (
        <LoanTerms
          interest={interest}
          instalment={instalment}
          frequency={frequency}
          currency={currency}
          onInterest={setInterest}
          onInstalment={setInstalment}
          onFrequency={setFrequency}
        />
      )}
      <Field label="Notes">{(id) => <Textarea id={id} value={notes} maxLength={400} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />}</Field>
      {!obligation && (
        <p className="text-[13px] leading-relaxed text-ink-3">
          {toYou
            ? 'Nothing is counted as income yet. It is counted once, when you record the money arriving.'
            : 'Nothing is counted as spending yet. It is counted once, when you record the payment.'}{' '}
          Recorded in {space?.name ?? 'this Space'}.
        </p>
      )}
    </FormShell>
  );
}

// ── Interest ───────────────────────────────────────────────────────────────

function InterestForm({ obligation, onClose }: { obligation: Obligation; onClose: () => void }) {
  const [requestId, nextRequest] = useRequestId();
  const state = useAppState();
  const toast = useToast();
  const borrowed = obligation.kind === 'borrowed';
  const type = borrowed ? 'expense' : 'income';
  const accounts = state.accounts.filter((a) => a.spaceId === obligation.spaceId && !a.archived);
  const categories = state.categories.filter((c) => c.spaceId === obligation.spaceId && c.kind === type);
  const usual = useMemo(
    () =>
      habits(
        state.transactions.filter((t) => t.spaceId === obligation.spaceId),
        type,
      ),
    [state.transactions, obligation.spaceId, type],
  );
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [accountId, setAccountId] = useState(accounts.find((a) => a.id === usual.account)?.id ?? accounts[0]?.id ?? '');
  // "Other" is the natural home for interest unless the user has something better.
  const [categoryId, setCategoryId] = useState(categories.find((c) => /interest|other/i.test(c.name))?.id ?? categories[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = store.recordInterest(obligation.id, { amount: parseMoney(amount), date, accountId, categoryId: categoryId || undefined }, requestId);
    if (!result.ok) return setError(result.error);
    nextRequest();
    toast('Interest recorded');
    onClose();
  }

  return (
    <FormShell title={borrowed ? 'Interest paid' : 'Interest received'} formId="interest-form" submitLabel="Save" error={error} onClose={onClose} onSubmit={submit}>
      <AmountInput
        value={amount}
        currency={obligation.currency}
        onChange={(v) => {
          setAmount(v);
          setError(null);
        }}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label={borrowed ? 'Paid from' : 'Received in'}>
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
      {categories.length > 0 && (
        <Field label={borrowed ? 'Category' : 'Income source'}>
          {(id) => (
            <Select id={id} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <p className="text-[13px] leading-relaxed text-ink-3">
        {borrowed ? 'Interest counts as spending.' : 'Interest counts as income.'} It does not reduce what is still owed on the loan.
      </p>
    </FormShell>
  );
}

// ── Detail ─────────────────────────────────────────────────────────────────

type Sub = 'settle' | 'interest' | 'edit' | 'delete' | 'write-off' | null;

/** Everything about one receivable, payable or loan, with its history and actions. */
export function ObligationSheet({ id, onClose }: { id: ID | null; onClose: () => void }) {
  const state = useAppState();
  const toast = useToast();
  const { openDetail } = useAddFlow();
  const [sub, setSub] = useState<Sub>(null);
  const o = state.obligations.find((item) => item.id === id);
  if (!o) return null;

  const position = obligationPosition(o, state.transactions);
  const status = obligationStatus(position);
  const words = KIND_WORDS[o.kind];
  const person = state.people.find((p) => p.id === o.personId);
  const accounts = state.accounts.filter((a) => a.spaceId === o.spaceId);
  const history = sortByDateDesc(state.transactions.filter((t) => t.obligationId === o.id));
  const source = state.transactions.find((t) => t.id === o.sourceTransactionId);
  const isLoan = o.kind === 'lent' || o.kind === 'borrowed';
  const interest = interestPaid(o, state.transactions);
  const money = (n: number) => formatMoney(n, o.currency);
  const open = position.state === 'open';

  const rows: [string, string][] = [
    ['Started', formatDay(o.date)],
    [owedToYouKind(o.kind) ? 'Expected by' : 'Due by', o.dueDate ? formatDay(o.dueDate) : 'No date set'],
  ];
  if (o.instalmentAmount && o.instalmentFrequency) rows.push(['Instalments', `${money(o.instalmentAmount)} ${FREQUENCY_WORDS[o.instalmentFrequency]}`]);
  if (open && position.nextDue && position.nextDue !== o.dueDate) rows.push(['Next due', `${formatDay(position.nextDue)} · ${formatDueLabel(position.nextDue)}`]);
  if (o.interestRate) rows.push(['Interest', `${o.interestRate}% a year`]);
  if (interest > 0) rows.push([o.kind === 'borrowed' ? 'Interest paid so far' : 'Interest received so far', money(interest)]);
  if (source) rows.push(['Share of', `${source.description || 'An expense'} (${money(source.amount)})`]);
  if (o.notes) rows.push(['Notes', o.notes]);

  function writeOff(cancelled: boolean) {
    const result = store.setObligationCancelled(o!.id, cancelled);
    setSub(null);
    toast(result.ok ? (cancelled ? 'Written off' : 'Reopened') : result.error, result.ok ? undefined : { tone: 'error' });
  }

  function remove() {
    const result = store.deleteObligation(o!.id);
    setSub(null);
    if (!result.ok) return toast(result.error, { tone: 'error' });
    toast('Deleted');
    onClose();
  }

  return (
    <>
      <Modal
        open={sub === null}
        onClose={onClose}
        title={person?.name ?? 'Money owed'}
        description={o.title}
        footer={
          open ? (
            <Button block variant="primary" size="lg" icon={<Wallet className="size-4" />} onClick={() => setSub('settle')}>
              {words.settle}
            </Button>
          ) : position.state === 'cancelled' ? (
            <Button block size="lg" icon={<RotateCcw className="size-4" />} onClick={() => writeOff(false)}>
              Reopen
            </Button>
          ) : undefined
        }
      >
        <div className="rounded-card bg-canvas px-4 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-ink-3">{position.state === 'open' ? 'Remaining' : words.noun}</p>
              <p className="money mt-1 truncate text-[32px] font-extrabold leading-tight tracking-tight text-ink">
                {money(position.state === 'open' ? position.outstanding : o.amount)}
              </p>
            </div>
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
          <ProgressBar value={o.amount > 0 ? position.settled / o.amount : 0} label={`${words.done} so far`} className="mt-4" />
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {(
              [
                [isLoan ? 'Original' : 'Total', o.amount],
                [words.done, position.settled],
                ['Remaining', position.outstanding],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="truncate text-xs text-ink-3">{label}</dt>
                <dd className="money truncate text-sm font-bold text-ink">{money(value)}</dd>
              </div>
            ))}
          </dl>
        </div>

        <dl className="mt-4 divide-y divide-line">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-6 py-3 text-sm">
              <dt className="shrink-0 text-ink-3">{label}</dt>
              <dd className="whitespace-pre-wrap text-right font-semibold text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="border-t border-line pt-3">
          <p className="text-[13px] font-semibold text-ink-3">History</p>
          {history.length === 0 ? (
            <p className="mt-1.5 text-sm text-ink-3">Nothing has been recorded against this yet.</p>
          ) : (
            <ul className="mt-1">
              {history.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openDetail(t.id)}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-4 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-canvas"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ink">{historyLabel(t, o, accounts)}</span>
                      <span className="block text-[13px] text-ink-3">{formatDay(t.date)}</span>
                    </span>
                    <span className="money shrink-0 font-bold text-ink">{money(t.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          <Button size="sm" icon={<Pencil className="size-4" />} onClick={() => setSub('edit')}>
            Edit
          </Button>
          {isLoan && open && (
            <Button size="sm" icon={<Percent className="size-4" />} onClick={() => setSub('interest')}>
              Interest
            </Button>
          )}
          {open && (
            <Button size="sm" icon={<Ban className="size-4" />} onClick={() => setSub('write-off')}>
              Write off
            </Button>
          )}
          {history.length === 0 && (
            <Button size="sm" icon={<Trash2 className="size-4" />} className="text-negative" onClick={() => setSub('delete')}>
              Delete
            </Button>
          )}
        </div>
      </Modal>

      {sub === 'settle' && <ReceivePayForm settle={o} onClose={() => setSub(null)} />}
      {sub === 'interest' && <InterestForm obligation={o} onClose={() => setSub(null)} />}
      {sub === 'edit' && <ObligationEditor obligation={o} onClose={() => setSub(null)} />}
      <ConfirmDialog
        open={sub === 'write-off'}
        title="Write this off?"
        message={`The ${money(position.outstanding)} still remaining will no longer be counted as owed. Anything already recorded stays as it is, and you can reopen this later.`}
        confirmLabel="Write off"
        onConfirm={() => writeOff(true)}
        onCancel={() => setSub(null)}
      />
      <ConfirmDialog
        open={sub === 'delete'}
        title="Delete this record?"
        message="Nothing has been recorded against it, so no balances change. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
        onCancel={() => setSub(null)}
      />
    </>
  );
}

function historyLabel(t: Transaction, o: Obligation, accounts: Parameters<typeof transactionLabel>[1]): string {
  if (o.kind === 'borrowed' && t.type === 'expense') return 'Interest paid';
  if (o.kind === 'lent' && t.type === 'income') return 'Interest received';
  if (o.kind === 'receivable') return 'Received';
  if (o.kind === 'payable') return 'Paid';
  return transactionLabel(t, accounts, o);
}

// ── Person ─────────────────────────────────────────────────────────────────

const ROLE_OPTIONS: { value: PersonRole; label: string }[] = [
  { value: 'customer', label: 'Customer' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'lender', label: 'Lender' },
  { value: 'other', label: 'Other' },
];

export function PersonEditor({ person, spaceId, defaultRole, onClose }: { person: Person | null; spaceId: ID; defaultRole?: PersonRole; onClose: () => void }) {
  const toast = useToast();
  const state = useAppState();
  // Roles matter in business Spaces; elsewhere people are just people.
  const showRole = state.spaces.find((sp) => sp.id === spaceId)?.type === 'business' || Boolean(person?.role);
  const [role, setRole] = useState<PersonRole>(person?.role ?? defaultRole ?? 'customer');
  const [name, setName] = useState(person?.name ?? '');
  const [phone, setPhone] = useState(person?.phone ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [notes, setNotes] = useState(person?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError('That email address does not look right.');
    const draft = { name, phone, email, notes, ...(showRole ? { role } : {}) };
    const result = person ? store.updatePerson(person.id, draft) : store.addPerson(spaceId, draft);
    if (!result.ok) return setError(result.error);
    toast(person ? 'Changes saved' : `${name.trim()} added`);
    onClose();
  }

  return (
    <FormShell
      title={person ? 'Edit person' : 'New person'}
      formId="person-form"
      submitLabel={person ? 'Save changes' : 'Add person'}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            data-autofocus
            value={name}
            maxLength={40}
            placeholder="A person, customer or supplier"
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      {showRole && (
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-2">They are a</p>
          <Segmented label="Role" value={role} onChange={setRole} options={ROLE_OPTIONS} className="flex w-full" />
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Phone">{(id) => <Input id={id} type="tel" value={phone} maxLength={24} placeholder="Optional" onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              value={email}
              maxLength={80}
              placeholder="Optional"
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Notes">{(id) => <Textarea id={id} value={notes} maxLength={400} placeholder="Optional" onChange={(e) => setNotes(e.target.value)} />}</Field>
    </FormShell>
  );
}

// ── Shared expense ─────────────────────────────────────────────────────────

/** Splits an expense you paid between you and other people. */
export function SplitForm({ expense, onClose }: { expense: Transaction; onClose: () => void }) {
  const state = useAppState();
  const toast = useToast();
  const people = state.people.filter((p) => p.spaceId === expense.spaceId).sort((a, b) => a.name.localeCompare(b.name));
  const already = sharedAmount(expense.id, state.obligations);
  const available = expense.amount - already;
  const taken = new Set(state.obligations.filter((o) => o.sourceTransactionId === expense.id && o.status !== 'cancelled').map((o) => o.personId));
  const unit = expense.amount % 100 === 0 ? 100 : 1;

  const [chosen, setChosen] = useState<ID[]>([]);
  /** Amounts typed by hand; anyone not listed here gets an equal share. */
  const [custom, setCustom] = useState<Record<ID, string>>({});
  const [includeMe, setIncludeMe] = useState(true);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const money = (n: number) => formatMoney(n, expense.currency);

  const isCustom = Object.keys(custom).length > 0;
  // An equal split divides what is left between everyone taking part, you included.
  const equal = splitEqually(available, chosen.length + (includeMe ? 1 : 0), unit);
  const shareOf = (id: ID, index: number) => (isCustom ? parseMoney(custom[id] || '0') : (equal[index + (includeMe ? 1 : 0)] ?? 0));
  const othersTotal = chosen.reduce((sum, id, i) => sum + shareOf(id, i), 0);
  const yours = available - othersTotal;

  function toggle(id: ID) {
    setChosen((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
    setCustom({});
    setError(null);
  }

  function addNew() {
    const name = newName.trim();
    if (!name) return;
    const person = resolvePerson(expense.spaceId, NEW_PERSON, name);
    if (!person.ok) return setError(person.error);
    if (taken.has(person.id)) return setError(`${person.name} already has a share of this.`);
    if (!chosen.includes(person.id)) setChosen([...chosen, person.id]);
    setCustom({});
    setNewName('');
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (chosen.length === 0) return setError('Choose at least one person to share this with.');
    if (yours < -1e-6) return setError('The shares add up to more than the expense.');
    const shares = chosen.map((personId, i) => ({ personId, amount: shareOf(personId, i) }));
    if (shares.some((share) => !(share.amount > 0))) return setError('Every person needs a share greater than zero.');
    const result = store.splitExpense(expense.id, shares);
    if (!result.ok) return setError(result.error);
    toast(result.count === 1 ? 'Share recorded' : `${result.count} shares recorded`);
    onClose();
  }

  const selectable = people.filter((p) => !taken.has(p.id));

  return (
    <FormShell title="Split this expense" formId="split-form" submitLabel="Save shares" error={error} onClose={onClose} onSubmit={submit}>
      <div className="rounded-card bg-canvas px-4 py-4">
        <p className="truncate text-sm font-semibold text-ink-2">{expense.description || 'Expense'}</p>
        <p className="money mt-1 text-[28px] font-extrabold leading-tight tracking-tight text-ink">{money(expense.amount)}</p>
        {already > 0 && (
          <p className="mt-1 text-[13px] text-ink-3">
            {money(already)} is already shared, so {money(available)} is left to split.
          </p>
        )}
      </div>

      <fieldset>
        <legend className="mb-2 text-[13px] font-semibold text-ink-2">Who shared it with you?</legend>
        {selectable.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {selectable.map((p) => {
              const active = chosen.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggle(p.id)}
                  className={cn(
                    'h-9 rounded-full border px-3.5 text-sm font-semibold transition-colors',
                    active ? 'border-ink bg-ink text-white' : 'border-line text-ink-2 hover:border-line-strong',
                  )}
                >
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex gap-2">
          <Input
            aria-label="Add someone new"
            value={newName}
            maxLength={40}
            placeholder="Add someone new"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addNew();
              }
            }}
          />
          <Button onClick={addNew} disabled={!newName.trim()}>
            Add
          </Button>
        </div>
      </fieldset>

      {chosen.length > 0 && (
        <fieldset>
          <legend className="mb-2 flex w-full items-center justify-between text-[13px] font-semibold text-ink-2">
            Shares
            {isCustom && (
              <button type="button" onClick={() => setCustom({})} className="font-bold text-accent hover:text-accent-strong">
                Split equally
              </button>
            )}
          </legend>
          <ul className="divide-y divide-line rounded-card border border-line">
            <li className="flex items-center gap-3 px-3.5 py-2.5">
              <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={includeMe}
                  onChange={(e) => {
                    setIncludeMe(e.target.checked);
                    setCustom({});
                  }}
                  className="size-4 accent-[var(--color-accent)]"
                />
                You
              </label>
              <span className={cn('money text-sm font-bold', yours < 0 ? 'text-negative' : 'text-ink')}>{money(Math.max(yours, 0))}</span>
            </li>
            {chosen.map((id, i) => {
              const person = state.people.find((p) => p.id === id);
              const value = shareOf(id, i);
              return (
                <li key={id} className="flex items-center gap-3 px-3.5 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{person?.name}</span>
                  <span className="text-sm text-ink-3">{currencySymbol(expense.currency)}</span>
                  <input
                    aria-label={`${person?.name ?? 'Their'} share`}
                    inputMode="decimal"
                    autoComplete="off"
                    value={isCustom ? (custom[id] ?? '') : moneyToInput(value)}
                    onChange={(e) => {
                      // Typing one amount fixes everyone's amounts where they are, so nothing shifts under the user.
                      const base = isCustom ? custom : Object.fromEntries(chosen.map((cid, ci) => [cid, moneyToInput(shareOf(cid, ci))]));
                      setCustom({ ...base, [id]: cleanAmount(e.target.value) });
                      setError(null);
                    }}
                    className="money h-9 w-28 rounded-control border border-line bg-surface px-2.5 text-right text-sm font-bold text-ink focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
                  />
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            Each person will owe you their share. When they pay you back it lowers this expense; it is never counted as income.
          </p>
        </fieldset>
      )}
    </FormShell>
  );
}
