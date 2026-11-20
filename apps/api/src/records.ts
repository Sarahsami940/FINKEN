/**
 * Reading and writing records for a signed-in user. Every query is limited to
 * the Spaces the user is a member of; every write runs inside one database
 * transaction and is checked three ways before it commits:
 *   1. shape: types, lengths, known values, whole paisa (zod, from collections.ts);
 *   2. permission: the user may write to every Space the batch touches, and no
 *      id can be reused to overwrite a record in someone else's Space;
 *   3. money rules: the same checks the app runs (packages/domain), against the
 *      Space as it will be after the batch.
 * The database then checks its own constraints and links at commit.
 */
import { checkTransaction, obligationPosition, openingType, sharedAmount } from '@finken/domain/money';
import { goalSaved } from '@finken/domain/planning';
import type { GoalEntry, Obligation, Transaction, TransactionDraft } from '@finken/domain/types';
import { z } from 'zod';
import type { AuthUser } from './auth';
import { COLLECTION_NAMES, COLLECTIONS, type CollectionName, type CollectionSpec, type Field, selectList, toRecord } from './collections';
import type { Db } from './db';

export type Role = 'owner' | 'editor' | 'viewer';
type Rec = Record<string, unknown> & { id: string };

/** A problem with a batch. Its message is safe to show the user. */
export class BatchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 422,
    readonly where?: { collection: CollectionName; id: string },
  ) {
    super(message);
  }
}

// ── Input checks ───────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function fieldSchema(f: Field): z.ZodType {
  switch (f.kind) {
    case 'money':
      return z.number().int('Amounts must be whole paisa.').min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
    case 'int':
      return z.number().int();
    case 'num':
      return z.number().finite();
    case 'bool':
      return z.boolean();
    case 'date':
      return z.string().refine(realDate, 'Use a real date, YYYY-MM-DD.');
    case 'json':
      return z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(80) }));
    default:
      return f.oneOf ? z.enum(f.oneOf as [string, ...string[]]) : z.string().max(f.max ?? 200);
  }
}

const schemas = Object.fromEntries(
  COLLECTION_NAMES.map((name) => {
    const shape: Record<string, z.ZodType> = { id: z.string().min(1).max(100), createdAt: z.string().optional() };
    for (const f of COLLECTIONS[name].fields) shape[f.key] = f.required ? fieldSchema(f) : fieldSchema(f).optional().nullable();
    // Unknown keys (audit fields, ownerId) are dropped: the server sets those.
    return [name, z.object(shape)];
  }),
) as Record<CollectionName, z.ZodObject>;

export const Batch = z.object({
  /** When these changes were made on the device. Later edits win; missing means now. */
  editedAt: z.iso.datetime({ offset: true }).optional(),
  puts: z.partialRecord(z.enum(COLLECTION_NAMES), z.array(z.unknown()).max(5000)).default({}),
  deletes: z.partialRecord(z.enum(COLLECTION_NAMES), z.array(z.string().min(1).max(100)).max(5000)).default({}),
});
export type BatchInput = z.input<typeof Batch>;

function parseItems(name: CollectionName, items: unknown[]): Rec[] {
  const parsed = items.map((item, i) => {
    const r = schemas[name].safeParse(item);
    if (!r.success) {
      const issue = r.error.issues[0];
      const id = typeof (item as { id?: unknown })?.id === 'string' ? (item as { id: string }).id : `#${i}`;
      throw new BatchError(`${issue.path.join('.') || 'record'}: ${issue.message}`, 400, { collection: name, id });
    }
    return r.data as Rec;
  });
  // The same record twice in one batch: the last copy wins.
  return [...new Map(parsed.map((r) => [r.id, r])).values()];
}

// ── Membership ─────────────────────────────────────────────────────────────

export async function memberships(db: Db, userId: string): Promise<Map<string, Role>> {
  const rows = await db.query<{ space_id: string; role: Role }>(
    'select m.space_id, m.role from space_members m join spaces s on s.id = m.space_id where m.user_id = $1 and s.deleted_at is null',
    [userId],
  );
  return new Map(rows.map((r) => [r.space_id, r.role]));
}

