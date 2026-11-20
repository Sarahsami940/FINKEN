/**
 * The API on an in-memory Postgres (PGlite), for trying Finken without Docker.
 * Development only: signs its own tokens, and forgets everything when stopped.
 *   npm run dev:memory -w @finken/api
 */
import { buildApp } from '../src/app';
import { migrate } from '../src/migrate';
import { testDb } from '../src/testing';

const db = await testDb();
await migrate(db);
const app = buildApp({ db, config: { NODE_ENV: 'development', LOG_LEVEL: 'info', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'd'.repeat(40) } });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4000) });
