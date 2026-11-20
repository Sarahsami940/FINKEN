/**
 * Load test: many people using Finken at once, then a check that every
 * figure is still right.
 *
 *   npm run load -w @finken/e2e                      # in-process API on an in-memory Postgres
 *   LOAD_API_URL=https://staging.example/api LOAD_USERS=50 npm run load -w @finken/e2e
 *
 * Each virtual person signs in (development sign-in), saves a Space of
 * sample data in one batch, then repeatedly records an expense, syncs the
 * changes, and now and then reads their whole transaction list, like the
 * app does. Every expense is sent with its own id, and a few are sent twice,
 * as a retrying phone would.
 *
 * Reports how long each kind of request took (median, 95th and 99th
 * percentile) and how many failed. Then it checks the results: the server
 * must hold exactly the expenses that were sent, once each, with balances
 * that match, and (in-process) reconciliation must find nothing wrong.
 * Exits 1 when any check or limit fails.
 *
 * Against a real server, raise its rate limits for the test, or run it from
 * several addresses: one address is allowed 2,000 requests a minute.
 */
import { buildApp } from '@finken/api/src/app';
import { migrate } from '@finken/api/src/migrate';
import { reconcile } from '@finken/api/src/reconcile';
import { testDb } from '@finken/api/src/testing';
import { totalBalance } from '@finken/domain/money';
import { buildSeed } from '@finken/domain/seed';
import type { Account, Transaction } from '@finken/domain/types';

const USERS = Number(process.env.LOAD_USERS ?? 20);
const STEPS = Number(process.env.LOAD_STEPS ?? 30);
// In-process, the in-memory Postgres runs on one thread shared with the API and this script, so
// everyone queues: the limit there only catches large slowdowns. Against a real server the
// launch target applies (see docs/OPERATIONS.md).
const LIMIT_P95_MS = Number(process.env.LOAD_P95_MS ?? (process.env.LOAD_API_URL ? 300 : 2000));
const LIMIT_ERRORS = Number(process.env.LOAD_MAX_ERROR_RATE ?? 0.01);

const timings = new Map<string, number[]>();
let failures = 0;
let requests = 0;

