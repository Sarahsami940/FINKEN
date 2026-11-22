/**
 * Phase 9: sharing a Space. Invites, joining, what each role may do with
 * every kind of record, and how members' devices hear about it.
 */
import { buildSeed } from '@finken/domain/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { devToken } from './auth';
import { COLLECTION_NAMES, type CollectionName } from './collections';
import type { Db } from './db';
import { migrate } from './migrate';
import { testDb } from './testing';

const SECRET = 'm'.repeat(40);
const CONFIG = { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } as const;

let db: Db;
let app: ReturnType<typeof buildApp>;

type Headers = Record<string, string>;
type Rec = Record<string, unknown> & { id: string; spaceId?: string };
interface Person {
  headers: Headers;
  id: string;
}

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: CONFIG });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

async function person(subject: string): Promise<Person> {
  const headers = { authorization: `Bearer ${await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject })}` };
  const me = (await app.inject({ method: 'GET', url: '/v1/me', headers })).json() as { id: string };
  return { headers, id: me.id };
}

const call = (p: Person, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: p.headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function changes(p: Person, since = 0) {
  const res = await call(p, 'GET', `/v1/changes?since=${since}`);
  return res.json() as { changes: { collection: CollectionName; record: Rec }[]; cursor: number; more: boolean; memberships: { spaceId: string; role: string }[] };
}

/** Everything in the owner's business Space: one record of each kind, ready to send back. */
async function businessSpace(owner: Person) {
  const seed = buildSeed(owner.id);
  const spaceId = seed.spaceIdByType.business!;
  const puts: Partial<Record<CollectionName, Rec[]>> = {};
  for (const name of COLLECTION_NAMES) {
    const all = (seed as unknown as Record<string, Rec[]>)[name] ?? [];
    puts[name] = all.filter((r) => (name === 'spaces' ? r.id === spaceId : r.spaceId === spaceId));
  }
  const res = await call(owner, 'POST', '/v1/batch', { puts });
  expect(res.statusCode, res.body).toBe(200);
  const count = Object.values(puts).reduce((s, l) => s + (l?.length ?? 0), 0);
  return { spaceId, puts, count };
}

async function invite(owner: Person, spaceId: string, role: 'editor' | 'viewer') {
  const res = await call(owner, 'POST', `/v1/spaces/${spaceId}/invites`, { role });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; code: string; role: string; expiresAt: string };
}

const join = (p: Person, code: string) => call(p, 'POST', '/v1/spaces/join', { code });

