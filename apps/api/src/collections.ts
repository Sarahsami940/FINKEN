/**
 * How each kind of record maps onto its table. One list of fields drives the
 * SQL, the input checks and the conversion back to the shape the app uses
 * (packages/domain/src/types.ts), so they can never disagree.
 */

export type FieldKind = 'text' | 'money' | 'int' | 'num' | 'bool' | 'date' | 'json';

export interface Field {
  /** Name in the app's records (camelCase). */
  key: string;
  /** Column in the table (snake_case). */
  col: string;
  kind: FieldKind;
  required?: boolean;
  /** Allowed values, for kinds and statuses. */
  oneOf?: readonly string[];
  /** Longest text allowed. */
  max?: number;
  /** Stored when the app leaves the field out, for columns that cannot be empty. */
  fallback?: string | boolean;
}

export interface CollectionSpec {
  name: CollectionName;
  table: string;
  fields: Field[];
}

export const COLLECTION_NAMES = ['spaces', 'accounts', 'categories', 'people', 'obligations', 'recurring', 'transactions', 'budgets', 'goals', 'goalEntries'] as const;
export type CollectionName = (typeof COLLECTION_NAMES)[number];

const text = (key: string, col: string, extra: Partial<Field> = {}): Field => ({ key, col, kind: 'text', max: 200, ...extra });
const req = (f: Field): Field => ({ ...f, required: true });
const id = (key: string, col: string) => text(key, col, { max: 100 });
const money = (key: string, col: string) => ({ key, col, kind: 'money' as const });
const date = (key: string, col: string) => ({ key, col, kind: 'date' as const });

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

/** Every collection except spaces: it lives in one Space. */
const inSpace: Field[] = [req(id('spaceId', 'space_id'))];

export const COLLECTIONS: Record<CollectionName, CollectionSpec> = {
  spaces: {
    name: 'spaces',
    table: 'spaces',
    fields: [
      req(text('name', 'name', { max: 80 })),
      req(text('type', 'type', { oneOf: ['personal', 'business', 'family', 'other'] })),
      text('icon', 'icon', { max: 40, fallback: '' }),
      text('description', 'description', { max: 500, fallback: '' }),
      req(text('currency', 'currency', { max: 3 })),
      req(text('status', 'status', { oneOf: ['active', 'archived'] })),
    ],
  },
  accounts: {
    name: 'accounts',
    table: 'accounts',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      req(text('kind', 'kind', { oneOf: ['cash', 'bank', 'wallet', 'other'] })),
      req(money('openingBalance', 'opening_balance')),
      { key: 'archived', col: 'archived', kind: 'bool', fallback: false },
    ],
  },
  categories: {
    name: 'categories',
    table: 'categories',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      req(text('kind', 'kind', { oneOf: ['expense', 'income'] })),
      text('icon', 'icon', { max: 40, fallback: '' }),
      text('color', 'color', { max: 40, fallback: '' }),
      { key: 'subcategories', col: 'subcategories', kind: 'json', required: true },
      text('costType', 'cost_type', { oneOf: ['direct', 'operating'] }),
    ],
  },
  people: {
    name: 'people',
    table: 'people',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      text('phone', 'phone', { max: 40 }),
      text('email', 'email', { max: 200 }),
      text('notes', 'notes', { max: 2000 }),
      text('role', 'role', { oneOf: ['customer', 'supplier', 'lender', 'other'] }),
    ],
  },
  obligations: {
    name: 'obligations',
    table: 'obligations',
    fields: [
      ...inSpace,
      req(text('kind', 'kind', { oneOf: ['receivable', 'payable', 'lent', 'borrowed'] })),
      req(id('personId', 'person_id')),
      req(text('title', 'title', { max: 120 })),
      req(money('amount', 'amount')),
      req(text('currency', 'currency', { max: 3 })),
      req(date('date', 'date')),
      date('dueDate', 'due_date'),
      id('sourceTransactionId', 'source_transaction_id'),
      { key: 'interestRate', col: 'interest_rate', kind: 'num' },
      money('instalmentAmount', 'instalment_amount'),
      text('instalmentFrequency', 'instalment_frequency', { oneOf: FREQUENCIES }),
      text('notes', 'notes', { max: 2000 }),
      date('snoozedUntil', 'snoozed_until'),
      req(text('status', 'status', { oneOf: ['open', 'cancelled'] })),
    ],
  },
  recurring: {
    name: 'recurring',
    table: 'recurring',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      req(money('amount', 'amount')),
      req(text('type', 'type', { oneOf: ['expense', 'income'] })),
      id('categoryId', 'category_id'),
      req(id('accountId', 'account_id')),
      req(text('frequency', 'frequency', { oneOf: ['daily', ...FREQUENCIES, 'custom'] })),
      { key: 'intervalDays', col: 'interval_days', kind: 'int' },
      req(date('startDate', 'start_date')),
      date('endDate', 'end_date'),
      req(date('nextDueDate', 'next_due_date')),
      { key: 'reminderDays', col: 'reminder_days', kind: 'int' },
      id('obligationId', 'obligation_id'),
      date('snoozedUntil', 'snoozed_until'),
      req(text('status', 'status', { oneOf: ['active', 'paused', 'cancelled', 'ended'] })),
    ],
  },
  transactions: {
    name: 'transactions',
    table: 'transactions',
    fields: [
      ...inSpace,
      req(text('type', 'type', { oneOf: ['expense', 'income', 'transfer', 'refund', 'principal_in', 'principal_out'] })),
      req(money('amount', 'amount')),
      req(text('currency', 'currency', { max: 3 })),
      id('categoryId', 'category_id'),
      id('subcategoryId', 'subcategory_id'),
      req(date('date', 'date')),
      text('description', 'description', { max: 200, fallback: '' }),
      req(id('accountId', 'account_id')),
      id('toAccountId', 'to_account_id'),
      id('personId', 'person_id'),
      id('obligationId', 'obligation_id'),
      id('refundOfId', 'refund_of_id'),
      id('recurringId', 'recurring_id'),
      text('notes', 'notes', { max: 2000 }),
      req(text('status', 'status', { oneOf: ['confirmed', 'pending'] })),
    ],
  },
  budgets: {
    name: 'budgets',
    table: 'budgets',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      id('categoryId', 'category_id'),
      id('subcategoryId', 'subcategory_id'),
      req(money('amount', 'amount')),
      req(text('frequency', 'frequency', { oneOf: ['weekly', 'monthly', 'yearly', 'custom'] })),
      req(date('startDate', 'start_date')),
      date('endDate', 'end_date'),
    ],
  },
  goals: {
    name: 'goals',
    table: 'goals',
    fields: [
      ...inSpace,
      req(text('name', 'name', { max: 80 })),
      req(money('targetAmount', 'target_amount')),
      date('targetDate', 'target_date'),
      text('description', 'description', { max: 500, fallback: '' }),
      text('icon', 'icon', { max: 40, fallback: '' }),
    ],
  },
  goalEntries: {
    name: 'goalEntries',
    table: 'goal_entries',
    fields: [...inSpace, req(id('goalId', 'goal_id')), req(money('amount', 'amount')), req(date('date', 'date')), text('note', 'note', { max: 500 })],
  },
};

