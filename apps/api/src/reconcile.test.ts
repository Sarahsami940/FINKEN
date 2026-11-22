/**
 * Reconciliation and the restore drill. A healthy database has nothing to
 * report; damage made behind the API's back is found and named; a restored
 * copy is checked against the source.
 */
import { buildSeed } from '@finken/domain/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { devToken } from './auth';
import { migrate } from './migrate';
import { reconcile } from './reconcile';
import { checkRestore } from './restore';
import { type TestDb, testDb } from './testing';

const SECRET = 'r'.repeat(40);
let db: TestDb;
let app: ReturnType<typeof buildApp>;
const seeds: ReturnType<typeof buildSeed>[] = [];

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } });
  for (const subject of ['rec-a', 'rec-b']) {
    const headers = { authorization: `Bearer ${await devToken(SECRET, { subject })}` };
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers })).json() as { id: string };
    const seed = buildSeed(me.id);
    const { spaceIdByType: _, ...puts } = seed;
    expect((await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts } })).statusCode).toBe(200);
    seeds.push(seed);
  }
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('reconciliation', () => {
  it('finds nothing wrong in a database written through the API', async () => {
    const report = await reconcile(db);
    expect(report.problems).toEqual([]);
    expect(report.spaces).toBe(6);
    expect(report.records).toBeGreaterThan(1000);
  });

  it('finds and names damage made directly in the database, leaving everything else alone', async () => {
    const [a] = seeds;
    const expense = a.transactions.find((t) => t.type === 'expense')!;
    const category = a.categories.find((c) => a.transactions.some((t) => t.categoryId === c.id))!;
    const goal = a.goals[0];
    await db.transaction(async (tx) => {
      // A refund of more than was paid, a category deleted while still in use,
      // a goal emptied below zero, and a Space without its owner.
      await tx.query(
        "insert into transactions (id, space_id, type, amount, currency, date, account_id, status, refund_of_id, description) values ('bad-refund', $1, 'refund', $2, 'PKR', '2026-11-01', $3, 'confirmed', $4, '')",
        [expense.spaceId, expense.amount + 100, expense.accountId, expense.id],
      );
      await tx.query('update categories set deleted_at = now() where id = $1', [category.id]);
      await tx.query("insert into goal_entries (id, space_id, goal_id, amount, date) values ('bad-withdrawal', $1, $2, -999999999, '2026-11-01')", [goal.spaceId, goal.id]);
      await tx.query('delete from space_members where space_id = $1', [a.spaces[2].id]);
    });
    const { problems } = await reconcile(db);
    const found = (id: string) => problems.filter((p) => p.id === id);
    expect(found('bad-refund')[0]).toMatchObject({ spaceId: expense.spaceId, collection: 'transactions', message: expect.stringMatching(/refund/i) });
    expect(problems.some((p) => p.collection === 'transactions' && p.message.includes('categories record that is deleted'))).toBe(true);
    expect(found(goal.id)[0]).toMatchObject({ collection: 'goalEntries', message: 'You cannot take out more than has been saved.' });
    expect(found(a.spaces[2].id)[0]).toMatchObject({ collection: 'space_members', message: expect.stringContaining('found none') });
    // Nothing about the other person's Spaces.
    const theirs = new Set(seeds[1].spaces.map((s) => s.id));
    expect(problems.filter((p) => theirs.has(p.spaceId))).toEqual([]);
    // Problems name ids, never what a record says.
    expect(JSON.stringify(problems)).not.toContain(expense.description);
  });
});

describe('restore drill', () => {
  it('passes for a complete restored copy, and names every difference in an incomplete one', async () => {
    const fresh = await testDb();
    await migrate(fresh);
    const source = { ...fresh };
    const restore = async () => testDb(await fresh.backup());
    // A quiet, healthy source.
    const headers = { authorization: `Bearer ${await devToken(SECRET, { subject: 'drill' })}` };
    const live = buildApp({ db: fresh, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } });
    const me = (await live.inject({ method: 'GET', url: '/v1/me', headers })).json() as { id: string };
    const { spaceIdByType: _, ...puts } = buildSeed(me.id);
    expect((await live.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts } })).statusCode).toBe(200);

    const good = await restore();
    const result = await checkRestore(good, source);
    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.restored.rows.transactions).toBe(puts.transactions.length);

    // A restore that lost the last few transactions.
    const partial = await restore();
    await partial.query("delete from transactions where id in (select id from transactions where type = 'income' order by seq desc limit 3)");
    const bad = await checkRestore(partial, source);
    expect(bad.ok).toBe(false);
    expect(bad.differences).toContain(`transactions: ${puts.transactions.length - 3} rows, the source has ${puts.transactions.length}.`);

    // Someone deletes their account after the backup: restoring it must not bring them back unnoticed.
    const backupBefore = await fresh.backup();
    expect((await live.inject({ method: 'DELETE', url: '/v1/me', headers, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    const old = await testDb(backupBefore);
    const stale = await checkRestore(old, source);
    expect(stale.differences).toContain(
      `Account ${me.id} was deleted after this backup was taken: delete it again (DELETE /v1/me as that user, or deleteAccount) before reopening.`,
    );

    await live.close();
    for (const d of [good, partial, old, fresh]) await d.close();
  });
});
