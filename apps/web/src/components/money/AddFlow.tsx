import { parseCapture } from '@finken/domain/capture';
import { formatDay, formatFullDate } from '@finken/domain/dates';
import { formatMoney } from '@finken/domain/format';
import { isPrincipal, obligationPosition, refundedAmount, sharedAmount, transactionLabel } from '@finken/domain/money';
import { frequencyLabel } from '@finken/domain/planning';
import type { ID, Transaction, TransactionType } from '@finken/domain/types';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Copy,
  FileInput,
  FileOutput,
  HandCoins,
  Handshake,
  type LucideIcon,
  Pencil,
  RotateCcw,
  Sparkles,
  Split,
  Trash2,
  Truck,
} from 'lucide-react';
import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { useAppState } from '../../data/hooks';
import { store, VIEW_ONLY } from '../../data/store';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { ConfirmDialog, Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { LoanForm, ReceivePayForm } from './OwedForms';
import { ObligationEditor, SplitForm } from './OwedSheets';
import { TransactionAmount, TransactionIcon, transactionMeta, transactionTitle } from './parts';
import { type FormRequest, TransactionForm } from './TransactionForm';

interface AddFlow {
  /** Opens the quick-action menu. */
  openMenu: () => void;
  openForm: (type: TransactionType) => void;
  openDetail: (id: ID) => void;
  /** False in a Space shared with the person to view only: adding is explained instead of opened. */
  canAdd: boolean;
}

const AddFlowContext = createContext<AddFlow>({ openMenu: () => {}, openForm: () => {}, openDetail: () => {}, canAdd: true });

export function useAddFlow(): AddFlow {
  return useContext(AddFlowContext);
}

interface Action {
  key: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  tone: string;
  type?: TransactionType;
  owed?: OwedForm;
}

type OwedForm = 'receive-pay' | 'loan' | 'customer' | 'supplier' | 'invoice' | 'bill';

const ACTIONS: Action[] = [
  { key: 'expense', label: 'Expense', hint: 'Money you spent', icon: ArrowUpRight, tone: 'bg-negative-soft text-negative', type: 'expense' },
  { key: 'income', label: 'Income', hint: 'Money you received', icon: ArrowDownLeft, tone: 'bg-positive-soft text-positive', type: 'income' },
  { key: 'transfer', label: 'Transfer', hint: 'Move money between accounts', icon: ArrowLeftRight, tone: 'bg-accent-soft text-accent-strong', type: 'transfer' },
  { key: 'receive-pay', label: 'Receive / Pay', hint: 'Money from or to a person', icon: Handshake, tone: 'bg-warning-soft text-warning', owed: 'receive-pay' },
  { key: 'loan', label: 'Loan', hint: 'Money borrowed or lent', icon: HandCoins, tone: 'bg-sunken text-ink-2', owed: 'loan' },
];

/** The same records, in the words a business uses. */
const BUSINESS_ACTIONS: Action[] = [
  { key: 'income', label: 'Sale or income', hint: 'Money from a sale or other business income', icon: ArrowDownLeft, tone: 'bg-positive-soft text-positive', type: 'income' },
  { key: 'expense', label: 'Business expense', hint: 'Running costs and purchases', icon: ArrowUpRight, tone: 'bg-negative-soft text-negative', type: 'expense' },
  {
    key: 'customer',
    label: 'Customer payment',
    hint: 'Money from a customer, including invoice payments',
    icon: Handshake,
    tone: 'bg-positive-soft text-positive',
    owed: 'customer',
  },
  { key: 'supplier', label: 'Supplier payment', hint: 'Money to a supplier, including bills', icon: Truck, tone: 'bg-warning-soft text-warning', owed: 'supplier' },
  { key: 'invoice', label: 'Unpaid invoice', hint: 'A customer owes you; nothing is received yet', icon: FileInput, tone: 'bg-accent-soft text-accent-strong', owed: 'invoice' },
  { key: 'bill', label: 'Unpaid supplier bill', hint: 'You owe a supplier; nothing is paid yet', icon: FileOutput, tone: 'bg-sunken text-ink-2', owed: 'bill' },
  { key: 'transfer', label: 'Transfer', hint: 'Move money between accounts', icon: ArrowLeftRight, tone: 'bg-accent-soft text-accent-strong', type: 'transfer' },
  { key: 'loan', label: 'Loan', hint: 'Money borrowed or lent', icon: HandCoins, tone: 'bg-sunken text-ink-2', owed: 'loan' },
];

/** "Type it" box: reads a sentence and opens the form pre-filled for the user to confirm. */
function CaptureBox({ onCapture }: { onCapture: (text: string) => void }) {
  const [text, setText] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) onCapture(text.trim());
  }
  return (
    <form onSubmit={submit} className="mb-3">
      <label htmlFor="capture" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink-2">
        <Sparkles aria-hidden className="size-3.5 text-accent" />
        Or just type it
      </label>
      <div className="flex gap-2">
        <input
          id="capture"
          value={text}
          maxLength={160}
          autoComplete="off"
          enterKeyHint="go"
          onChange={(e) => setText(e.target.value)}
          placeholder="Spent Rs. 850 on dinner yesterday"
          className="h-11 min-w-0 flex-1 rounded-control border border-line bg-surface px-3.5 text-[15px] text-ink placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
        />
        <Button type="submit" variant="primary" aria-label="Read this and open the form" disabled={!text.trim()} className="px-3.5">
          <ArrowRight className="size-4" />
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-ink-3">Finken fills in the form for you to check. Nothing is saved until you confirm.</p>
    </form>
  );
}

