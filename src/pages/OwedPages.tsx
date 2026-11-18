import { HandCoins, Mail, Pencil, Phone, Plus, Trash2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { LoanForm } from '../components/money/OwedForms';
import { KIND_WORDS, ObligationEditor, ObligationSheet, PersonEditor } from '../components/money/OwedSheets';
import { TransactionItem } from '../components/money/parts';
import { Button, IconButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Badge, EmptyState, PageHeader, ProgressBar, Segmented } from '../components/ui/Misc';
import { ConfirmDialog } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useSpaceData } from '../data/hooks';
import { store } from '../data/store';
import { formatDay, formatDueLabel, formatRelativeDay } from '../domain/dates';
import { formatMoney } from '../domain/format';
import { obligationPosition, obligationStatus, personHistory, personSummaries, type ObligationPosition, type PersonSummary } from '../domain/money';
import type { ID, ObligationKind, Person } from '../domain/types';
import { BackLink } from './MoneyPages';
import { ROLE_LABEL } from '../domain/business';

/** "Owes you Rs. 8,500", "You owe Rs. 5,000" or "Settled". */
function netPhrase(summary: Pick<PersonSummary, 'net' | 'hasHistory'>, currency: string): { text: string; tone: string } {
  if (summary.net > 0) return { text: `Owes you ${formatMoney(summary.net, currency)}`, tone: 'text-positive' };
  if (summary.net < 0) return { text: `You owe ${formatMoney(-summary.net, currency)}`, tone: 'text-ink' };
  return { text: summary.hasHistory ? 'Settled' : 'Nothing recorded', tone: 'text-ink-3' };
}

