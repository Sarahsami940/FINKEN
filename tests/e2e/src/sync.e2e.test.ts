/**
 * Phase 3: two devices on one account, each with its own offline copy,
 * syncing through the real API and Postgres. The Phase 3 check: an expense
 * added offline on a phone appears correctly on a laptop, and editing it on
 * both never corrupts any balance.
 */
import { buildApp } from '@finken/api/src/app';
import { devToken } from '@finken/api/src/auth';
import { migrate } from '@finken/api/src/migrate';
import { testDb } from '@finken/api/src/testing';
import { accountBalances, totalBalance } from '@finken/domain/money';
import type { Transaction } from '@finken/domain/types';
import { ApiAuthService, ApiClient } from '@finken/web/src/data/api';
import { consistencyScenarios } from '@finken/web/src/data/scenarios';
import { MemoryAdapter } from '@finken/web/src/data/storage';
import { AppStore } from '@finken/web/src/data/store';
import { SyncedStorage } from '@finken/web/src/data/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'y'.repeat(40);
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

/** A device: its own offline copy, a switch for its connection, an adjustable clock, and the app's store. */
async function device(subject: string, cache = new MemoryAdapter()) {
  await ready;
  const token = await devToken(SECRET, { subject, email: `${subject}@example.com` });
  const net = { online: true, serverDown: false, changesFetched: [] as number[] };
  const clock = { now: new Date('2026-11-18T09:00:00Z') };
  const api = new ApiClient({
    baseUrl,
    token: async () => token,
    fetch: async (input, init) => {
      if (!net.online) throw new TypeError('Failed to fetch');
      if (net.serverDown) return new Response('{"error":"Bad gateway"}', { status: 502 });
      const res = await fetch(input, init);
      if (String(input).includes('/v1/changes')) net.changesFetched.push(((await res.clone().json()) as { changes: unknown[] }).changes.length);
      return res;
    },
  });
  const storage = new SyncedStorage(api, cache, { clock: () => clock.now });
  const store = new AppStore(storage, new ApiAuthService(api, storage));
  const settle = async () => {
    await storage.whenIdle();
    await storage.sync().catch(() => {});
    await storage.whenIdle();
  };
  return { store, storage, cache, net, clock, settle };
}

// The 12 scenarios once more, with every save going through the offline copy and the outbox.
let scenarioDevice: Awaited<ReturnType<typeof device>>;
consistencyScenarios('offline-first sync', async () => {
  scenarioDevice = await device('sync-scenarios');
  return {
    store: scenarioDevice.store,
    reopen: async () => {
      // Another device on the same account: it gets everything from the server.
      const other = await device('sync-scenarios');
      await other.store.init();
      await other.store.signInWithProvider();
      await other.settle();
      return other.store;
    },
    settle: scenarioDevice.settle,
    guest: false,
    readTransactions: async (ids) => {
      const api = new ApiClient({ baseUrl, token: async () => devToken(SECRET, { subject: 'sync-scenarios' }) });
      return (await api.request<{ records: (Transaction & { createdBy?: string; updatedAt?: string; version?: number })[] }>('POST', '/v1/records/transactions/get', { ids }))
        .records;
    },
  };
});

