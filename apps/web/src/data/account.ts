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
import { useSyncExternalStore } from 'react';
import { ApiAuthService, ApiClient, ApiError, type Me } from './api';
import { LocalDataMover } from './migration';
import { IndexedDbAdapter, MemoryAdapter, type StorageAdapter } from './storage';
import { SyncedStorage } from './sync';

const TOKEN_KEY = 'finken:token';
const PROFILE_KEY = 'finken:profile';

/** What the server says about this person beyond their name: whether they are in the beta, and whether usage may be counted. */
export interface Profile {
  access: 'member' | 'invite-needed';
  usage: 'yes' | 'no' | null;
}

export type FeedbackKind = 'problem' | 'idea' | 'praise';

export interface SpaceMember {
  userId: ID;
  name: string;
  /** Only the owner sees other people's emails. */
  email: string | null;
  role: 'owner' | 'editor' | 'viewer';
  since: string;
  you: boolean;
}

export interface SpaceInvite {
  id: number;
  role: 'editor' | 'viewer';
  createdAt: string;
  expiresAt: string;
}

function readProfile(): Profile | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as Profile | null;
    return value && (value.access === 'member' || value.access === 'invite-needed') ? value : null;
  } catch {
    return null;
  }
}

function writeProfile(profile: Profile | null) {
  try {
    if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    // Then it is asked for again when Finken next opens.
  }
}

const failure = (err: unknown, fallback: string) => (err instanceof ApiError && err.status < 500 && err.status !== 408 ? err.message : fallback);
const OFFLINE = 'Finken could not reach its server. Check your connection and try again.';
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
  /** Known from the last time the server was asked; kept so Finken opens offline. */
  private profileValue: Profile | null = readProfile();
  private listeners = new Set<() => void>();

  constructor(
    baseUrl: string,
    cache: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter(ACCOUNT_DB) : new MemoryAdapter(),
    local: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter() : new MemoryAdapter(),
  ) {
    this.api = new ApiClient({ baseUrl, token: async () => this.token });
    this.storage = new SyncedStorage(this.api, cache);
    this.auth = new ApiAuthService(this.api, this.storage, (me) => this.setProfile(me));
    this.mover = new LocalDataMover(local, this.api);
  }

  get signedIn() {
    return Boolean(this.token);
  }

  get profile(): Profile | null {
    return this.profileValue;
  }

  /** Signed in but still needs an invite code before records can be kept. */
  get needsInvite(): boolean {
    return this.profileValue?.access === 'invite-needed';
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setProfile(me: Pick<Me, 'access' | 'usage'> | null) {
    const next: Profile | null = me ? { access: me.access ?? 'member', usage: me.usage ?? null } : null;
    if (JSON.stringify(next) === JSON.stringify(this.profileValue)) return;
    this.profileValue = next;
    writeProfile(next);
    for (const l of this.listeners) l();
  }

  /** Joins the closed beta with an invite code, then starts syncing. */
  async joinBeta(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!code.trim()) return { ok: false, error: 'Enter your invite code.' };
    try {
      this.setProfile(await this.api.request<Me>('POST', '/v1/beta/join', { code: code.trim() }));
      this.start();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: failure(err, OFFLINE) };
    }
  }

  /** Says yes or no to sharing usage. Saying no also removes what was counted before. */
  async setUsage(yes: boolean): Promise<void> {
    this.setProfile(await this.api.request<Me>('PATCH', '/v1/me', { usage: yes }));
  }

  // ── Sharing a Space ────────────────────────────────────────────────────

  /** Runs a sharing request, turning failures into words to show. */
  private async share<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await work() };
    } catch (err) {
      return { ok: false, error: failure(err, OFFLINE) };
    }
  }

  members(spaceId: ID) {
    return this.share(async () => (await this.api.request<{ members: SpaceMember[] }>('GET', `/v1/spaces/${encodeURIComponent(spaceId)}/members`)).members);
  }

  invites(spaceId: ID) {
    return this.share(async () => (await this.api.request<{ invites: SpaceInvite[] }>('GET', `/v1/spaces/${encodeURIComponent(spaceId)}/invites`)).invites);
  }

  /** A one-person invite. Its code is shown once. */
  invite(spaceId: ID, role: 'editor' | 'viewer') {
    return this.share(() => this.api.request<SpaceInvite & { code: string }>('POST', `/v1/spaces/${encodeURIComponent(spaceId)}/invites`, { role }));
  }

  cancelInvite(spaceId: ID, inviteId: number) {
    return this.share(() => this.api.request('DELETE', `/v1/spaces/${encodeURIComponent(spaceId)}/invites/${inviteId}`));
  }

  changeRole(spaceId: ID, userId: ID, role: 'editor' | 'viewer') {
    return this.share(
      async () =>
        (await this.api.request<{ members: SpaceMember[] }>('PATCH', `/v1/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`, { role })).members,
    );
  }

  /** Removes someone (the owner), or leaves (yourself). This device then forgets the Space. */
  removeMember(spaceId: ID, userId: ID) {
    return this.share(async () => {
      await this.api.request('DELETE', `/v1/spaces/${encodeURIComponent(spaceId)}/members/${encodeURIComponent(userId)}`);
      await this.storage.sync().catch(() => {});
    });
  }

  /** Joins a Space with an invite code; its records arrive with the next sync, started here. */
  joinSpace(code: string) {
    return this.share(async () => {
      const joined = await this.api.request<{ spaceId: ID; name: string; role: 'owner' | 'editor' | 'viewer'; already: boolean }>('POST', '/v1/spaces/join', { code: code.trim() });
      await this.storage.sync();
      return joined;
    });
  }

  /** Sends feedback in the person's own words, with the screen it is about. */
  async sendFeedback(input: { kind: FeedbackKind; message: string; screen: string; release?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.api.request('POST', '/v1/feedback', input);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: failure(err, 'Your feedback could not be sent: Finken could not reach its server. It is still here; try again when you are back online.') };
    }
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
    // Until an invite code is entered, nothing syncs: the server would refuse it.
    if (this.started || !this.token || this.needsInvite) return;
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
    this.setProfile(null);
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

/** The signed-in person's beta and usage settings, kept current. */
export function useProfile(): Profile | null {
  return useSyncExternalStore(account?.subscribe ?? noSubscribe, () => account?.profile ?? null);
}
const noSubscribe = () => () => {};

const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL?.trim();

/** The account connection, or null when Finken keeps everything in this browser. */
export const account: Account | null = API_URL ? new Account(API_URL.replace(/\/$/, '')) : null;
