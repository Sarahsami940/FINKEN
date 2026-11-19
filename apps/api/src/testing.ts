import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from './db';

/** An in-memory Postgres for tests. Same SQL dialect and constraints as production. */
export async function testDb(): Promise<Db> {
  const pg = await PGlite.create();
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
  return wrap(pg);
}
