/**
 * The API on PGlite (Postgres compiled to run inside Node), for trying
 * Finken without installing a database. Development only.
 *
 *   npm run dev:local -w @finken/api        keeps its data in apps/api/.local-data, so accounts and records survive restarts
 *   npm run dev:memory -w @finken/api       keeps nothing: every start is empty (tests use this)
 *   npm run dev:memory:sign-in -w @finken/api   an outside sign-in provider instead (the stand-in on port 4400)
 *
 * Sign-in is Finken's own (accounts, password hashes and sessions in this
 * database), exactly as in production, except that emails are written to
 * this window instead of being sent, and GET /v1/dev/mail lists them.
 *
 * Settings: PORT (4000); FINKEN_DATA_DIR (where to keep data); APP_URL (the
 * web app, for links in emails); BETA_ACCESS=invite with DEV_INVITE_CODE to
 * try the closed beta; SIGN_IN_PORT, WEB_ORIGINS and TOKEN_SECONDS with --sign-in.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../src/app';
import { createInvites } from '../src/beta';
import { migrate } from '../src/migrate';
import { testDb } from '../src/testing';
import { startDevSignIn } from './dev-sign-in';

const keep = process.env.FINKEN_DATA_DIR ?? (process.argv.includes('--keep') ? '.local-data' : undefined);
const dataDir = keep ? resolve(keep) : undefined;
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await testDb(dataDir);
await migrate(db);
const BETA_ACCESS = process.env.BETA_ACCESS === 'invite' ? 'invite' : 'open';
const code = process.env.DEV_INVITE_CODE;
if (code) {
  // Kept data already has the code from an earlier start.
  await createInvites(db, { wave: 1, count: 1, uses: 10_000, note: 'development' }, () => code).catch(() => {});
}

const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
type Auth = { AUTH_MODE: 'password'; AUTH_SECRET: string; APP_URL: string } | { AUTH_MODE: 'oidc'; AUTH_ISSUER: string; AUTH_AUDIENCE: string; AUTH_JWKS_URL: string };
let auth: Auth;
if (process.argv.includes('--sign-in')) {
  const origins = (process.env.WEB_ORIGINS ?? 'http://localhost:5173').split(',').map((o) => o.trim());
  const provider = await startDevSignIn({
    port: Number(process.env.SIGN_IN_PORT ?? 4400),
    redirectUris: origins.map((o) => `${o}/auth/callback`),
    tokenSeconds: Number(process.env.TOKEN_SECONDS ?? 3600),
  });
  // Exactly the settings a real provider takes in staging and production.
  auth = { AUTH_MODE: 'oidc', AUTH_ISSUER: provider.issuer, AUTH_AUDIENCE: provider.clientId, AUTH_JWKS_URL: provider.jwksUrl };
  console.log(`Stand-in sign-in provider: ${provider.issuer} (client ${provider.clientId}); returns to ${origins.join(', ')}`);
} else {
  // A fixed secret is fine here: this server is only ever on this computer. Real servers set their own.
  auth = { AUTH_MODE: 'password', AUTH_SECRET: 'finken-local-development-only-not-a-real-secret', APP_URL: appUrl };
}
const app = buildApp({ db, config: { NODE_ENV: 'development', LOG_LEVEL: 'info', BETA_ACCESS, ...auth } });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4000) });
console.log(
  `Finken API on http://127.0.0.1:${process.env.PORT ?? 4000}, ${dataDir ? `keeping data in ${dataDir}` : 'keeping nothing (in memory)'}; sign-in: ${auth.AUTH_MODE === 'password' ? "Finken's own" : 'outside provider'}.`,
);
