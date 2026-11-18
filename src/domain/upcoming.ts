/**
 * Coming up: every expected money event in one list.
 *
 * Two kinds of record produce expected events:
 *  - Recurring items (salary, rent, bills, subscriptions, instalments).
 *  - Money owed: receivables, payables and loans that still have a balance.
 *
 * Rules that keep the numbers honest:
 *  - Only what is still outstanding is expected. Settled or written-off
 *    obligations, and finished or stopped recurring items, add nothing.
 *  - An obligation paid by a recurring item appears once, through that
 *    recurring item, never a second time on its own.
 *  - Repayments stop at the outstanding balance, so a loan never shows
 *    more instalments than are left to pay.
 *  - These are expectations. Nothing here touches an account balance.
 */
import { addDays, diffDays, inRange, nextOccurrence, today } from './dates';
import { obligationPosition, openingType, owedToYouKind, sortByDateDesc } from './money';
import { nextRecurringDate } from './planning';
import type { DateRange, ID, ISODate, Obligation, ObligationKind, Recurring, Transaction } from './types';

export type EventDirection = 'in' | 'out';
export type EventKind = 'income' | 'bill' | 'instalment' | 'to-receive' | 'to-pay';
export type EventStatus = 'overdue' | 'due-soon' | 'upcoming';

/** How many days ahead counts as "due soon". */
export const DUE_SOON_DAYS = 7;

export interface ExpectedEvent {
  /** Stable across renders: source, record id and date. */
  key: string;
  source: 'recurring' | 'obligation';
  /** The recurring item or obligation this comes from. */
  sourceId: ID;
  spaceId: ID;
  title: string;
  amount: number;
  direction: EventDirection;
  kind: EventKind;
  date: ISODate;
  status: EventStatus;
  personId?: ID;
  categoryId?: ID;
  accountId?: ID;
  /** The money-owed record this pays down, when there is one. */
  obligationId?: ID;
  /**
   * Only the next occurrence of a record can be marked paid; later ones are
   * projections that move up once it is.
   */
  actionable: boolean;
  /** The reminder for this item is snoozed until this date. */
  snoozedUntil?: ISODate;
}

export interface UpcomingInput {
  recurring: Recurring[];
  obligations: Obligation[];
  transactions: Transaction[];
}

/** Safety limit on occurrences per record, so a daily item over a long range stays cheap. */
const MAX_OCCURRENCES = 400;

function statusFor(date: ISODate, anchor: ISODate): EventStatus {
  if (date < anchor) return 'overdue';
  return diffDays(anchor, date) <= DUE_SOON_DAYS ? 'due-soon' : 'upcoming';
}

const KIND_FOR_OBLIGATION: Record<ObligationKind, EventKind> = {
  receivable: 'to-receive',
  payable: 'to-pay',
  lent: 'instalment',
  borrowed: 'instalment',
};

/**
 * Every expected event up to `range.to`. Overdue events are always included,
 * whatever `range.from` is, because they still need dealing with.
 */
