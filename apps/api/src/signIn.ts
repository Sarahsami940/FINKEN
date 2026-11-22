/**
 * Finken's own sign-in. Accounts, passwords and sessions are kept in
 * Finken's database; nothing goes to an outside sign-in company.
 *
 * - **Passwords** are scrypt hashes (passwords.ts). A wrong email and a
 *   wrong password get the same answer, in about the same time.
 * - **Guessing.** After 5 wrong passwords in a row an account waits 15
 *   minutes. Unknown emails are counted the same way, so the waiting
 *   message says nothing about whether an account exists. Addresses are
 *   rate-limited as well (app.ts).
 * - **Sessions.** Signing in starts a session for that device. The app gets
 *   a short access token (15 minutes, held in memory) and a refresh token
 *   in a cookie that page scripts cannot read. Each refresh swaps the
 *   refresh token for a new one; presenting an old one again (after a short
 *   grace for two tabs refreshing at once) means it was copied, and the
 *   session ends. Every request checks its session is still open, so
 *   logging out takes effect at once.
 * - **Email links** (confirming the address, setting a new password) work
 *   once and expire; only their hashes are stored. Setting a new password
 *   ends every session.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Db } from './db';
import { type Mailer, resetEmail, verifyEmail } from './mail';
import { hashPassword, passwordProblem, spendTimeAsIfChecking, verifyPassword } from './passwords';
import { RateLimiter } from './security';

export const ACCESS_SECONDS = 15 * 60;
export const SESSION_DAYS = 30;
export const LOCK_AFTER = 5;
export const LOCK_MINUTES = 15;
const VERIFY_HOURS = 48;
const RESET_MINUTES = 30;
/** Two tabs refreshing with the same cookie at the same moment is not theft. */
const REUSE_GRACE_SECONDS = 60;

export const ISSUER = 'finken';
export const AUDIENCE = 'finken-api';

export class SignInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: 'email' | 'password' | 'name' | 'current',
  ) {
    super(message);
  }
}

const WRONG = 'That email and password do not match a Finken account.';
const LOCKED = `Too many wrong passwords. Wait ${LOCK_MINUTES} minutes, or set a new password with “Forgot your password?”.`;
const ENDED = 'Sign in again.';
const OLD_LINK = 'That link has expired or was already used. Ask for a new one.';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');
export const normaliseEmail = (email: string) => email.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Session {
  sessionId: string;
  /** For the cookie only; never stored. */
  refreshToken: string;
  accessToken: string;
  /** When the access token stops working, in milliseconds. */
  expiresAt: number;
}

export interface SignInDeps {
  db: Db;
  /** Signs access tokens. At least 32 characters; a secret. */
  secret: string;
  /** The web app's address, for links in emails. */
  appUrl: string;
  mailer: Mailer;
  log?: (message: string, err?: unknown) => void;
}

export class SignInService {
  private key: Uint8Array;
  /** Wrong passwords for emails with no account, so they wait exactly like real ones. */
  private unknownFailures = new RateLimiter({ max: LOCK_AFTER, windowMs: LOCK_MINUTES * 60_000 });

  constructor(private deps: SignInDeps) {
    this.key = new TextEncoder().encode(deps.secret);
  }

