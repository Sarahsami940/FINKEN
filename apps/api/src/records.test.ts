/**
 * The API against a real Postgres (PGlite): sign-in, permissions between
 * users, the money rules, retries and soft delete.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { devToken } from './auth';
import type { Db } from './db';
import { migrate } from './migrate';
import { testDb } from './testing';

const SECRET = 's'.repeat(40);
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

type Json = Record<string, unknown>;
const tokens = new Map<string, string>();
async function as(subject: string) {
  if (!tokens.has(subject)) tokens.set(subject, await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject }));
  const auth = { authorization: `Bearer ${tokens.get(subject)}` };
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: body as Json });
    return { status: res.statusCode, body: res.json() as Json };
  };
  return {
    call,
    batch: (body: Json) => call('POST', '/v1/batch', body),
    list: async (collection: string) => (await call('GET', `/v1/records/${collection}`)).body.records as Json[],
  };
}

const now = '2026-11-15';
/** A Space with a bank account and a spending category, ready to use. */
function starter(key: string) {
  const space = `${key}-space`;
  return {
    space,
    bank: `${space}:bank`,
    food: `${space}:food`,
    batch: {
      puts: {
        spaces: [{ id: space, name: `${key} home`, type: 'personal', icon: 'home', description: '', currency: 'PKR', status: 'active' }],
        accounts: [{ id: `${space}:bank`, spaceId: space, name: 'Bank', kind: 'bank', openingBalance: 10000000 }],
        categories: [
          { id: `${space}:food`, spaceId: space, name: 'Food', kind: 'expense', icon: 'utensils', color: 'orange', subcategories: [] },
          { id: `${space}:pay`, spaceId: space, name: 'Salary', kind: 'income', icon: 'wallet', color: 'green', subcategories: [] },
        ],
      },
    },
  };
}
const expense = (s: ReturnType<typeof starter>, id: string, amount: number, extra: Json = {}) => ({
  id,
  spaceId: s.space,
  type: 'expense',
  amount,
  currency: 'PKR',
  categoryId: s.food,
  date: now,
  description: 'Groceries',
  accountId: s.bank,
  status: 'confirmed',
  ...extra,
});

