/**
 * Phase 5: security and privacy. Rate limits, headers, what logs may contain,
 * exporting and deleting an account, and inputs built to break things.
 */
import { buildSeed } from '@finken/domain/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { devToken } from './auth';
import type { Db } from './db';
import { migrate } from './migrate';
import { RateLimiter } from './security';
import { testDb } from './testing';

const SECRET = 's'.repeat(40);
const CONFIG = { NODE_ENV: 'test', LOG_LEVEL: 'info', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } as const;

let db: Db;
const logs: string[] = [];
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: CONFIG, logStream: { write: (line) => void logs.push(line) } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const auth = async (subject: string) => ({ authorization: `Bearer ${await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject })}` });

/** A demo set of Spaces saved into `subject`'s account. */
async function seeded(subject: string) {
  const headers = await auth(subject);
  const me = (await app.inject({ method: 'GET', url: '/v1/me', headers })).json() as { id: string };
  const seed = buildSeed(me.id);
  const res = await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts: { ...seed, spaceIdByType: undefined } } });
  expect(res.statusCode, res.body).toBe(200);
  return { headers, seed, me };
}

describe('rate limits', () => {
  it('counts per key and window, and says how long to wait', () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000 }, () => now);
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: false, retryAfter: 60 });
    expect(limiter.take('b')).toEqual({ ok: true });
    now = 59_000;
    expect(limiter.take('a')).toEqual({ ok: false, retryAfter: 1 });
    now = 60_000;
    expect(limiter.take('a')).toEqual({ ok: true });
  });

  it('stops a person who sends too much, without touching anyone else', async () => {
    const small = buildApp({ db, config: { ...CONFIG, LOG_LEVEL: 'silent' }, limits: { person: { max: 3, windowMs: 60_000 } } });
    const ali = await auth('rate-ali');
    const bo = await auth('rate-bo');
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await small.inject({ method: 'GET', url: '/v1/me', headers: ali })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const stopped = await small.inject({ method: 'GET', url: '/v1/me', headers: ali });
    expect(stopped.json()).toEqual({ error: 'Too many requests. Wait a minute, then try again.' });
    expect(Number(stopped.headers['retry-after'])).toBeGreaterThan(0);
    expect((await small.inject({ method: 'GET', url: '/v1/me', headers: bo })).statusCode).toBe(200);
    expect(small.metrics.limited.get({ limit: 'person' })).toBe(2);
    await small.close();
  });

  it('slows down guessing at sign-in tokens', async () => {
    const small = buildApp({ db, config: { ...CONFIG, LOG_LEVEL: 'silent' }, limits: { signInFailures: { max: 2, windowMs: 60_000 } } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await small.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer guess-${i}` } })).statusCode);
    expect(codes).toEqual([401, 401, 429]);
    await small.close();
  });
});

describe('headers', () => {
  it('tells browsers the API is JSON only, never to be framed or cached, with an id for every request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: await auth('headers') });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    // A proxy's id is kept; anything odd is replaced.
    expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'edge-12345678' } })).headers['x-request-id']).toBe('edge-12345678');
    expect((await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'x"; drop' } })).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adds HSTS in production', async () => {
    const prod = buildApp({ db, config: { NODE_ENV: 'production', LOG_LEVEL: 'silent', AUTH_MODE: 'oidc' }, verify: async () => ({ subject: 'p' }) });
    expect((await prod.inject({ method: 'GET', url: '/health' })).headers['strict-transport-security']).toContain('max-age=');
    await prod.close();
  });
});

describe('logs', () => {
  it('never contain tokens, emails, names, amounts, descriptions, query values or addresses', async () => {
    logs.length = 0;
    const { headers, seed } = await seeded('logs-pat');
    const t = seed.transactions[0];
    await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts: { transactions: [{ ...t, description: 'Secret pharmacy visit', amount: 987654 }] } } });
    await app.inject({ method: 'GET', url: '/v1/changes?since=12345', headers });
    await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts: { transactions: [{ ...t, amount: -5 }] } } });
    const text = logs.join('\n');
    expect(logs.length).toBeGreaterThan(3);
    for (const secret of [headers.authorization.slice(7), 'logs-pat@example.com', 'Secret pharmacy', '987654', '12345', '127.0.0.1']) expect(text).not.toContain(secret);
    // What they do say: enough to follow a request.
    const line = JSON.parse(logs.find((l) => l.includes('/v1/batch'))!);
    expect(line).toMatchObject({ msg: 'request', req: { method: 'POST', route: '/v1/batch' }, res: { status: 200 } });
    expect(line.user).toBeTruthy();
  });

  it('keep a server failure’s details to themselves, and give the person an id to quote', async () => {
    logs.length = 0;
    const failing = {
      ...db,
      // Signing in works; reading transactions fails the way a lost database connection does.
      query: (sql: string, params?: unknown[]) =>
        sql.includes('from transactions') ? Promise.reject(new Error('connection to 10.0.0.5 failed for user finken_app')) : db.query(sql, params),
    } as Db;
    const broken = buildApp({ db: failing, config: CONFIG, logStream: { write: (line) => void logs.push(line) } });
    const res = await broken.inject({ method: 'GET', url: '/v1/records/transactions', headers: await auth('broken') });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Something went wrong. Try again.', requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('10.0.0.5');
    // The log has the details, under the same id.
    const line = JSON.parse(logs.find((l) => l.includes('request failed'))!);
    expect(line).toMatchObject({ reqId: res.headers['x-request-id'], err: { message: expect.stringContaining('10.0.0.5') } });
    await broken.close();
  });
});

describe('a copy of everything', () => {
  it('has every record of the person’s Spaces, deleted ones marked, and nothing of anyone else’s', async () => {
    const { headers, seed, me } = await seeded('export-kim');
    await seeded('export-other');
    const gone = seed.transactions[1];
    await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { deletes: { transactions: [gone.id] } } });
    const res = await app.inject({ method: 'GET', url: '/v1/export', headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="finken-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = res.json() as {
      format: string;
      profile: { email: string };
      memberships: unknown[];
      records: Record<string, { id: string; spaceId?: string; deletedAt?: string }[]>;
    };
    expect(data).toMatchObject({ format: 'finken-export', profile: { id: me.id, email: 'export-kim@example.com' } });
    expect(data.memberships).toHaveLength(3);
    expect(data.records.transactions).toHaveLength(seed.transactions.length);
    expect(data.records.transactions.find((t) => t.id === gone.id)?.deletedAt).toBeTruthy();
    const mine = new Set(seed.spaces.map((s) => s.id));
    for (const list of Object.values(data.records)) for (const r of list) expect(mine.has(r.spaceId ?? r.id)).toBe(true);
  });
});

describe('deleting an account', () => {
  it('needs the word DELETE', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/me', headers: await auth('delete-careful'), payload: { confirm: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Type DELETE to confirm.');
  });

  it('removes the person and everything they own for good, and leaves everyone else alone', async () => {
    const { headers, seed, me } = await seeded('delete-lee');
    const other = await seeded('delete-sam');
    const count = async (table: string, where = '') => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table} ${where}`))[0].n);
    const othersBefore = await count('transactions', `where space_id = '${other.seed.spaces[0].id}'`);

    const res = await app.inject({ method: 'DELETE', url: '/v1/me', headers, payload: { confirm: 'DELETE' } });
    expect(res.statusCode, res.body).toBe(200);
    const total = Object.entries(seed)
      .filter(([k]) => k !== 'spaces' && k !== 'spaceIdByType')
      .reduce((n, [, list]) => n + (list as unknown[]).length, 0);
    expect(res.json()).toEqual({ deleted: { spaces: 3, records: total } });

    expect(await count('users', `where id = '${me.id}'`)).toBe(0);
    expect(await count('spaces', `where owner_id = '${me.id}'`)).toBe(0);
    for (const t of ['transactions', 'accounts', 'goal_entries', 'space_members']) {
      expect(await count(t, `where ${t === 'space_members' ? 'space_id' : 'space_id'} = any(array['${seed.spaces.map((s) => s.id).join("','")}'])`)).toBe(0);
    }
    expect(await count('transactions', `where space_id = '${other.seed.spaces[0].id}'`)).toBe(othersBefore);
    // Kept: the internal id (for as long as backups last), the date and the counts. Nothing else.
    const [row] = await db.query<Record<string, unknown>>('select * from account_deletions order by id desc limit 1');
    expect(Object.keys(row).sort()).toEqual(['deleted_at', 'id', 'records', 'spaces', 'user_id']);
    expect(row.user_id).toBe(me.id);
    // After 35 days, not even whose it was.
    await db.query("update account_deletions set deleted_at = now() - interval '36 days' where user_id = $1", [me.id]);
    const later = await seeded('delete-later');
    await app.inject({ method: 'DELETE', url: '/v1/me', headers: later.headers, payload: { confirm: 'DELETE' } });
    expect(await count('account_deletions', `where user_id = '${me.id}'`)).toBe(0);
    expect(await count('account_deletions', `where user_id = '${later.me.id}'`)).toBe(1);
    // Signing in again with the same identity starts a brand new, empty account.
    expect((await app.inject({ method: 'GET', url: '/v1/records/spaces', headers })).json()).toEqual({ records: [] });
  });
});

