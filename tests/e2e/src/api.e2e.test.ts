/**
 * The web app's store, unchanged, saving through ApiStorage to the real HTTP
 * API and Postgres (PGlite). This is the Phase 2 check: the 12
 * data-consistency scenarios pass against the server, and one user cannot see
 * or change another's data through the app.
 */
import { buildApp } from '@finken/api/src/app';
import { devToken } from '@finken/api/src/auth';
import { migrate } from '@finken/api/src/migrate';
import { testDb } from '@finken/api/src/testing';
import { ApiAuthService, ApiClient, ApiStorage } from '@finken/web/src/data/api';
import { consistencyScenarios } from '@finken/web/src/data/scenarios';
import { MemoryAdapter } from '@finken/web/src/data/storage';
import { AppStore } from '@finken/web/src/data/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'e'.repeat(40);
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

/** One person on one device: their sign-in token, their device's local settings, and a store. */
async function device(subject: string, local = new MemoryAdapter()) {
  await ready;
  const token = await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject });
  const api = new ApiClient({ baseUrl, token: async () => token });
  const storage = new ApiStorage(api, local);
  return { store: new AppStore(storage, new ApiAuthService(api)), storage, local };
}

let main: Awaited<ReturnType<typeof device>>;
const opened: ApiStorage[] = [];

consistencyScenarios('the API and Postgres', async () => {
  main = await device('sam');
  opened.push(main.storage);
  return {
    store: main.store,
    reopen: async () => {
      const again = await device('sam', main.local);
      opened.push(again.storage);
      return again.store;
    },
    settle: async () => {
      for (const s of opened) await s.whenIdle();
    },
    guest: false,
    readTransactions: (ids) => main.storage.getMany('transactions', ids),
  };
});

describe('through the app, one user never reaches another user’s data', () => {
  let other: Awaited<ReturnType<typeof device>>;
  beforeAll(async () => {
    other = await device('lee');
    await other.store.init();
    await other.store.enterGuest('personal');
    await other.storage.whenIdle();
  });

  it('shows each person only their own Spaces and records', () => {
    const mine = new Set(main.store.getState().spaces.map((s) => s.id));
    const theirs = other.store.getState().spaces.map((s) => s.id);
    expect(theirs.length).toBe(3);
    expect(theirs.some((id) => mine.has(id))).toBe(false);
    const myTx = new Set(main.store.getState().transactions.map((t) => t.id));
    expect(other.store.getState().transactions.some((t) => myTx.has(t.id))).toBe(false);
  });

  it('refuses a save into someone else’s Space, and the app shows it could not be saved', async () => {
    const target = main.store.getState().transactions[0];
    const before = { ...target };
    // Lee's app is tricked into writing Sam's transaction id into Sam's Space.
    await expect(other.storage.putMany('transactions', [{ ...target, amount: 1 }])).rejects.toThrow('That record could not be found, or you cannot change it.');
    const reread = await main.storage.getMany('transactions', [target.id]);
    expect(reread[0]).toMatchObject({ amount: before.amount });
  });
});
