/**
 * Offline-first storage for a signed-in account.
 *
 * - **Reads** come from a copy on this device, so Finken opens instantly and
 *   works with no connection.
 * - **Writes** go to that copy at once, and into an outbox kept on the device.
 *   Everything saved in the same moment (one action) is one outbox entry.
 * - **Sync** sends the outbox to the server in order, then fetches only what
 *   changed since the last sync (the server's change feed). It runs when asked,
 *   when the connection comes back, and every 30 seconds while the app is open.
 * - **Conflicts**: each entry carries the time it was made. When two devices
 *   change the same record, the later edit wins on the server, whichever
 *   arrives first, and the other device takes the winning version on its
 *   next sync.
 * - **Refusals**: every change still passes the server's money rules. If the
 *   server refuses one (say, two devices each refunded the rest of the same
 *   expense while offline), it is undone on this device, the server's version
 *   is put back, and the store is told why.
 *
 * A failed connection is never a refusal: the outbox simply waits.
 */
import { type ApiClient, ApiError } from './api';
import type { CollectionName, Entity, StorageAdapter, StorageEvent } from './storage';

const LOCAL: ReadonlySet<CollectionName> = new Set(['users', 'credentials', 'meta', 'outbox']);
const CURSOR_KEY = 'sync:cursor';

interface OutboxEntry extends Entity {
  /** When the change was made on this device. */
  editedAt: string;
  puts: Partial<Record<CollectionName, Entity[]>>;
  deletes: Partial<Record<CollectionName, string[]>>;
}

export interface SyncStatus {
  /** Changes made here that have not reached the server yet. */
  pending: number;
  /** False after a sync could not reach the server. */
  online: boolean;
  /** When this device last finished a sync, if it ever has. */
  lastSynced: string | null;
}

export interface SyncOptions {
  clock?: () => Date;
}

type Change = { collection: CollectionName; record: Entity & { deletedAt?: string } };

/** A refusal is the server saying no to the change itself; anything else means "try again later". */
const isRefusal = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);

export class SyncedStorage implements StorageAdapter {
  readonly audited = true;
  private listeners = new Set<(event: StorageEvent) => void>();
  private statusListeners = new Set<(status: SyncStatus) => void>();
  private outbox: OutboxEntry[] | null = null;
  private moment: OutboxEntry | null = null;
  private momentDone: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private counter = 0;
  /** Moments being written to the outbox right now. */
  private closing = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private online = true;
  private lastSynced: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clock: () => Date;

