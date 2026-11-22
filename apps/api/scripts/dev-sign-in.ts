/**
 * A stand-in sign-in provider, for development and tests only. It speaks
 * the same OpenID Connect as Auth0, Google, Keycloak and the rest, so the
 * real sign-in path (the provider's page, PKCE, signed ID tokens, renewing
 * them, signing out) can be tried and tested before a provider is chosen.
 *
 * Anyone can sign in with any email and no password: it must never run
 * anywhere real. The production build does not include it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface DevSignInOptions {
  port: number;
  clientId?: string;
  /** Addresses the provider may send people back to. */
  redirectUris: string[];
  /** How long an ID token lasts. Short in tests, to exercise renewing. */
  tokenSeconds?: number;
}

const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha256 = (text: string) => createHash('sha256').update(text).digest('base64url');

export async function startDevSignIn({ port, clientId = 'finken-web', redirectUris, tokenSeconds = 3600 }: DevSignInOptions) {
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'dev-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { email: string; name: string; challenge: string; nonce: string; redirectUri: string }>();
  const refreshTokens = new Map<string, { email: string; name: string }>();

  const subjectFor = (email: string) => `dev|${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}`;
  const idToken = (who: { email: string; name: string }, nonce?: string) =>
    new SignJWT({ email: who.email.toLowerCase(), name: who.name, ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(subjectFor(who.email))
      .setIssuedAt()
      .setExpirationTime(`${tokenSeconds}s`)
      .sign(privateKey);

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  // The web app calls the discovery and token addresses from the browser.
  app.addHook('onSend', async (req, reply) => {
    if (req.headers.origin) reply.header('access-control-allow-origin', req.headers.origin);
  });

  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks.json`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
  }));

  app.get('/jwks.json', async () => ({ keys: [jwk] }));

  type AuthorizeQuery = Record<'client_id' | 'redirect_uri' | 'state' | 'nonce' | 'code_challenge' | 'code_challenge_method' | 'login_hint' | 'screen_hint', string | undefined>;

  /** The provider's own page: an email and a name, no password. */
  app.get<{ Querystring: AuthorizeQuery }>('/authorize', async (req, reply) => {
    const q = req.query;
    if (q.client_id !== clientId || !q.redirect_uri || !redirectUris.includes(q.redirect_uri)) return reply.code(400).type('text/plain').send('Unknown app or return address.');
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) return reply.code(400).type('text/plain').send('PKCE (S256) is required.');
    const hidden = (['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'] as const)
      .map((k) => `<input type="hidden" name="${k}" value="${html(q[k] ?? '')}">`)
      .join('');
    return reply
      .type('text/html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Development sign-in</title>
<style>body{font:16px system-ui;max-width:26rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:1rem 0 .3rem;font-weight:600}input{width:100%;padding:.6rem;font:inherit;box-sizing:border-box}button{margin-top:1.2rem;padding:.7rem 1.2rem;font:inherit;font-weight:700}</style></head>
<body><h1>Development sign-in</h1><p>A stand-in for the real sign-in provider. Any email works; there is no password.</p>
<form method="post" action="/authorize">${hidden}
<label for="email">Email</label><input id="email" name="email" type="email" required value="${html(q.login_hint ?? '')}">
<label for="name">Name</label><input id="name" name="name">
<button type="submit">${q.screen_hint === 'signup' ? 'Create account' : 'Sign in'}</button>
<button type="submit" name="cancel" value="1" formnovalidate>Cancel</button></form></body></html>`);
  });

  app.post<{ Body: Record<string, string> }>('/authorize', async (req, reply) => {
    const b = req.body;
    if (b.client_id !== clientId || !redirectUris.includes(b.redirect_uri)) return reply.code(400).type('text/plain').send('Unknown app or return address.');
    const back = new URL(b.redirect_uri);
    if (b.state) back.searchParams.set('state', b.state);
    if (b.cancel) {
      back.searchParams.set('error', 'access_denied');
      return reply.redirect(back.toString());
    }
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { email: b.email, name: b.name ?? '', challenge: b.code_challenge, nonce: b.nonce, redirectUri: b.redirect_uri });
    setTimeout(() => codes.delete(code), 60_000).unref();
    back.searchParams.set('code', code);
    return reply.redirect(back.toString());
  });

  app.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const b = req.body;
    if (b.client_id !== clientId) return reply.code(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      const grant = codes.get(b.code);
      codes.delete(b.code);
      // The code works once, back to the same address, for whoever holds the PKCE verifier.
      if (!grant || grant.redirectUri !== b.redirect_uri || sha256(b.code_verifier ?? '') !== grant.challenge) return reply.code(400).send({ error: 'invalid_grant' });
      const refresh = randomUUID();
      refreshTokens.set(refresh, grant);
      return { token_type: 'Bearer', id_token: await idToken(grant, grant.nonce), refresh_token: refresh, expires_in: tokenSeconds };
    }
    if (b.grant_type === 'refresh_token') {
      const who = refreshTokens.get(b.refresh_token);
      if (!who) return reply.code(400).send({ error: 'invalid_grant' });
      // Each refresh token works once; a new one comes with every answer.
      refreshTokens.delete(b.refresh_token);
      const next = randomUUID();
      refreshTokens.set(next, who);
      return { token_type: 'Bearer', id_token: await idToken(who), refresh_token: next, expires_in: tokenSeconds };
    }
    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.get<{ Querystring: { post_logout_redirect_uri?: string } }>('/logout', async (req, reply) => {
    const to = req.query.post_logout_redirect_uri;
    const allowed = to && redirectUris.some((r) => new URL(r).origin === new URL(to).origin);
    return allowed ? reply.redirect(to) : reply.type('text/plain').send('Signed out.');
  });

  await app.listen({ host: '127.0.0.1', port });
  return { issuer, clientId, jwksUrl: `${issuer}/jwks.json`, close: () => app.close() };
}
