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
import { OidcClient, oidcSettings, SignInError, type Tokens } from './oidc';
import { IndexedDbAdapter, MemoryAdapter, type StorageAdapter } from './storage';
import { SyncedStorage } from './sync';

const TOKEN_KEY = 'finken:token';
const SESSION_KEY = 'finken:session';
const PROFILE_KEY = 'finken:profile';

/** What the server says about this person beyond their name: whether they are in the beta, and whether usage may be counted. */
export interface Profile {
  access: 'member' | 'invite-needed';
  usage: 'yes' | 'no' | null;
  signIn?: 'password' | 'provider' | 'development';
  emailVerified?: boolean;
}

/** A sign-in form's outcome: the message to show, and the field it is about. */
export type FormResult = { ok: true } | { ok: false; error: string; field?: string };

/** Finken's own sign-in keeps only this on the device: the session itself is in a cookie page scripts cannot read. */
const SIGNED_IN_KEY = 'finken:signed-in';
const remembered = () => {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === '1';
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    if (on) localStorage.setItem(SIGNED_IN_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // Then the device asks the server whether it is signed in each time Finken opens.
  }
};

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

/** The saved sign-in. A development token saved before tokens were renewable is kept as it is. */
function readSession(): Tokens | null {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) return JSON.parse(saved) as Tokens;
    const old = localStorage.getItem(TOKEN_KEY);
    return old ? { idToken: old, expiresAt: Number.POSITIVE_INFINITY } : null;
  } catch {
    return null;
  }
}

