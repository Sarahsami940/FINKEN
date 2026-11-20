import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isValidTimeZone } from '@finken/domain/dates';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions, LogController } from 'fastify';
import { z } from 'zod';
import { deleteAccount, exportAccount } from './account';
import { type AuthUser, devToken, makeVerifier, userFor, type Verifier } from './auth';
import { isCollection } from './collections';
import type { Config } from './config';
import type { Db } from './db';
import { Metrics } from './metrics';
import { allowedEndpoint, PUSH_HOSTS, removeSubscription, Subscription, saveSubscription } from './push';
import { applyBatch, BatchError, changesSince, constraintMessage, getRecords, listRecords } from './records';
import { type Limit, overLimit, RateLimiter, replySerializer, requestSerializer, routeOf, securityHeaders } from './security';

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL' | 'AUTH_MODE'> &
    Partial<Pick<Config, 'AUTH_ISSUER' | 'AUTH_AUDIENCE' | 'AUTH_JWKS_URL' | 'AUTH_DEV_SECRET' | 'RATE_LIMIT_PER_MINUTE' | 'METRICS_TOKEN' | 'VAPID_PUBLIC_KEY'>>;
  /** Push services devices may register (tests add a local one). */
  pushHosts?: RegExp[];
  /** Replaces the token check built from config (tests). */
  verify?: Verifier;
  /** Replaces the request budgets (tests). */
  limits?: Partial<Record<LimitName, Limit>>;
  /** Where log lines go (tests read them). */
  logStream?: { write(line: string): void };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
  interface FastifyInstance {
    metrics: Metrics;
  }
}

type LimitName = 'address' | 'signInFailures' | 'devToken' | 'person' | 'batch' | 'export' | 'clientErrors';

