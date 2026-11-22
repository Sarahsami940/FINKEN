/**
 * The restore drill's check: is a database restored from backup complete and
 * sound? Run against the restored copy, optionally comparing with the source:
 *
 *   DATABASE_URL=<restored> SOURCE_DATABASE_URL=<live> node dist/restore.js
 *
 * It checks that every migration the source has is recorded with the same
 * checksum, that every table holds the same number of rows and reaches the
 * same change number (when the source is given; a backup taken earlier can
 * only have fewer), that no account deleted since the backup has come back,
 * and that reconciliation finds nothing wrong. Exits 1 if not.
 */
import { fileURLToPath } from 'node:url';
import { COLLECTION_NAMES, COLLECTIONS } from './collections';
import { loadConfig } from './config';
import { connect, type Db } from './db';
import { type ReconcileReport, reconcile } from './reconcile';

const TABLES = ['users', 'space_members', 'push_subscriptions', ...COLLECTION_NAMES.map((n) => COLLECTIONS[n].table)];

export interface Snapshot {
  migrations: Record<string, string>;
  rows: Record<string, number>;
  lastChange: number;
}

export async function snapshot(db: Db): Promise<Snapshot> {
  const migrations = Object.fromEntries(
    (await db.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations order by name')).map((m) => [m.name, m.checksum]),
  );
  const rows: Record<string, number> = {};
  for (const t of TABLES) rows[t] = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t}`))[0].n);
  const [seq] = await db.query<{ last: string | null }>(
    `select max(seq)::text as last from (${COLLECTION_NAMES.map((n) => `select seq from ${COLLECTIONS[n].table}`).join(' union all ')}) s`,
  );
  return { migrations, rows, lastChange: Number(seq?.last ?? 0) };
}

export interface RestoreCheck {
  ok: boolean;
  differences: string[];
  restored: Snapshot;
  reconciliation: ReconcileReport;
}

export async function checkRestore(restored: Db, source?: Db): Promise<RestoreCheck> {
  const differences: string[] = [];
  const mine = await snapshot(restored);
  if (!Object.keys(mine.migrations).length) differences.push('No migrations are recorded: this does not look like a Finken database.');
  if (source) {
    const theirs = await snapshot(source);
    for (const [name, checksum] of Object.entries(theirs.migrations)) {
      if (!(name in mine.migrations)) differences.push(`Migration ${name} is missing.`);
      else if (mine.migrations[name] !== checksum) differences.push(`Migration ${name} has a different checksum.`);
    }
    for (const t of TABLES) if (mine.rows[t] !== theirs.rows[t]) differences.push(`${t}: ${mine.rows[t]} rows, the source has ${theirs.rows[t]}.`);
    if (mine.lastChange !== theirs.lastChange) differences.push(`Last change number is ${mine.lastChange}, the source has ${theirs.lastChange}.`);
  }
  // Accounts deleted after this backup was taken must not come back.
  const deleted = (await (source ?? restored).query<{ user_id: string }>('select user_id from account_deletions where user_id is not null')).map((r) => r.user_id);
  if (deleted.length) {
    const back = await restored.query<{ id: string }>('select id from users where id = any($1)', [deleted]);
    for (const u of back)
      differences.push(`Account ${u.id} was deleted after this backup was taken: delete it again (DELETE /v1/me as that user, or deleteAccount) before reopening.`);
  }
  const reconciliation = await reconcile(restored);
  for (const p of reconciliation.problems) differences.push(`${p.collection} ${p.id}: ${p.message}`);
  return { ok: differences.length === 0, differences, restored: mine, reconciliation };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const restored = connect(loadConfig().DATABASE_URL);
  const source = process.env.SOURCE_DATABASE_URL ? connect(process.env.SOURCE_DATABASE_URL) : undefined;
  try {
    const result = await checkRestore(restored, source);
    console.log(JSON.stringify({ msg: 'restore check', ok: result.ok, differences: result.differences, rows: result.restored.rows, lastChange: result.restored.lastChange }));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await restored.close();
    await source?.close();
  }
}