function writeSession(session: Tokens | null) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
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
  /** The sign-in: a provider's tokens, or a development token. */
  private session: Tokens | null;
  /** Set when a sign-in provider is connected (VITE_AUTH_ISSUER); otherwise the development sign-in is used. */
  readonly provider: OidcClient | null;
  private readonly baseUrl: string;
  private refreshing: Promise<string | null> | null = null;
  private started = false;
  /** Known from the last time the server was asked; kept so Finken opens offline. */
  private profileValue: Profile | null = readProfile();
  private listeners = new Set<() => void>();

  constructor(
    baseUrl: string,
    cache: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter(ACCOUNT_DB) : new MemoryAdapter(),
    local: StorageAdapter = hasIndexedDb() ? new IndexedDbAdapter() : new MemoryAdapter(),
    provider: OidcClient | null = oidcSettings ? new OidcClient(oidcSettings) : null,
  ) {
    this.provider = provider;
    // A provider's tokens are kept on the device; Finken's own access token starts empty and comes from the session cookie.
    this.session = provider ? readSession() : null;
    this.baseUrl = baseUrl;
    this.api = new ApiClient({ baseUrl, token: () => this.currentToken() });
    this.storage = new SyncedStorage(this.api, cache);
    this.auth = new ApiAuthService(this.api, this.storage, (me) => this.setProfile(me));
    this.mover = new LocalDataMover(local, this.api);
  }

  get signedIn() {
    return this.provider ? Boolean(this.session) : remembered();
  }

  private get token(): string | null {
    return this.session?.idToken ?? null;
  }

  private setSession(session: Tokens | null) {
    this.session = session;
    // A provider's tokens are kept so the device stays signed in; Finken's own access token lives only in memory.
    if (this.provider) writeSession(session);
    else remember(Boolean(session));
  }

  /**
   * The token for the next request. A provider's token is renewed shortly
   * before it runs out; if the provider says the sign-in has ended, the
   * person is signed out. Without a connection, the old token is used and
   * the server's answer decides.
   */
  private async currentToken(): Promise<string | null> {
    if (!this.provider) return this.finkenToken();
    const session = this.session;
    if (!session) return null;
    if (!this.provider || !session.refreshToken || session.expiresAt - Date.now() > 60_000) return session.idToken;
    this.refreshing ??= this.provider
      .refresh(session.refreshToken)
      .then((tokens) => {
        this.setSession(tokens);
        return tokens.idToken;
      })
      .catch((err) => {
        if (err instanceof SignInError && /ended/.test(err.message)) {
          this.setSession(null);
          return null;
        }
        return session.idToken;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  // ── Finken's own sign-in ─────────────────────────────────────────────────

  /**
   * The access token for the next request: the one in memory while it has
   * more than a minute left, otherwise a new one from the session cookie.
   * If the server says the session has ended, this device is signed out.
   * Without a connection there is none, and requests wait as they do offline.
   */
  private finkenToken(): Promise<string | null> {
    const session = this.session;
    if (session && session.expiresAt - Date.now() > 60_000) return Promise.resolve(session.idToken);
    if (!remembered()) return Promise.resolve(null);
    this.refreshing ??= (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/v1/auth/refresh`, { method: 'POST', headers: { 'x-finken-session': '1' }, credentials: 'same-origin' });
        if (res.status === 401 || res.status === 403) {
          this.setSession(null);
          return null;
        }
        if (!res.ok) return null;
        const { accessToken, expiresAt } = (await res.json()) as { accessToken: string; expiresAt: number };
        this.setSession({ idToken: accessToken, expiresAt });
        return accessToken;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Runs a sign-in form's request; on success the device is signed in. */
  private async form(work: () => Promise<{ accessToken: string; expiresAt: number } | undefined>): Promise<FormResult> {
    try {
      const signed = await work();
      if (signed) this.setSession({ idToken: signed.accessToken, expiresAt: signed.expiresAt });
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return { ok: false, error: err.message, field: err.field };
      return { ok: false, error: OFFLINE };
    }
  }

  /** A new Finken account; this device is signed in. */
  register(input: { email: string; password: string; name: string; timeZone?: string }) {
    return this.form(() => this.api.request('POST', '/v1/auth/register', input));
  }

  logIn(email: string, password: string) {
    return this.form(() => this.api.request('POST', '/v1/auth/login', { email, password }));
  }

  /** Emails a link to set a new password. The answer is the same whether or not the email has an account. */
  forgotPassword(email: string) {
    return this.form(async () => {
      await this.api.request('POST', '/v1/auth/forgot', { email });
      return undefined;
    });
  }

  /** Sets a new password from the emailed link; every device is signed out, and this one signed in. */
  async resetPassword(token: string, password: string) {
    const wasSignedIn = this.signedIn;
    const result = await this.form(() => this.api.request('POST', '/v1/auth/reset', { token, password }));
    // Only once the new password is set: whoever was signed in here before loses this device's copy,
    // so it is never shown to this account. (Their cookie has already been replaced by the new one.)
    if (result.ok && wasSignedIn) {
      this.storage.stop();
      this.started = false;
      this.setProfile(null);
      await this.storage.clearAll();
    }
    return result;
  }

  confirmEmail(token: string) {
    return this.form(async () => {
      await this.api.request('POST', '/v1/auth/verify', { token });
      return undefined;
    });
  }

  resendConfirmation() {
    return this.form(async () => {
      await this.api.request('POST', '/v1/auth/verify/resend', {});
      return undefined;
    });
  }

  /** A new password, after the current one; every other device is signed out. */
  changePassword(current: string, password: string) {
    return this.form(async () => {
      await this.api.request('POST', '/v1/auth/password', { current, password });
      return undefined;
    });
  }

  /** Signs out every device but this one. */
  async signOutOthers(): Promise<{ ok: true; ended: number } | { ok: false; error: string }> {
    try {
      return { ok: true, ended: (await this.api.request<{ ended: number }>('POST', '/v1/auth/logout-others', {})).ended };
    } catch (err) {
      return { ok: false, error: failure(err, OFFLINE) };
    }
  }

  /** Development servers only: the emails Finken would have sent to this address. */
  async developmentMail(to: string): Promise<{ subject: string; link: string }[]> {
    try {
      return (await this.api.request<{ emails: { subject: string; link: string }[] }>('GET', `/v1/dev/mail?to=${encodeURIComponent(to.trim().toLowerCase())}`)).emails;
    } catch {
      return [];
    }
  }

  /** Sends the person to the provider's sign-in (or sign-up) page. */
  async startSignIn(options: { signUp?: boolean } = {}): Promise<{ ok: false; error: string } | undefined> {
    if (!this.provider) return { ok: false, error: 'Signing in is not set up for this app yet.' };
    try {
      window.location.assign(await this.provider.signInUrl(options));
      return undefined;
    } catch (err) {
      return { ok: false, error: err instanceof SignInError ? err.message : 'The sign-in page could not be opened. Try again.' };
    }
  }

  /** Back from the provider's page: keeps the sign-in. */
  async finishSignIn(callbackUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.provider) return { ok: false, error: 'Signing in is not set up for this app yet.' };
    try {
      this.setSession(await this.provider.finishSignIn(callbackUrl));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof SignInError ? err.message : 'Signing in did not finish. Try again.' };
    }
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

  private setProfile(me: Pick<Me, 'access' | 'usage' | 'signIn' | 'emailVerified'> | null) {
    const next: Profile | null = me ? { access: me.access ?? 'member', usage: me.usage ?? null, signIn: me.signIn, emailVerified: me.emailVerified } : null;
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

  /** Starts syncing once someone is signed in. Safe to call repeatedly. */
  start() {
    // Until an invite code is entered, nothing syncs: the server would refuse it.
    if (this.started || !this.signedIn || this.needsInvite) return;
    this.started = true;
    this.storage.start();
    this.reportErrors();
  }

  /**
   * Signs out and forgets this device's copy, so the next person starts
   * clean. The account keeps everything. Returns the provider's sign-out
   * page, if it has one, so its own session can end too.
   */
  async signOut(): Promise<string | null> {
    const idToken = this.token;
    this.storage.stop();
    this.started = false;
    // Finken's own sign-in: end the session on the server, which also clears the cookie.
    if (!this.provider && remembered()) {
      await fetch(`${this.baseUrl}/v1/auth/logout`, { method: 'POST', headers: { 'x-finken-session': '1' }, credentials: 'same-origin' }).catch(() => {});
    }
    this.setSession(null);
    this.setProfile(null);
    await this.storage.clearAll();
    return this.provider ? await this.provider.signOutUrl(idToken) : null;
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
      if (!this.signedIn || sent >= 5) return;
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
