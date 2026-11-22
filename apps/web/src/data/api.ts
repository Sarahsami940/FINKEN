/**
 * Finken's server, behind the same interfaces as browser storage and local
 * sign-in. The store, money rules and screens do not change: they keep calling
 * StorageAdapter and AuthService, and these classes turn that into API calls.
 *
 * - Money records go to the API. Every save and delete made in the same moment
 *   (one action can write several records) is sent as one batch, which the
 *   server applies all or nothing, after running the same money rules.
 * - Session settings stay on this device.
 * - Change history and soft delete happen on the server (`audited`).
 */
import type { ID, User } from '@finken/domain/types';
import { AuthError, type AuthService } from './auth';
import type { CollectionName, Entity, StorageAdapter } from './storage';

/** Collections that only ever live on this device. */
const LOCAL: ReadonlySet<CollectionName> = new Set(['users', 'credentials', 'meta']);

export interface ApiOptions {
  /** Where the API is, for example "/api" behind the same domain. */
  baseUrl: string;
  /** The current sign-in token from the provider, or null when signed out. */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}

/** A failure the server explained. Its message is safe to show. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The record the server's answer is about, when it names one. */
    readonly where?: { collection?: string; id?: string },
    /** The form field the answer is about (sign-in forms). */
    readonly field?: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(private options: ApiOptions) {}

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: { keepalive?: boolean } = {}): Promise<T> {
    const token = await this.options.token();
    const res = await (this.options.fetch ?? fetch)(`${this.options.baseUrl}${path}`, {
      method,
      ...(options.keepalive ? { keepalive: true } : {}),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; collection?: string; id?: string; field?: string };
    if (!res.ok) throw new ApiError(data.error ?? 'Finken could not reach its server.', res.status, { collection: data.collection, id: data.id }, data.field);
    return data as T;
  }
}

interface Pending {
  puts: Partial<Record<CollectionName, Entity[]>>;
  deletes: Partial<Record<CollectionName, string[]>>;
  done: { resolve: () => void; reject: (e: unknown) => void }[];
}

export class ApiStorage implements StorageAdapter {
  readonly audited = true;
  private pending: Pending | null = null;
  /** Batches go one at a time, in order, so a record is never updated before it is created. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private api: ApiClient,
    /** Where session settings live: this device. */
    private local: StorageAdapter,
  ) {}

  async getAll<T extends Entity>(collection: CollectionName): Promise<T[]> {
    if (LOCAL.has(collection)) return this.local.getAll(collection);
    await this.whenIdle();
    return (await this.api.request<{ records: T[] }>('GET', `/v1/records/${collection}`)).records;
  }

  async getMany<T extends Entity>(collection: CollectionName, ids: string[]): Promise<T[]> {
    if (LOCAL.has(collection)) return this.local.getMany(collection, ids);
    await this.whenIdle();
    return (await this.api.request<{ records: T[] }>('POST', `/v1/records/${collection}/get`, { ids })).records;
  }

  put<T extends Entity>(collection: CollectionName, item: T): Promise<void> {
    return this.putMany(collection, [item]);
  }

  putMany<T extends Entity>(collection: CollectionName, items: T[]): Promise<void> {
    if (LOCAL.has(collection)) return this.local.putMany(collection, items);
    if (items.length === 0) return Promise.resolve();
    return this.enqueue((p) => {
      // A record saved twice in one moment is sent once, as its latest version;
      // saving it again after a delete in the same moment brings it back.
      const latest = new Map((p.puts[collection] ?? []).map((i) => [i.id, i]));
      for (const item of items) latest.set(item.id, item);
      p.puts[collection] = [...latest.values()];
      const ids = new Set(items.map((i) => i.id));
      if (p.deletes[collection]) p.deletes[collection] = p.deletes[collection]!.filter((id) => !ids.has(id));
    });
  }

  remove(collection: CollectionName, id: string): Promise<void> {
    return this.removeMany(collection, [id]);
  }

  removeMany(collection: CollectionName, ids: string[]): Promise<void> {
    if (LOCAL.has(collection)) return this.local.removeMany(collection, ids);
    if (ids.length === 0) return Promise.resolve();
    return this.enqueue((p) => {
      p.deletes[collection] = [...(p.deletes[collection] ?? []), ...ids];
    });
  }

  /** Forgets what is on this device. Records on the server are never cleared from here. */
  clearAll(): Promise<void> {
    return this.local.clearAll();
  }

  /** Resolves once every save made so far has reached the server (or failed). */
  async whenIdle(): Promise<void> {
    await Promise.resolve();
    await this.chain.catch(() => {});
  }

  private enqueue(add: (p: Pending) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.pending) {
        this.pending = { puts: {}, deletes: {}, done: [] };
        // Everything written in this moment goes in the same batch.
        queueMicrotask(() => this.flush());
      }
      add(this.pending);
      this.pending.done.push({ resolve, reject });
    });
  }

  private flush() {
    const batch = this.pending!;
    this.pending = null;
    this.chain = this.chain
      .then(() => this.api.request('POST', '/v1/batch', { puts: batch.puts, deletes: batch.deletes }))
      .then(
        () => {
          for (const d of batch.done) d.resolve();
        },
        (err) => {
          // Each save made in this moment hears about it; the queue itself carries on.
          for (const d of batch.done) d.reject(err);
        },
      );
  }
}

