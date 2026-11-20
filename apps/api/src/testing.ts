import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from './db';

export interface TestDb extends Db {
  /** A full copy of the database files: a backup, as far as tests are concerned. */
  backup(): Promise<Blob>;
}

/** An in-memory Postgres for tests. Same SQL dialect and constraints as production. Pass a backup to start from it. */
export async function testDb(restoreFrom?: Blob): Promise<TestDb> {
  const pg = await PGlite.create(restoreFrom ? { loadDataDir: restoreFrom } : {});
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
