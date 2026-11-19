import postgres from 'postgres';

/**
 * The small slice of a Postgres client the API depends on. The server uses
 * postgres.js; tests use PGlite (real Postgres compiled to WebAssembly), so
 * every query and migration is checked against real Postgres either way.
 */
export interface Db {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Sql = postgres.Sql | postgres.TransactionSql;

function wrap(sql: Sql, root: postgres.Sql): Db {
  return {
    query: async (text, params = []) => (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as never,
    exec: async (text) => {
      await sql.unsafe(text);
    },
    transaction: async (fn) => {
      if (!('begin' in sql)) throw new Error('Nested transactions are not supported');
      return (await sql.begin((tx) => fn(wrap(tx, root)))) as never;
    },
    close: () => root.end({ timeout: 5 }),
  };
}

export function connect(url: string): Db {
  const sql = postgres(url, { max: 10, idle_timeout: 30, onnotice: () => {} });
  return wrap(sql, sql);
}