  constructor(
    private api: ApiClient,
    /** This device's copy: IndexedDB in the browser, memory in tests. */
    private cache: StorageAdapter,
    options: SyncOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  // ── Events ───────────────────────────────────────────────────────────────

  subscribe(listener: (event: StorageEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async status(): Promise<SyncStatus> {
    return { pending: (await this.loadOutbox()).length, online: this.online, lastSynced: this.lastSynced };
  }

  private emit(event: StorageEvent) {
    for (const l of this.listeners) l(event);
  }

  private async emitStatus() {
    const status = await this.status();
    for (const l of this.statusListeners) l(status);
  }

  // ── StorageAdapter: everything reads and writes this device's copy ───────

  getAll<T extends Entity>(collection: CollectionName): Promise<T[]> {
    return this.cache.getAll(collection);
  }

  getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]> {
    return this.cache.getMany(collection, ids);
  }

  put<T extends Entity>(collection: CollectionName, item: T): Promise<void> {
    return this.putMany(collection, [item]);
  }

  async putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void> {
    if (LOCAL.has(collection)) return this.cache.putMany(collection, items);
    if (items.length === 0) return;
    await this.cache.putMany(collection, items);
    return this.record((m) => {
      const latest = new Map((m.puts[collection] ?? []).map((i) => [i.id, i]));
      for (const item of items) latest.set(item.id, item);
      m.puts[collection] = [...latest.values()];
      const ids = new Set(items.map((i) => i.id));
      if (m.deletes[collection]) m.deletes[collection] = m.deletes[collection]!.filter((id) => !ids.has(id));
    });
  }

  remove(collection: CollectionName, id: string): Promise<void> {
    return this.removeMany(collection, [id]);
  }

  async removeMany(collection: CollectionName, ids: string[]): Promise<void> {
    if (LOCAL.has(collection)) return this.cache.removeMany(collection, ids);
    if (ids.length === 0) return;
    await this.cache.removeMany(collection, ids);
    return this.record((m) => {
      m.deletes[collection] = [...new Set([...(m.deletes[collection] ?? []), ...ids])];
    });
  }

  /** Forgets this device's copy and its outbox. The server keeps everything. */
  async clearAll(): Promise<void> {
    this.outbox = [];
    await this.cache.clearAll();
  }

  // ── The outbox ───────────────────────────────────────────────────────────

  private async loadOutbox(): Promise<OutboxEntry[]> {
    this.outbox ??= (await this.cache.getAll<OutboxEntry>('outbox')).sort((a, b) => a.id.localeCompare(b.id));
    return this.outbox;
  }

  /** Adds to this moment's outbox entry; the entry is saved once the moment ends. */
  private record(add: (m: OutboxEntry) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.moment) {
        const at = this.clock();
        // Sortable and unique on this device: time, then a counter for the same millisecond.
        const id = `${at.toISOString()}#${String(this.counter++).padStart(6, '0')}`;
        this.moment = { id, editedAt: at.toISOString(), puts: {}, deletes: {} };
        this.closing++;
        queueMicrotask(() => void this.closeMoment());
      }
      add(this.moment);
      this.momentDone.push({ resolve, reject });
    });
  }

  private async closeMoment() {
    const entry = this.moment!;
    const done = this.momentDone;
    this.moment = null;
    this.momentDone = [];
    try {
      const outbox = await this.loadOutbox();
      await this.cache.put('outbox', entry);
      outbox.push(entry);
      for (const d of done) d.resolve();
      void this.emitStatus();
      // Try to send it straight away; if there is no connection it waits.
      void this.sync().catch(() => {});
    } catch (err) {
      for (const d of done) d.reject(err);
    } finally {
      this.closing--;
    }
  }

  /** Ids with changes still waiting to be sent, which incoming changes must not overwrite. */
  private pendingIds(): Set<string> {
    const ids = new Set<string>();
    for (const e of this.outbox ?? []) {
      for (const items of Object.values(e.puts)) for (const i of items ?? []) ids.add(i.id);
      for (const list of Object.values(e.deletes)) for (const id of list ?? []) ids.add(id);
    }
    return ids;
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  /** Sends what is waiting, then fetches what changed elsewhere. Never runs twice at once. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.push();
          await this.pull();
        } while (this.again);
        this.online = true;
        this.lastSynced = this.clock().toISOString();
      } catch (err) {
        if (isRefusal(err)) throw err;
        // No connection, signed out, or the server is busy: everything waits for the next try.
        this.online = false;
      } finally {
        this.running = null;
        void this.emitStatus();
      }
    })();
    return this.running;
  }

  /** Resolves once nothing is being saved or synced. */
  async whenIdle(): Promise<void> {
    await Promise.resolve();
    while (this.moment || this.closing || this.running) {
      await (this.running ?? Promise.resolve());
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  private async push() {
    const outbox = await this.loadOutbox();
    while (outbox.length) {
      const entry = outbox[0];
      let refetch: Partial<Record<CollectionName, string[]>> = {};
      try {
        const result = await this.api.request<{ superseded?: Partial<Record<CollectionName, string[]>> }>('POST', '/v1/batch', {
          editedAt: entry.editedAt,
          puts: entry.puts,
          deletes: entry.deletes,
        });
        // A later edit from another device won: take its version.
        refetch = result.superseded ?? {};
      } catch (err) {
        if (!isRefusal(err)) throw err;
        // The server refused this change. Undo it here by putting back the server's version of everything it touched.
        for (const [c, items] of Object.entries(entry.puts) as [CollectionName, Entity[]][]) refetch[c] = [...(refetch[c] ?? []), ...items.map((i) => i.id)];
        for (const [c, ids] of Object.entries(entry.deletes) as [CollectionName, string[]][]) refetch[c] = [...(refetch[c] ?? []), ...ids];
        outbox.shift();
        await this.cache.remove('outbox', entry.id);
        await this.restore(refetch);
        this.emit({ type: 'rejected', message: (err as Error).message });
        continue;
      }
      outbox.shift();
      await this.cache.remove('outbox', entry.id);
      if (Object.keys(refetch).length) {
        await this.restore(refetch);
        this.emit({ type: 'changed' });
      }
    }
  }

  /** Replaces this device's copy of some records with the server's. */
  private async restore(ids: Partial<Record<CollectionName, string[]>>) {
    const waiting = this.pendingIds();
    for (const [collection, list] of Object.entries(ids) as [CollectionName, string[]][]) {
      const wanted = list.filter((id) => !waiting.has(id));
      if (!wanted.length) continue;
      const { records } = await this.api.request<{ records: (Entity & { deletedAt?: string })[] }>('POST', `/v1/records/${collection}/get`, { ids: wanted });
      const live = records.filter((r) => !r.deletedAt);
      await this.cache.putMany(collection, live);
      const keep = new Set(live.map((r) => r.id));
      await this.cache.removeMany(
        collection,
        wanted.filter((id) => !keep.has(id)),
      );
    }
  }

  private async pull() {
    const meta = await this.cache.getMany<Entity & { value: string }>('meta', [CURSOR_KEY]);
    let cursor = Number(meta[0]?.value ?? 0);
    let changed = false;
    for (;;) {
      const page = await this.api.request<{ changes: Change[]; cursor: number; more: boolean }>('GET', `/v1/changes?since=${cursor}`);
      const waiting = this.pendingIds();
      const byCollection = new Map<CollectionName, { put: Entity[]; remove: string[] }>();
      for (const { collection, record } of page.changes) {
        // A change still waiting here is newer than what the server sent; it goes up first.
        if (waiting.has(record.id)) continue;
        const slot = byCollection.get(collection) ?? { put: [], remove: [] };
        if (record.deletedAt) slot.remove.push(record.id);
        else slot.put.push(record);
        byCollection.set(collection, slot);
      }
      for (const [collection, { put, remove }] of byCollection) {
        await this.cache.putMany(collection, put);
        await this.cache.removeMany(collection, remove);
        changed = true;
      }
      cursor = page.cursor;
      await this.cache.put('meta', { id: CURSOR_KEY, value: String(cursor) });
      if (!page.more) break;
    }
    if (changed) this.emit({ type: 'changed' });
  }

  // ── Running in the browser ───────────────────────────────────────────────

  /** Syncs now, every 30 seconds, and whenever the connection or the tab comes back. */
  start() {
    const tick = () => void this.sync().catch(() => {});
    tick();
    this.timer = setInterval(tick, 30_000);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', tick);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
