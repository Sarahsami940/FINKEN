/**
 * Finken data models.
 *
 * Every financial record belongs to exactly one Space.
 *
 * Finken thinks about money in five ways, and each maps onto these models:
 *   Money In        — Transaction of type `income`
 *   Money Out       — Transaction of type `expense` (less any `refund`)
 *   Money Movement  — Transaction of type `transfer`
 *   Money Owed      — Obligation, plus the transactions linked to it
 *   Commitments     — Recurring
 */

export type ID = string;
/** Calendar date in local time, formatted YYYY-MM-DD. */
export type ISODate = string;

export interface User {
  id: ID;
  name: string;
  email?: string;
  /** Guests have no account; their data exists only in this browser. */
  isGuest: boolean;
}

export type SpaceType = 'personal' | 'business' | 'family' | 'other';
export type SpaceStatus = 'active' | 'archived';

export interface Space {
  id: ID;
  /** The user this Space belongs to. Spaces are never shared between users. */
  ownerId: ID;
  name: string;
  type: SpaceType;
  /** Key into the icon registry (see components/ui/icons.ts). */
  icon: string;
  description: string;
  /** ISO 4217 code, e.g. PKR. */
  currency: string;
  createdAt: string;
  status: SpaceStatus;
}

export type AccountKind = 'cash' | 'bank' | 'wallet' | 'other';

/** A simple place where money sits: cash, a bank account, a digital wallet. */
export interface Account {
  id: ID;
  spaceId: ID;
  name: string;
  kind: AccountKind;
  /** What the account held before the first recorded transaction. */
  openingBalance: number;
  /** Archived accounts keep their history but are hidden from pickers and totals. */
  archived?: boolean;
}

export type AccountDraft = Pick<Account, 'name' | 'kind' | 'openingBalance'>;

export type CategoryKind = 'expense' | 'income';

export interface Subcategory {
  id: ID;
  name: string;
}

/**
 * Where a spending category sits in a business Profit and Loss view.
 * direct    — Cost of goods sold: what it costs to make or buy what you sell.
 * operating — Running the business: rent, salaries, marketing and the rest.
 */
export type CostType = 'direct' | 'operating';

export interface Category {
  id: ID;
  spaceId: ID;
  name: string;
  kind: CategoryKind;
  icon: string;
  /** Key into the category colour palette (see domain/palette.ts). */
  color: string;
  subcategories: Subcategory[];
  /** Spending categories only. Undefined is treated as operating. */
  costType?: CostType;
}

export type CategoryDraft = Pick<Category, 'name' | 'kind' | 'icon' | 'color'> & Partial<Pick<Category, 'costType'>> & {
  /** Existing subcategories keep their id; new ones have none yet. */
  subcategories: { id?: ID; name: string }[];
};

/**
 * expense       — Money Out. Counts as spending.
 * income        — Money In. Counts as income.
 * transfer      — Money Movement between two accounts. Never income or spending.
 * refund        — Money back for something already paid for. Reduces spending
 *                 in the original category; never counts as income.
 * principal_in  — Money Owed arriving: a loan you took, or someone repaying
 *                 what you lent. Never income.
 * principal_out — Money Owed leaving: money you lent, or you repaying what
 *                 you borrowed. Never spending.
 */
export type TransactionType = 'expense' | 'income' | 'transfer' | 'refund' | 'principal_in' | 'principal_out';
export type TransactionStatus = 'confirmed' | 'pending';

export interface Transaction {
  id: ID;
  spaceId: ID;
  type: TransactionType;
  /** Always positive. Direction comes from `type`. */
  amount: number;
  currency: string;
  categoryId?: ID;
  subcategoryId?: ID;
  date: ISODate;
  description: string;
  /** Account the money left (expense, transfer, principal_out) or entered (income, refund, principal_in). */
  accountId: ID;
  /** Destination account, transfers only. */
  toAccountId?: ID;
  /** The person this money went to or came from, when known. */
  personId?: ID;
  /** The Obligation this transaction opens or settles. Required for principal types. */
  obligationId?: ID;
  /** Refunds only: the expense being refunded, when known. */
  refundOfId?: ID;
  recurringId?: ID;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  status: TransactionStatus;
}

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
export type RecurringFrequency = Frequency | 'daily' | 'custom';
/** `ended` means it ran past its end date; `cancelled` means the user stopped it. */
export type RecurringStatus = 'active' | 'paused' | 'cancelled' | 'ended';

/** An expected, repeating money event. Never creates a transaction by itself. */
export interface Recurring {
  id: ID;
  spaceId: ID;
  name: string;
  amount: number;
  type: 'expense' | 'income';
  categoryId?: ID;
  accountId: ID;
  frequency: RecurringFrequency;
  /** `custom` only: repeats every this many days. */
  intervalDays?: number;
  /** The first occurrence. Later dates are counted from here. */
  startDate: ISODate;
  /** No occurrences after this date. */
  endDate?: ISODate;
  nextDueDate: ISODate;
  /** Flag it this many days before it is due. 0 means on the day; undefined means no reminder. */
  reminderDays?: number;
  /**
   * A loan, receivable or payable this pays down. Confirming it then records
   * a repayment against that, which is never booked as income or spending.
   */
  obligationId?: ID;
  /** The reminder is hidden until this date. The item itself is still expected. */
  snoozedUntil?: ISODate;
  status: RecurringStatus;
}

