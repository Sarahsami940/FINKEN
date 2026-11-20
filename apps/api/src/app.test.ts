import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';
import type { Db } from './db';
import { migrate } from './migrate';
import { testDb } from './testing';

const TEST_CONFIG = { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: 'x'.repeat(32) } as const;
const SECRET = { AUTH_DEV_SECRET: 'x'.repeat(32) };

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());

describe('config', () => {
  it('needs a Postgres DATABASE_URL and fills in defaults', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x', ...SECRET })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...SECRET })).toMatchObject({ NODE_ENV: 'development', PORT: 4000, AUTH_MODE: 'dev' });
  });

  it('never allows development sign-in in staging or production, and needs provider settings there', () => {
    const db = 'postgres://u:p@localhost:5432/db';
    expect(() => loadConfig({ DATABASE_URL: db, NODE_ENV: 'production', AUTH_MODE: 'dev', ...SECRET })).toThrow(/never allowed/);
    expect(() => loadConfig({ DATABASE_URL: db, NODE_ENV: 'staging', AUTH_MODE: 'oidc' })).toThrow(/AUTH_ISSUER/);
    expect(() =>
      loadConfig({
        DATABASE_URL: db,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        AUTH_ISSUER: 'https://id.example.com/',
        AUTH_AUDIENCE: 'finken',
        AUTH_JWKS_URL: 'http://id.example.com/keys',
      }),
    ).toThrow(/AUTH_JWKS_URL/);
    expect(
      loadConfig({
        DATABASE_URL: db,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        AUTH_ISSUER: 'https://id.example.com/',
        AUTH_AUDIENCE: 'finken',
        AUTH_JWKS_URL: 'https://id.example.com/keys',
      }).AUTH_MODE,
    ).toBe('oidc');
  });

  it('never echoes values in its error', () => {
    expect(() => loadConfig({ DATABASE_URL: 'secret-value' })).toThrow(expect.objectContaining({ message: expect.not.stringContaining('secret-value') }));
  });
});

describe('migrations', () => {
  it('apply once, in order, and are recorded', async () => {
    expect(await migrate(db)).toContain('0001_foundations.sql');
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query<{ proname: string }>("select proname from pg_proc where proname = 'set_updated_at'");
    expect(rows).toHaveLength(1);
  });

  it('refuse to run when an applied file was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finken-mig-'));
    const fresh = await testDb();
    await writeFile(join(dir, '0001_a.sql'), 'create table a (id int);');
    await migrate(fresh, `${dir}/`);
    await writeFile(join(dir, '0001_a.sql'), 'create table a (id bigint);');
    await expect(migrate(fresh, `${dir}/`)).rejects.toThrow(/changed after it was applied/);
    await fresh.close();
  });

  it('roll back a migration that fails part-way', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'finken-mig-'));
    const fresh = await testDb();
    await writeFile(join(dir, '0001_bad.sql'), 'create table b (id int); select * from missing_table;');
    await expect(migrate(fresh, `${dir}/`)).rejects.toThrow();
    expect(await fresh.query("select 1 from pg_tables where tablename = 'b'")).toHaveLength(0);
    await fresh.close();
  });
});

describe('health endpoints', () => {
  it('report liveness and database readiness', async () => {
    const app = buildApp({ db, config: TEST_CONFIG });
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/ready')).statusCode).toBe(200);
    await app.close();
  });

  it('say unavailable when the database cannot be reached', async () => {
    const broken: Db = { ...db, query: () => Promise.reject(new Error('down')) };
    const app = buildApp({ db: broken, config: TEST_CONFIG });
    const res = await app.inject('/ready');
    expect([res.statusCode, res.json()]).toEqual([503, { status: 'unavailable' }]);
    await app.close();
  });
});