/** Columns the server writes itself. Anything a client sends for them is ignored. */
export const AUDIT_FIELDS = [
  { key: 'createdAt', col: 'created_at' },
  { key: 'createdBy', col: 'created_by' },
  { key: 'updatedAt', col: 'updated_at' },
  { key: 'updatedBy', col: 'updated_by' },
  { key: 'version', col: 'version' },
  { key: 'deletedAt', col: 'deleted_at' },
  { key: 'deletedBy', col: 'deleted_by' },
  { key: 'editedAt', col: 'edited_at' },
] as const;

export function isCollection(name: string): name is CollectionName {
  return (COLLECTION_NAMES as readonly string[]).includes(name);
}

const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The select list for a collection, with every value cast to text so both
 * Postgres drivers return the same thing; `toRecord` turns it back.
 */
export function selectList(spec: CollectionSpec, alias = 't'): string {
  const cols = [`${alias}.id`, ...spec.fields.map((f) => `${alias}.${f.col}${f.kind === 'json' || f.kind === 'bool' ? '' : '::text'} as ${f.col}`)];
  if (spec.name === 'spaces') cols.push(`${alias}.owner_id`);
  for (const a of AUDIT_FIELDS) cols.push(a.col.endsWith('_at') ? `${iso(`${alias}.${a.col}`)} as ${a.col}` : `${alias}.${a.col}`);
  cols.push(`${alias}.seq::text as seq`);
  return cols.join(', ');
}

/** A database row back into the app's record shape. Empty columns are left out, as the app expects. */
export function toRecord(spec: CollectionSpec, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const f of spec.fields) {
    const v = row[f.col];
    if (v === null || v === undefined) continue;
    out[f.key] = f.kind === 'money' || f.kind === 'int' || f.kind === 'num' ? Number(v) : v;
  }
  if (spec.name === 'spaces') out.ownerId = row.owner_id;
  for (const a of AUDIT_FIELDS) {
    const v = row[a.col];
    if (v !== null && v !== undefined) out[a.key] = a.key === 'version' ? Number(v) : v;
  }
  return out;
}
