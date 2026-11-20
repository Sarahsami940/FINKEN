/**
 * Phase 4: moving data saved in this browser into a Finken account, through
 * the real API and Postgres. The check: everything arrives exactly as it was,
 * nothing is ever duplicated or lost (even when the connection drops
 * mid-move), and nobody can move data that is not theirs.
 */
import { buildApp } from '@finken/api/src/app';
import { devToken } from '@finken/api/src/auth';
import { migrate } from '@finken/api/src/migrate';
import { testDb } from '@finken/api/src/testing';
import { accountBalances, totalBalance } from '@finken/domain/money';
import type { Space, Transaction } from '@finken/domain/types';
import { ApiAuthService, ApiClient } from '@finken/web/src/data/api';
import { LocalDataMover, type MoveResult } from '@finken/web/src/data/migration';
import { type Entity, MemoryAdapter } from '@finken/web/src/data/storage';
import { AppStore } from '@finken/web/src/data/store';
import { SyncedStorage } from '@finken/web/src/data/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'm'.repeat(40);
let baseUrl = '';
let close: () => Promise<void> = async () => {};
const ready = (async () => {
  const db = await testDb();
  await migrate(db);
  const app = buildApp({ db, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  close = async () => {
    await app.close();
    await db.close();
  };
})();
afterAll(() => close());

/** A connection to the account, with a switch that loses the server's answer to the next save. */
async function account(subject: string) {
  await ready;
  const token = await devToken(SECRET, { subject, email: `${subject}@example.com` });
  const net = { dropNextAnswer: false };
  const api = new ApiClient({
    baseUrl,
    token: async () => token,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (net.dropNextAnswer && String(input).endsWith('/v1/batch')) {
        net.dropNextAnswer = false;
        // The server saved it, but the answer never arrives.
        throw new TypeError('Failed to fetch');
      }
      return res;
    },
  });
  return { api, net };
}

/** A second device signed in to the account: what the person sees after moving. */
async function signedInDevice(subject: string) {
  const { api } = await account(subject);
  const storage = new SyncedStorage(api, new MemoryAdapter());
  const store = new AppStore(storage, new ApiAuthService(api));
  await store.init();
  await store.signInWithProvider();
  await storage.whenIdle();
  await storage.sync();
  await storage.whenIdle();
  return store;
}

const figures = (store: AppStore, spaceId: string) => {
  const s = store.getState();
  const accounts = s.accounts.filter((a) => a.spaceId === spaceId);
  const transactions = s.transactions.filter((t) => t.spaceId === spaceId);
  return {
    total: totalBalance(accounts, transactions),
    each: accountBalances(accounts, transactions).map((b) => [b.account.id, b.balance]),
    transactions: transactions.map((t) => [t.id, t.amount, t.date, t.type]).sort(),
    obligations: s.obligations.filter((o) => o.spaceId === spaceId).length,
    goalEntries: s.goalEntries.filter((g) => g.spaceId === spaceId).length,
  };
};

const statuses = (results: MoveResult[]) => results.map((r) => r.status);

describe('moving data from this browser into an account', () => {
  // This browser, as it was before accounts lived on the server.
  const local = new MemoryAdapter();
  let browser: AppStore;
  let guestSpaces: Space[] = [];
  let samSpace = '';

  beforeAll(async () => {
    browser = new AppStore(local);
    await browser.init();
    // A guest who tried the demo and added their own expense.
    await browser.enterGuest('personal');
    guestSpaces = browser.getState().spaces;
    const personal = guestSpaces.find((s) => s.type === 'personal')!;
    const s = browser.getState();
    const bank = s.accounts.find((a) => a.spaceId === personal.id && a.kind === 'bank')!.id;
    const food = s.categories.find((c) => c.spaceId === personal.id && c.name === 'Food')!.id;
    expect(
      browser.addTransaction({ spaceId: personal.id, type: 'expense', amount: 125050, date: '2026-11-17', description: 'Groceries', accountId: bank, categoryId: food }).ok,
    ).toBe(true);
    // Someone else made an account on the same computer.
    browser.signOut();
    expect((await browser.register({ name: 'Sam', email: 'sam@example.com', password: 'sam-secret-1', confirmPassword: 'sam-secret-1' })).ok).toBe(true);
    samSpace = browser.createSpace({ name: 'Sam’s shop', type: 'business', icon: 'briefcase', description: '', currency: 'PKR' })!.id;
    const shopAccount = browser.addAccount(samSpace, { name: 'Till', kind: 'cash', openingBalance: 500000 });
    expect(shopAccount.ok).toBe(true);
    browser.signOut();
    // Let the browser finish saving.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('lists every Space in this browser, with whose it is', async () => {
    const mover = new LocalDataMover(local, (await account('pat')).api);
    const listed = await mover.list();
    expect(listed.map((l) => l.space.id).sort()).toEqual([...guestSpaces.map((s) => s.id), samSpace].sort());
    const sam = listed.find((l) => l.space.id === samSpace)!;
    expect(sam.owner).toMatchObject({ email: 'sam@example.com', isGuest: false, locked: true });
    const samAccounts = (await local.getAll<Entity & { spaceId: string; name: string }>('accounts')).filter((a) => a.spaceId === samSpace);
    expect(samAccounts.map((a) => a.name)).toContain('Till');
    expect(sam.counts.accounts).toBe(samAccounts.length);
    const guest = listed.filter((l) => l.owner.isGuest);
    expect(guest.every((l) => l.sample && !l.owner.locked && !l.moved)).toBe(true);
    expect(guest.find((l) => l.space.type === 'personal')!.counts.transactions).toBeGreaterThan(10);
  });

  it('moves the guest’s Spaces, and the account shows exactly the same figures', async () => {
    const mover = new LocalDataMover(local, (await account('pat')).api);
    const progress: number[] = [];
    const results = await mover.move(
      guestSpaces.map((s) => s.id),
      (done) => progress.push(done),
    );
    expect(statuses(results)).toEqual(['moved', 'moved', 'moved']);
    expect(progress.at(-1)).toBe(3);

    const laptop = await signedInDevice('pat');
    await browser.enterGuest();
    for (const space of guestSpaces) {
      expect(figures(laptop, space.id)).toEqual(figures(browser, space.id));
      expect(results.find((r) => r.spaceId === space.id)!.balance).toBe(figures(browser, space.id).total);
    }
    expect(laptop.getState().transactions.find((t) => t.description === 'Groceries')).toMatchObject({ amount: 125050 });
    expect((await mover.list()).filter((l) => l.moved?.userId).length).toBe(3);
  });

  it('skips Spaces already moved, writing nothing', async () => {
    const { api } = await account('pat');
    const before = (await api.request<{ cursor: number }>('GET', '/v1/changes?since=0')).cursor;
    const results = await new LocalDataMover(local, api).move(guestSpaces.map((s) => s.id));
    expect(statuses(results)).toEqual(['already', 'already', 'already']);
    expect((await api.request<{ cursor: number }>('GET', '/v1/changes?since=0')).cursor).toBe(before);
  });

  it('needs the password of an account made on this device before moving its Spaces', async () => {
    const mover = new LocalDataMover(local, (await account('pat')).api);
    const [locked] = await mover.move([samSpace]);
    expect(locked).toMatchObject({ status: 'failed', message: 'Enter the password for sam@example.com first.' });
    await expect(mover.unlock('sam@example.com', 'wrong-password')).rejects.toThrow('That email and password do not match an account on this device.');
    await mover.unlock('sam@example.com', 'sam-secret-1');
    expect((await mover.list()).find((l) => l.space.id === samSpace)!.owner.locked).toBe(false);
    expect(statuses(await mover.move([samSpace]))).toEqual(['moved']);
  });

  it('refuses to move a Space into a second account', async () => {
    const kim = await account('kim');
    const [again] = await new LocalDataMover(local, kim.api).move([guestSpaces[0].id]);
    expect(again).toMatchObject({ status: 'failed', message: 'This Space was already moved to a different Finken account.' });

    // A copy of the same data in another browser has no mark, and the server still says no.
    const copy = new MemoryAdapter();
    for (const c of ['spaces', 'accounts', 'categories', 'transactions'] as const) await copy.putMany(c, await local.getAll(c));
    const [blocked] = await new LocalDataMover(copy, kim.api).move([guestSpaces[0].id]);
    expect(blocked).toMatchObject({ status: 'failed', message: 'This Space is already in another Finken account, so it cannot be moved into this one.' });
    expect((await kim.api.request<{ records: Entity[] }>('GET', '/v1/records/spaces')).records).toHaveLength(0);
  });

  it('never makes a second copy when the connection drops mid-move, and keeps edits made in the account since', async () => {
    const phone = new MemoryAdapter();
    const store = new AppStore(phone);
    await store.init();
    await store.enterGuest('family');
    const family = store.getState().spaces.find((s) => s.type === 'family')!;
    await new Promise((r) => setTimeout(r, 0));

    const lee = await account('lee');
    const mover = new LocalDataMover(phone, lee.api);
    lee.net.dropNextAnswer = true;
    const [lost] = await mover.move([family.id]);
    expect(lost).toMatchObject({ status: 'failed', message: expect.stringContaining('could not reach its server') });
    expect((await mover.list()).find((l) => l.space.id === family.id)!.moved).toBeNull();

    // Meanwhile Lee edits an expense in the account on another device.
    const edited = store.getState().transactions.find((t) => t.spaceId === family.id && t.type === 'expense')!;
    const { records } = await lee.api.request<{ records: Transaction[] }>('POST', '/v1/records/transactions/get', { ids: [edited.id] });
    await lee.api.request('POST', '/v1/batch', { puts: { transactions: [{ ...records[0], description: 'Edited in the account' }] } });

    const [retried] = await mover.move([family.id]);
    expect(retried).toMatchObject({ status: 'moved', keptNewer: 1 });
    const server = await lee.api.request<{ records: Transaction[] }>('GET', '/v1/records/transactions');
    const local = store.getState().transactions.filter((t) => t.spaceId === family.id);
    expect(server.records).toHaveLength(local.length);
    expect(server.records.find((t) => t.id === edited.id)!.description).toBe('Edited in the account');
  });

  it('moves nothing from a Space the money rules refuse, and names the record', async () => {
    const odd = new MemoryAdapter();
    const space = {
      id: 'old-space',
      ownerId: 'guest',
      name: 'Old notes',
      type: 'personal',
      icon: 'home',
      description: '',
      currency: 'PKR',
      createdAt: '2025-01-01T00:00:00.000Z',
      status: 'active',
    };
    await odd.put('spaces', space);
    await odd.put('accounts', { id: 'old-cash', spaceId: space.id, name: 'Cash', kind: 'cash', openingBalance: 100000 });
    await odd.put('categories', { id: 'old-food', spaceId: space.id, name: 'Food', kind: 'expense', icon: 'utensils', color: 'orange', subcategories: [] });
    const base = {
      spaceId: space.id,
      accountId: 'old-cash',
      categoryId: 'old-food',
      currency: 'PKR',
      status: 'confirmed',
      createdAt: '2025-01-02T00:00:00.000Z',
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    await odd.put('transactions', { ...base, id: 'old-lunch', type: 'expense', amount: 50000, date: '2025-01-02', description: 'Lunch' });
    // Saved by an early version, before refunds were checked: more back than was paid.
    await odd.put('transactions', { ...base, id: 'old-refund', type: 'refund', amount: 90000, date: '2025-01-03', description: 'Lunch refund', refundOfId: 'old-lunch' });

    const { api } = await account('ray');
    const [result] = await new LocalDataMover(odd, api).move([space.id]);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/^Nothing in this Space was moved\. "Lunch( refund)?" on 2025-01-0[23]: .+ Fix it in Finken on this device, then try again\.$/);
    expect((await api.request<{ records: Entity[] }>('GET', '/v1/records/spaces')).records).toHaveLength(0);
    expect((await api.request<{ records: Entity[] }>('GET', '/v1/records/accounts')).records).toHaveLength(0);

    // A record in a shape the account cannot take is named too, with what to do.
    await odd.remove('transactions', 'old-refund');
    await odd.put('categories', { id: 'old-food', spaceId: space.id, name: 'Food', kind: 'expense', icon: 'utensils', color: 'orange' });
    const [shape] = await new LocalDataMover(odd, api).move([space.id]);
    expect(shape.message).toBe(
      'Nothing in this Space was moved. "Food" was saved by an older version of Finken in a form the account cannot take (subcategories). Contact support and we will move it for you.',
    );
  });

  it('saves a backup of everything, and removes only moved Spaces from this device when asked', async () => {
    const mover = new LocalDataMover(local, (await account('pat')).api);
    const backup = JSON.parse(await mover.backup(guestSpaces.map((s) => s.id))) as { format: string; spaces: { transactions: Transaction[] }[] };
    expect(backup.format).toBe('finken-backup');
    const transactions = backup.spaces.flatMap((s) => s.transactions);
    expect(transactions.length).toBe(browser.getState().transactions.filter((t) => guestSpaces.some((s) => s.id === t.spaceId)).length);

    const notMoved = new MemoryAdapter();
    await notMoved.put('spaces', {
      id: 'keep-me',
      ownerId: 'guest',
      name: 'Keep',
      type: 'personal',
      icon: 'home',
      description: '',
      currency: 'PKR',
      createdAt: '2025-01-01T00:00:00.000Z',
      status: 'active',
    });
    expect(await new LocalDataMover(notMoved, (await account('pat')).api).forget(['keep-me'])).toBe(0);
    expect(await notMoved.getAll('spaces')).toHaveLength(1);

    expect(await mover.forget(guestSpaces.map((s) => s.id))).toBe(3);
    const left = await local.getAll<Space>('spaces');
    expect(left.map((s) => s.id)).toEqual([samSpace]);
    expect((await local.getAll<Transaction>('transactions')).some((t) => guestSpaces.some((s) => s.id === t.spaceId))).toBe(false);
    // Still all there in the account.
    const laptop = await signedInDevice('pat');
    expect(laptop.getState().spaces.map((s) => s.id)).toEqual(expect.arrayContaining(guestSpaces.map((s) => s.id)));
  });
});