/** Owns the global Add menu, the transaction form and the transaction detail sheet. */
export function AddFlowProvider({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [form, setForm] = useState<FormRequest | null>(null);
  const [owedForm, setOwedForm] = useState<OwedForm | null>(null);
  const [detailId, setDetailId] = useState<ID | null>(null);
  const [formKey, setFormKey] = useState(0);
  const { spaces, activeSpaceId, roles } = useAppState();
  const isBusiness = spaces.find((sp) => sp.id === activeSpaceId)?.type === 'business';
  const actions = isBusiness ? BUSINESS_ACTIONS : ACTIONS;
  const canAdd = roles[activeSpaceId ?? ''] !== 'viewer';
  const toast = useToast();

  /** Reads a typed sentence against the active Space and opens the confirmation form. */
  function capture(text: string) {
    const { activeSpaceId, categories, accounts } = store.getState();
    const result = parseCapture(text, {
      categories: categories.filter((c) => c.spaceId === activeSpaceId),
      accounts: accounts.filter((a) => a.spaceId === activeSpaceId),
    });
    setMenuOpen(false);
    setFormKey((k) => k + 1);
    setForm({ type: result.type, capture: result });
  }

  // In a view-only Space every way in to adding says why, rather than opening a form that cannot save.
  const openMenu = useCallback(() => (canAdd ? setMenuOpen(true) : toast(VIEW_ONLY, { tone: 'error' })), [canAdd, toast]);
  const openForm = useCallback(
    (type: TransactionType) => {
      setMenuOpen(false);
      if (!canAdd) return toast(VIEW_ONLY, { tone: 'error' });
      setForm({ type });
    },
    [canAdd, toast],
  );
  const openDetail = useCallback((id: ID) => setDetailId(id), []);
  const value = useMemo(() => ({ openMenu, openForm, openDetail, canAdd }), [openMenu, openForm, openDetail, canAdd]);

  return (
    <AddFlowContext.Provider value={value}>
      {children}

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title="Add" description="What would you like to record?" size="sm">
        <CaptureBox onCapture={capture} />
        <ul className="-mx-2 space-y-1 border-t border-line pb-1 pt-2">
          {actions.map((action) => {
            return (
              <li key={action.key}>
                <button
                  type="button"
                  onClick={() => {
                    if (action.type) return openForm(action.type);
                    setMenuOpen(false);
                    setOwedForm(action.owed ?? null);
                  }}
                  className="flex w-full items-center gap-3.5 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-canvas"
                >
                  <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', action.tone)}>
                    <action.icon aria-hidden className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-bold text-ink">{action.label}</span>
                    <span className="block text-[13px] text-ink-3">{action.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Modal>

      {/* Keyed so each request starts with a clean form. */}
      {form && <TransactionForm key={form.edit?.id ?? form.copyFrom?.id ?? form.refundOf?.id ?? `${form.type}-${formKey}`} request={form} onClose={() => setForm(null)} />}
      {owedForm === 'receive-pay' && <ReceivePayForm onClose={() => setOwedForm(null)} />}
      {owedForm === 'loan' && <LoanForm onClose={() => setOwedForm(null)} />}
      {owedForm === 'customer' && <ReceivePayForm direction="received" onClose={() => setOwedForm(null)} />}
      {owedForm === 'supplier' && <ReceivePayForm direction="paid" onClose={() => setOwedForm(null)} />}
      {owedForm === 'invoice' && <ObligationEditor kind="receivable" onClose={() => setOwedForm(null)} />}
      {owedForm === 'bill' && <ObligationEditor kind="payable" onClose={() => setOwedForm(null)} />}

      <TransactionDetail
        key={detailId ?? 'none'}
        id={detailId}
        onClose={() => setDetailId(null)}
        onEdit={(t) => {
          setDetailId(null);
          setForm({ type: t.type, edit: t });
        }}
        onDuplicate={(t) => {
          setDetailId(null);
          setForm({ type: t.type, copyFrom: t });
        }}
        onRefund={(t) => {
          setDetailId(null);
          setForm({ type: 'refund', refundOf: t });
        }}
        onOpen={setDetailId}
      />
    </AddFlowContext.Provider>
  );
}

interface TransactionDetailProps {
  id: ID | null;
  onClose: () => void;
  onEdit: (t: Transaction) => void;
  onDuplicate: (t: Transaction) => void;
  onRefund: (t: Transaction) => void;
  onOpen: (id: ID) => void;
}

function TransactionDetail({ id, onClose, onEdit, onDuplicate, onRefund, onOpen }: TransactionDetailProps) {
  const state = useAppState();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [splitting, setSplitting] = useState(false);
  const transaction = state.transactions.find((t) => t.id === id);
  if (!transaction) return null;

  const category = state.categories.find((c) => c.id === transaction.categoryId);
  const accounts = state.accounts.filter((a) => a.spaceId === transaction.spaceId);
  const space = state.spaces.find((s) => s.id === transaction.spaceId);
  const recurring = state.recurring.find((r) => r.id === transaction.recurringId);
  const obligation = state.obligations.find((o) => o.id === transaction.obligationId);
  const person = state.people.find((pp) => pp.id === (transaction.personId ?? obligation?.personId));
  const original = state.transactions.find((t) => t.id === transaction.refundOfId);
  const refunds = state.transactions.filter((t) => t.type === 'refund' && t.refundOfId === transaction.id);
  const refunded = refundedAmount(transaction.id, state.transactions);
  const fixedType = transaction.type === 'refund' || isPrincipal(transaction.type);
  const blocker = store.deleteBlocker(transaction.id);
  const money = (n: number) => formatMoney(n, transaction.currency);
  const shares = state.obligations.filter((o) => o.sourceTransactionId === transaction.id && o.status !== 'cancelled');
  const shared = sharedAmount(transaction.id, state.obligations);

  const rows: [string, string][] = [
    ['Type', transactionLabel(transaction, accounts, obligation)],
    ['Date', formatFullDate(transaction.date)],
    [transaction.type === 'transfer' ? 'Accounts' : 'Details', transactionMeta(transaction, category, accounts)],
    ['Space', space?.name ?? '—'],
  ];
  if (person) rows.push([transaction.type === 'expense' || transaction.type === 'principal_out' ? 'Paid to' : 'From', person.name]);
  if (obligation) {
    const position = obligationPosition(obligation, state.transactions);
    rows.push(['Part of', obligation.title]);
    rows.push(['Still outstanding', position.state === 'cancelled' ? 'Written off' : money(position.outstanding)]);
  }
  if (recurring) rows.push(['Linked to', `${recurring.name} (${frequencyLabel(recurring).toLowerCase()})`]);
  if (refunded > 0) rows.push(['Refunded', `${money(refunded)} of ${money(transaction.amount)}`]);

  function saveNote() {
    if (note === null) return;
    const result = store.setTransactionNotes(transaction!.id, note);
    if (result.ok) toast(note.trim() ? 'Note saved' : 'Note removed');
    else toast(result.error, { tone: 'error' });
    setNote(null);
  }

  function remove() {
    const removed = store.deleteTransaction(transaction!.id);
    setConfirming(false);
    onClose();
    if (removed) toast('Transaction deleted', { action: { label: 'Undo', onClick: () => store.restoreTransaction(removed) } });
  }

  return (
    <>
      <Modal
        open={!confirming && !splitting}
        onClose={onClose}
        title="Transaction"
        footer={
          <div className="flex gap-2">
            <Button block variant="primary" icon={<Pencil className="size-4" />} onClick={() => onEdit(transaction)}>
              Edit
            </Button>
            {!fixedType && (
              <Button block icon={<Copy className="size-4" />} onClick={() => onDuplicate(transaction)}>
                Duplicate
              </Button>
            )}
            <Button aria-label="Delete transaction" title="Delete" className="px-3.5 text-negative" onClick={() => setConfirming(true)}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center rounded-card bg-canvas px-4 py-6 text-center">
          <TransactionIcon transaction={transaction} category={category} />
          <TransactionAmount transaction={transaction} currency={transaction.currency} className="mt-3 text-[32px] font-extrabold leading-tight" />
          <p className="mt-1 text-[15px] font-semibold text-ink-2">{transactionTitle(transaction, category, accounts)}</p>
        </div>
        <dl className="mt-4 divide-y divide-line">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-6 py-3 text-sm">
              <dt className="shrink-0 text-ink-3">{label}</dt>
              <dd className="text-right font-semibold text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="border-t border-line py-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-ink-3">Notes</span>
            {note === null && (
              <button type="button" onClick={() => setNote(transaction.notes ?? '')} className="font-bold text-accent hover:text-accent-strong">
                {transaction.notes ? 'Edit note' : 'Add a note'}
              </button>
            )}
          </div>
          {note === null ? (
            transaction.notes && <p className="mt-1.5 whitespace-pre-wrap font-semibold leading-relaxed text-ink">{transaction.notes}</p>
          ) : (
            <div className="mt-2">
              <textarea
                aria-label="Note"
                // biome-ignore lint/a11y/noAutofocus: the note step exists only to type a note
                autoFocus
                value={note}
                maxLength={400}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything worth remembering about this"
                className="min-h-20 w-full resize-y rounded-control border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" onClick={() => setNote(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={saveNote}>
                  Save note
                </Button>
              </div>
            </div>
          )}
        </div>

        {(original || refunds.length > 0) && (
          <div className="border-t border-line pt-3">
            <p className="text-[13px] font-semibold text-ink-3">{original ? 'Refund of' : refunds.length === 1 ? 'Refund' : 'Refunds'}</p>
            <ul className="mt-1">
              {(original ? [original] : refunds).map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(t.id)}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-4 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-canvas"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-ink">{t.description || transactionLabel(t)}</span>
                      <span className="block text-[13px] text-ink-3">{formatDay(t.date)}</span>
                    </span>
                    <span className="money shrink-0 font-bold text-ink">{money(t.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {shares.length > 0 && (
          <div className="border-t border-line pt-3">
            <p className="text-[13px] font-semibold text-ink-3">Shared with</p>
            <ul className="mt-1.5 space-y-1.5 text-sm">
              {shares.map((o) => {
                const position = obligationPosition(o, state.transactions);
                return (
                  <li key={o.id} className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate font-semibold text-ink">{state.people.find((pp) => pp.id === o.personId)?.name ?? 'Someone'}</span>
                    <span className="money shrink-0 text-ink-2">
                      {money(o.amount)}
                      <span className="text-ink-3"> · {position.outstanding > 0 ? `${money(position.outstanding)} remaining` : 'paid back'}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {transaction.type === 'expense' && (refunded < transaction.amount || shared < transaction.amount) && (
          <div className="mt-4 flex gap-2">
            {refunded < transaction.amount && (
              <Button block icon={<RotateCcw className="size-4" />} onClick={() => onRefund(transaction)}>
                Refund
              </Button>
            )}
            {shared < transaction.amount && (
              <Button block icon={<Split className="size-4" />} onClick={() => setSplitting(true)}>
                Split
              </Button>
            )}
          </div>
        )}
      </Modal>
      {splitting && <SplitForm expense={transaction} onClose={() => setSplitting(false)} />}
      <ConfirmDialog
        open={confirming}
        title={blocker ? 'This cannot be deleted yet' : 'Delete this transaction?'}
        message={blocker ?? 'Your balances and totals will update straight away. You can undo this for a few seconds afterwards.'}
        confirmLabel={blocker ? 'OK' : 'Delete'}
        destructive={!blocker}
        onConfirm={blocker ? () => setConfirming(false) : remove}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
