/**
 * Phase 9: a business Space shared between people, each on their own device
 * with an offline copy, through the real API. The owner's records reach the
 * people they invite; an editor's sale reaches the owner; a viewer's change
 * is refused and undone on their device; someone removed loses the Space.
 * Every balance stays the same on every device.
 */
import { buildApp } from '@finken/api/src/app';
import { devToken } from '@finken/api/src/auth';
import { migrate } from '@finken/api/src/migrate';
import { testDb } from '@finken/api/src/testing';
import { totalBalance } from '@finken/domain/money';
import { ApiAuthService, ApiClient } from '@finken/web/src/data/api';
import { MemoryAdapter } from '@finken/web/src/data/storage';
import { AppStore, VIEW_ONLY } from '@finken/web/src/data/store';
import { SyncedStorage } from '@finken/web/src/data/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'z'.repeat(40);
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

async function device(subject: string) {
  await ready;
  const token = await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject });
  const api = new ApiClient({ baseUrl, token: async () => token });
  const storage = new SyncedStorage(api, new MemoryAdapter());
  const store = new AppStore(storage, new ApiAuthService(api, storage));
  await store.init();
  expect((await store.signInWithProvider()).ok).toBe(true);
  const settle = async () => {
    await storage.whenIdle();
    await storage.sync().catch(() => {});
    await storage.whenIdle();
    // The store reloads after sync tells it something changed.
    await new Promise((r) => setTimeout(r, 20));
  };
  await settle();
  return { api, storage, store, settle };
}

type Device = Awaited<ReturnType<typeof device>>;

describe('a shop shared with staff and an accountant', () => {
  let owner: Device;
  let staff: Device;
  let accountant: Device;
  let shop = '';

  const balance = (d: Device) => {
    const s = d.store.getState();
    return totalBalance(
      s.accounts.filter((a) => a.spaceId === shop),
      s.transactions.filter((t) => t.spaceId === shop),
    );
  };
  const inviteCode = async (role: 'editor' | 'viewer') => (await owner.api.request<{ code: string }>('POST', `/v1/spaces/${shop}/invites`, { role })).code;

  beforeAll(async () => {
    owner = await device('shop-owner');
    await owner.store.enterGuest('business');
    await owner.settle();
    shop = owner.store.getState().spaces.find((s) => s.type === 'business')!.id;
    staff = await device('shop-staff');
    accountant = await device('shop-accountant');
  });

  it('the people invited get every record the shop already had, with the same balance', async () => {
    await staff.api.request('POST', '/v1/spaces/join', { code: await inviteCode('editor') });
    await accountant.api.request('POST', '/v1/spaces/join', { code: await inviteCode('viewer') });
    await staff.settle();
    await accountant.settle();

    const count = (d: Device) => d.store.getState().transactions.filter((t) => t.spaceId === shop).length;
    expect(count(staff)).toBe(count(owner));
    expect(count(accountant)).toBe(count(owner));
    expect(balance(staff)).toBe(balance(owner));
    expect(balance(accountant)).toBe(balance(owner));
    // The shop shows in their Spaces, shared, with their role.
    expect(staff.store.getState().spaces.map((s) => s.id)).toContain(shop);
    expect(staff.store.getState().roles[shop]).toBe('editor');
    expect(accountant.store.getState().roles[shop]).toBe('viewer');
    expect(owner.store.roleIn(shop)).toBe('owner');
  });

  it('a sale recorded by staff reaches the owner and the accountant', async () => {
    const s = staff.store.getState();
    const till = s.accounts.find((a) => a.spaceId === shop && !a.archived)!;
    const sales = s.categories.find((c) => c.spaceId === shop && c.kind === 'income')!;
    const before = balance(owner);
    const sale = staff.store.addTransaction({
      spaceId: shop,
      type: 'income',
      amount: 450_000,
      date: '2026-11-18',
      description: 'Counter sale',
      accountId: till.id,
      categoryId: sales.id,
    });
    expect(sale.ok).toBe(true);
    await staff.settle();
    await owner.settle();
    await accountant.settle();
    expect(balance(owner)).toBe(before + 450_000);
    expect(balance(accountant)).toBe(balance(owner));
    const id = sale.ok ? sale.transaction.id : '';
    expect(owner.store.getState().transactions.find((t) => t.id === id)).toMatchObject({ amount: 450_000, description: 'Counter sale' });
  });

  it('the accountant can only look: Finken says so, and nothing changes anywhere', async () => {
    const s = accountant.store.getState();
    const till = s.accounts.find((a) => a.spaceId === shop && !a.archived)!;
    const before = balance(owner);
    const tried = accountant.store.addTransaction({ spaceId: shop, type: 'expense', amount: 100, date: '2026-11-18', description: 'Should not save', accountId: till.id });
    expect(tried).toEqual({ ok: false, error: VIEW_ONLY });
    expect(accountant.store.canEdit(shop)).toBe(false);
    const someone = s.transactions.find((t) => t.spaceId === shop)!;
    expect(accountant.store.setTransactionNotes(someone.id, 'changed')).toEqual({ ok: false, error: VIEW_ONLY });
    await accountant.settle();
    await owner.settle();
    expect(balance(owner)).toBe(before);
    expect(balance(accountant)).toBe(before);
  });

  it('a change the server refuses is undone on the viewer’s device, with the reason', async () => {
    // As if the viewer's app were old or modified and skipped its own check.
    const s = accountant.store.getState();
    const record = s.transactions.find((t) => t.spaceId === shop && t.type === 'expense')!;
    await accountant.storage.put('transactions', { ...record, amount: record.amount + 1 });
    await accountant.settle();
    expect(accountant.store.getState().transactions.find((t) => t.id === record.id)?.amount).toBe(record.amount);
    expect(accountant.store.getState().error).toMatch(/^A change made earlier could not be saved: That record could not be found, or you cannot change it\./);
  });

  it('when the owner lets the accountant edit, the device knows without signing in again', async () => {
    const me = await accountant.api.request<{ id: string }>('GET', '/v1/me');
    await owner.api.request('PATCH', `/v1/spaces/${shop}/members/${me.id}`, { role: 'editor' });
    await accountant.settle();
    expect(accountant.store.canEdit(shop)).toBe(true);
    await owner.api.request('PATCH', `/v1/spaces/${shop}/members/${me.id}`, { role: 'viewer' });
    await accountant.settle();
    expect(accountant.store.canEdit(shop)).toBe(false);
  });

  it('staff who are removed lose the shop from their device; the owner keeps everything they added', async () => {
    const me = await staff.api.request<{ id: string }>('GET', '/v1/me');
    const before = owner.store.getState().transactions.filter((t) => t.spaceId === shop).length;
    await owner.api.request('DELETE', `/v1/spaces/${shop}/members/${me.id}`);
    await staff.settle();
    const left = staff.store.getState();
    expect(left.spaces.map((s) => s.id)).not.toContain(shop);
    expect(left.transactions.filter((t) => t.spaceId === shop)).toEqual([]);
    expect(left.accounts.filter((a) => a.spaceId === shop)).toEqual([]);
    // Their own Spaces are untouched, and they are not left without one in view.
    expect(left.activeSpaceId).not.toBe(shop);
    await owner.settle();
    expect(owner.store.getState().transactions.filter((t) => t.spaceId === shop)).toHaveLength(before);
  });
});
