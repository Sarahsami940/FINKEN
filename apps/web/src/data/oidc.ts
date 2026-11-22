/**
 * Signing in through a sign-in provider, with OpenID Connect: the open
 * standard that Auth0, Google, Microsoft, Okta, Keycloak, Zitadel, AWS
 * Cognito and most other sign-in companies support. Finken never sees a
 * password.
 *
 * 1. "Sign in" sends the person to the provider's own page (the
 *    authorization code flow, with PKCE, the standard for apps like this).
 * 2. The provider sends them back to /auth/callback with a one-time code.
 * 3. Finken swaps the code for tokens. The ID token, signed by the provider,
 *    is what Finken's server checks on every request.
 * 4. Before it runs out, a refresh token gets a new one, so people stay
 *    signed in.
 *
 * Connecting a provider takes two settings, VITE_AUTH_ISSUER and
 * VITE_AUTH_CLIENT_ID (docs/SIGN-IN.md). Nothing here names a provider.
 */

export interface OidcSettings {
  /** The provider's address, such as https://finken.eu.auth0.com/ */
  issuer: string;
  /** The id the provider gave Finken's web app. */
  clientId: string;
  /** Asked for on top of `openid`; `offline_access` brings a refresh token. */
  scope?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export interface Tokens {
  /** Sent to Finken's server on every request. */
  idToken: string;
  refreshToken?: string;
  /** When the ID token stops working, in milliseconds. */
  expiresAt: number;
}

/** Something that went wrong with signing in, in words that can be shown. */
export class SignInError extends Error {}

const PENDING_KEY = 'finken:sign-in';

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomText = (bytes = 32) => base64Url(crypto.getRandomValues(new Uint8Array(bytes)));

/** The PKCE challenge for a verifier: the provider checks the code is swapped by whoever asked for it. */
export async function challengeFor(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** What a token says about itself, without checking it (the server checks every token it is sent). */
export function claimsOf(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new SignInError('The sign-in provider sent a token Finken cannot read.');
  const json = atob(
    part
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '='),
  );
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
}

export class OidcClient {
  private discovery: Promise<Discovery> | null = null;

  constructor(
    private settings: OidcSettings,
    private options: { fetch?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; origin?: string } = {},
  ) {}

  private get fetch() {
    return this.options.fetch ?? fetch.bind(globalThis);
  }

  private get pending() {
    return this.options.storage ?? sessionStorage;
  }

  /** Where the provider sends people back to. It must be listed in the provider's settings. */
  get redirectUri() {
    return `${this.options.origin ?? window.location.origin}/auth/callback`;
  }

  /** The provider's addresses, read once from its published settings. */
  private settingsFromProvider(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const url = `${this.settings.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      let res: Response;
      try {
        res = await this.fetch(url);
      } catch {
        this.discovery = null;
        throw new SignInError('Finken could not reach the sign-in service. Check your connection and try again.');
      }
      if (!res.ok) {
        this.discovery = null;
        throw new SignInError('The sign-in service is not answering properly. Try again later.');
      }
      return (await res.json()) as Discovery;
    })();
    return this.discovery;
  }

  /** The address of the provider's sign-in page. Remembers what is needed to finish when the person comes back. */
  async signInUrl(options: { signUp?: boolean; loginHint?: string } = {}): Promise<string> {
    const d = await this.settingsFromProvider();
    const verifier = randomText();
    const state = randomText(16);
    const nonce = randomText(16);
    this.pending.setItem(PENDING_KEY, JSON.stringify({ verifier, state, nonce }));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.settings.clientId,
      redirect_uri: this.redirectUri,
      scope: ['openid', 'email', 'profile', ...(this.settings.scope ?? 'offline_access').split(/\s+/).filter(Boolean)].join(' '),
      state,
      nonce,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    });
    // Most providers open straight on their sign-up form when asked.
    if (options.signUp) params.set('screen_hint', 'signup');
    if (options.loginHint) params.set('login_hint', options.loginHint);
    return `${d.authorization_endpoint}?${params}`;
  }

  /** Back from the provider: checks the answer is the one Finken asked for, and swaps the code for tokens. */
  async finishSignIn(callbackUrl: string): Promise<Tokens> {
    const url = new URL(callbackUrl);
    const saved = this.pending.getItem(PENDING_KEY);
    this.pending.removeItem(PENDING_KEY);
    const error = url.searchParams.get('error');
    if (error) {
      throw new SignInError(error === 'access_denied' ? 'Signing in was cancelled.' : 'The sign-in service could not sign you in. Try again.');
    }
    const code = url.searchParams.get('code');
    const { verifier, state, nonce } = saved ? (JSON.parse(saved) as { verifier: string; state: string; nonce: string }) : ({} as Record<string, string>);
    // A different state means this answer is not for the sign-in started here: never use it.
    if (!code || !verifier || url.searchParams.get('state') !== state) throw new SignInError('That sign-in link is out of date. Sign in again.');
    const tokens = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier });
    if (claimsOf(tokens.idToken).nonce !== nonce) throw new SignInError('That sign-in link is out of date. Sign in again.');
    return tokens;
  }

  /** A new ID token before the old one runs out. */
  refresh(refreshToken: string): Promise<Tokens> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
  }

  /** The provider's sign-out page, when it has one, so its own session ends too. */
  async signOutUrl(idToken: string | null): Promise<string | null> {
    const d = await this.settingsFromProvider().catch(() => null);
    if (!d?.end_session_endpoint) return null;
    const params = new URLSearchParams({ client_id: this.settings.clientId, post_logout_redirect_uri: this.options.origin ?? window.location.origin });
    if (idToken) params.set('id_token_hint', idToken);
    return `${d.end_session_endpoint}?${params}`;
  }

  private async tokenRequest(body: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
    const d = await this.settingsFromProvider();
    let res: Response;
    try {
      res = await this.fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.settings.clientId, ...body }),
      });
    } catch {
      throw new SignInError('Finken could not reach the sign-in service. Check your connection and try again.');
    }
    const data = (await res.json().catch(() => ({}))) as { id_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !data.id_token) {
      // A refresh token that no longer works means the sign-in has ended; a code that no longer works is an old link.
      const ended = body.grant_type === 'refresh_token' ? 'Your sign-in has ended. Sign in again.' : 'That sign-in link is out of date. Sign in again.';
      throw new SignInError(data.error === 'invalid_grant' ? ended : 'The sign-in service could not sign you in. Try again.');
    }
    const exp = Number(claimsOf(data.id_token).exp);
    return {
      idToken: data.id_token,
      // Some providers send a new refresh token each time; others keep the old one.
      refreshToken: data.refresh_token ?? previousRefresh,
      expiresAt: Number.isFinite(exp) ? exp * 1000 : Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  }
}

type Env = { VITE_AUTH_ISSUER?: string; VITE_AUTH_CLIENT_ID?: string; VITE_AUTH_SCOPE?: string };
const env = ((import.meta as { env?: Env }).env ?? {}) as Env;

/** The provider's settings from the build, or null while Finken uses the development sign-in. */
export const oidcSettings: OidcSettings | null =
  env.VITE_AUTH_ISSUER?.trim() && env.VITE_AUTH_CLIENT_ID?.trim()
    ? { issuer: env.VITE_AUTH_ISSUER.trim(), clientId: env.VITE_AUTH_CLIENT_ID.trim(), scope: env.VITE_AUTH_SCOPE }
    : null;
