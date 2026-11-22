import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from './db';

export interface TestDb extends Db {
  /** A full copy of the database files: a backup, as far as tests are concerned. */
  backup(): Promise<Blob>;
}

/**
 * Postgres inside Node (PGlite), for tests and local development. Same SQL
 * dialect and constraints as production. In memory by default; pass a
 * backup to start from it, or a folder to keep the data there.
 */
export async function testDb(from?: Blob | string): Promise<TestDb> {
  const pg = await PGlite.create(typeof from === 'string' ? { dataDir: from } : from ? { loadDataDir: from } : {});
  const wrap = (c: PGlite | Transaction): Db => ({
    query: async (sql, params) => (await c.query(sql, params)).rows as never,
    exec: async (sql) => {
      await c.exec(sql);
    },
    transaction: (fn) => {
      if (!('transaction' in c)) throw new Error('Nested transactions are not supported');
      return c.transaction((tx) => fn(wrap(tx)));
    },
    close: () => pg.close(),
  });
  return { ...wrap(pg), backup: () => pg.dumpDataDir('none') };
}