function Initial({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-strong">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

function Totals({ items }: { items: [label: string, value: string, tone?: string][] }) {
  return (
    <div className={cn('grid gap-3', items.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2')}>
      {items.map(([label, value, tone]) => (
        <Card key={label} className="min-w-0 !p-5">
          <p className="text-[13px] font-semibold text-ink-3">{label}</p>
          <p className={cn('money mt-1.5 truncate text-2xl font-extrabold tracking-tight', tone ?? 'text-ink')}>{value}</p>
        </Card>
      ))}
    </div>
  );
}

// ── Obligation rows ────────────────────────────────────────────────────────

interface RowProps {
  position: ObligationPosition;
  person?: Person;
  currency: string;
  /** Hide the person's name when the list already belongs to one person. */
  showPerson?: boolean;
  onOpen: (id: ID) => void;
}

function ObligationRow({ position, person, currency, showPerson = true, onOpen }: RowProps) {
  const { obligation: o, outstanding, settled, state, nextDue } = position;
  const status = obligationStatus(position);
  const words = KIND_WORDS[o.kind];
  return (
    <li>
      <button type="button" onClick={() => onOpen(o.id)} className="-mx-2 block w-[calc(100%+1rem)] rounded-xl px-2 py-3 text-left transition-colors hover:bg-canvas">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1 basis-44">
            <span className="block truncate text-[15px] font-semibold text-ink">{showPerson ? (person?.name ?? o.title) : o.title}</span>
            <span className="block truncate text-[13px] text-ink-3">
              {showPerson ? o.title : words.noun}
              {state === 'open' && nextDue ? ` · ${formatDueLabel(nextDue)}` : ''}
            </span>
          </span>
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="ml-auto text-right">
            <span className="money block text-[15px] font-bold text-ink">{formatMoney(state === 'open' ? outstanding : o.amount, currency)}</span>
            {state === 'open' && settled > 0 && <span className="money block text-xs text-ink-3">of {formatMoney(o.amount, currency)}</span>}
          </span>
        </span>
        {state === 'open' && settled > 0 && <ProgressBar value={settled / o.amount} label={`${words.done} so far`} className="mt-2.5" />}
      </button>
    </li>
  );
}

// ── Receivables, payables and loans ────────────────────────────────────────

type Section = 'receivables' | 'payables' | 'loans';

const SECTIONS: Record<Section, { title: string; subtitle: string; kinds: ObligationKind[]; add: string; empty: string }> = {
  receivables: {
    title: 'To receive',
    subtitle: 'Money other people owe you',
    kinds: ['receivable'],
    add: 'Money to receive',
    empty: 'When someone owes you for work, a sale or their share of a bill, add it here to keep track.',
  },
  payables: {
    title: 'To pay',
    subtitle: 'Money you still need to pay',
    kinds: ['payable'],
    add: 'Money to pay',
    empty: 'When you owe a supplier or a person for something you have not paid yet, add it here.',
  },
  loans: {
    title: 'Loans',
    subtitle: 'Money borrowed and lent, with repayments',
    kinds: ['borrowed', 'lent'],
    add: 'New loan',
    empty: 'Record money you borrow or lend, and Finken will track what is repaid and what remains.',
  },
};

type Show = 'open' | 'closed';

export function ObligationsPage({ section }: { section: Section }) {
  const { space, currency, obligations, transactions, people } = useSpaceData();
  const meta = SECTIONS[section];
  const [show, setShow] = useState<Show>('open');
  const [openId, setOpenId] = useState<ID | null>(null);
  const [adding, setAdding] = useState(false);

  const positions = useMemo(
    () =>
      obligations
        .filter((o) => meta.kinds.includes(o.kind))
        .map((o) => obligationPosition(o, transactions))
        .sort((a, b) => (a.nextDue ?? '9999').localeCompare(b.nextDue ?? '9999') || b.obligation.date.localeCompare(a.obligation.date)),
    [obligations, transactions, meta],
  );
  if (!space) return null;

  const open = positions.filter((p) => p.state === 'open');
  const closed = positions.filter((p) => p.state !== 'open');
  const list = show === 'open' ? open : closed;
  const sum = (items: ObligationPosition[], kind?: ObligationKind) => items.reduce((total, p) => (!kind || p.obligation.kind === kind ? total + p.outstanding : total), 0);
  const overdue = open.filter((p) => p.overdue);
  const money = (n: number) => formatMoney(n, currency);
  const personById = new Map(people.map((p) => [p.id, p]));

  const totals: [string, string, string?][] =
    section === 'loans'
      ? [
          ['You still owe', money(sum(open, 'borrowed'))],
          ['Still owed to you', money(sum(open, 'lent')), 'text-positive'],
          ['Overdue', money(sum(overdue)), overdue.length ? 'text-negative' : undefined],
        ]
      : [
          [section === 'receivables' ? 'Still to receive' : 'Still to pay', money(sum(open)), section === 'receivables' ? 'text-positive' : undefined],
          ['Overdue', money(sum(overdue)), overdue.length ? 'text-negative' : undefined],
        ];

  const groups: { key: string; title: string; items: ObligationPosition[] }[] =
    section === 'loans'
      ? [
          { key: 'borrowed', title: 'You borrowed', items: list.filter((p) => p.obligation.kind === 'borrowed') },
          { key: 'lent', title: 'You lent', items: list.filter((p) => p.obligation.kind === 'lent') },
        ]
      : [{ key: 'all', title: show === 'open' ? 'Outstanding' : 'Settled and written off', items: list }];

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title={meta.title}
        subtitle={`${meta.subtitle} in ${space.name}`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            {meta.add}
          </Button>
        }
      />

      <Totals items={totals} />

      <div className="mt-5">
        <Segmented
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: 'open', label: `Outstanding (${open.length})` },
            { value: 'closed', label: `Settled (${closed.length})` },
          ]}
        />
      </div>

      <div className="mt-3 space-y-4">
        {list.length === 0 ? (
          <Card>
            <EmptyState
              icon={HandCoins}
              title={show === 'open' ? (positions.length === 0 ? 'Nothing here yet' : 'All settled') : 'Nothing settled yet'}
              message={show === 'open' && positions.length === 0 ? meta.empty : show === 'open' ? 'Nothing is outstanding right now.' : 'Settled and written-off items will appear here.'}
              action={
                show === 'open' ? (
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                    {meta.add}
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Card key={g.key}>
                <CardHeader title={g.title} subtitle={`${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}`} />
                <ul className="divide-y divide-line">
                  {g.items.map((p) => (
                    <ObligationRow key={p.obligation.id} position={p} person={personById.get(p.obligation.personId)} currency={currency} onOpen={setOpenId} />
                  ))}
                </ul>
              </Card>
            ))
        )}
      </div>

      <ObligationSheet key={openId ?? 'none'} id={openId} onClose={() => setOpenId(null)} />
      {adding && (section === 'loans' ? <LoanForm onClose={() => setAdding(false)} /> : <ObligationEditor kind={section === 'receivables' ? 'receivable' : 'payable'} onClose={() => setAdding(false)} />)}
    </div>
  );
}

