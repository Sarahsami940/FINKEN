import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { connect, type Db } from './db';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Applies every migration in migrations/ that has not run yet, in file-name
 * order, each in its own transaction. Applied files must never be edited:
 * a changed checksum stops the run.
 */
export async function migrate(db: Db, dir = MIGRATIONS): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const bad = files.filter((f) => !NAME.test(f));
  if (bad.length > 0) throw new Error(`Migration files must be named like 0001_name.sql: ${bad.join(', ')}`);

  const applied = new Map((await db.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).map((r) => [r.name, r.checksum]));
  const ran: string[] = [];
  for (const file of files) {
    const text = await readFile(dir + file, 'utf8');
    const checksum = await sha256(text);
    const previous = applied.get(file);
    if (previous) {
      if (previous !== checksum) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(text);
      await tx.query('insert into schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
    });
    ran.push(file);
  }
  return ran;
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')));
  return Buffer.from(digest).toString('hex');
}

// Run directly: npm run db:migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = connect(loadConfig().DATABASE_URL);
  try {
    const ran = await migrate(db);
    console.log(ran.length > 0 ? `Applied ${ran.length} migration(s):\n  ${ran.join('\n  ')}` : 'Database is up to date.');
  } finally {
    await db.close();
  }
}