describe('a phone and a laptop on one account', () => {
  let phone: Awaited<ReturnType<typeof device>>;
  let laptop: Awaited<ReturnType<typeof device>>;
  let spaceId = '';
  let bank = '';
  let food = '';

  const balances = (d: typeof phone) => {
    const s = d.store.getState();
    const accounts = s.accounts.filter((a) => a.spaceId === spaceId);
    const transactions = s.transactions.filter((t) => t.spaceId === spaceId);
    return { total: totalBalance(accounts, transactions), each: accountBalances(accounts, transactions).map((b) => [b.account.id, b.balance]) };
  };
  const find = (d: typeof phone, id: string) => d.store.getState().transactions.find((t) => t.id === id);
  const expense = (amount: number, description: string) => ({ spaceId, type: 'expense' as const, amount, date: '2026-11-18', description, accountId: bank, categoryId: food });
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error);
    return r as Extract<T, { ok: true }>;
  };

  beforeAll(async () => {
    phone = await device('pat');
    await phone.store.init();
    await phone.store.enterGuest('personal');
    await phone.settle();
    spaceId = phone.store.getState().activeSpaceId!;
    const s = phone.store.getState();
    bank = s.accounts.find((a) => a.spaceId === spaceId && a.kind === 'bank')!.id;
    food = s.categories.find((c) => c.spaceId === spaceId && c.name === 'Food')!.id;

    laptop = await device('pat');
    await laptop.store.init();
    // A new device: signing in brings everything down from the server.
    expect((await laptop.store.signInWithProvider()).ok).toBe(true);
    await laptop.settle();
  });

  it('starts with the same data on both', () => {
    expect(
      laptop.store
        .getState()
        .spaces.map((s) => s.id)
        .sort(),
    ).toEqual(
      phone.store
        .getState()
        .spaces.map((s) => s.id)
        .sort(),
    );
    expect(balances(laptop)).toEqual(balances(phone));
  });

  it('records an expense offline on the phone and shows it on the laptop once the phone is back online', async () => {
    phone.net.online = false;
    const before = balances(phone).total;
    const { transaction } = ok(phone.store.addTransaction(expense(250050, 'Offline lunch')));
    await phone.settle();
    // Saved on the phone at once, with nothing lost while offline.
    expect(find(phone, transaction.id)).toBeTruthy();
    expect(balances(phone).total).toBe(before - 250050);
    expect(await phone.storage.status()).toMatchObject({ pending: 1, online: false });
    await laptop.settle();
    expect(find(laptop, transaction.id)).toBeUndefined();

    phone.net.online = true;
    await phone.settle();
    expect(await phone.storage.status()).toMatchObject({ pending: 0, online: true });
    await laptop.settle();
    expect(find(laptop, transaction.id)).toMatchObject({ amount: 250050, description: 'Offline lunch' });
    expect(balances(laptop)).toEqual(balances(phone));
  });

  it('keeps the later of two offline edits to the same expense, on both devices, whichever syncs first', async () => {
    const { transaction } = ok(phone.store.addTransaction(expense(100000, 'Shared edit')));
    await phone.settle();
    await laptop.settle();

    for (const phoneFirst of [true, false]) {
      phone.net.online = laptop.net.online = false;
      phone.clock.now = new Date(phoneFirst ? '2026-11-18T10:00:00Z' : '2026-11-18T12:05:00Z');
      laptop.clock.now = new Date(phoneFirst ? '2026-11-18T10:05:00Z' : '2026-11-18T12:00:00Z');
      ok(phone.store.updateTransaction(transaction.id, expense(phoneFirst ? 111100 : 444400, 'Edited on the phone')));
      ok(laptop.store.updateTransaction(transaction.id, expense(phoneFirst ? 222200 : 333300, 'Edited on the laptop')));
      await phone.settle();
      await laptop.settle();

      // The older edit reaches the server first in the first round, last in the second.
      const [first, second] = phoneFirst ? [phone, laptop] : [laptop, phone];
      first.net.online = true;
      await first.settle();
      second.net.online = true;
      await second.settle();
      await first.settle();

      const winner = phoneFirst ? { amount: 222200, description: 'Edited on the laptop' } : { amount: 444400, description: 'Edited on the phone' };
      expect(find(phone, transaction.id)).toMatchObject(winner);
      expect(find(laptop, transaction.id)).toMatchObject(winner);
      expect(balances(laptop)).toEqual(balances(phone));
      expect(phone.store.getState().error).toBeNull();
      expect(laptop.store.getState().error).toBeNull();
    }
  });

  it('undoes a change the server refuses, and says why, without touching any balance', async () => {
    phone.clock.now = laptop.clock.now = new Date('2026-11-18T14:00:00Z');
    const { transaction: shoes } = ok(phone.store.addTransaction(expense(500000, 'Shoes')));
    await phone.settle();
    await laptop.settle();
    // Both refund the whole amount while offline: together that is twice what was paid.
    phone.net.online = laptop.net.online = false;
    const refund = { ...expense(500000, 'Refund'), type: 'refund' as const, refundOfId: shoes.id };
    ok(phone.store.addTransaction(refund));
    laptop.clock.now = new Date('2026-11-18T14:10:00Z');
    const { transaction: second } = ok(laptop.store.addTransaction(refund));
    await phone.settle();
    await laptop.settle();

    phone.net.online = true;
    await phone.settle();
    laptop.net.online = true;
    await laptop.settle();
    await phone.settle();

    expect(laptop.store.getState().error).toBe('A change made earlier could not be saved: That expense has already been refunded in full.');
    expect(find(laptop, second.id)).toBeUndefined();
    expect(laptop.store.getState().transactions.filter((t) => t.refundOfId === shoes.id)).toHaveLength(1);
    expect(balances(laptop)).toEqual(balances(phone));
    laptop.store.dismissError();
  });

  it('keeps changes made offline when the app is closed, and sends them when it opens again', async () => {
    phone.net.online = false;
    const { transaction } = ok(phone.store.addTransaction(expense(9900, 'Before closing')));
    await phone.settle();
    // The app closes. Later it opens again on the same device, with a connection.
    const reopened = await device('pat', phone.cache);
    await reopened.store.init();
    expect(reopened.store.getState().transactions.some((t) => t.id === transaction.id)).toBe(true);
    await reopened.settle();
    expect(await reopened.storage.status()).toMatchObject({ pending: 0 });
    await laptop.settle();
    expect(find(laptop, transaction.id)).toMatchObject({ amount: 9900 });
    phone = reopened;
  });

  it('opens without a connection, or with the server down, as the person last signed in', async () => {
    const before = balances(phone);
    for (const way of ['no connection', 'server down'] as const) {
      const reopened = await device('pat', phone.cache);
      reopened.net.online = way !== 'no connection';
      reopened.net.serverDown = way === 'server down';
      await reopened.store.init();
      expect(reopened.store.getState(), way).toMatchObject({ error: null, user: { email: 'pat@example.com' } });
      expect(balances(reopened), way).toEqual(before);
    }
  });

  it('fetches only what changed since the last sync', async () => {
    await laptop.settle();
    laptop.net.changesFetched.length = 0;
    await laptop.settle();
    expect(laptop.net.changesFetched).toEqual([0]);
    ok(phone.store.addTransaction(expense(100, 'One more')));
    await phone.settle();
    laptop.net.changesFetched.length = 0;
    await laptop.settle();
    expect(laptop.net.changesFetched).toEqual([1]);
  });
});
