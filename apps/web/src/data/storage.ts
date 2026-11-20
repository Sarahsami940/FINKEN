import { MONEY_FIELDS, type MoneyCollection, recordToMinor } from '@finken/domain/units';
/**
 * Storage abstraction. The app only ever talks to `StorageAdapter`, so the
 * IndexedDB implementation below can be swapped for Firebase or any other
 * backend without touching business logic or UI.
 */

export const COLLECTIONS = [
  'users',
  'credentials',
  'spaces',
  'accounts',
  'categories',
  'transactions',
  'recurring',
  'people',
  'obligations',
  'budgets',
  'goals',
  'goalEntries',
  'meta',
  /** Changes made on this device that have not reached the server yet (sync only). */
  'outbox',
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

export interface Entity {
  id: string;
}

/** What a storage that syncs with a server tells the store. */
export type StorageEvent =
  /** Records changed underneath: another device's changes arrived, or a refused one was undone. */
  | { type: 'changed' }
  /** The server refused a change made earlier on this device; it has been undone here. */
  | { type: 'rejected'; message: string };

export interface StorageAdapter {
  /** True when the adapter keeps change history and soft deletes itself, as the API does. */
  readonly audited?: boolean;
  /** Storages that sync with a server report changes the store did not make. */
  subscribe?(listener: (event: StorageEvent) => void): () => void;
  getAll<T extends Entity>(collection: CollectionName): Promise<T[]>;
  /** The stored copies of these ids, where they exist. */
  getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]>;
  put<T extends Entity>(collection: CollectionName, item: T): Promise<void>;
  putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void>;
  remove(collection: CollectionName, id: string): Promise<void>;
  removeMany(collection: CollectionName, ids: string[]): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'finken';
// v2 adds `credentials`; v3 adds `people` and `obligations`;
// v4 adds `budgets`, `goals` and `goalEntries`;
// v5 stores money in paisa instead of rupees (see MONEY_FIELDS);
// v6 adds `outbox`, for changes waiting to reach the server.
// Upgrades add missing stores and convert data in place, in the upgrade's own
// transaction: if anything fails, the browser keeps the old version untouched.
const DB_VERSION = 6;
const FIRST_PAISA_VERSION = 5;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class IndexedDbAdapter implements StorageAdapter {
  private db: Promise<IDBDatabase>;

  /** Pass a name to keep a separate database, such as the offline copy of one account's data. */
  constructor(name = DB_NAME) {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(name, DB_VERSION);
      open.onupgradeneeded = (event) => {
        for (const name of COLLECTIONS) {
          if (!open.result.objectStoreNames.contains(name)) {
            open.result.createObjectStore(name, { keyPath: 'id' });
          }
        }
        // Data saved before v5 holds rupees. A new database (oldVersion 0) has nothing to convert.
        const tx = open.transaction;
        if (tx && event.oldVersion > 0 && event.oldVersion < FIRST_PAISA_VERSION) {
          for (const name of Object.keys(MONEY_FIELDS) as MoneyCollection[]) {
            const cursor = tx.objectStore(name).openCursor();
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c) return;
              c.update(recordToMinor(name, c.value));
              c.continue();
            };
          }
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  async getAll<T extends Entity>(collection: CollectionName): Promise<T[]> {
    const db = await this.db;
    return request<T[]>(db.transaction(collection).objectStore(collection).getAll());
  }

  async getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const store = (await this.db).transaction(collection).objectStore(collection);
    const found = (await Promise.all(ids.map((id) => request(store.get(id))))) as (T | undefined)[];
    return found.filter((x): x is T => x !== undefined);
  }

  put<T extends Entity>(collection: CollectionName, item: T): Promise<void> {
    return this.putMany(collection, [item]);
  }

  async putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void> {
    if (items.length === 0) return;
    const tx = (await this.db).transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    for (const item of items) store.put(item);
    return done(tx);
  }

  remove(collection: CollectionName, id: string): Promise<void> {
    return this.removeMany(collection, [id]);
  }

  async removeMany(collection: CollectionName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = (await this.db).transaction(collection, 'readwrite');
    const store = tx.objectStore(collection);
    for (const id of ids) store.delete(id);
    return done(tx);
  }

  async clearAll(): Promise<void> {
    const tx = (await this.db).transaction([...COLLECTIONS], 'readwrite');
    for (const name of COLLECTIONS) tx.objectStore(name).clear();
    return done(tx);
  }
}

/** Non-persistent fallback for environments without IndexedDB (and for tests). */
export class MemoryAdapter implements StorageAdapter {
  private data = new Map<CollectionName, Map<string, Entity>>();

  private bucket(collection: CollectionName) {
    let bucket = this.data.get(collection);
    if (!bucket) this.data.set(collection, (bucket = new Map()));
    return bucket;
  }

  async getAll<T extends Entity>(collection: CollectionName): Promise<T[]> {
    return [...this.bucket(collection).values()] as T[];
  }
  async getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]> {
    const bucket = this.bucket(collection);
    return ids.flatMap((id) => (bucket.has(id) ? [structuredClone(bucket.get(id)) as T] : []));
  }
  async put<T extends Entity>(collection: CollectionName, item: T) {
    this.bucket(collection).set(item.id, item);
  }
  async putMany<T extends Entity>(collection: CollectionName, items: T[]) {
    for (const item of items) this.bucket(collection).set(item.id, item);
  }
  async remove(collection: CollectionName, id: string) {
    this.bucket(collection).delete(id);
  }
  async removeMany(collection: CollectionName, ids: string[]) {
    for (const id of ids) this.bucket(collection).delete(id);
  }
  async clearAll() {
    this.data.clear();
  }
}