export interface Me {
  id: ID;
  email: string | null;
  name: string;
  timeZone: string;
  /** invite-needed while the beta is invite-only and no code has been entered. */
  access?: 'member' | 'invite-needed';
  /** Whether usage may be counted; null until asked. */
  usage?: 'yes' | 'no' | null;
  /** How this person signs in: a Finken password, an outside provider, or the development sign-in. */
  signIn?: 'password' | 'provider' | 'development';
  emailVerified?: boolean;
}

const toUser = (me: Me): User => ({ id: me.id, name: me.name, email: me.email ?? undefined, isGuest: false, timeZone: me.timeZone });

/**
 * Sign-in through the provider, with the user's profile kept on the server.
 * Signing up and signing in happen on the provider's own screens, which hand
 * the app a token; this service then only reads and updates the profile.
 */
export class ApiAuthService implements AuthService {
  constructor(
    private api: ApiClient,
    /** Where the last known profile is kept, so Finken opens without a connection. */
    private local?: StorageAdapter,
    /** Hears the beta and usage settings each time the profile is read. */
    private onProfile?: (me: Me) => void,
  ) {}

  /** The signed-in user, or null when there is no valid token. */
  async current(): Promise<User | null> {
    try {
      const me = await this.api.request<Me>('GET', '/v1/me');
      this.onProfile?.(me);
      const user = toUser(me);
      await this.local?.put('users', user);
      return user;
    } catch (err) {
      // Signed out, but changes still waiting here are kept for when they sign in again.
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  }

  async getUser(id: ID): Promise<User | null> {
    try {
      const user = await this.current();
      return user?.id === id ? user : null;
    } catch (err) {
      // No connection, or the server is down or busy: carry on as the person last signed in here.
      const unreachable = !(err instanceof ApiError) || err.status >= 500 || err.status === 408 || err.status === 429;
      if (!unreachable || !this.local) throw err;
      return (await this.local.getMany<User>('users', [id]))[0] ?? null;
    }
  }

  /** "Try Finken" with a signed-in account opens the demo inside that account. */
  async ensureGuest(): Promise<User> {
    const user = await this.current();
    if (!user) throw new AuthError('Sign in again.');
    return user;
  }

  async updateUser(user: User): Promise<void> {
    await this.api.request('PATCH', '/v1/me', { name: user.name, timeZone: user.timeZone });
    await this.local?.put('users', user);
  }

  register(): Promise<User> {
    return Promise.reject(new AuthError('Create your account on the sign-in screen.'));
  }

  login(): Promise<User> {
    return Promise.reject(new AuthError('Sign in on the sign-in screen.'));
  }

  /** Accounts are removed through the provider; nothing to do here. */
  async removeUser(): Promise<void> {}
}