export function expectedEvents(input: UpcomingInput, range: DateRange, anchor: ISODate = today()): ExpectedEvent[] {
  const events: ExpectedEvent[] = [];
  const keep = (date: ISODate) => date <= range.to && (date >= range.from || date < anchor);
  const positions = new Map(input.obligations.map((o) => [o.id, obligationPosition(o, input.transactions, anchor)]));
  // Obligations covered by an active recurring item are shown through that item only.
  const coveredByRecurring = new Set(input.recurring.filter((r) => r.status === 'active' && r.obligationId).map((r) => r.obligationId!));

  for (const r of input.recurring) {
    if (r.status !== 'active') continue;
    const linked = r.obligationId ? positions.get(r.obligationId) : undefined;
    // A repayment plan for something already settled expects nothing more.
    if (r.obligationId && (!linked || linked.state !== 'open')) continue;
    let left = linked ? linked.outstanding : Infinity;
    let date = r.nextDueDate;
    for (let i = 0; i < MAX_OCCURRENCES && date <= range.to && left > 0; i++) {
      if (r.endDate && date > r.endDate) break;
      const amount = Math.min(r.amount, left);
      left -= amount;
      if (keep(date)) {
        events.push({
          key: `r:${r.id}:${date}`,
          source: 'recurring',
          sourceId: r.id,
          spaceId: r.spaceId,
          title: r.name,
          amount,
          direction: r.type === 'income' ? 'in' : 'out',
          kind: linked ? KIND_FOR_OBLIGATION[linked.obligation.kind] : r.type === 'income' ? 'income' : 'bill',
          date,
          status: statusFor(date, anchor),
          personId: linked?.obligation.personId,
          categoryId: r.categoryId,
          accountId: r.accountId,
          obligationId: r.obligationId,
          actionable: i === 0,
          snoozedUntil: i === 0 ? r.snoozedUntil : undefined,
        });
      }
      date = nextRecurringDate(r, date);
    }
  }

  for (const o of input.obligations) {
    const p = positions.get(o.id)!;
    if (p.state !== 'open' || !p.nextDue || coveredByRecurring.has(o.id)) continue;
    const direction: EventDirection = owedToYouKind(o.kind) ? 'in' : 'out';
    const instalments = Boolean(o.instalmentAmount && o.instalmentFrequency);
    let left = p.outstanding;
    let date = p.nextDue;
    for (let i = 0; i < MAX_OCCURRENCES && date <= range.to && left > 0; i++) {
      // On the final date everything still owed is due.
      const final = !instalments || (o.dueDate !== undefined && date >= o.dueDate);
      const amount = final ? left : Math.min(o.instalmentAmount!, left);
      left -= amount;
      if (keep(date)) {
        events.push({
          key: `o:${o.id}:${date}`,
          source: 'obligation',
          sourceId: o.id,
          spaceId: o.spaceId,
          title: o.title,
          amount,
          direction,
          kind: KIND_FOR_OBLIGATION[o.kind],
          date,
          status: statusFor(date, anchor),
          personId: o.personId,
          obligationId: o.id,
          actionable: i === 0,
          snoozedUntil: i === 0 ? o.snoozedUntil : undefined,
        });
      }
      if (final) break;
      let next = nextOccurrence(date, o.instalmentFrequency!);
      if (o.dueDate && next > o.dueDate) next = o.dueDate;
      date = next;
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount || a.key.localeCompare(b.key));
}

/** Open obligations with no due date: real, but they cannot be placed on a calendar. */
export function undatedOwed(input: UpcomingInput, anchor: ISODate = today()) {
  const covered = new Set(input.recurring.filter((r) => r.status === 'active' && r.obligationId).map((r) => r.obligationId!));
  return input.obligations
    .filter((o) => !covered.has(o.id))
    .map((o) => obligationPosition(o, input.transactions, anchor))
    .filter((p) => p.state === 'open' && !p.nextDue);
}

export interface ExpectedTotals {
  incoming: number;
  outgoing: number;
  net: number;
  count: number;
}

export function expectedTotals(events: ExpectedEvent[]): ExpectedTotals {
  let incoming = 0;
  let outgoing = 0;
  for (const e of events) {
    if (e.direction === 'in') incoming += e.amount;
    else outgoing += e.amount;
  }
  return { incoming, outgoing, net: incoming - outgoing, count: events.length };
}

/**
 * Events whose reminder is live: overdue, or close enough to their date,
 * and not snoozed. Recurring items use their own reminder setting; money
 * owed is flagged three days ahead.
 */
export function needsReminder(events: ExpectedEvent[], recurring: Recurring[], anchor: ISODate = today()): ExpectedEvent[] {
  const lead = new Map(recurring.map((r) => [r.id, r.reminderDays]));
  return events.filter((e) => {
    if (!e.actionable) return false;
    if (e.snoozedUntil && e.snoozedUntil > anchor) return false;
    const days = e.source === 'recurring' ? lead.get(e.sourceId) : 3;
    if (e.status === 'overdue') return true;
    return days !== undefined && diffDays(anchor, e.date) <= days;
  });
}

export interface SettledEvent {
  transaction: Transaction;
  source: 'recurring' | 'obligation';
  sourceId: ID;
  direction: EventDirection;
}

/**
 * Recent payments that settled something expected: a confirmed recurring
 * item, or a payment towards money owed. The hand-over that starts a loan
 * is not a settlement, and neither is loan interest.
 */
export function recentlySettled(input: UpcomingInput, range: DateRange): SettledEvent[] {
  const byId = new Map(input.obligations.map((o) => [o.id, o]));
  const out: SettledEvent[] = [];
  for (const t of sortByDateDesc(input.transactions)) {
    if (!inRange(t.date, range)) continue;
    if (t.recurringId) {
      out.push({ transaction: t, source: 'recurring', sourceId: t.recurringId, direction: t.type === 'income' ? 'in' : 'out' });
      continue;
    }
    const o = t.obligationId ? byId.get(t.obligationId) : undefined;
    if (!o || t.type === openingType(o.kind)) continue;
    const interest = (o.kind === 'borrowed' && t.type === 'expense') || (o.kind === 'lent' && t.type === 'income');
    if (interest) continue;
    out.push({ transaction: t, source: 'obligation', sourceId: o.id, direction: owedToYouKind(o.kind) ? 'in' : 'out' });
  }
  return out;
}

/** The last payment recorded against a recurring item or obligation, if any. */
export function lastSettlement(source: 'recurring' | 'obligation', id: ID, input: UpcomingInput): Transaction | undefined {
  const all = { from: '0000-01-01', to: '9999-12-31' };
  return recentlySettled(input, all).find((s) => s.source === source && s.sourceId === id)?.transaction;
}

export function daysFrom(anchor: ISODate, days: number): DateRange {
  return { from: anchor, to: addDays(anchor, days) };
}