const canWrite = (role: Role | undefined) => role === 'owner' || role === 'editor';

// ── Reads ──────────────────────────────────────────────────────────────────

/** Every live record of one kind in the user's Spaces. */
export async function listRecords(db: Db, user: AuthUser, name: CollectionName): Promise<Rec[]> {
  const spec = COLLECTIONS[name];
  const scope = name === 'spaces' ? 't.id' : 't.space_id';
  const rows = await db.query(
    `select ${selectList(spec)} from ${spec.table} t
     where t.deleted_at is null and ${scope} in (select space_id from space_members where user_id = $1)
     order by t.seq`,
    [user.id],
  );
  return rows.map((r) => toRecord(spec, r) as Rec);
}

/** Records by id, deleted ones included, but only from the user's Spaces. */
export async function getRecords(db: Db, user: AuthUser, name: CollectionName, ids: string[]): Promise<Rec[]> {
  const spec = COLLECTIONS[name];
  const scope = name === 'spaces' ? 't.id' : 't.space_id';
  const rows = await db.query(`select ${selectList(spec)} from ${spec.table} t where t.id = any($2) and ${scope} in (select space_id from space_members where user_id = $1)`, [
    user.id,
    ids,
  ]);
  return rows.map((r) => toRecord(spec, r) as Rec);
}

/**
 * Everything that changed in the user's Spaces after change number `since`,
 * deletes included, oldest first. Pass the returned cursor next time.
 */
export async function changesSince(db: Db, user: AuthUser, since: number, limit = 1000) {
  const changes: { collection: CollectionName; record: Rec; seq: number }[] = [];
  for (const name of COLLECTION_NAMES) {
    const spec = COLLECTIONS[name];
    const scope = name === 'spaces' ? 't.id' : 't.space_id';
    const rows = await db.query(
      `select ${selectList(spec)} from ${spec.table} t where t.seq > $2 and ${scope} in (select space_id from space_members where user_id = $1) order by t.seq limit $3`,
      [user.id, since, limit],
    );
    for (const r of rows) changes.push({ collection: name, record: toRecord(spec, r) as Rec, seq: Number(r.seq) });
  }
  changes.sort((a, b) => a.seq - b.seq);
  const page = changes.slice(0, limit);
  return { changes: page.map(({ collection, record }) => ({ collection, record })), cursor: page.length ? page[page.length - 1].seq : since, more: changes.length > limit };
}

// ── Writes ─────────────────────────────────────────────────────────────────

export const LINKS: Partial<Record<CollectionName, [field: string, target: CollectionName][]>> = {
  obligations: [
    ['personId', 'people'],
    ['sourceTransactionId', 'transactions'],
  ],
  recurring: [
    ['categoryId', 'categories'],
    ['accountId', 'accounts'],
    ['obligationId', 'obligations'],
  ],
  transactions: [
    ['accountId', 'accounts'],
    ['toAccountId', 'accounts'],
    ['categoryId', 'categories'],
    ['personId', 'people'],
    ['obligationId', 'obligations'],
    ['refundOfId', 'transactions'],
    ['recurringId', 'recurring'],
  ],
  budgets: [['categoryId', 'categories']],
  goalEntries: [['goalId', 'goals']],
};

/** The edit time a batch counts as: what the device said, but never later than now. */
const EDITED = (param: string) => `least(coalesce(${param}::timestamptz, now()), now())`;

