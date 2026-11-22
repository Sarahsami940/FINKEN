import { createRemoteJWKSet, type JWTPayload, jwtVerify, SignJWT } from 'jose';
import type { Config } from './config';
import type { Db } from './db';

/** Who a valid token says the caller is, according to the sign-in provider. */
export interface Identity {
  subject: string;
  email?: string;
  name?: string;
  /** Finken's own sign-in: the session the token belongs to, checked on every request. */
  sessionId?: string;
}

/** A signed-in Finken user, as stored in the users table. */
export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  timeZone: string;
  /** Entered an invite code (only matters while the beta is invite-only). */
  joinedBeta: boolean;
  /** Said yes or no to sharing usage; null until asked. */
  usage: 'yes' | 'no' | null;
  /** Already counted among today's people (daily_health). */
  seenToday: boolean;
  /** Signs in with a Finken password (as opposed to an outside provider or the development sign-in). */
  hasPassword: boolean;
  emailVerified: boolean;
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
export function makeVerifier(config: Pick<Config, 'AUTH_ISSUER' | 'AUTH_AUDIENCE' | 'AUTH_JWKS_URL' | 'AUTH_DEV_SECRET'> & { AUTH_MODE: 'oidc' | 'dev' }): Verifier {
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

/**
 * Finds the Finken user for an identity. With an outside provider they are
 * created on their first request; with Finken's own sign-in (`create`
 * false) they must already exist, so a deleted account never comes back.
 */
export async function userFor(db: Db, identity: Identity, create = true): Promise<AuthUser> {
  type Row = {
    id: string;
    email: string | null;
    name: string;
    time_zone: string;
    joined: boolean;
    usage: 'yes' | 'no' | null;
    seen: boolean;
    has_password: boolean;
    verified: boolean;
  };
  const COLUMNS = `id, email, name, time_zone, beta_joined_at is not null as joined, usage_consent as usage,
    coalesce(last_seen_on = (now() at time zone 'utc')::date, false) as seen,
    password_hash is not null as has_password, email_verified_at is not null as verified`;
  const find = () => db.query<Row>(`select ${COLUMNS} from users where auth_subject = $1`, [identity.subject]);
  let [row] = await find();
  if (!row && !create) throw new Error('No such account');
  if (!row) {
    // Two first requests at once both try; the loser finds the winner's row.
    [row] = await db.query<Row>(
      `insert into users (id, auth_subject, email, name) values ($1, $2, $3, $4)
       on conflict (auth_subject) do nothing returning ${COLUMNS}`,
      [crypto.randomUUID(), identity.subject, identity.email ?? null, identity.name ?? ''],
    );
    row ??= (await find())[0];
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timeZone: row.time_zone,
    joinedBeta: row.joined,
    usage: row.usage,
    seenToday: row.seen,
    hasPassword: row.has_password,
    emailVerified: row.verified,
  };
}
