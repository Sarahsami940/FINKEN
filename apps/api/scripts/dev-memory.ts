/**
 * The API on an in-memory Postgres (PGlite), for trying Finken without Docker.
 * Development only: signs its own tokens, and forgets everything when stopped.
 *   npm run dev:memory -w @finken/api
 */
import { buildApp } from '../src/app';
import { createInvites } from '../src/beta';
import { migrate } from '../src/migrate';
import { testDb } from '../src/testing';

const db = await testDb();
await migrate(db);
// BETA_ACCESS=invite tries the closed beta; DEV_INVITE_CODE is then a code anyone can use.
const BETA_ACCESS = process.env.BETA_ACCESS === 'invite' ? 'invite' : 'open';
const code = process.env.DEV_INVITE_CODE;
if (code) await createInvites(db, { wave: 1, count: 1, uses: 10_000, note: 'development' }, () => code);
const app = buildApp({ db, config: { NODE_ENV: 'development', LOG_LEVEL: 'info', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'd'.repeat(40), BETA_ACCESS } });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4000) });
