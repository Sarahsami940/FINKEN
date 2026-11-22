/**
 * Signing in through a sign-in provider (OpenID Connect), end to end: the
 * web app's sign-in code, a provider (the stand-in, which speaks the same
 * standard as Auth0, Google or Keycloak) and the API in `AUTH_MODE=oidc`,
 * exactly as staging and production run it.
 */
import { startDevSignIn } from '@finken/api/scripts/dev-sign-in';
import { buildApp } from '@finken/api/src/app';
import { migrate } from '@finken/api/src/migrate';
import { testDb } from '@finken/api/src/testing';
import { claimsOf, OidcClient, SignInError } from '@finken/web/src/data/oidc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'http://localhost:5199';
let provider: Awaited<ReturnType<typeof startDevSignIn>>;
let api: ReturnType<typeof buildApp>;
let db: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  provider = await startDevSignIn({ port: 4499, redirectUris: [`${ORIGIN}/auth/callback`], tokenSeconds: 120 });
  db = await testDb();
  await migrate(db);
  api = buildApp({
    db,
    config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'oidc', AUTH_ISSUER: provider.issuer, AUTH_AUDIENCE: provider.clientId, AUTH_JWKS_URL: provider.jwksUrl },
  });
});
afterAll(async () => {
  await api.close();
  await db.close();
  await provider.close();
});

/** Session storage, as a browser tab has. */
const tab = () => {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
};

const client = (storage = tab()) => new OidcClient({ issuer: provider.issuer, clientId: provider.clientId }, { storage, origin: ORIGIN });

/** What a person does on the provider's page: fills in the form and is sent back. Returns where they land. */
async function signInOnProvider(signInUrl: string, email: string, name = '', cancel = false): Promise<string> {
  const page = new URL(signInUrl);
  const form = new URLSearchParams({ email, name });
  for (const key of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(key, page.searchParams.get(key) ?? '');
  if (cancel) form.set('cancel', '1');
  const res = await fetch(`${provider.issuer}/authorize`, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  expect(res.status).toBe(302);
  return res.headers.get('location')!;
}

const me = (token: string) => api.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });

describe('signing in with a provider', () => {
  it('asks the provider the standard way: code flow, PKCE, state and nonce, back to /auth/callback', async () => {
    const url = new URL(await client().signInUrl({ signUp: true, loginHint: 'sana@example.com' }));
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.issuer}/authorize`);
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      response_type: 'code',
      client_id: 'finken-web',
      redirect_uri: `${ORIGIN}/auth/callback`,
      code_challenge_method: 'S256',
      screen_hint: 'signup',
      login_hint: 'sana@example.com',
    });
    expect(p.scope.split(' ')).toEqual(['openid', 'email', 'profile', 'offline_access']);
    expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.state.length).toBeGreaterThan(15);
  });

  it('comes back signed in, and the API knows who it is', async () => {
    const c = client();
    const back = await signInOnProvider(await c.signInUrl(), 'Sana@Example.com', 'Sana');
    expect(back.startsWith(`${ORIGIN}/auth/callback?`)).toBe(true);
    const tokens = await c.finishSignIn(back);
    expect(claimsOf(tokens.idToken)).toMatchObject({ iss: provider.issuer, aud: 'finken-web', email: 'sana@example.com' });
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresAt).toBeGreaterThan(Date.now() + 100_000);

    const res = await me(tokens.idToken);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ email: 'sana@example.com', name: 'Sana' });

    // Signing in again later is the same Finken account.
    const again = client();
    const second = await again.finishSignIn(await signInOnProvider(await again.signInUrl(), 'sana@example.com'));
    expect((await me(second.idToken)).json().id).toBe(res.json().id);
  });

  it('renews the token before it runs out, and the old refresh token stops working', async () => {
    const c = client();
    const first = await c.finishSignIn(await signInOnProvider(await c.signInUrl(), 'renew@example.com'));
    const renewed = await c.refresh(first.refreshToken!);
    expect(renewed.idToken).not.toBe(first.idToken);
    expect(renewed.refreshToken).not.toBe(first.refreshToken);
    expect((await me(renewed.idToken)).statusCode).toBe(200);
    await expect(c.refresh(first.refreshToken!)).rejects.toThrow('Your sign-in has ended. Sign in again.');
  });

  it('refuses an answer that is not for the sign-in started on this tab', async () => {
    // Started on one tab, finished on another (or a link someone else sent).
    const back = await signInOnProvider(await client().signInUrl(), 'mallory@example.com');
    await expect(client().finishSignIn(back)).rejects.toThrow('That sign-in link is out of date. Sign in again.');

    // The right tab, but the state was changed on the way.
    const storage = tab();
    const c = client(storage);
    const real = await signInOnProvider(await c.signInUrl(), 'mallory@example.com');
    const forged = new URL(real);
    forged.searchParams.set('state', 'not-the-one');
    await expect(c.finishSignIn(forged.toString())).rejects.toBeInstanceOf(SignInError);
  });

  it('a code works once', async () => {
    const storage = tab();
    const c = client(storage);
    const url = await c.signInUrl();
    const pending = storage.getItem('finken:sign-in');
    const back = await signInOnProvider(url, 'once@example.com');
    await c.finishSignIn(back);
    storage.setItem('finken:sign-in', pending!);
    await expect(c.finishSignIn(back)).rejects.toThrow('That sign-in link is out of date. Sign in again.');
  });

  it('says so when the person cancels on the provider’s page', async () => {
    const c = client();
    const back = await signInOnProvider(await c.signInUrl(), 'x@example.com', '', true);
    await expect(c.finishSignIn(back)).rejects.toThrow('Signing in was cancelled.');
  });

  it('the API refuses tokens it should: another app’s, forged, or from another provider', async () => {
    const c = client();
    const good = await c.finishSignIn(await signInOnProvider(await c.signInUrl(), 'check@example.com'));
    const [h, p, s] = good.idToken.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const swapped = Buffer.from(JSON.stringify({ ...payload, email: 'boss@example.com' })).toString('base64url');
    expect((await me(`${h}.${swapped}.${s}`)).statusCode).toBe(401);

    const other = await startDevSignIn({ port: 4498, redirectUris: [`${ORIGIN}/auth/callback`] });
    try {
      const o = new OidcClient({ issuer: other.issuer, clientId: other.clientId }, { storage: tab(), origin: ORIGIN });
      const foreign = await o.finishSignIn(
        await (async () => {
          const url = new URL(await o.signInUrl());
          const form = new URLSearchParams({ email: 'check@example.com', name: '' });
          for (const key of ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge']) form.set(key, url.searchParams.get(key) ?? '');
          const res = await fetch(`${other.issuer}/authorize`, {
            method: 'POST',
            body: form,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            redirect: 'manual',
          });
          return res.headers.get('location')!;
        })(),
      );
      expect((await me(foreign.idToken)).statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('offers the provider’s sign-out page, returning to Finken', async () => {
    const url = new URL((await client().signOutUrl('token-here'))!);
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.issuer}/logout`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(ORIGIN);
    expect(url.searchParams.get('id_token_hint')).toBe('token-here');
  });

  it('explains when the provider cannot be reached', async () => {
    const down = new OidcClient({ issuer: 'http://127.0.0.1:1', clientId: 'x' }, { storage: tab(), origin: ORIGIN });
    await expect(down.signInUrl()).rejects.toThrow('Finken could not reach the sign-in service. Check your connection and try again.');
  });
});
