import { createRemoteJWKSet, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import type { Config } from './config';
import type { Db } from './db';

/** Who a valid token says the caller is, according to the sign-in provider. */
export interface Identity {
  subject: string;
  email?: string;
  name?: string;
}

/** A signed-in Finken user, as stored in the users table. */
export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  timeZone: string;
}

export type Verifier = (token: string) => Promise<Identity>;

const DEV_ISSUER = 'finken-dev';
const DEV_AUDIENCE = 'finken-api';

function identityFrom(payload: JWTPayload): Identity {
  if (!payload.sub) throw new Error('Token has no subject');
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
  const name = typeof payload.name === 'string' ? payload.name.slice(0, 80) : undefined;
  return { subject: payload.sub, email, name };
}

/**
 * Checks sign-in tokens. In oidc mode the provider's public keys are fetched
 * from AUTH_JWKS_URL (and cached), and the issuer, audience and expiry must all
 * match. Nothing about the provider is hard-coded, so Supabase, Clerk, Auth0 or
 * any other standard provider works by changing settings only.
 */
export function makeVerifier(config: Pick<Config, 'AUTH_MODE' | 'AUTH_ISSUER' | 'AUTH_AUDIENCE' | 'AUTH_JWKS_URL' | 'AUTH_DEV_SECRET'>): Verifier {
  if (config.AUTH_MODE === 'dev') {
    const key = new TextEncoder().encode(config.AUTH_DEV_SECRET);
    return async (token) => identityFrom((await jwtVerify(token, key, { issuer: DEV_ISSUER, audience: DEV_AUDIENCE, algorithms: ['HS256'] })).payload);
  }
  const jwks = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL!));
  return async (token) =>
    identityFrom((await jwtVerify(token, jwks, { issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE, algorithms: ['RS256', 'ES256', 'EdDSA'] })).payload);
}

/** Signs a development token. Only usable when the API runs in dev mode with the same secret. */
export function devToken(secret: string, identity: Identity, expiresIn = '1h'): Promise<string> {
  return new SignJWT({ email: identity.email, name: identity.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(identity.subject)
    .setIssuer(DEV_ISSUER)
    .setAudience(DEV_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

/** Finds the Finken user for a provider identity, creating them on their first request. */
export async function userFor(db: Db, identity: Identity): Promise<AuthUser> {
  type Row = { id: string; email: string | null; name: string; time_zone: string };
  const find = () => db.query<Row>('select id, email, name, time_zone from users where auth_subject = $1', [identity.subject]);
  let [row] = await find();
  if (!row) {
    // Two first requests at once both try; the loser finds the winner's row.
    [row] = await db.query<Row>(
      `insert into users (id, auth_subject, email, name) values ($1, $2, $3, $4)
       on conflict (auth_subject) do nothing returning id, email, name, time_zone`,
      [crypto.randomUUID(), identity.subject, identity.email ?? null, identity.name ?? ''],
    );
    row ??= (await find())[0];
  }
  return { id: row.id, email: row.email, name: row.name, timeZone: row.time_zone };
}