/** Writes records, and returns the ids that were actually changed. */
async function upsert(tx: Db, user: AuthUser, spec: CollectionSpec, items: Rec[], editedAt: string | null): Promise<Set<string>> {
  const applied = new Set<string>();
  const cols = spec.fields.map((f) => f.col);
  const ownerCols = spec.name === 'spaces' ? ['owner_id'] : [];
  const all = ['id', ...cols, ...ownerCols, 'created_at', 'created_by', 'updated_by', 'edited_at'];
  const cast = (f: Field) =>
    f.kind === 'date'
      ? '::date'
      : f.kind === 'json'
        ? '::jsonb'
        : f.kind === 'money' || f.kind === 'int'
          ? '::bigint'
          : f.kind === 'num'
            ? '::numeric'
            : f.kind === 'bool'
              ? '::boolean'
              : '::text';
  const changed = cols.map((c) => `t.${c}`).join(', ');
  const incoming = cols.map((c) => `excluded.${c}`).join(', ');
  for (let start = 0; start < items.length; start += 200) {
    const chunk = items.slice(start, start + 200);
    const params: unknown[] = [];
    const p = (v: unknown, c = '') => {
      params.push(v);
      return `$${params.length}${c}`;
    };
    const rows = chunk.map((item) => {
      const values = [p(item.id), ...spec.fields.map((f) => p(f.kind === 'json' ? JSON.stringify(item[f.key] ?? []) : (item[f.key] ?? f.fallback ?? null), cast(f)))];
      if (ownerCols.length) values.push(p(user.id));
      // A record made offline keeps the time it was made, but never a time in the future.
      const created = typeof item.createdAt === 'string' && !Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : null;
      values.push(`least(coalesce(${p(created, '::timestamptz')}, now()), now())`, p(user.id), p(user.id), EDITED(p(editedAt)));
      return `(${values.join(', ')})`;
    });
    // Saving exactly what is already stored changes nothing: no new version, so retries are harmless.
    // When two devices change the same record, the later edit wins: an older one is passed over.
    const rows2 = await tx.query<{ id: string }>(
      `insert into ${spec.table} as t (${all.join(', ')}) values ${rows.join(', ')}
       on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
         updated_at = now(), updated_by = excluded.updated_by, edited_at = excluded.edited_at,
         version = t.version + 1, deleted_at = null, deleted_by = null
       where (${changed}, t.deleted_at) is distinct from (${incoming}, null) and t.edited_at <= excluded.edited_at
       returning t.id`,
      params,
    );
    for (const r of rows2) applied.add(r.id);
  }
  return applied;
}

/** The live records of the given Spaces, as the app's money rules expect them. */
export async function loadSpaces(tx: Db, spaceIds: string[]) {
  const out = {} as Record<CollectionName, Rec[]>;
  for (const name of COLLECTION_NAMES) {
    const spec = COLLECTIONS[name];
    const scope = name === 'spaces' ? 't.id' : 't.space_id';
    const rows = await tx.query(`select ${selectList(spec)} from ${spec.table} t where t.deleted_at is null and ${scope} = any($1)`, [spaceIds]);
    out[name] = rows.map((r) => toRecord(spec, r) as Rec);
  }
  return out;
}

export type Report = (collection: CollectionName, id: string, message: string) => void;

const refuse: Report = (collection, id, message) => {
  throw new BatchError(message, 422, { collection, id });
};

/**
 * The money rules for the given Spaces as they stand. `puts` and `deleted`
 * say which records to check. By default the first problem refuses the
 * batch; the nightly check passes its own `fail` to collect every problem.
 */