// ── People ─────────────────────────────────────────────────────────────────

export function PeoplePage() {
  const { space, currency, people, obligations, transactions } = useSpaceData();
  const [adding, setAdding] = useState(false);
  const summaries = useMemo(() => personSummaries(people, obligations, transactions), [people, obligations, transactions]);
  if (!space) return null;
  const owesYou = summaries.reduce((sum, s) => sum + s.owesYou, 0);
  const youOwe = summaries.reduce((sum, s) => sum + s.youOwe, 0);
  const net = owesYou - youOwe;

  return (
    <div>
      <BackLink to="/money">Money</BackLink>
      <PageHeader
        title="People"
        subtitle={`Who owes you, and who you owe, in ${space.name}`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            New person
          </Button>
        }
      />

      <Totals
        items={[
          ['Owed to you', formatMoney(owesYou, currency), 'text-positive'],
          ['You owe', formatMoney(youOwe, currency)],
          [net >= 0 ? 'Overall, you are owed' : 'Overall, you owe', formatMoney(Math.abs(net), currency)],
        ]}
      />

      <Card className="mt-5">
        {summaries.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No people yet"
            message="Add friends, family, customers or suppliers to keep track of money between you."
            action={
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                New person
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {summaries.map((s) => {
              const phrase = netPhrase(s, currency);
              return (
                <li key={s.person.id}>
                  <Link to={`/money/people/${encodeURIComponent(s.person.id)}`} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-canvas">
                    <Initial name={s.person.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-ink">{s.person.name}</span>
                      <span className="block truncate text-[13px] text-ink-3">
                        {s.open.length > 0 ? `${s.open.length} open ${s.open.length === 1 ? 'item' : 'items'}` : s.person.notes || 'Nothing outstanding'}
                      </span>
                    </span>
                    <span className={cn('money shrink-0 text-right text-sm font-bold', phrase.tone)}>{phrase.text}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {adding && <PersonEditor person={null} spaceId={space.id} onClose={() => setAdding(false)} />}
    </div>
  );
}

type PersonAction = 'receivable' | 'payable' | 'loan' | 'edit' | 'delete' | null;

export function PersonPage() {
  const { personId } = useParams();
  const { space, currency, people, obligations, transactions, categories, accounts } = useSpaceData();
  const { openDetail } = useAddFlow();
  const navigate = useNavigate();
  const toast = useToast();
  const [action, setAction] = useState<PersonAction>(null);
  const [openId, setOpenId] = useState<ID | null>(null);

  const person = people.find((p) => p.id === personId);
  const summary = useMemo(() => (person ? personSummaries([person], obligations, transactions)[0] : null), [person, obligations, transactions]);
  const all = useMemo(
    () => (person ? obligations.filter((o) => o.personId === person.id).map((o) => obligationPosition(o, transactions)) : []),
    [person, obligations, transactions],
  );
  const history = useMemo(() => (person ? personHistory(person.id, obligations, transactions) : []), [person, obligations, transactions]);
  if (!space) return null;
  // Someone from another Space, or who no longer exists.
  if (!person || !summary) return <Navigate to="/money/people" replace />;

  const phrase = netPhrase(summary, currency);
  const open = all.filter((p) => p.state === 'open');
  const closed = all.filter((p) => p.state !== 'open');
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const canDelete = !summary.hasHistory;

  function remove() {
    const result = store.deletePerson(person!.id);
    setAction(null);
    if (!result.ok) return toast(result.error, { tone: 'error' });
    toast(`${person!.name} removed`);
    navigate('/money/people', { replace: true });
  }

  return (
    <div>
      {space.type === 'business' ? <BackLink to="/business?tab=contacts">Customers and suppliers</BackLink> : <BackLink to="/money/people">People</BackLink>}
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Initial name={person.name} />
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="flex min-w-0 items-center gap-2.5 text-2xl font-extrabold tracking-tight text-ink sm:text-[28px]">
            <span className="truncate">{person.name}</span>
            {person.role && <Badge tone={person.role === 'customer' ? 'positive' : 'neutral'}>{ROLE_LABEL[person.role]}</Badge>}
          </h1>
          <p className={cn('money mt-0.5 text-[15px] font-bold', phrase.tone)}>{phrase.text}</p>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={`Edit ${person.name}`} onClick={() => setAction('edit')}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton
            label={canDelete ? `Remove ${person.name}` : 'People with records cannot be removed'}
            disabled={!canDelete}
            onClick={() => setAction('delete')}
            className="hover:bg-negative-soft hover:text-negative"
          >
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </header>

      <Totals
        items={[
          ['Owes you', formatMoney(summary.owesYou, currency), 'text-positive'],
          ['You owe', formatMoney(summary.youOwe, currency)],
          [summary.net >= 0 ? 'Overall, owes you' : 'Overall, you owe', formatMoney(Math.abs(summary.net), currency)],
        ]}
      />

      <div className="mt-5 grid gap-4 xl:grid-cols-3 [&>*]:min-w-0">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title="Outstanding" subtitle={open.length === 0 ? 'Nothing is outstanding' : `${open.length} ${open.length === 1 ? 'item' : 'items'}`} />
            {open.length > 0 && (
              <ul className="divide-y divide-line">
                {open.map((p) => (
                  <ObligationRow key={p.obligation.id} position={p} currency={currency} showPerson={false} onOpen={setOpenId} />
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAction('receivable')}>
                They owe me
              </Button>
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAction('payable')}>
                I owe them
              </Button>
              <Button size="sm" icon={<HandCoins className="size-4" />} onClick={() => setAction('loan')}>
                Loan
              </Button>
            </div>
          </Card>

          {closed.length > 0 && (
            <Card>
              <CardHeader title="Settled" subtitle={`${closed.length} ${closed.length === 1 ? 'item' : 'items'}`} />
              <ul className="divide-y divide-line">
                {closed.map((p) => (
                  <ObligationRow key={p.obligation.id} position={p} currency={currency} showPerson={false} onOpen={setOpenId} />
                ))}
              </ul>
            </Card>
          )}

          <Card padded={false} className="p-5 sm:p-6">
            <CardHeader title="History" subtitle={history.length === 0 ? 'No money recorded yet' : `${history.length} ${history.length === 1 ? 'transaction' : 'transactions'}`} />
            {history.length > 0 && (
              <ul className="-mx-2">
                {history.map((t) => (
                  <li key={t.id}>
                    <TransactionItem
                      transaction={t}
                      category={categoryById.get(t.categoryId ?? '')}
                      accounts={accounts}
                      currency={currency}
                      trailing={formatRelativeDay(t.date)}
                      onClick={() => openDetail(t.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader title="Details" />
          <dl className="space-y-3 text-sm">
            <div className="flex items-center gap-3">
              <Phone aria-hidden className="size-4 shrink-0 text-ink-3" />
              <dt className="sr-only">Phone</dt>
              <dd className="min-w-0 truncate font-semibold text-ink">
                {person.phone ? <a href={`tel:${person.phone.replace(/[^\d+]/g, '')}`} className="hover:text-accent">{person.phone}</a> : <span className="font-normal text-ink-3">No phone number</span>}
              </dd>
            </div>
            <div className="flex items-center gap-3">
              <Mail aria-hidden className="size-4 shrink-0 text-ink-3" />
              <dt className="sr-only">Email</dt>
              <dd className="min-w-0 truncate font-semibold text-ink">
                {person.email ? <a href={`mailto:${person.email}`} className="hover:text-accent">{person.email}</a> : <span className="font-normal text-ink-3">No email address</span>}
              </dd>
            </div>
          </dl>
          <p className="mt-4 whitespace-pre-wrap border-t border-line pt-4 text-sm leading-relaxed text-ink-2">{person.notes || <span className="text-ink-3">No notes.</span>}</p>
          <p className="mt-3 text-xs text-ink-3">Added {formatDay(person.createdAt.slice(0, 10))}</p>
        </Card>
      </div>

      <ObligationSheet key={openId ?? 'none'} id={openId} onClose={() => setOpenId(null)} />
      {(action === 'receivable' || action === 'payable') && <ObligationEditor kind={action} personId={person.id} onClose={() => setAction(null)} />}
      {action === 'loan' && <LoanForm personId={person.id} onClose={() => setAction(null)} />}
      {action === 'edit' && <PersonEditor person={person} spaceId={space.id} onClose={() => setAction(null)} />}
      <ConfirmDialog
        open={action === 'delete'}
        title={`Remove ${person.name}?`}
        message="There are no records with this person, so nothing else changes. This cannot be undone."
        confirmLabel="Remove"
        destructive
        onConfirm={remove}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}