  private get db() {
    return this.deps.db;
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  private async accessToken(subject: string, sessionId: string): Promise<{ token: string; expiresAt: number }> {
    const expiresAt = Date.now() + ACCESS_SECONDS * 1000;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  /** Checks an access token: signature, issuer, audience and expiry. The session is checked separately. */
  async readAccessToken(token: string): Promise<{ subject: string; sessionId: string }> {
    const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.sid !== 'string') throw new Error('Not a Finken access token');
    return { subject: payload.sub, sessionId: payload.sid };
  }

  /** True while the session has not ended. */
  async sessionOpen(sessionId: string): Promise<boolean> {
    const rows = await this.db.query('select 1 from sessions where id = $1 and revoked_at is null and expires_at > now()', [sessionId]);
    return rows.length === 1;
  }

  private async startSession(userId: string, subject: string): Promise<Session> {
    const sessionId = randomUUID();
    const refreshToken = newSecret();
    await this.db.query(`insert into sessions (id, user_id, refresh_hash, expires_at) values ($1, $2, $3, now() + make_interval(days => $4::int))`, [
      sessionId,
      userId,
      sha(refreshToken),
      SESSION_DAYS,
    ]);
    const access = await this.accessToken(subject, sessionId);
    return { sessionId, refreshToken, accessToken: access.token, expiresAt: access.expiresAt };
  }

  // ── Email links ──────────────────────────────────────────────────────────

  private async emailLink(userId: string, purpose: 'verify' | 'reset', minutes: number): Promise<string> {
    // A new link replaces any earlier one of the same kind.
    await this.db.query(`update email_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null`, [userId, purpose]);
    const token = newSecret();
    await this.db.query(`insert into email_tokens (user_id, purpose, token_hash, expires_at) values ($1, $2, $3, now() + make_interval(mins => $4::int))`, [
      userId,
      purpose,
      sha(token),
      minutes,
    ]);
    const path = purpose === 'verify' ? '/auth/verify' : '/auth/reset';
    return `${this.deps.appUrl.replace(/\/$/, '')}${path}#token=${token}`;
  }

  /** Sends without holding up the person: a mail server that is down never stops a sign-up. */
  private async send(make: () => Promise<Parameters<Mailer['send']>[0]>) {
    try {
      await this.deps.mailer.send(await make());
    } catch (err) {
      this.deps.log?.('could not send an email', err);
    }
  }

  /** Takes a link's token, once. Returns whose it was. */
  private async useLink(token: string, purpose: 'verify' | 'reset'): Promise<string> {
    const [row] = await this.db.query<{ user_id: string }>(
      `update email_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id`,
      [sha(token), purpose],
    );
    if (!row) throw new SignInError(OLD_LINK, 400);
    return row.user_id;
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  async register(input: { email: string; password: string; name?: string; timeZone?: string }): Promise<Session> {
    const email = normaliseEmail(input.email);
    const name = (input.name ?? '').trim().slice(0, 80);
    if (!EMAIL.test(email) || email.length > 254) throw new SignInError('Enter a valid email address.', 400, 'email');
    const weak = passwordProblem(input.password, { email, name });
    if (weak) throw new SignInError(weak, 400, 'password');
    const exists = await this.db.query('select 1 from users where lower(email) = $1 and password_hash is not null', [email]);
    const taken = new SignInError('An account with this email already exists. Log in instead, or use “Forgot your password?”.', 409, 'email');
    if (exists.length) throw taken;
    const id = randomUUID();
    const subject = `finken:${id}`;
    try {
      await this.db.query(
        `insert into users (id, auth_subject, email, name, time_zone, password_hash, password_changed_at) values ($1, $2, $3, $4, coalesce($5, 'Asia/Karachi'), $6, now())`,
        [id, subject, email, name, input.timeZone ?? null, await hashPassword(input.password)],
      );
    } catch (err) {
      // Two sign-ups with the same email at the same moment: one wins.
      if ((err as { code?: string }).code === '23505') throw taken;
      throw err;
    }
    await this.send(async () => verifyEmail(email, name, await this.emailLink(id, 'verify', VERIFY_HOURS * 60)));
    return this.startSession(id, subject);
  }

  async login(emailInput: string, password: string): Promise<Session> {
    const email = normaliseEmail(emailInput);
    const [user] = await this.db.query<{ id: string; auth_subject: string; password_hash: string; failed_logins: number; locked: boolean }>(
      `select id, auth_subject, password_hash, failed_logins, coalesce(locked_until > now(), false) as locked from users where lower(email) = $1 and password_hash is not null`,
      [email],
    );
    if (!user) {
      // The same time, the same answers, the same waiting as a real account.
      await spendTimeAsIfChecking(password);
      if (!this.unknownFailures.take(email).ok) throw new SignInError(LOCKED, 429);
      throw new SignInError(WRONG, 401);
    }
    if (user.locked) {
      await spendTimeAsIfChecking(password);
      throw new SignInError(LOCKED, 429);
    }
    const { ok, rehash } = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const failed = user.failed_logins + 1;
      const lock = failed % LOCK_AFTER === 0;
      await this.db.query(`update users set failed_logins = $2, locked_until = case when $3 then now() + make_interval(mins => $4::int) else locked_until end where id = $1`, [
        user.id,
        failed,
        lock,
        LOCK_MINUTES,
      ]);
      throw new SignInError(lock ? LOCKED : WRONG, lock ? 429 : 401);
    }
    await this.db.query(
      `update users set failed_logins = 0, locked_until = null${rehash ? ', password_hash = $2' : ''} where id = $1`,
      rehash ? [user.id, await hashPassword(password)] : [user.id],
    );
    return this.startSession(user.id, user.auth_subject);
  }

  /** A new access token, and a new refresh token in place of the one presented. */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string }> {
    const hash = sha(refreshToken);
    const [current] = await this.db.query<{ id: string; subject: string; open: boolean }>(
      `select s.id, u.auth_subject as subject, (s.revoked_at is null and s.expires_at > now()) as open from sessions s join users u on u.id = s.user_id where s.refresh_hash = $1`,
      [hash],
    );
    if (current) {
      if (!current.open) throw new SignInError(ENDED, 401);
      const next = newSecret();
      await this.db.query('update sessions set previous_hash = refresh_hash, refresh_hash = $2, last_used_at = now() where id = $1', [current.id, sha(next)]);
      const access = await this.accessToken(current.subject, current.id);
      return { accessToken: access.token, expiresAt: access.expiresAt, refreshToken: next };
    }
    const [old] = await this.db.query<{ id: string; subject: string; open: boolean; recent: boolean }>(
      `select s.id, u.auth_subject as subject, (s.revoked_at is null and s.expires_at > now()) as open, s.last_used_at > now() - make_interval(secs => $2::int) as recent
       from sessions s join users u on u.id = s.user_id where s.previous_hash = $1`,
      [hash, REUSE_GRACE_SECONDS],
    );
    if (old?.open && old.recent) {
      // Another tab refreshed a moment ago; this one keeps the cookie that tab got.
      const access = await this.accessToken(old.subject, old.id);
      return { accessToken: access.token, expiresAt: access.expiresAt };
    }
    // An old refresh token used again: someone has a copy. End the session for everyone holding it.
    if (old) await this.db.query(`update sessions set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'reuse') where id = $1`, [old.id]);
    throw new SignInError(ENDED, 401);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.query(`update sessions set revoked_at = now(), revoked_reason = 'logout' where refresh_hash = $1 and revoked_at is null`, [sha(refreshToken)]);
  }