const MINUTE = 60_000;
const ClientError = z.object({ message: z.string().trim().min(1).max(500), where: z.string().max(200).optional(), release: z.string().max(40).optional() });
const DeleteConfirm = z.object({ confirm: z.literal('DELETE', 'Type DELETE to confirm.') });
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const Ids = z.object({ ids: z.array(z.string().min(1).max(100)).max(5000) });
const MePatch = z.object({ name: z.string().trim().max(80).optional(), timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone.').optional() });
const DevIdentity = z.object({ subject: z.string().min(1).max(200), email: z.email().optional(), name: z.string().max(80).optional() });

export function buildApp({ db, config, verify, limits = {}, logStream, pushHosts = PUSH_HOSTS }: AppDeps) {
  const logger: FastifyServerOptions['logger'] =
    config.NODE_ENV === 'test' && !logStream
      ? false
      : {
          level: config.LOG_LEVEL,
          // Financial and personal data never goes into logs: no bodies, query values, credentials, emails or addresses.
          serializers: { req: requestSerializer as never, res: replySerializer as never },
          ...(logStream ? { stream: logStream } : {}),
        };
  const production = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';
  // A whole demo set (about 1,500 records) arrives in one batch.
  const app = Fastify({
    logger,
    trustProxy: config.NODE_ENV !== 'development',
    bodyLimit: 8 * 1024 * 1024,
    // A request id from the proxy is kept, so one request can be followed through every log.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    // Fastify's own request lines are off: the onResponse hook writes one safe line instead.
    logController: new LogController({ disableRequestLogging: true }),
  });
  const check = verify ?? makeVerifier(config as Config);
  const metrics = new Metrics();
  app.decorate('metrics', metrics);

  const budget = (name: LimitName, fallback: Limit) => new RateLimiter(limits[name] ?? fallback);
  const limiters: Record<LimitName, RateLimiter> = {
    // Everything from one address, signed in or not: stops floods early.
    address: budget('address', { max: 2000, windowMs: MINUTE }),
    // Requests with a token that does not check out: slows down guessing.
    signInFailures: budget('signInFailures', { max: 30, windowMs: MINUTE }),
    devToken: budget('devToken', { max: 30, windowMs: MINUTE }),
    person: budget('person', { max: config.RATE_LIMIT_PER_MINUTE ?? 300, windowMs: MINUTE }),
    batch: budget('batch', { max: 120, windowMs: MINUTE }),
    export: budget('export', { max: 10, windowMs: 60 * MINUTE }),
    clientErrors: budget('clientErrors', { max: 20, windowMs: MINUTE }),
  };
  const limited = (name: LimitName, key: string, reply: FastifyReply) => {
    const stopped = overLimit(limiters[name], key, reply);
    if (stopped) metrics.limited.inc({ limit: name });
    return stopped;
  };

  app.addHook('onRequest', async (req, reply) => {
    // A request id that is not a plain token is replaced, so it cannot carry anything into logs.
    if (!/^[A-Za-z0-9-]{8,64}$/.test(req.id)) req.id = randomUUID();
    reply.header('x-request-id', req.id);
    if (limited('address', req.ip, reply)) return reply;
  });
  app.addHook('onSend', securityHeaders(production));
  app.addHook('onResponse', async (req, reply) => {
    const route = routeOf(req);
    metrics.requests.inc({ route, method: req.method, status: String(reply.statusCode) });
    metrics.duration.observe({ route, method: req.method }, reply.elapsedTime / 1000);
    req.log.info({ req, res: reply, ms: Math.round(reply.elapsedTime), user: req.user?.id }, 'request');
  });

  /** For monitoring. Outside development it needs METRICS_TOKEN, and without one it does not exist. */
  if (config.METRICS_TOKEN || !production) {
    app.get('/metrics', async (req, reply) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (config.METRICS_TOKEN && !sameSecret(token, config.METRICS_TOKEN)) return reply.code(401).send({ error: 'Sign in again.' });
      return reply.type('text/plain; version=0.0.4').send(metrics.render());
    });
  }

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

  const REASONS: Record<number, string> = { 400: 'shape', 403: 'permission', 409: 'conflict', 422: 'money_rules' };
  app.setErrorHandler((err: Error, req, reply) => {
    const known = err instanceof BatchError ? err : constraintMessage(err);
    if (known) {
      if (routeOf(req) === '/v1/batch') metrics.refused.inc({ reason: REASONS[known.status] ?? 'other' });
      return reply.code(known.status).send({ error: known.message, ...known.where });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? 'Invalid request.' });
    const status = (err as { statusCode?: number }).statusCode;
    // Framework errors (a body too large, broken JSON) explain themselves; their text holds no data.
    if (status && status < 500) return reply.code(status).send({ error: status === 413 ? 'That is too much to send at once.' : err.message });
    // The details go to the log, never to the client: the request id links the two.
    req.log.error({ err: { type: err.name, message: err.message, stack: err.stack } }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong. Try again.', requestId: req.id });
  });

  // ── Development sign-in ──────────────────────────────────────────────────
  // Signs a token for any identity, so the API can be used without a provider.
  // Config refuses dev mode in staging and production, so this never exists there.
  if (config.AUTH_MODE === 'dev' && config.AUTH_DEV_SECRET && (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')) {
    const secret = config.AUTH_DEV_SECRET;
    app.post('/v1/dev/token', async (req, reply) => {
      if (limited('devToken', req.ip, reply)) return reply;
      return { token: await devToken(secret, DevIdentity.parse(req.body)) };
    });
  }

  // ── Everything below needs a signed-in user ──────────────────────────────
  app.register(async (api) => {
    api.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/v1/dev/')) return;
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      try {
        if (!token) throw new Error('missing');
        req.user = await userFor(db, await check(token));
      } catch {
        if (limited('signInFailures', req.ip, reply)) return reply;
        return reply.code(401).send({ error: 'Sign in again.' });
      }
      if (limited('person', req.user.id, reply)) return reply;
    });

    api.get('/v1/me', async (req) => req.user);

    api.patch('/v1/me', async (req) => {
      const patch = MePatch.parse(req.body ?? {});
      const [row] = await db.query<{ id: string; email: string | null; name: string; time_zone: string }>(
        'update users set name = coalesce($2, name), time_zone = coalesce($3, time_zone) where id = $1 returning id, email, name, time_zone',
        [req.user.id, patch.name ?? null, patch.timeZone ?? null],
      );
      return { id: row.id, email: row.email, name: row.name, timeZone: row.time_zone };
    });

    api.get<{ Params: { collection: string } }>('/v1/records/:collection', async (req, reply) => {
      if (!isCollection(req.params.collection)) return reply.code(404).send({ error: 'Unknown collection.' });
      return { records: await listRecords(db, req.user, req.params.collection) };
    });

    api.post<{ Params: { collection: string } }>('/v1/records/:collection/get', async (req, reply) => {
      if (!isCollection(req.params.collection)) return reply.code(404).send({ error: 'Unknown collection.' });
      return { records: await getRecords(db, req.user, req.params.collection, Ids.parse(req.body).ids) };
    });

    /** Saves and deletes, all or nothing. */
    api.post('/v1/batch', async (req, reply) => {
      if (limited('batch', req.user.id, reply)) return reply;
      const result = await applyBatch(db, req.user, (req.body ?? {}) as never);
      metrics.records.inc({}, result.written + result.deleted);
      return result;
    });

    /** Everything the person has, as one file. */
    api.get('/v1/export', async (req, reply) => {
      if (limited('export', req.user.id, reply)) return reply;
      const data = await exportAccount(db, req.user);
      reply.header('content-disposition', `attachment; filename="finken-export-${data.exportedAt.slice(0, 10)}.json"`);
      return data;
    });

    /** Deletes the account and every Space it owns, for good. */
    api.delete('/v1/me', async (req) => {
      DeleteConfirm.parse(req.body ?? {});
      const removed = await deleteAccount(db, req.user);
      req.log.warn({ user: req.user.id, ...removed }, 'account deleted');
      return { deleted: removed };
    });

    /** The key devices need to ask for reminders, when the server sends them. */
    api.get('/v1/push/key', async (_req, reply) => {
      if (!config.VAPID_PUBLIC_KEY) return reply.code(404).send({ error: 'Reminders from the server are not set up.' });
      return { publicKey: config.VAPID_PUBLIC_KEY };
    });

    /** This device wants reminders. */
    api.post('/v1/push/subscriptions', async (req, reply) => {
      const sub = Subscription.parse(req.body ?? {});
      if (!allowedEndpoint(sub.endpoint, pushHosts)) return reply.code(400).send({ error: 'That is not a push service Finken can use.' });
      await saveSubscription(db, req.user.id, sub);
      return reply.code(201).send({ ok: true });
    });

    /** This device no longer wants reminders. */
    api.delete('/v1/push/subscriptions', async (req, reply) => {
      const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body ?? {});
      await removeSubscription(db, req.user.id, endpoint);
      return reply.code(204).send();
    });

    /** Errors the web app ran into, so they can be fixed: only the message and where it happened. */
    api.post('/v1/client-errors', async (req, reply) => {
      if (limited('clientErrors', req.user.id, reply)) return reply;
      const report = ClientError.parse(req.body ?? {});
      metrics.clientErrors.inc();
      req.log.warn({ user: req.user.id, client: report }, 'client error');
      return reply.code(204).send();
    });

    api.get<{ Querystring: { since?: string } }>('/v1/changes', async (req) => {
      const since = Number(req.query.since ?? 0);
      return changesSince(db, req.user, Number.isSafeInteger(since) && since >= 0 ? since : 0);
    });
  });

  return app;
}
