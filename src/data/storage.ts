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
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

export interface Entity {
  id: string;
}

export interface StorageAdapter {
  getAll<T extends Entity>(collection: CollectionName): Promise<T[]>;
  put<T extends Entity>(collection: CollectionName, item: T): Promise<void>;
  putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void>;
  remove(collection: CollectionName, id: string): Promise<void>;
  removeMany(collection: CollectionName, ids: string[]): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'finken';
// v2 adds `credentials`; v3 adds `people` and `obligations`;
// v4 adds `budgets`, `goals` and `goalEntries`.
// Upgrades only ever add missing stores.
const DB_VERSION = 4;

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

  constructor() {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        for (const name of COLLECTIONS) {
          if (!open.result.objectStoreNames.contains(name)) {
            open.result.createObjectStore(name, { keyPath: 'id' });
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