  /** Ends every session of the person, or every one but this device's. Returns how many ended. */
  async logoutEverywhere(userId: string, keep?: string): Promise<number> {
    const rows = await this.db.query(
      `update sessions set revoked_at = now(), revoked_reason = 'logout-all' where user_id = $1 and revoked_at is null and id <> coalesce($2, '') returning id`,
      [userId, keep ?? null],
    );
    return rows.length;
  }

  /** A new password, after the current one. Every other device is signed out. */
  async changePassword(userId: string, sessionId: string, current: string, next: string): Promise<void> {
    const [user] = await this.db.query<{ email: string; name: string; password_hash: string | null }>('select email, name, password_hash from users where id = $1', [userId]);
    if (!user?.password_hash) throw new SignInError('This account signs in another way.', 400);
    if (!(await verifyPassword(current, user.password_hash)).ok) throw new SignInError('Your current password is not right.', 400, 'current');
    const weak = passwordProblem(next, { email: user.email, name: user.name });
    if (weak) throw new SignInError(weak, 400, 'password');
    if (current === next) throw new SignInError('Choose a password different from the current one.', 400, 'password');
    await this.db.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [userId, await hashPassword(next)]);
    await this.db.query(`update sessions set revoked_at = now(), revoked_reason = 'password' where user_id = $1 and revoked_at is null and id <> $2`, [userId, sessionId]);
  }

  /** Emails a link to set a new password, if there is such an account. Says the same either way. */
  async forgotPassword(emailInput: string): Promise<void> {
    const email = normaliseEmail(emailInput);
    const [user] = await this.db.query<{ id: string }>('select id from users where lower(email) = $1 and password_hash is not null', [email]);
    if (!user) return;
    await this.send(async () => resetEmail(email, await this.emailLink(user.id, 'reset', RESET_MINUTES)));
  }

  /** Sets a new password from an emailed link: every device is signed out, and this one is signed in. */
  async resetPassword(token: string, password: string): Promise<Session> {
    const [peek] = await this.db.query<{ email: string; name: string }>(
      `select u.email, u.name from email_tokens t join users u on u.id = t.user_id where t.token_hash = $1 and t.purpose = 'reset' and t.used_at is null and t.expires_at > now()`,
      [sha(token)],
    );
    if (!peek) throw new SignInError(OLD_LINK, 400);
    const weak = passwordProblem(password, peek);
    if (weak) throw new SignInError(weak, 400, 'password');
    const userId = await this.useLink(token, 'reset');
    const [user] = await this.db.query<{ auth_subject: string }>(
      // Opening the emailed link also proves the address.
      `update users set password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = null, email_verified_at = coalesce(email_verified_at, now())
       where id = $1 returning auth_subject`,
      [userId, await hashPassword(password)],
    );
    await this.db.query(`update sessions set revoked_at = now(), revoked_reason = 'reset' where user_id = $1 and revoked_at is null`, [userId]);
    return this.startSession(userId, user.auth_subject);
  }

  async confirmEmail(token: string): Promise<void> {
    const userId = await this.useLink(token, 'verify');
    await this.db.query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [userId]);
  }

  /** Sends the confirmation link again, unless the address is already confirmed. */
  async resendConfirmation(userId: string): Promise<boolean> {
    const [user] = await this.db.query<{ email: string; name: string; verified: boolean }>(
      'select email, name, email_verified_at is not null as verified from users where id = $1 and password_hash is not null',
      [userId],
    );
    if (!user || user.verified) return false;
    await this.send(async () => verifyEmail(user.email, user.name, await this.emailLink(userId, 'verify', VERIFY_HOURS * 60)));
    return true;
  }
}