describe('inputs built to break things', () => {
  it('stores ids and text exactly as sent, never as SQL', async () => {
    const { headers, me } = await seeded('inject-ray');
    const space = buildSeed(me.id).spaces[0];
    const odd = { ...space, id: "sp'; drop table users; --", name: "Robert'); drop table spaces;--" };
    const res = await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: { puts: { spaces: [odd] } } });
    expect(res.statusCode, res.body).toBe(200);
    const got = (await app.inject({ method: 'POST', url: '/v1/records/spaces/get', headers, payload: { ids: [odd.id] } })).json();
    expect(got.records[0]).toMatchObject({ id: odd.id, name: odd.name });
    // Both tables are still there.
    expect(await db.query("select to_regclass('users') as u, to_regclass('spaces') as s")).toEqual([{ u: 'users', s: 'spaces' }]);
  });

  it('refuses unknown collections, oversized requests, broken JSON and other people’s records', async () => {
    const { headers, seed } = await seeded('break-mo');
    expect((await app.inject({ method: 'GET', url: '/v1/records/users', headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/records/__proto__', headers })).statusCode).toBe(404);
    const huge = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: `{"puts":{"transactions":[${'"x",'.repeat(2_200_000)}"x"]}}`,
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error).toBe('That is too much to send at once.');
    expect((await app.inject({ method: 'POST', url: '/v1/batch', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"puts":' })).statusCode).toBe(400);
    const stranger = await auth('break-stranger');
    const steal = await app.inject({ method: 'POST', url: '/v1/batch', headers: stranger, payload: { puts: { transactions: [{ ...seed.transactions[0], amount: 1 }] } } });
    expect(steal.statusCode).toBe(403);
    const peek = await app.inject({ method: 'POST', url: '/v1/records/transactions/get', headers: stranger, payload: { ids: [seed.transactions[0].id] } });
    expect(peek.json()).toEqual({ records: [] });
  });

  it('never offers development sign-in outside development', async () => {
    const prod = buildApp({ db, config: { NODE_ENV: 'production', LOG_LEVEL: 'silent', AUTH_MODE: 'oidc' }, verify: async () => Promise.reject(new Error('bad')) });
    expect((await prod.inject({ method: 'POST', url: '/v1/dev/token', payload: { subject: 'x' } })).statusCode).toBe(404);
    // Nor metrics, without their own token.
    expect((await prod.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    await prod.close();
    const withToken = buildApp({
      db,
      config: { NODE_ENV: 'production', LOG_LEVEL: 'silent', AUTH_MODE: 'oidc', METRICS_TOKEN: 'm'.repeat(32) },
      verify: async () => ({ subject: 'x' }),
    });
    expect((await withToken.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await withToken.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${'m'.repeat(32)}` } })).statusCode).toBe(200);
    await withToken.close();
  });
});
