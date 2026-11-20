/**
 * Account mode: Finken keeps records on its server, with an offline copy here.
 *
 * It is on when the app is built with `VITE_API_URL` (for example `/api`).
 * Without it, Finken keeps everything in this browser, as before.
 *
 * Signing in: the sign-in provider is not chosen yet. Until it is, a
 * development server (`AUTH_MODE=dev`) hands out sign-in tokens for any
 * email address; a real server refuses, and the sign-in screen says so.
 * Choosing a provider replaces `signIn` and the token source here, nothing else.
 */
import type { ID } from '@finken/domain/types';
import { ApiAuthService, ApiClient, ApiError } from './api';
import { LocalDataMover } from './migration';
import { IndexedDbAdapter, MemoryAdapter, type StorageAdapter } from './storage';
import { SyncedStorage } from './sync';

const TOKEN_KEY = 'finken:token';
/** This device's copy of the account's records, kept apart from the data Finken saved before accounts. */
const ACCOUNT_DB = 'finken-account';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the sign-in lasts until the page closes.
  }
}

const hasIndexedDb = () => typeof indexedDB !== 'undefined';

export class Account {
  readonly api: ApiClient;
  readonly storage: SyncedStorage;
  readonly auth: ApiAuthService;
  /** Moves data saved in this browser before accounts into the signed-in account. */
  readonly mover: LocalDataMover;
  private token: string | null = readToken();
  private started = false;

  constructor(
    baseUrl: string,
    cache: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter(ACCOUNT_DB) : new MemoryAdapter(),
    local: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter() : new MemoryAdapter(),
  ) {
    this.api = new ApiClient({ baseUrl, token: async () => this.token });
    this.storage = new SyncedStorage(this.api, cache);
    this.auth = new ApiAuthService(this.api, this.storage);
    this.mover = new LocalDataMover(local, this.api);
  }

  get signedIn() {
    return Boolean(this.token);
  }

  /**
   * Development sign-in: any email, no password. Works only against a
   * development server; on a real one this answers that sign-in is not ready.
   */
  async signIn(email: string, name: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const subject = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) return { ok: false, error: 'Enter a valid email address.' };
    try {
      const { token } = await this.api.request<{ token: string }>('POST', '/v1/dev/token', { subject, email: subject, ...(name.trim() ? { name: name.trim() } : {}) });
      this.token = token;
      writeToken(token);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { ok: false, error: 'Signing in is not available on this server yet.' };
      if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message };
      return { ok: false, error: 'Finken could not reach its server. Check your connection and try again.' };
    }
  }

  /** Starts syncing once someone is signed in. Safe to call repeatedly. */
  start() {
    if (this.started || !this.token) return;
    this.started = true;
    this.storage.start();
    this.reportErrors();
  }

  /** Signs out and forgets this device's copy, so the next person starts clean. The account keeps everything. */
  async signOut() {
    this.storage.stop();
    this.started = false;
    this.token = null;
    writeToken(null);
    await this.storage.clearAll();
  }

  /** Everything in the account, as the JSON file the server prepares. */
  async exportAll(): Promise<{ name: string; text: string }> {
    const data = await this.api.request<{ exportedAt: string }>('GET', '/v1/export');
    return { name: `finken-export-${data.exportedAt.slice(0, 10)}.json`, text: JSON.stringify(data, null, 2) };
  }

  /** Deletes the account and every Space it owns, for good, then signs out here. */
  async deleteAccount(): Promise<void> {
    await this.api.request('DELETE', '/v1/me', { confirm: 'DELETE' });
    await this.signOut();
  }

  /**
   * Tells the server about errors the app runs into, so they can be fixed.
   * Only the error's message and the page it happened on are sent: never
   * records, amounts or anything typed. At most a few per page load.
   */
  reportErrors() {
    if (typeof window === 'undefined') return;
    let sent = 0;
    const send = (message: unknown) => {
      if (!this.token || sent >= 5) return;
      sent++;
      const text = String(message instanceof Error ? `${message.name}: ${message.message}` : message).slice(0, 500);
      void this.api.request('POST', '/v1/client-errors', { message: text || 'Unknown error', where: window.location.pathname.slice(0, 200) }).catch(() => {});
    };
    window.addEventListener('error', (e) => send(e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => send(e.reason));
  }

  /** Remembers that the person chose not to move data from this browser for now. */
  dismissMove(userId: ID) {
    try {
      localStorage.setItem(`finken:move-later:${userId}`, '1');
    } catch {
      // Then it is asked again next time, which is harmless.
    }
  }

  moveDismissed(userId: ID): boolean {
    try {
      return localStorage.getItem(`finken:move-later:${userId}`) === '1';
    } catch {
      return false;
    }
  }
}

const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL?.trim();

/** The account connection, or null when Finken keeps everything in this browser. */
export const account: Account | null = API_URL ? new Account(API_URL.replace(/\/$/, '')) : null;