describe('sign-in', () => {
  it('turns away requests without a valid token', async () => {
    expect((await app.inject('/v1/me')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer nonsense' } })).statusCode).toBe(401);
    const forged = await devToken('f'.repeat(40), { subject: 'mallory' });
    expect((await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401);
    const expired = await devToken(SECRET, { subject: 'ana' }, '-1m');
    expect((await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${expired}` } })).statusCode).toBe(401);
  });

  it('creates the user on their first request, once', async () => {
    const ana = await as('ana');
    const first = await ana.call('GET', '/v1/me');
    const second = await ana.call('GET', '/v1/me');
    expect(first.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({ email: 'ana@example.com', timeZone: 'Asia/Karachi' });
    const patched = await ana.call('PATCH', '/v1/me', { timeZone: 'Europe/London', name: 'Ana' });
    expect(patched.body).toMatchObject({ timeZone: 'Europe/London', name: 'Ana' });
    expect((await ana.call('PATCH', '/v1/me', { timeZone: 'Mars/Base' })).status).toBe(400);
  });
});

describe('records', () => {
  it('saves a new Space with its records in one batch, and stamps the history', async () => {
    const ana = await as('ana');
    const s = starter('ana');
    expect((await ana.batch(s.batch)).status).toBe(200);
    expect((await ana.batch({ puts: { transactions: [expense(s, 'ana-t1', 450050)] } })).status).toBe(200);
    const me = (await ana.call('GET', '/v1/me')).body;
    const [space] = await ana.list('spaces');
    expect(space).toMatchObject({ id: s.space, ownerId: me.id, createdBy: me.id, version: 1 });
    const [t] = await ana.list('transactions');
    expect(t).toMatchObject({ id: 'ana-t1', amount: 450050, date: now, categoryId: s.food, version: 1, createdBy: me.id });
    expect(t).not.toHaveProperty('toAccountId');
    expect(Date.parse(t.updatedAt as string)).not.toBeNaN();
  });

  it('treats a repeated save as one save, and a real change as a new version', async () => {
    const ana = await as('ana');
    const s = starter('ana');
    const again = await ana.batch({ puts: { transactions: [expense(s, 'ana-t1', 450050)] } });
    expect(again.status).toBe(200);
    expect((await ana.list('transactions')).find((t) => t.id === 'ana-t1')).toMatchObject({ version: 1 });
    await ana.batch({ puts: { transactions: [expense(s, 'ana-t1', 460000)] } });
    expect((await ana.list('transactions')).find((t) => t.id === 'ana-t1')).toMatchObject({ version: 2, amount: 460000 });
  });

  it('takes the last copy when one batch saves the same record twice', async () => {
    const ana = await as('ana');
    const s = starter('ana');
    const res = await ana.batch({ puts: { transactions: [expense(s, 'ana-twice', 100), expense(s, 'ana-twice', 200)] } });
    expect(res.status).toBe(200);
    expect((await ana.list('transactions')).find((t) => t.id === 'ana-twice')).toMatchObject({ amount: 200, version: 1 });
  });

  it('ignores history and ownership a client tries to send', async () => {
    const ana = await as('ana');
    const s = starter('ana');
    await ana.batch({ puts: { transactions: [{ ...expense(s, 'ana-t2', 1000), version: 99, createdBy: 'someone', createdAt: '2999-01-01T00:00:00Z' }] } });
    const t = (await ana.list('transactions')).find((x) => x.id === 'ana-t2')!;
    expect(t.version).toBe(1);
    expect(t.createdBy).not.toBe('someone');
    expect(Date.parse(t.createdAt as string)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('one user can never reach another user’s data', () => {
  it('lists, fetches and syncs only your own Spaces', async () => {
    const bo = await as('bo');
    await bo.batch(starter('bo').batch);
    expect((await bo.list('spaces')).map((s) => s.id)).toEqual(['bo-space']);
    expect(await bo.list('transactions')).toEqual([]);
    expect((await bo.call('POST', '/v1/records/transactions/get', { ids: ['ana-t1'] })).body.records).toEqual([]);
    const changes = (await bo.call('GET', '/v1/changes?since=0')).body.changes as { record: Json }[];
    expect(changes.every((c) => JSON.stringify(c.record).includes('bo-space'))).toBe(true);
  });

  it('refuses writes into someone else’s Space, and taking over their ids', async () => {
    const bo = await as('bo');
    const ana = starter('ana');
    const mine = starter('bo');
    const into = await bo.batch({ puts: { transactions: [expense(ana, 'bo-sneaky', 100)] } });
    expect(into.status).toBe(403);
    // Reusing Ana's id inside Bo's own Space would overwrite her record: refused.
    const hijack = await bo.batch({ puts: { transactions: [expense(mine, 'ana-t1', 1)] } });
    expect(hijack.status).toBe(403);
    // Renaming her Space, or claiming its id as a new Space, is refused too.
    expect((await bo.batch({ puts: { spaces: [{ ...ana.batch.puts.spaces[0], name: 'Mine now' }] } })).status).toBe(403);
    expect((await bo.batch({ deletes: { transactions: ['ana-t1'], spaces: ['ana-space'] } })).status).toBe(403);
    // And the answer is the same as for something that does not exist, so nothing leaks.
    expect((await bo.batch({ deletes: { transactions: ['ana-t1'] } })).body.error).toBe('That record could not be found, or you cannot change it.');
    const ana2 = await as('ana');
    expect((await ana2.list('transactions')).find((t) => t.id === 'ana-t1')).toMatchObject({ amount: 460000, version: 2 });
    expect((await ana2.list('spaces'))[0].name).toBe('ana home');
  });

  it('cannot link a record to an account in another Space', async () => {
    const bo = await as('bo');
    const mine = starter('bo');
    const res = await bo.batch({ puts: { transactions: [expense(mine, 'bo-t1', 100, { accountId: 'ana-space:bank' })] } });
    expect(res.status).toBe(422);
  });

  it('lets a viewer read a shared Space but not change it', async () => {
    const bo = await as('bo');
    const boId = (await bo.call('GET', '/v1/me')).body.id;
    await db.query("insert into space_members (space_id, user_id, role) values ('ana-space', $1, 'viewer')", [boId]);
    expect((await bo.list('transactions')).map((t) => t.id)).toContain('ana-t1');
    expect((await bo.batch({ puts: { transactions: [expense(starter('ana'), 'bo-t2', 100)] } })).status).toBe(403);
    await db.query("delete from space_members where space_id = 'ana-space' and user_id = $1", [boId]);
    expect((await bo.list('transactions')).map((t) => t.id)).not.toContain('ana-t1');
  });
});

describe('the server runs the money rules', () => {
  const s = starter('cy');
  let cy: Awaited<ReturnType<typeof as>>;
  beforeAll(async () => {
    cy = await as('cy');
    await cy.batch(s.batch);
    await cy.batch({ puts: { transactions: [expense(s, 'cy-shoes', 500000)] } });
  });

  it('checks shape: whole paisa, real dates, known types', async () => {
    expect((await cy.batch({ puts: { transactions: [expense(s, 'cy-x', 10.5)] } })).body.error).toMatch(/whole paisa/);
    expect((await cy.batch({ puts: { transactions: [expense(s, 'cy-x', 100, { date: '2026-02-30' })] } })).status).toBe(400);
    expect((await cy.batch({ puts: { transactions: [expense(s, 'cy-x', 100, { type: 'gift' })] } })).status).toBe(400);
    expect((await cy.batch({ puts: { transactions: [expense(s, 'cy-x', -100)] } })).status).toBe(422);
  });

  it('stops a refund bigger than what is left of the expense', async () => {
    const refund = (id: string, amount: number) => ({ ...expense(s, id, amount), type: 'refund', refundOfId: 'cy-shoes' });
    expect((await cy.batch({ puts: { transactions: [refund('cy-r1', 300000)] } })).status).toBe(200);
    const res = await cy.batch({ puts: { transactions: [refund('cy-r2', 200001)] } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'Only 2,000 of that expense is left to refund.', collection: 'transactions', id: 'cy-r2' });
  });

  it('refuses a transaction in another currency than its Space', async () => {
    expect((await cy.batch({ puts: { transactions: [expense(s, 'cy-usd', 100, { currency: 'USD' })] } })).status).toBe(422);
  });

  it('keeps money owed at or above what has been paid', async () => {
    const person = { id: 'cy-ali', spaceId: s.space, name: 'Ali' };
    const owed = { id: 'cy-o1', spaceId: s.space, kind: 'receivable', personId: 'cy-ali', title: 'Invoice', amount: 800000, currency: 'PKR', date: now, status: 'open' };
    const paid = { ...expense(s, 'cy-p1', 300000), type: 'income', categoryId: `${s.space}:pay`, obligationId: 'cy-o1', personId: 'cy-ali' };
    expect((await cy.batch({ puts: { people: [person], obligations: [owed], transactions: [paid] } })).status).toBe(200);
    const shrink = await cy.batch({ puts: { obligations: [{ ...owed, amount: 200000 }] } });
    expect(shrink).toMatchObject({ status: 422, body: { error: 'The amount cannot be less than what has already been settled.' } });
    const over = await cy.batch({ puts: { transactions: [{ ...paid, id: 'cy-p2', amount: 500001 }] } });
    expect(over.body.error).toBe('Only 5,000 is still outstanding.');
  });

  it('never lets more come out of a goal than went in', async () => {
    const goal = { id: 'cy-g', spaceId: s.space, name: 'Trip', targetAmount: 1000000, description: '', icon: 'plane' };
    expect((await cy.batch({ puts: { goals: [goal], goalEntries: [{ id: 'cy-e1', spaceId: s.space, goalId: 'cy-g', amount: 50000, date: now }] } })).status).toBe(200);
    expect((await cy.batch({ puts: { goalEntries: [{ id: 'cy-e2', spaceId: s.space, goalId: 'cy-g', amount: -50001, date: now }] } })).status).toBe(422);
    expect(
      (await cy.batch({ deletes: { goalEntries: ['cy-e1'] }, puts: { goalEntries: [{ id: 'cy-e3', spaceId: s.space, goalId: 'cy-g', amount: -1, date: now }] } })).status,
    ).toBe(422);
  });

  it('will not delete something still in use', async () => {
    const res = await cy.batch({ deletes: { accounts: [s.bank] } });
    expect(res).toMatchObject({ status: 422, body: { error: 'This is still used by other records, so it cannot be deleted.' } });
  });

  it('saves all of a batch or none of it', async () => {
    const before = (await cy.list('transactions')).length;
    const res = await cy.batch({ puts: { transactions: [expense(s, 'cy-ok', 100), expense(s, 'cy-bad', 100, { accountId: 'nowhere' })] } });
    expect(res.status).toBe(422);
    expect((await cy.list('transactions')).length).toBe(before);
  });
});

describe('soft delete and changes', () => {
  it('hides deleted records, keeps them in the change feed, and treats a repeat delete as done', async () => {
    const dee = await as('dee');
    const s = starter('dee');
    await dee.batch(s.batch);
    const start = (await dee.call('GET', '/v1/changes?since=0')).body.cursor as number;
    await dee.batch({ puts: { transactions: [expense(s, 'dee-t1', 1000)] } });
    expect((await dee.batch({ deletes: { transactions: ['dee-t1'] } })).body).toMatchObject({ deleted: 1 });
    expect((await dee.batch({ deletes: { transactions: ['dee-t1'] } })).body).toMatchObject({ deleted: 0 });
    expect(await dee.list('transactions')).toEqual([]);
    const feed = (await dee.call('GET', `/v1/changes?since=${start}`)).body as { changes: { collection: string; record: Json }[]; cursor: number };
    expect(feed.changes).toHaveLength(1);
    expect(feed.changes[0]).toMatchObject({ collection: 'transactions', record: { id: 'dee-t1', version: 2 } });
    expect(feed.changes[0].record.deletedAt).toBeTruthy();
    expect((await dee.call('GET', `/v1/changes?since=${feed.cursor}`)).body.changes).toEqual([]);
    // Saving it again brings it back.
    await dee.batch({ puts: { transactions: [expense(s, 'dee-t1', 1000)] } });
    expect((await dee.list('transactions'))[0]).toMatchObject({ id: 'dee-t1', version: 3 });
  });
});

describe('two devices changing the same record', () => {
  it('keeps the later edit, whichever arrives first, and says which save was passed over', async () => {
    const eve = await as('eve');
    const s = starter('eve');
    await eve.batch(s.batch);
    await eve.batch({ editedAt: '2026-11-15T09:00:00Z', puts: { transactions: [expense(s, 'eve-t', 1000)] } });
    // The laptop edited at 11:00 and reaches the server first; the phone edited at 10:00, offline, and arrives later.
    await eve.batch({ editedAt: '2026-11-15T11:00:00Z', puts: { transactions: [expense(s, 'eve-t', 3000)] } });
    const late = await eve.batch({ editedAt: '2026-11-15T10:00:00Z', puts: { transactions: [expense(s, 'eve-t', 2000)] } });
    expect(late.body).toMatchObject({ written: 0, superseded: { transactions: ['eve-t'] } });
    expect((await eve.list('transactions'))[0]).toMatchObject({ amount: 3000, version: 2, editedAt: '2026-11-15T11:00:00.000Z' });
  });

  it('never lets a clock set in the future win for good', async () => {
    const eve = await as('eve');
    const s = starter('eve');
    await eve.batch({ editedAt: '2999-01-01T00:00:00Z', puts: { transactions: [expense(s, 'eve-t', 4000)] } });
    const t = (await eve.list('transactions'))[0];
    expect(Date.parse(t.editedAt as string)).toBeLessThanOrEqual(Date.now() + 1000);
    // An edit made now still replaces it.
    await eve.batch({ puts: { transactions: [expense(s, 'eve-t', 5000)] } });
    expect((await eve.list('transactions'))[0]).toMatchObject({ amount: 5000 });
  });

  it('ignores a delete made before a later edit, and applies one made after', async () => {
    const eve = await as('eve');
    const s = starter('eve');
    await eve.batch({ editedAt: '2026-11-16T12:00:00Z', puts: { transactions: [expense(s, 'eve-d', 1000)] } });
    expect((await eve.batch({ editedAt: '2026-11-16T08:00:00Z', deletes: { transactions: ['eve-d'] } })).body).toMatchObject({ deleted: 0 });
    expect((await eve.list('transactions')).map((t) => t.id)).toContain('eve-d');
    expect((await eve.batch({ deletes: { transactions: ['eve-d'] } })).body).toMatchObject({ deleted: 1 });
  });
});
