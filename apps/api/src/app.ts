import Fastify, { type FastifyServerOptions } from 'fastify';
import type { Config } from './config';
import type { Db } from './db';

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL'>;
}

export function buildApp({ db, config }: AppDeps) {
  const logger: FastifyServerOptions['logger'] =
    config.NODE_ENV === 'test'
      ? false
      : {
          level: config.LOG_LEVEL,
          // Financial data never goes into logs: no bodies, no credentials.
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        };
  const app = Fastify({ logger, trustProxy: config.NODE_ENV !== 'development' });

  /** Liveness: the process is up. */
  app.get('/health', async () => ({ status: 'ok' }));

  /** Readiness: the process can reach the database. */
  app.get('/ready', async (_req, reply) => {
    try {
      await db.query('select 1');
      return { status: 'ready' };
    } catch (err) {
      app.log.error({ err }, 'database check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
