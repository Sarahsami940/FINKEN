import { describe, expect, it } from 'vitest';
import { AuditedStorage, type AuditFields, MemoryAdapter } from './storage';

type Row = { id: string; name: string } & AuditFields;

function setup() {
  const inner = new MemoryAdapter();
  let user = 'u1';
  let tick = 0;
  const storage = new AuditedStorage(
    inner,
    () => user,
    () => `2026-01-01T00:00:0${tick++}.000Z`,
  );
  return {
    inner,
    storage,
    as: (id: string) => {
      user = id;
    },
  };
}

describe('change history', () => {
  it('stamps who and when on every save, keeps the original creation, and counts versions', async () => {
    const { storage, as } = setup();
    await storage.put<Row>('accounts', { id: 'a', name: 'Cash' });
    as('u2');
    // A caller cannot rewrite history by sending its own values.
    await storage.put<Row>('accounts', { id: 'a', name: 'Wallet', createdAt: 'spoofed', version: 99 });
    const [row] = await storage.getAll<Row>('accounts');
    expect(row).toMatchObject({ name: 'Wallet', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1', updatedBy: 'u2', updatedAt: '2026-01-01T00:00:01.000Z', version: 2 });
  });

  it('gives quick successive saves different versions', async () => {
    const { storage } = setup();
    await Promise.all([1, 2, 3].map((n) => storage.put<Row>('transactions', { id: 't', name: `v${n}` })));
    const [row] = await storage.getAll<Row>('transactions');
    expect([row.version, row.name]).toEqual([3, 'v3']);
  });
});

describe('soft delete', () => {
  it('hides deleted records, keeps them for sync, and restores them when saved again', async () => {
    const { storage } = setup();
    await storage.putMany<Row>('transactions', [
      { id: 'x', name: 'Keep' },
      { id: 'y', name: 'Remove' },
    ]);
    await storage.remove('transactions', 'y');
    expect((await storage.getAll<Row>('transactions')).map((r) => r.id)).toEqual(['x']);
    const [gone] = await storage.getDeleted<Row>('transactions');
    expect(gone).toMatchObject({ id: 'y', deletedBy: 'u1', version: 2 });
    expect(gone.deletedAt).toBeTruthy();
    await storage.put<Row>('transactions', { id: 'y', name: 'Remove' });
    const back = (await storage.getAll<Row>('transactions')).find((r) => r.id === 'y');
    expect(back).toMatchObject({ version: 3 });
    expect(back?.deletedAt).toBeUndefined();
  });

  it('erases sign-in data for real, and purges money records only on request', async () => {
    const { storage, inner } = setup();
    await storage.put('credentials', { id: 'c' });
    await storage.remove('credentials', 'c');
    expect(await inner.getAll('credentials')).toEqual([]);
    await storage.put<Row>('goals', { id: 'g', name: 'Trip' });
    await storage.purgeMany('goals', ['g']);
    expect(await inner.getAll('goals')).toEqual([]);
  });
});
