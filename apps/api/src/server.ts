import { buildApp } from './app';
import { loadConfig } from './config';
import { connect } from './db';

const config = loadConfig();
const db = connect(config.DATABASE_URL);
const app = buildApp({ db, config });

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