async function startLocal() {
  const db = await testDb();
  await migrate(db);
  const unlimited = { max: 1_000_000, windowMs: 60_000 };
  const app = buildApp({
    db,
    config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'l'.repeat(40) },
    limits: { address: unlimited, person: unlimited, batch: unlimited },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const close = async () => {
    await app.close();
    await db.close();
  };
  return { url, db, close };
}

async function call<T>(base: string, name: string, method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const started = performance.now();
  requests++;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`${name}: ${res.status} ${data.error ?? ''}`);
    return data;
  } catch (err) {
    failures++;
    throw err;
  } finally {
    const list = timings.get(name) ?? [];
    list.push(performance.now() - started);
    timings.set(name, list);
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** One person's session. Returns what they sent, to check against the server afterwards. */
async function person(base: string, n: number) {
  const { token } = await call<{ token: string }>(base, 'sign in', 'POST', '/v1/dev/token', undefined, { subject: `load-${n}-${Date.now()}` });
  const me = await call<{ id: string }>(base, 'GET /v1/me', 'GET', '/v1/me', token);
  const seed = buildSeed(me.id);
  // One Space of sample data, as a guest moving to an account would send it.
  const spaceId = seed.spaceIdByType.personal;
  const inSpace = <T extends { spaceId: string }>(list: T[]) => list.filter((r) => r.spaceId === spaceId);
  await call(base, 'POST /v1/batch (whole Space)', 'POST', '/v1/batch', token, {
    puts: {
      spaces: seed.spaces.filter((s) => s.id === spaceId),
      accounts: inSpace(seed.accounts),
      categories: inSpace(seed.categories),
      people: inSpace(seed.people),
      obligations: inSpace(seed.obligations),
      recurring: inSpace(seed.recurring),
      transactions: inSpace(seed.transactions),
      budgets: inSpace(seed.budgets),
      goals: inSpace(seed.goals),
      goalEntries: inSpace(seed.goalEntries),
    },
  });
  const account = inSpace(seed.accounts)[0];
  const category = inSpace(seed.categories).find((c) => c.kind === 'expense')!;
  let cursor = 0;
  const sent: Transaction[] = [];
  for (let step = 0; step < STEPS; step++) {
    const t = {
      id: `load-${n}-${step}`,
      spaceId,
      type: 'expense',
      amount: 1000 + step * 7 + n,
      currency: 'PKR',
      date: '2026-11-18',
      description: `Load ${step}`,
      accountId: account.id,
      categoryId: category.id,
      status: 'confirmed',
    } as Transaction;
    try {
      await call(base, 'POST /v1/batch (one expense)', 'POST', '/v1/batch', token, { puts: { transactions: [t] } });
      sent.push(t);
      // A phone that never heard back sends it again: still one expense.
      if (step % 10 === 3) await call(base, 'POST /v1/batch (retry)', 'POST', '/v1/batch', token, { puts: { transactions: [t] } });
    } catch {
      // Counted as a failure; the check below then expects it to be missing.
    }
    try {
      let more = true;
      while (more) {
        const page = await call<{ cursor: number; more: boolean }>(base, 'GET /v1/changes', 'GET', `/v1/changes?since=${cursor}`, token);
        cursor = page.cursor;
        more = page.more;
      }
      if (step % 5 === 4) await call(base, 'GET /v1/records/transactions', 'GET', '/v1/records/transactions', token);
    } catch {
      // Counted.
    }
  }
  return { token, spaceId, sent, seedTransactions: inSpace(seed.transactions), accounts: inSpace(seed.accounts) as Account[] };
}

const local = process.env.LOAD_API_URL ? null : await startLocal();
const base = process.env.LOAD_API_URL ?? local!.url;
console.log(`Load test: ${USERS} people, ${STEPS} steps each, against ${local ? 'an in-process API on an in-memory Postgres' : base}`);
const started = performance.now();
const results = await Promise.allSettled(Array.from({ length: USERS }, (_, n) => person(base, n)));
const seconds = (performance.now() - started) / 1000;

console.log(`\n${requests} requests in ${seconds.toFixed(1)} s (${(requests / seconds).toFixed(0)} a second), ${failures} failed\n`);
console.log('request'.padEnd(34), 'count'.padStart(6), 'median'.padStart(9), 'p95'.padStart(9), 'p99'.padStart(9));
const problems: string[] = [];
for (const [name, list] of [...timings].sort(([a], [b]) => a.localeCompare(b))) {
  const sorted = [...list].sort((a, b) => a - b);
  const p95 = pct(sorted, 95);
  console.log(
    name.padEnd(34),
    String(list.length).padStart(6),
    `${pct(sorted, 50).toFixed(0)} ms`.padStart(9),
    `${p95.toFixed(0)} ms`.padStart(9),
    `${pct(sorted, 99).toFixed(0)} ms`.padStart(9),
  );
  if (name !== 'POST /v1/batch (whole Space)' && name !== 'sign in' && p95 > LIMIT_P95_MS) problems.push(`${name}: p95 ${p95.toFixed(0)} ms is over ${LIMIT_P95_MS} ms`);
}
if (failures / Math.max(1, requests) > LIMIT_ERRORS) problems.push(`${failures} of ${requests} requests failed`);

// Every expense that was accepted is there once, and the balances add up.
for (const r of results) {
  if (r.status === 'rejected') {
    problems.push(`A person's session stopped: ${(r.reason as Error).message}`);
    continue;
  }
  const { token, spaceId, sent, seedTransactions, accounts } = r.value;
  const { records } = await call<{ records: Transaction[] }>(base, 'check', 'GET', '/v1/records/transactions', token);
  const mine = records.filter((t) => t.spaceId === spaceId);
  const expected = [...seedTransactions, ...sent];
  if (mine.length !== expected.length) problems.push(`Space ${spaceId}: ${mine.length} transactions on the server, ${expected.length} sent`);
  if (totalBalance(accounts, mine) !== totalBalance(accounts, expected as Transaction[])) problems.push(`Space ${spaceId}: the balance does not match what was sent`);
}
if (local) {
  const report = await reconcile(local.db);
  console.log(`\nReconciliation: ${report.spaces} Spaces, ${report.records} records, ${report.problems.length} problems`);
  for (const p of report.problems.slice(0, 10)) problems.push(`Reconciliation: ${p.collection} ${p.id}: ${p.message}`);
  await local.close();
}

if (problems.length) {
  console.log(`\nFAILED\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('\nPASSED: every expense arrived exactly once, every balance matches, and every limit was met.');
}
