/**
 * Reconciliation: checks every Space in the database against the money rules
 * and the database's own promises, and lists everything that is wrong.
 *
 * Every save already passes these rules, so in a healthy database this finds
 * nothing. It is run nightly, and after every restore from backup, to catch
 * what the save path cannot: a bug that let something through, a manual
 * change made directly in the database, or a damaged or incomplete restore.
 *
 * The check only reads. (Run as the nightly job, it also forgets whose deleted
 * accounts were once backups no longer hold them.) Problems name records by id, never by their contents, so
 * the report is safe to log and to share with whoever investigates.
 */
import { fileURLToPath } from 'node:url';
import { totalBalance } from '@finken/domain/money';
import type { Account, Transaction } from '@finken/domain/types';
import { forgetOldDeletions } from './account';
import { COLLECTION_NAMES, COLLECTIONS, type CollectionName } from './collections';
import { loadConfig } from './config';
import { connect, type Db } from './db';
import { checkMoneyRules, LINKS, loadSpaces } from './records';

export interface Problem {
  spaceId: string;
  collection: CollectionName | 'space_members';
  id: string;
  message: string;
}

export interface ReconcileReport {
  startedAt: string;
  finishedAt: string;
  spaces: number;
  records: number;
  problems: Problem[];
}

/** Spaces checked together; small enough to keep memory flat on a large database. */
const PAGE = 50;

export async function reconcile(db: Db, clock: () => Date = () => new Date()): Promise<ReconcileReport> {
  const startedAt = clock().toISOString();
  const problems: Problem[] = [];
  let spaces = 0;
  let records = 0;
  let after = '';
  for (;;) {
    const page = (await db.query<{ id: string }>('select id from spaces where deleted_at is null and id > $1 order by id limit $2', [after, PAGE])).map((r) => r.id);
    if (!page.length) break;
    after = page[page.length - 1];
    spaces += page.length;

    const state = await loadSpaces(db, page);
    for (const name of COLLECTION_NAMES) records += state[name].length;
    const spaceOf = new Map<string, string>();
    for (const name of COLLECTION_NAMES) for (const r of state[name]) spaceOf.set(`${name}:${r.id}`, name === 'spaces' ? r.id : (r.spaceId as string));
    const note = (collection: Problem['collection'], id: string, message: string, spaceId = spaceOf.get(`${collection}:${id}`) ?? '') =>
      problems.push({ spaceId, collection, id, message });

    // The money rules, on every record that carries money, all at once.
    checkMoneyRules(state, { transactions: state.transactions, obligations: state.obligations, goalEntries: state.goalEntries }, {}, (c, id, message) => note(c, id, message));

    // Nothing live may point at a record that has been deleted.
    const live = new Map(COLLECTION_NAMES.map((n) => [n, new Set(state[n].map((r) => r.id))]));
    for (const [name, links] of Object.entries(LINKS) as [CollectionName, [string, CollectionName][]][]) {
      for (const r of state[name]) {
        for (const [field, target] of links) {
          const ref = r[field];
          if (typeof ref === 'string' && ref && !live.get(target)!.has(ref)) note(name, r.id, `Points at a ${target} record that is deleted (${field}).`);
        }
      }
    }

    // Balances must stay exact whole numbers.
    for (const spaceId of page) {
      const accounts = state.accounts.filter((a) => a.spaceId === spaceId) as unknown as Account[];
      const transactions = state.transactions.filter((t) => t.spaceId === spaceId) as unknown as Transaction[];
      if (!Number.isSafeInteger(totalBalance(accounts, transactions))) note('spaces', spaceId, 'The total balance is not an exact whole number of paisa.', spaceId);
    }

    // Every Space has exactly one owner, and it is the user the Space says.
    const members = await db.query<{ space_id: string; user_id: string; role: string }>('select space_id, user_id, role from space_members where space_id = any($1)', [page]);
    for (const s of state.spaces) {
      const owners = members.filter((m) => m.space_id === s.id && m.role === 'owner');
      if (owners.length !== 1 || owners[0].user_id !== s.ownerId)
        note('space_members', s.id, `Expected one owner (${String(s.ownerId)}), found ${owners.map((o) => o.user_id).join(', ') || 'none'}.`, s.id);
    }
  }

  // Change numbers are what sync relies on: each is used once.
  const seqs = await db.query<{ seq: string; n: string }>(
    `select seq::text, count(*)::text as n from (${COLLECTION_NAMES.map((n) => `select seq from ${COLLECTIONS[n].table}`).join(' union all ')}) s group by seq having count(*) > 1 limit 20`,
  );
  for (const s of seqs) problems.push({ spaceId: '', collection: 'spaces', id: `seq ${s.seq}`, message: `Change number ${s.seq} is used ${s.n} times.` });

  return { startedAt, finishedAt: clock().toISOString(), spaces, records, problems };
}

// Run directly: npm run db:reconcile (nightly: node dist/reconcile.js). Exits 1 when anything is wrong.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = connect(loadConfig().DATABASE_URL);
  try {
    const report = await reconcile(db);
    // The nightly job's one write: forgetting whose deleted accounts were, once backups no longer hold them.
    const forgotten = await forgetOldDeletions(db);
    // One line a log search or alert can match: counts and ids only.
    console.log(JSON.stringify({ msg: 'reconciliation', ...report, problems: report.problems.length, details: report.problems.slice(0, 100), forgottenDeletions: forgotten }));
    process.exitCode = report.problems.length ? 1 : 0;
  } finally {
    await db.close();
  }
}