export function checkMoneyRules(
  state: Record<CollectionName, Rec[]>,
  puts: Partial<Record<CollectionName, Rec[]>>,
  deleted: Partial<Record<CollectionName, string[]>>,
  fail: Report = refuse,
) {
  const transactions = state.transactions as unknown as Transaction[];
  const obligations = state.obligations as unknown as Obligation[];
  const ctx = { accounts: state.accounts as never, categories: state.categories as never, transactions, obligations };
  const spaceCurrency = new Map(state.spaces.map((s) => [s.id, s.currency]));

  // Check each saved transaction as it now stands: after a conflict, that may be the other device's version.
  const saved = new Set((puts.transactions ?? []).map((t) => t.id));
  for (const t of transactions.filter((x) => saved.has(x.id))) {
    if (spaceCurrency.get(t.spaceId) !== t.currency) fail('transactions', t.id, "A transaction must be in its Space's currency.");
    const error = checkTransaction(t as TransactionDraft, ctx, t.id);
    if (error) fail('transactions', t.id, error);
  }

  // Changing what is owed can never leave it below what has already moved.
  const touchedObligations = new Set([...(puts.obligations ?? []).map((o) => o.id), ...(puts.transactions ?? []).map((t) => t.obligationId as string).filter(Boolean)]);
  for (const o of obligations.filter((x) => touchedObligations.has(x.id))) {
    if (spaceCurrency.get(o.spaceId) !== o.currency) fail('obligations', o.id, "Money owed must be in its Space's currency.");
    const { settled } = obligationPosition(o, transactions);
    if (o.amount < settled) fail('obligations', o.id, 'The amount cannot be less than what has already been settled.');
    const opens = openingType(o.kind);
    const handedOver = transactions.reduce((sum, t) => (t.obligationId === o.id && t.type === opens ? sum + t.amount : sum), 0);
    if (o.amount < handedOver) fail('obligations', o.id, 'The amount cannot be less than the money already handed over.');
    if (o.sourceTransactionId) {
      const source = transactions.find((t) => t.id === o.sourceTransactionId);
      if (source?.type !== 'expense' || o.kind !== 'receivable') fail('obligations', o.id, 'Only a share of an expense can be linked this way.');
      else if (sharedAmount(source.id, obligations) > source.amount) fail('obligations', o.id, 'The shares add up to more than the expense itself.');
    }
  }

  // A goal can never have more taken out of it than was put in.
  const entries = state.goalEntries as unknown as GoalEntry[];
  const touchedGoals = new Set([...(puts.goalEntries ?? []).map((e) => e.goalId as string), ...entries.filter((e) => deleted.goalEntries?.includes(e.id)).map((e) => e.goalId)]);
  for (const goalId of touchedGoals) if (goalSaved(goalId, entries) < 0) fail('goalEntries', goalId, 'You cannot take out more than has been saved.');

  // Nothing left in use may point at a record that was deleted.
  const live = new Map(COLLECTION_NAMES.map((n) => [n, new Set(state[n].map((r) => r.id))]));
  for (const [name, links] of Object.entries(LINKS) as [CollectionName, [string, CollectionName][]][]) {
    for (const r of state[name]) {
      for (const [field, target] of links) {
        const ref = r[field];
        if (typeof ref === 'string' && deleted[target]?.includes(ref) && !live.get(target)!.has(ref)) {
          fail(target, ref, 'This is still used by other records, so it cannot be deleted.');
        }
      }
    }
  }
}

/**
 * Applies one batch of saves and deletes for `user`, all or nothing. Returns
 * the ids that were written. Saving a record that is already stored exactly
 * as sent changes nothing, and deleting one that is already deleted is a no-op.
 */
