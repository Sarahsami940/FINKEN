/**
 * A person's rights over their own data: a copy of everything, and deleting
 * it for good.
 *
 * - **Export**: the profile, every Space they belong to and every record in
 *   those Spaces, deleted ones included (marked with `deletedAt`), as one
 *   JSON file. Nothing about other people is included beyond the records of
 *   Spaces they share.
 * - **Delete**: the Spaces they own and everything in them are removed from
 *   the database for good, in one transaction. In Spaces owned by others they
 *   are removed as a member, and their name is taken off the change history.
 *   Then the user record itself goes. Backups still hold the data until they
 *   expire, so the internal user id is kept for as long as backups last: if
 *   a backup is restored, the restore check names accounts to delete again.
 *   After that only the date and counts remain (see docs/PRIVACY.md).
 */
import type { AuthUser } from './auth';
import { COLLECTION_NAMES, COLLECTIONS, selectList, toRecord } from './collections';
import type { Db } from './db';

/** How long database backups are kept. Deleted accounts are remembered (by internal id only) for this long. */
export const BACKUP_DAYS = 35;

export async function exportAccount(db: Db, user: AuthUser, now = new Date()) {
  const [profile] = await db.query<{ created_at: string }>(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at from users where id = $1`,
    [user.id],
  );
  const members = await db.query<{ space_id: string; role: string }>('select space_id, role from space_members where user_id = $1 order by space_id', [user.id]);
  const ids = members.map((m) => m.space_id);
  const records: Record<string, Record<string, unknown>[]> = {};
  for (const name of COLLECTION_NAMES) {
    const spec = COLLECTIONS[name];
    const scope = name === 'spaces' ? 't.id' : 't.space_id';
    const rows = ids.length ? await db.query(`select ${selectList(spec)} from ${spec.table} t where ${scope} = any($1) order by t.seq`, [ids]) : [];
    records[name] = rows.map((r) => toRecord(spec, r));
  }
  // Devices that asked for reminders: when, and which push service, but not the push address itself.
  const devices = await db.query<{ created_at: string; endpoint: string }>(
    `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, endpoint from push_subscriptions where user_id = $1 order by id`,
    [user.id],
  );
  return {
    format: 'finken-export',
    version: 1,
    exportedAt: now.toISOString(),
    profile: { id: user.id, email: user.email, name: user.name, timeZone: user.timeZone, createdAt: profile?.created_at },
    memberships: members.map((m) => ({ spaceId: m.space_id, role: m.role })),
    reminderDevices: devices.map((d) => ({ since: d.created_at, service: new URL(d.endpoint).hostname })),
    records,
  };
}

/** Deletes the account and everything only it owns. Returns what was removed. */
export async function deleteAccount(db: Db, user: AuthUser): Promise<{ spaces: number; records: number }> {
  return db.transaction(async (tx) => {
    // The same lock as every batch: nothing is half-written while this runs.
    await tx.query('select pg_advisory_xact_lock(7240)');
    const owned = (await tx.query<{ id: string }>(`select id from spaces where owner_id = $1`, [user.id])).map((r) => r.id);
    let records = 0;
    // Everything inside the owned Spaces, then the Spaces. Links between records are checked at commit.
    for (const name of [...COLLECTION_NAMES].reverse()) {
      if (name === 'spaces' || !owned.length) continue;
      records += (await tx.query(`delete from ${COLLECTIONS[name].table} where space_id = any($1) returning id`, [owned])).length;
    }
    await tx.query('delete from space_members where space_id = any($1) or user_id = $2', [owned, user.id]);
    if (owned.length) await tx.query('delete from spaces where id = any($1)', [owned]);
    // In Spaces owned by others, the history no longer names them.
    for (const name of COLLECTION_NAMES) {
      const table = COLLECTIONS[name].table;
      for (const col of ['created_by', 'updated_by', 'deleted_by']) await tx.query(`update ${table} set ${col} = null where ${col} = $1`, [user.id]);
    }
    await tx.query('delete from users where id = $1', [user.id]);
    await tx.query('insert into account_deletions (user_id, spaces, records) values ($1, $2, $3)', [user.id, owned.length, records]);
    await forgetOldDeletions(tx);
    return { spaces: owned.length, records };
  });
}

/** Once no backup can hold a deleted account any more, forget whose it was. Runs on every deletion and nightly. */
export async function forgetOldDeletions(db: Db): Promise<number> {
  return (await db.query(`update account_deletions set user_id = null where user_id is not null and deleted_at < now() - interval '${BACKUP_DAYS} days' returning id`)).length;
}