export function createStorage(): { adapter: StorageAdapter; persistent: boolean } {
  if (typeof indexedDB !== 'undefined') return { adapter: new IndexedDbAdapter(), persistent: true };
  return { adapter: new MemoryAdapter(), persistent: false };
}

// ── Change history and soft delete ─────────────────────────────────────────

/** Collections whose records are money data: every change to them is recorded. */
const AUDITED: ReadonlySet<CollectionName> = new Set(['spaces', 'accounts', 'categories', 'transactions', 'recurring', 'people', 'obligations', 'budgets', 'goals', 'goalEntries']);

/**
 * Who changed a record and when. Written by the storage layer on every save,
 * so no action can forget it, and never trusted from the caller.
 */
export interface AuditFields {
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  /** Starts at 1 and goes up by one on every change, deletes included. */
  version?: number;
  /** Set when the record was deleted. Deleted records are kept, hidden, so a delete can be undone and synced. */
  deletedAt?: string;
  deletedBy?: string;
}

type Audited = Entity & AuditFields;

/**
 * Wraps any adapter so that money records get change history and are never
 * hard-deleted:
 * - every save stamps updatedAt, updatedBy and the next version, and keeps
 *   the original createdAt and createdBy;
 * - remove() marks the record deleted instead of erasing it, and getAll()
 *   leaves deleted records out; saving the record again restores it;
 * - writes run one at a time, so two quick saves can never share a version.
 * Sign-in data and session settings pass straight through.
 */
export class AuditedStorage implements StorageAdapter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private inner: StorageAdapter,
    private actor: () => string | undefined,
    private clock: () => string = () => new Date().toISOString(),
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => {});
    return run;
  }

  async getAll<T extends Entity>(collection: CollectionName): Promise<T[]> {
    const all = await this.inner.getAll<T & AuditFields>(collection);
    return AUDITED.has(collection) ? all.filter((r) => !r.deletedAt) : all;
  }

  /** Deleted records, for sync and for undoing a delete. */
  async getDeleted<T extends Entity>(collection: CollectionName): Promise<(T & AuditFields)[]> {
    return (await this.inner.getAll<T & AuditFields>(collection)).filter((r) => r.deletedAt);
  }

  getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]> {
    return this.inner.getMany<T>(collection, ids);
  }

  put<T extends Entity>(collection: CollectionName, item: T): Promise<void> {
    return this.putMany(collection, [item]);
  }

  putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void> {
    if (!AUDITED.has(collection)) return this.inner.putMany(collection, items);
    if (items.length === 0) return Promise.resolve();
    return this.serial(async () => {
      const previous = new Map(
        (
          await this.inner.getMany<Audited>(
            collection,
            items.map((i) => i.id),
          )
        ).map((r) => [r.id, r]),
      );
      const now = this.clock();
      const by = this.actor();
      const stamped = items.map((item) => {
        const prev = previous.get(item.id);
        const next: Audited = {
          ...(item as Audited),
          createdAt: prev?.createdAt ?? (item as Audited).createdAt ?? now,
          createdBy: prev?.createdBy ?? by,
          updatedAt: now,
          updatedBy: by,
          version: (prev?.version ?? 0) + 1,
        };
        delete next.deletedAt;
        delete next.deletedBy;
        return next;
      });
      await this.inner.putMany(collection, stamped);
    });
  }

  remove(collection: CollectionName, id: string): Promise<void> {
    return this.removeMany(collection, [id]);
  }

  removeMany(collection: CollectionName, ids: string[]): Promise<void> {
    if (!AUDITED.has(collection)) return this.inner.removeMany(collection, ids);
    if (ids.length === 0) return Promise.resolve();
    return this.serial(async () => {
      const now = this.clock();
      const by = this.actor();
      const live = (await this.inner.getMany<Audited>(collection, ids)).filter((r) => !r.deletedAt);
      const marked = live.map((r) => ({ ...r, deletedAt: now, deletedBy: by, updatedAt: now, updatedBy: by, version: (r.version ?? 0) + 1 }));
      await this.inner.putMany(collection, marked);
    });
  }

  /** Erases records for good. Only for replacing demo data the user asked to reset. */
  purgeMany(collection: CollectionName, ids: string[]): Promise<void> {
    return this.serial(() => this.inner.removeMany(collection, ids));
  }

  clearAll(): Promise<void> {
    return this.serial(() => this.inner.clearAll());
  }
}