describe('sharing a Space', () => {
  it('an invite brings in one person, with every record the Space already has', async () => {
    const owner = await person('share-owner');
    const bo = await person('share-bo');
    const { spaceId, count } = await businessSpace(owner);

    // Before joining, Bo sees nothing of it, and his device has synced to some point.
    const before = await changes(bo);
    expect(before.changes.filter((c) => (c.collection === 'spaces' ? c.record.id : c.record.spaceId) === spaceId)).toEqual([]);
    expect((await call(bo, 'GET', `/v1/spaces/${spaceId}/members`)).statusCode).toBe(404);

    const { code, expiresAt } = await invite(owner, spaceId, 'editor');
    expect(code).toMatch(/^SPC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const joined = await join(bo, code.toLowerCase());
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toMatchObject({ spaceId, role: 'editor', already: false, name: expect.any(String) });

    // From where his device had got to, every record of the Space arrives.
    const after = await changes(bo, before.cursor);
    const arrived = after.changes.filter((c) => (c.collection === 'spaces' ? c.record.id : c.record.spaceId) === spaceId);
    expect(arrived).toHaveLength(count);
    expect(after.memberships).toContainEqual({ spaceId, role: 'editor' });

    // The code worked once.
    const dee = await person('share-dee');
    expect((await join(dee, code)).json().error).toBe('That invite is not right, has been used, or has expired. Ask the Space’s owner for a new one.');
  });

  it('names everyone and their role; only the owner sees emails', async () => {
    const owner = await person('names-owner');
    const ed = await person('names-ed');
    const { spaceId } = await businessSpace(owner);
    await join(ed, (await invite(owner, spaceId, 'viewer')).code);

    const asOwner = (await call(owner, 'GET', `/v1/spaces/${spaceId}/members`)).json().members as { role: string; email: string | null; you: boolean }[];
    expect(asOwner.map((m) => [m.role, m.email, m.you])).toEqual([
      ['owner', 'names-owner@example.com', true],
      ['viewer', 'names-ed@example.com', false],
    ]);
    const asEd = (await call(ed, 'GET', `/v1/spaces/${spaceId}/members`)).json().members as { role: string; email: string | null }[];
    expect(asEd.map((m) => [m.role, m.email])).toEqual([
      ['owner', null],
      ['viewer', 'names-ed@example.com'],
    ]);
  });

  it('invites can be listed and cancelled by the owner only, and expire', async () => {
    const owner = await person('inv-owner');
    const ed = await person('inv-ed');
    const { spaceId } = await businessSpace(owner);
    const a = await invite(owner, spaceId, 'editor');
    const b = await invite(owner, spaceId, 'viewer');
    expect(((await call(owner, 'GET', `/v1/spaces/${spaceId}/invites`)).json().invites as { id: number }[]).map((i) => i.id)).toEqual([a.id, b.id]);
    expect((await call(ed, 'GET', `/v1/spaces/${spaceId}/invites`)).statusCode).toBe(404);
    expect((await call(ed, 'POST', `/v1/spaces/${spaceId}/invites`, { role: 'editor' })).statusCode).toBe(404);

    expect((await call(owner, 'DELETE', `/v1/spaces/${spaceId}/invites/${a.id}`)).statusCode).toBe(204);
    expect((await join(ed, a.code)).statusCode).toBe(400);
    await db.query(`update space_invites set expires_at = now() - interval '1 second' where id = $1`, [b.id]);
    expect((await join(ed, b.code)).statusCode).toBe(400);
    expect((await call(owner, 'GET', `/v1/spaces/${spaceId}/invites`)).json().invites).toEqual([]);
  });
});

describe('what each role may do', () => {
  let owner: Person;
  let editor: Person;
  let viewer: Person;
  let outsider: Person;
  let space: Awaited<ReturnType<typeof businessSpace>>;

  beforeAll(async () => {
    owner = await person('role-owner');
    editor = await person('role-editor');
    viewer = await person('role-viewer');
    outsider = await person('role-outsider');
    space = await businessSpace(owner);
    await join(editor, (await invite(owner, space.spaceId, 'editor')).code);
    await join(viewer, (await invite(owner, space.spaceId, 'viewer')).code);
  });

  /** One record of a kind, sent back with a harmless change (or unchanged when there is nothing safe to change). */
  const resave = (name: CollectionName) => {
    const record = space.puts[name]?.[0];
    if (!record) return null;
    const next = { ...record } as Rec;
    if (typeof next.name === 'string') next.name = `${next.name} `.trim();
    if ('description' in next && typeof next.description === 'string') next.description = `${next.description} (checked)`;
    if ('notes' in next) next.notes = 'checked';
    return { puts: { [name]: [next] } };
  };

  it('a viewer can read everything but change nothing, of any kind', async () => {
    const records = (await call(viewer, 'GET', '/v1/records/transactions')).json().records as Rec[];
    expect(records.filter((r) => r.spaceId === space.spaceId)).toHaveLength(space.puts.transactions!.length);
    for (const name of COLLECTION_NAMES) {
      const body = resave(name);
      if (!body) continue;
      const put = await call(viewer, 'POST', '/v1/batch', body);
      expect(put.statusCode, `${name}: ${put.body}`).toBe(403);
      const del = await call(viewer, 'POST', '/v1/batch', { deletes: { [name]: [space.puts[name]![0].id] } });
      expect(del.statusCode, name).toBe(403);
    }
    // A new record in the Space is refused too.
    const account = space.puts.accounts![0];
    const added = await call(viewer, 'POST', '/v1/batch', { puts: { accounts: [{ ...account, id: 'viewer-new-account', name: 'Petty cash 2' }] } });
    expect(added.statusCode).toBe(403);
  });

  it('an editor can change every kind of record, but not delete the Space or manage people', async () => {
    for (const name of COLLECTION_NAMES) {
      const body = resave(name);
      if (!body) continue;
      const put = await call(editor, 'POST', '/v1/batch', body);
      expect(put.statusCode, `${name}: ${put.body}`).toBe(200);
    }
    const spend = space.puts.transactions!.find((t) => t.type === 'expense')!;
    const added = await call(editor, 'POST', '/v1/batch', { puts: { transactions: [{ ...spend, id: 'editor-expense', amount: 12_345, description: 'Courier' }] } });
    expect(added.statusCode, added.body).toBe(200);
    // The owner sees it.
    const seen = (await call(owner, 'POST', '/v1/records/transactions/get', { ids: ['editor-expense'] })).json().records as Rec[];
    expect(seen).toEqual([expect.objectContaining({ id: 'editor-expense', amount: 12_345, createdBy: editor.id })]);

    expect((await call(editor, 'POST', '/v1/batch', { deletes: { spaces: [space.spaceId] } })).statusCode).toBe(403);
    expect((await call(editor, 'POST', `/v1/spaces/${space.spaceId}/invites`, { role: 'viewer' })).statusCode).toBe(404);
    expect((await call(editor, 'PATCH', `/v1/spaces/${space.spaceId}/members/${viewer.id}`, { role: 'editor' })).statusCode).toBe(404);
    expect((await call(editor, 'DELETE', `/v1/spaces/${space.spaceId}/members/${viewer.id}`)).statusCode).toBe(404);
  });

  it('someone outside the Space gets the same answer as for a Space that does not exist', async () => {
    const body = resave('transactions')!;
    const theirs = await call(outsider, 'POST', '/v1/batch', body);
    expect(theirs.statusCode).toBe(403);
    const ghost = await call(outsider, 'POST', '/v1/batch', { puts: { transactions: [{ ...space.puts.transactions![0], id: 'ghost', spaceId: 'no-such-space' }] } });
    expect(ghost.json().error).toBe(theirs.json().error);
    expect((await call(outsider, 'GET', `/v1/spaces/${space.spaceId}/members`)).json().error).toBe((await call(outsider, 'GET', '/v1/spaces/nope/members')).json().error);
  });

  it('the owner can let a viewer edit, and take it back', async () => {
    const body = resave('categories')!;
    expect((await call(owner, 'PATCH', `/v1/spaces/${space.spaceId}/members/${viewer.id}`, { role: 'editor' })).statusCode).toBe(200);
    expect((await call(viewer, 'POST', '/v1/batch', body)).statusCode).toBe(200);
    expect((await changes(viewer)).memberships).toContainEqual({ spaceId: space.spaceId, role: 'editor' });
    expect((await call(owner, 'PATCH', `/v1/spaces/${space.spaceId}/members/${viewer.id}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await call(viewer, 'POST', '/v1/batch', body)).statusCode).toBe(403);
    // The owner's own role is not for changing.
    expect((await call(owner, 'PATCH', `/v1/spaces/${space.spaceId}/members/${owner.id}`, { role: 'viewer' })).statusCode).toBe(400);
  });

  it('a removed member loses the Space at once, and their devices are told', async () => {
    const leaver = await person('role-leaver');
    await join(leaver, (await invite(owner, space.spaceId, 'editor')).code);
    expect((await call(owner, 'DELETE', `/v1/spaces/${space.spaceId}/members/${leaver.id}`)).statusCode).toBe(204);
    expect((await call(leaver, 'POST', '/v1/batch', resave('transactions')!)).statusCode).toBe(403);
    const feed = await changes(leaver);
    expect(feed.memberships.map((m) => m.spaceId)).not.toContain(space.spaceId);
    expect(feed.changes.filter((c) => c.record.spaceId === space.spaceId)).toEqual([]);
  });

  it('a member can leave; the owner cannot', async () => {
    const guest = await person('role-guest');
    await join(guest, (await invite(owner, space.spaceId, 'viewer')).code);
    expect((await call(guest, 'DELETE', `/v1/spaces/${space.spaceId}/members/${guest.id}`)).statusCode).toBe(204);
    expect((await call(guest, 'GET', `/v1/spaces/${space.spaceId}/members`)).statusCode).toBe(404);
    const stay = await call(owner, 'DELETE', `/v1/spaces/${space.spaceId}/members/${owner.id}`);
    expect(stay.statusCode).toBe(400);
    expect(stay.json().error).toBe('The owner cannot leave their own Space. Archive or delete it instead.');
  });

  it('joining twice changes nothing and keeps the invite for someone else', async () => {
    const second = await invite(owner, space.spaceId, 'editor');
    const again = await join(editor, second.code);
    expect(again.json()).toMatchObject({ already: true, role: 'editor' });
    const newcomer = await person('role-newcomer');
    expect((await join(newcomer, second.code)).json()).toMatchObject({ already: false, role: 'editor' });
  });

  it('wrong codes are limited, so codes cannot be guessed', async () => {
    const small = buildApp({ db, config: CONFIG, limits: { spaceJoin: { max: 2, windowMs: 60_000 } } });
    for (const code of ['SPC-AAAA-AAA2', 'SPC-AAAA-AAA3'])
      expect((await small.inject({ method: 'POST', url: '/v1/spaces/join', headers: outsider.headers, payload: { code } })).statusCode).toBe(400);
    expect((await small.inject({ method: 'POST', url: '/v1/spaces/join', headers: outsider.headers, payload: { code: 'SPC-AAAA-AAA4' } })).statusCode).toBe(429);
    await small.close();
  });

  it('deleting the owner’s account removes the Space for every member', async () => {
    const boss = await person('gone-owner');
    const staff = await person('gone-staff');
    const shop = await businessSpace(boss);
    await join(staff, (await invite(boss, shop.spaceId, 'editor')).code);
    expect((await call(boss, 'DELETE', '/v1/me', { confirm: 'DELETE' })).statusCode).toBe(200);
    expect((await changes(staff)).memberships.map((m) => m.spaceId)).not.toContain(shop.spaceId);
    expect(((await call(staff, 'GET', '/v1/records/transactions')).json().records as Rec[]).filter((r) => r.spaceId === shop.spaceId)).toEqual([]);
  });
});