export async function applyBatch(db: Db, user: AuthUser, input: BatchInput): Promise<{ written: number; deleted: number; superseded: Partial<Record<CollectionName, string[]>> }> {
  const batch = Batch.parse(input);
  const puts: Partial<Record<CollectionName, Rec[]>> = {};
  for (const name of COLLECTION_NAMES) if (batch.puts[name]?.length) puts[name] = parseItems(name, batch.puts[name]!);
  const deletes = batch.deletes;

  const editedAt = batch.editedAt ?? null;

  return db.transaction(async (tx) => {
    // One batch at a time, so change numbers are handed out in the order batches commit
    // and a device reading the change feed can never miss one. (Per-Space ordering would
    // scale further; one lock is plenty for launch.)
    await tx.query('select pg_advisory_xact_lock(7240)');
    const roles = await memberships(tx, user.id);

    // Spaces in this batch that do not exist yet are being created by this user.
    const spaceIds = (puts.spaces ?? []).map((s) => s.id);
    const existingSpaces = new Set(spaceIds.length ? (await tx.query<{ id: string }>('select id from spaces where id = any($1)', [spaceIds])).map((r) => r.id) : []);
    const creating = new Set(spaceIds.filter((id) => !existingSpaces.has(id)));
    const writable = (spaceId: string) => creating.has(spaceId) || canWrite(roles.get(spaceId));

    // The same answer whether a Space is someone else's or does not exist, so nothing leaks.
    const denied = (collection: CollectionName, id: string): never => {
      throw new BatchError('That record could not be found, or you cannot change it.', 403, { collection, id });
    };

    for (const s of puts.spaces ?? []) if (!creating.has(s.id) && !canWrite(roles.get(s.id))) denied('spaces', s.id);
    for (const [name, items] of Object.entries(puts) as [CollectionName, Rec[]][]) {
      if (name === 'spaces') continue;
      for (const item of items) if (!writable(item.spaceId as string)) denied(name, item.id);
      // An id already in use must be in the same Space: records never move, and ids cannot be borrowed.
      const ids = items.map((i) => i.id);
      const taken = await tx.query<{ id: string; space_id: string }>(`select id, space_id from ${COLLECTIONS[name].table} where id = any($1)`, [ids]);
      const want = new Map(items.map((i) => [i.id, i.spaceId as string]));
      for (const row of taken) if (row.space_id !== want.get(row.id) || !writable(row.space_id)) denied(name, row.id);
    }
    const deleteSpaces = new Set<string>();
    for (const [name, ids] of Object.entries(deletes) as [CollectionName, string[]][]) {
      if (!ids.length) continue;
      const scope = name === 'spaces' ? 'id' : 'space_id';
      const rows = await tx.query<{ id: string; space: string }>(`select id, ${scope} as space from ${COLLECTIONS[name].table} where id = any($1)`, [ids]);
      for (const row of rows) {
        if (!writable(row.space)) denied(name, row.id);
        deleteSpaces.add(row.space);
      }
      // Only the owner can delete a whole Space.
      if (name === 'spaces') for (const row of rows) if (roles.get(row.id) !== 'owner') denied('spaces', row.id);
    }

    let written = 0;
    const superseded: Partial<Record<CollectionName, string[]>> = {};
    for (const name of COLLECTION_NAMES) {
      const items = puts[name];
      if (!items?.length) continue;
      const applied = await upsert(tx, user, COLLECTIONS[name], items, editedAt);
      written += applied.size;
      // Not applied because a later edit is already stored (as opposed to unchanged).
      const rest = items.map((i) => i.id).filter((id) => !applied.has(id));
      if (rest.length) {
        const newer = await tx.query<{ id: string }>(`select id from ${COLLECTIONS[name].table} where id = any($1) and edited_at > ${EDITED('$2')}`, [rest, editedAt]);
        if (newer.length) superseded[name] = newer.map((r) => r.id);
      }
    }
    if (creating.size) {
      await tx.query(`insert into space_members (space_id, user_id, role) select unnest($1::text[]), $2, 'owner' on conflict do nothing`, [[...creating], user.id]);
    }
    let deleted = 0;
    for (const [name, ids] of Object.entries(deletes) as [CollectionName, string[]][]) {
      if (!ids.length) continue;
      const rows = await tx.query(
        `update ${COLLECTIONS[name].table} set deleted_at = now(), deleted_by = $2, updated_at = now(), updated_by = $2, version = version + 1, edited_at = ${EDITED('$3')}
         where id = any($1) and deleted_at is null and edited_at <= ${EDITED('$3')} returning id`,
        [ids, user.id, editedAt],
      );
      deleted += rows.length;
    }

    const touched = new Set<string>([...spaceIds, ...deleteSpaces]);
    for (const items of Object.values(puts)) for (const i of items ?? []) if (i.spaceId) touched.add(i.spaceId as string);
    if (touched.size) checkMoneyRules(await loadSpaces(tx, [...touched]), puts, deletes);
    return { written, deleted, superseded };
  });
}

/** Turns a database constraint failure into a message the user can act on. */
export function constraintMessage(err: unknown): BatchError | null {
  const e = err as { code?: string; constraint_name?: string; constraint?: string; table_name?: string; table?: string };
  const constraint = e.constraint_name ?? e.constraint ?? '';
  if (e.code === '23503') return new BatchError('A record points at something that is not in this Space.', 422);
  if (e.code === '23514') return new BatchError(`A value is not allowed (${constraint || 'check'}).`, 422);
  if (e.code === '23502') return new BatchError('A required value is missing.', 422);
  if (e.code === '22P02' || e.code === '22007' || e.code === '22008') return new BatchError('A value has the wrong format.', 422);
  if (e.code === '40001') return new BatchError('Someone else changed this at the same moment. Try again.', 409);
  return null;
}
