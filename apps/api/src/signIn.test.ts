/**
 * Finken's own sign-in: accounts, passwords and sessions kept by Finken.
 * What an attacker would try is tested next to what people do every day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import type { Db } from './db';
import { type Email, logMailer } from './mail';
import { migrate } from './migrate';
import { hashPassword, passwordProblem, verifyPassword } from './passwords';
import { testDb } from './testing';

const CONFIG = { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'password', AUTH_SECRET: 'p'.repeat(40), APP_URL: 'https://app.finken.test' } as const;
const PASSWORD = 'correct horse battery';

let db: Db;
let app: ReturnType<typeof buildApp>;
const mailer = logMailer(() => {});

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  // Many accounts from one test address: the address limits get their own tests below.
  const roomy = { max: 10_000, windowMs: 60_000 };
  app = buildApp({ db, config: CONFIG, mailer, limits: { register: roomy, login: roomy, forgot: roomy, emailLink: roomy } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

type Reply = Awaited<ReturnType<typeof app.inject>>;
const post = (url: string, payload: object = {}, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload, headers });
const cookieOf = (res: Reply) => {
  const set = String(res.headers['set-cookie'] ?? '');
  return /finken_session=([^;]*)/.exec(set)?.[1] ?? null;
};
const refresh = (cookie: string | null) => post('/v1/auth/refresh', {}, { cookie: `finken_session=${cookie}`, 'x-finken-session': '1' });
const me = (token: string) => app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
const lastEmail = (to: string): Email => mailer.recent!().find((e) => e.to === to)!;
const tokenIn = (email: Email) => new URL(email.link).hash.replace('#token=', '');

async function signUp(email: string, password = PASSWORD, name = 'Test') {
  const res = await post('/v1/auth/register', { email, password, name, timeZone: 'Asia/Karachi' });
  expect(res.statusCode, res.body).toBe(201);
  return { access: res.json().accessToken as string, cookie: cookieOf(res), res };
}

describe('passwords', () => {
  it('are stored only as salted scrypt hashes that cannot be turned back', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).toMatch(/^scrypt\$15\$8\$3\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('same password');
    expect((await verifyPassword('same password here', a)).ok).toBe(true);
    expect((await verifyPassword('same password herE', a)).ok).toBe(false);
  });

  it('upgrades old settings on the next sign-in', async () => {
    const old = (await hashPassword('x')).replace(/^scrypt\$15\$8\$3\$/, 'scrypt$14$8$1$');
    expect(await verifyPassword('x', old)).toEqual({ ok: false, rehash: false });
  });

  it.each([
    ['short1234', 'Use at least 10 characters.'],
    ['password123', 'That password is too easy to guess. Try a few unrelated words together.'],
    ['Pakistan123', 'That password is too easy to guess. Try a few unrelated words together.'],
    ['aaaaaaaaaaaa', 'That password is too easy to guess. Try a few unrelated words together.'],
    ['12345678901234', 'That password is too easy to guess. Try a few unrelated words together.'],
    ['sana.khan-2026!', 'Do not use your email address in your password.'],
  ])('refuses %s', (password, why) => expect(passwordProblem(password, { email: 'sana.khan@example.com' })).toBe(why));

  it('accepts a long phrase', () => expect(passwordProblem('tea at four by the river')).toBeNull());
});

describe('signing up and in', () => {
  it('creates the account, signs the device in, and emails a link to confirm the address', async () => {
    const { access, cookie, res } = await signUp('Sana@Example.com', PASSWORD, 'Sana');
    // The refresh token is only in a cookie page scripts cannot read, sent only to Finken.
    expect(String(res.headers['set-cookie'])).toMatch(/^finken_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect(res.body).not.toContain(cookie!);
    expect((await me(access)).json()).toMatchObject({ email: 'sana@example.com', name: 'Sana', signIn: 'password', emailVerified: false });

    // The database has a hash, never the password or the refresh token.
    const [row] = await db.query<{ password_hash: string }>(`select password_hash from users where email = 'sana@example.com'`);
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    const everything = JSON.stringify(await db.query('select * from sessions')) + JSON.stringify(await db.query('select * from users'));
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(cookie!);

    // The emailed link (with the token after #, so it never reaches a server log) confirms the address, once.
    const email = lastEmail('sana@example.com');
    expect(email.link).toMatch(/^https:\/\/app\.finken\.test\/auth\/verify#token=/);
    expect((await post('/v1/auth/verify', { token: tokenIn(email) })).statusCode).toBe(204);
    expect((await me(access)).json().emailVerified).toBe(true);
    expect((await post('/v1/auth/verify', { token: tokenIn(email) })).json().error).toBe('That link has expired or was already used. Ask for a new one.');
  });

  it('one account per email, however it is typed', async () => {
    await signUp('one@example.com');
    const again = await post('/v1/auth/register', { email: ' ONE@example.com ', password: 'another long phrase' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ field: 'email' });
  });

  it('refuses weak passwords and bad emails, saying which field', async () => {
    expect((await post('/v1/auth/register', { email: 'weak@example.com', password: 'password123' })).json()).toMatchObject({ field: 'password' });
    expect((await post('/v1/auth/register', { email: 'not-an-email', password: PASSWORD })).json()).toMatchObject({ field: 'email', error: 'Enter a valid email address.' });
  });

  it('logs in with the right password only, and gives the same answer for a wrong email', async () => {
    await signUp('lena@example.com');
    const ok = await post('/v1/auth/login', { email: 'LENA@example.com', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toBeTruthy();
    const wrongPassword = await post('/v1/auth/login', { email: 'lena@example.com', password: 'not the password' });
    const wrongEmail = await post('/v1/auth/login', { email: 'nobody@example.com', password: 'not the password' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongEmail.statusCode).toBe(401);
    expect(wrongEmail.json()).toEqual(wrongPassword.json());
    expect(wrongPassword.json()).toEqual({ error: 'That email and password do not match a Finken account.' });
  });

  it('makes an account wait after 5 wrong passwords, even for the right one, and the same for unknown emails', async () => {
    await signUp('guess@example.com');
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push((await post('/v1/auth/login', { email: 'guess@example.com', password: `wrong guess ${i}` })).statusCode);
    expect(tries).toEqual([401, 401, 401, 401, 429]);
    const right = await post('/v1/auth/login', { email: 'guess@example.com', password: PASSWORD });
    expect(right.statusCode).toBe(429);
    expect(right.json().error).toMatch(/^Too many wrong passwords\. Wait 15 minutes/);

    const ghost = [];
    for (let i = 0; i < 6; i++) ghost.push((await post('/v1/auth/login', { email: 'ghost@example.com', password: `wrong guess ${i}` })).statusCode);
    expect(ghost).toEqual([401, 401, 401, 401, 401, 429]);

    // Once the wait is over, the right password works and the count starts again.
    await db.query(`update users set locked_until = now() - interval '1 second' where email = 'guess@example.com'`);
    expect((await post('/v1/auth/login', { email: 'guess@example.com', password: PASSWORD })).statusCode).toBe(200);
  });

  it('limits sign-in attempts from one address', async () => {
    const small = buildApp({ db, config: CONFIG, mailer, limits: { login: { max: 2, windowMs: 60_000 } } });
    for (let i = 0; i < 2; i++) await small.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: `x${i}@example.com`, password: 'whatever it is' } });
    expect((await small.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x9@example.com', password: 'whatever it is' } })).statusCode).toBe(429);
    await small.close();
  });

  it('limits sign-ups and “forgot password” from one address, and per email', async () => {
    const small = buildApp({ db, config: CONFIG, mailer, limits: { register: { max: 1, windowMs: 60_000 }, forgot: { max: 1, windowMs: 60_000 } } });
    const signUpOnce = (email: string) => small.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: PASSWORD } });
    expect((await signUpOnce('lim1@example.com')).statusCode).toBe(201);
    expect((await signUpOnce('lim2@example.com')).statusCode).toBe(429);
    expect((await small.inject({ method: 'POST', url: '/v1/auth/forgot', payload: { email: 'lim1@example.com' } })).statusCode).toBe(202);
    expect((await small.inject({ method: 'POST', url: '/v1/auth/forgot', payload: { email: 'lim1@example.com' } })).statusCode).toBe(429);
    await small.close();
  });
});

describe('sessions', () => {
  it('refreshing swaps the cookie for a new one and gives a new access token', async () => {
    const { cookie } = await signUp('rota@example.com');
    const next = await refresh(cookie);
    expect(next.statusCode, next.body).toBe(200);
    const nextCookie = cookieOf(next);
    expect(nextCookie).toBeTruthy();
    expect(nextCookie).not.toBe(cookie);
    expect((await me(next.json().accessToken)).statusCode).toBe(200);
  });

  it('two tabs refreshing at once both stay signed in', async () => {
    const { cookie } = await signUp('tabs@example.com');
    const first = await refresh(cookie);
    const second = await refresh(cookie);
    expect(second.statusCode).toBe(200);
    // The second tab keeps the cookie the first one got.
    expect(cookieOf(second)).toBeNull();
    expect((await me(second.json().accessToken)).statusCode).toBe(200);
    expect((await refresh(cookieOf(first))).statusCode).toBe(200);
  });

  it('an old refresh token used again later means it was copied: the whole session ends', async () => {
    const { cookie } = await signUp('stolen@example.com');
    const fresh = await refresh(cookie);
    const access = fresh.json().accessToken as string;
    // Later, someone replays the old cookie.
    await db.query(
      `update sessions set last_used_at = now() - interval '2 minutes' where previous_hash is not null and user_id = (select id from users where email = 'stolen@example.com')`,
    );
    const replay = await refresh(cookie);
    expect(replay.statusCode).toBe(401);
    expect(String(replay.headers['set-cookie'])).toContain('Max-Age=0');
    // Everyone holding that session is out, the real owner included, at once.
    expect((await refresh(cookieOf(fresh))).statusCode).toBe(401);
    expect((await me(access)).statusCode).toBe(401);
    const [s] = await db.query<{ revoked_reason: string }>(`select revoked_reason from sessions where user_id = (select id from users where email = 'stolen@example.com')`);
    expect(s.revoked_reason).toBe('reuse');
  });

  it('refreshing needs Finken’s own header, so another site cannot do it', async () => {
    const { cookie } = await signUp('csrf@example.com');
    const forged = await post('/v1/auth/refresh', {}, { cookie: `finken_session=${cookie}` });
    expect(forged.statusCode).toBe(403);
    expect((await post('/v1/auth/logout', {}, { cookie: `finken_session=${cookie}` })).statusCode).toBe(403);
    expect((await refresh(cookie)).statusCode).toBe(200);
  });

  it('logging out ends the session at once, even for an access token that has not run out', async () => {
    const { access, cookie } = await signUp('bye@example.com');
    const out = await post('/v1/auth/logout', {}, { cookie: `finken_session=${cookie}`, 'x-finken-session': '1' });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await me(access)).statusCode).toBe(401);
    expect((await refresh(cookie)).statusCode).toBe(401);
  });

  it('“sign out other devices” keeps this one', async () => {
    const phone = await signUp('many@example.com');
    const laptop = await post('/v1/auth/login', { email: 'many@example.com', password: PASSWORD });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout-others', headers: { authorization: `Bearer ${phone.access}` } });
    expect(res.json()).toEqual({ ended: 1 });
    expect((await me(phone.access)).statusCode).toBe(200);
    expect((await me(laptop.json().accessToken)).statusCode).toBe(401);
  });

  it('refuses forged, tampered and outside tokens', async () => {
    const { access } = await signUp('forge@example.com');
    const [h, p, s] = access.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: 'finken:someone-else' })).toString('base64url')}.${s}`;
    expect((await me(tampered)).statusCode).toBe(401);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${p}.`;
    expect((await me(none)).statusCode).toBe(401);
    // A token signed with another secret (another Finken server, or a guess).
    const other = buildApp({ db, config: { ...CONFIG, AUTH_SECRET: 'q'.repeat(40) }, mailer });
    const theirs = (await other.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'forge@example.com', password: PASSWORD } })).json().accessToken;
    expect((await me(theirs)).statusCode).toBe(401);
    await other.close();
  });

  it('a deleted account never comes back, whatever tokens are left', async () => {
    const { access, cookie } = await signUp('gone@example.com');
    expect((await app.inject({ method: 'DELETE', url: '/v1/me', headers: { authorization: `Bearer ${access}` }, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect((await me(access)).statusCode).toBe(401);
    expect((await refresh(cookie)).statusCode).toBe(401);
    expect(await db.query(`select 1 from users where email = 'gone@example.com'`)).toEqual([]);
    // The email is free for a new account.
    await signUp('gone@example.com');
  });
});

describe('changing and resetting the password', () => {
  it('changing needs the current password, and signs out every other device', async () => {
    const phone = await signUp('change@example.com');
    const laptop = await post('/v1/auth/login', { email: 'change@example.com', password: PASSWORD });
    const auth = { authorization: `Bearer ${phone.access}` };
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/password', headers: auth, payload: { current: 'not it at all', password: 'a brand new phrase' } });
    expect(wrong.json()).toMatchObject({ field: 'current', error: 'Your current password is not right.' });
    const ok = await app.inject({ method: 'POST', url: '/v1/auth/password', headers: auth, payload: { current: PASSWORD, password: 'a brand new phrase' } });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await me(phone.access)).statusCode).toBe(200);
    expect((await me(laptop.json().accessToken)).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: 'change@example.com', password: PASSWORD })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: 'change@example.com', password: 'a brand new phrase' })).statusCode).toBe(200);
  });

  it('“forgot” says the same for every email, and only real accounts get a link', async () => {
    await signUp('forgot@example.com');
    const real = await post('/v1/auth/forgot', { email: 'forgot@example.com' });
    const fake = await post('/v1/auth/forgot', { email: 'nobody-here@example.com' });
    expect([real.statusCode, fake.statusCode]).toEqual([202, 202]);
    expect(fake.json()).toEqual(real.json());
    expect(lastEmail('forgot@example.com').subject).toBe('Set a new Finken password');
    expect(lastEmail('nobody-here@example.com')).toBeUndefined();
  });

  it('a reset link sets a new password once, signs out everywhere, and signs this device in', async () => {
    const before = await signUp('reset@example.com');
    await post('/v1/auth/forgot', { email: 'reset@example.com' });
    const token = tokenIn(lastEmail('reset@example.com'));
    expect((await post('/v1/auth/reset', { token, password: 'password123' })).json()).toMatchObject({ field: 'password' });
    const done = await post('/v1/auth/reset', { token, password: 'a fresh new phrase' });
    expect(done.statusCode, done.body).toBe(200);
    expect(cookieOf(done)).toBeTruthy();
    expect((await me(done.json().accessToken)).json()).toMatchObject({ email: 'reset@example.com', emailVerified: true });
    expect((await me(before.access)).statusCode).toBe(401);
    expect((await post('/v1/auth/reset', { token, password: 'yet another phrase' })).statusCode).toBe(400);
    expect((await post('/v1/auth/login', { email: 'reset@example.com', password: 'a fresh new phrase' })).statusCode).toBe(200);
  });

  it('only the newest reset link works, and links expire', async () => {
    await signUp('links@example.com');
    await post('/v1/auth/forgot', { email: 'links@example.com' });
    const first = tokenIn(lastEmail('links@example.com'));
    await post('/v1/auth/forgot', { email: 'links@example.com' });
    const second = tokenIn(lastEmail('links@example.com'));
    expect((await post('/v1/auth/reset', { token: first, password: 'a fresh new phrase' })).statusCode).toBe(400);
    await db.query(`update email_tokens set expires_at = now() - interval '1 second' where used_at is null`);
    expect((await post('/v1/auth/reset', { token: second, password: 'a fresh new phrase' })).statusCode).toBe(400);
  });

  it('a reset also lifts the wait after too many wrong passwords', async () => {
    await signUp('locked@example.com');
    for (let i = 0; i < 5; i++) await post('/v1/auth/login', { email: 'locked@example.com', password: `wrong guess ${i}` });
    await post('/v1/auth/forgot', { email: 'locked@example.com' });
    await post('/v1/auth/reset', { token: tokenIn(lastEmail('locked@example.com')), password: 'a fresh new phrase' });
    expect((await post('/v1/auth/login', { email: 'locked@example.com', password: 'a fresh new phrase' })).statusCode).toBe(200);
  });
});

describe('settings', () => {
  it('password sign-in needs a secret, and a real mail server and https address outside development', async () => {
    const { loadConfig } = await import('./config');
    const base = { DATABASE_URL: 'postgres://x@localhost/x', AUTH_MODE: 'password' };
    expect(() => loadConfig({ ...base })).toThrow(/AUTH_SECRET: required when AUTH_MODE is password/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_SECRET: 's'.repeat(40) })).toThrow(/APP_URL: must be https[\s\S]*SMTP_URL: required[\s\S]*MAIL_FROM: required/);
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        AUTH_SECRET: 's'.repeat(40),
        APP_URL: 'https://app.finken.pk',
        SMTP_URL: 'smtps://u:p@mail.finken.pk:465',
        MAIL_FROM: 'Finken <no-reply@finken.pk>',
      }).AUTH_MODE,
    ).toBe('password');
  });

  it('in staging and production the cookie is only ever sent over https', async () => {
    const live = buildApp({ db, config: { ...CONFIG, NODE_ENV: 'production', LOG_LEVEL: 'silent' }, mailer });
    const res = await live.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'https@example.com', password: PASSWORD } });
    expect(String(res.headers['set-cookie'])).toMatch(/; Secure$/);
    // And no development email list exists there.
    expect((await live.inject({ method: 'GET', url: '/v1/dev/mail' })).statusCode).toBe(404);
    await live.close();
  });
});