export type RecurringDraft = Pick<Recurring, 'name' | 'amount' | 'type' | 'accountId' | 'frequency' | 'startDate'> &
  Partial<Pick<Recurring, 'categoryId' | 'intervalDays' | 'endDate' | 'reminderDays' | 'obligationId'>>;

export type BudgetFrequency = 'weekly' | 'monthly' | 'yearly' | 'custom';

/** A spending limit for a period. Progress is always calculated from transactions. */
export interface Budget {
  id: ID;
  spaceId: ID;
  name: string;
  /** Undefined covers all spending in the Space. */
  categoryId?: ID;
  /** Narrows the budget to one subcategory of `categoryId`. */
  subcategoryId?: ID;
  amount: number;
  /** `custom` is a single period from startDate to endDate; the others repeat. */
  frequency: BudgetFrequency;
  startDate: ISODate;
  endDate?: ISODate;
  createdAt: string;
}

export type BudgetDraft = Pick<Budget, 'name' | 'amount' | 'frequency' | 'startDate'> & Partial<Pick<Budget, 'categoryId' | 'subcategoryId' | 'endDate'>>;

/** Something being saved towards. */
export interface Goal {
  id: ID;
  spaceId: ID;
  name: string;
  targetAmount: number;
  targetDate?: ISODate;
  description: string;
  icon: string;
  createdAt: string;
}

export type GoalDraft = Pick<Goal, 'name' | 'targetAmount' | 'description' | 'icon'> & Partial<Pick<Goal, 'targetDate'>>;

/**
 * Money set aside for a goal (positive) or taken back out (negative).
 *
 * This is an allocation, not a transaction: it does not move money between
 * accounts and is never counted as spending.
 */
export interface GoalEntry {
  id: ID;
  spaceId: ID;
  goalId: ID;
  amount: number;
  date: ISODate;
  note?: string;
  createdAt: string;
}

/** How a person relates to a business. Personal and family Spaces leave it unset. */
export type PersonRole = 'customer' | 'supplier' | 'lender' | 'other';

/** Someone money is owed to or by: a friend, relative, customer or supplier. */
export interface Person {
  id: ID;
  spaceId: ID;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  role?: PersonRole;
  createdAt: string;
}

export type PersonDraft = Pick<Person, 'name'> & Partial<Pick<Person, 'phone' | 'email' | 'notes' | 'role'>>;

/**
 * receivable — someone owes you for income you have not received yet
 * payable    — you owe someone for a cost you have not paid yet
 * lent       — you gave someone money and expect it back
 * borrowed   — someone gave you money and you will pay it back
 */
export type ObligationKind = 'receivable' | 'payable' | 'lent' | 'borrowed';
export type ObligationStatus = 'open' | 'cancelled';

/**
 * Money Owed. The record holds the agreed amount; how much is still
 * outstanding is always calculated from the transactions linked to it.
 */
export interface Obligation {
  id: ID;
  spaceId: ID;
  kind: ObligationKind;
  personId: ID;
  title: string;
  /** The full amount owed. Always positive. */
  amount: number;
  currency: string;
  /** When the obligation began. */
  date: ISODate;
  dueDate?: ISODate;
  /**
   * Receivables only: the expense this is someone's share of. Money received
   * against it is then recorded as a refund of that expense, not as income.
   */
  sourceTransactionId?: ID;
  /** Loans only: yearly interest, as a percentage. A reminder of the terms; Finken does not add interest itself. */
  interestRate?: number;
  /** Loans only: the agreed repayment each period. */
  instalmentAmount?: number;
  instalmentFrequency?: Frequency;
  notes?: string;
  /** The reminder is hidden until this date. */
  snoozedUntil?: ISODate;
  /** `cancelled` means written off; being fully settled is calculated, not stored. */
  status: ObligationStatus;
  createdAt: string;
  updatedAt: string;
}

export type ObligationDraft = Pick<Obligation, 'spaceId' | 'kind' | 'personId' | 'title' | 'amount' | 'date'> &
  Partial<Pick<Obligation, 'dueDate' | 'sourceTransactionId' | 'notes' | 'interestRate' | 'instalmentAmount' | 'instalmentFrequency'>>;

/** The parts of an obligation that can be changed after it exists. */
export type ObligationPatch = Pick<Obligation, 'title' | 'amount' | 'date'> &
  Partial<Pick<Obligation, 'dueDate' | 'notes' | 'interestRate' | 'instalmentAmount' | 'instalmentFrequency'>>;

/** What the user fills in when recording money; the engine adds the rest. */
export type TransactionDraft = Pick<
  Transaction,
  'spaceId' | 'type' | 'amount' | 'date' | 'description' | 'accountId'
> &
  Partial<
    Pick<Transaction, 'categoryId' | 'subcategoryId' | 'toAccountId' | 'notes' | 'recurringId' | 'personId' | 'obligationId' | 'refundOfId'>
  >;

export type SpaceDraft = Pick<Space, 'name' | 'type' | 'icon' | 'description' | 'currency'>;

export interface DateRange {
  from: ISODate;
  to: ISODate;
}
