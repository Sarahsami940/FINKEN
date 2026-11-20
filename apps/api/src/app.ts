import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isValidTimeZone } from '@finken/domain/dates';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions, LogController } from 'fastify';
import { z } from 'zod';
import { deleteAccount, exportAccount } from './account';
import { type AuthUser, devToken, makeVerifier, userFor, type Verifier } from './auth';
import { type BetaAccess, betaAccess, countError, joinBeta, markSeen, recordUsage, saveFeedback, setUsageConsent } from './beta';
import { isCollection } from './collections';
import type { Config } from './config';
import type { Db } from './db';
import { Metrics } from './metrics';
import { allowedEndpoint, PUSH_HOSTS, removeSubscription, Subscription, saveSubscription } from './push';
import { applyBatch, BatchError, changesSince, constraintMessage, getRecords, listRecords } from './records';
import { type Limit, overLimit, RateLimiter, replySerializer, requestSerializer, routeOf, securityHeaders } from './security';
import { cancelInvite, changeRole, createInvite, joinSpace, listInvites, listMembers, membershipList, removeMember, SharingError } from './sharing';

export interface AppDeps {
  db: Db;
  config: Pick<Config, 'NODE_ENV' | 'LOG_LEVEL' | 'AUTH_MODE'> &
    Partial<Pick<Config, 'AUTH_ISSUER' | 'AUTH_AUDIENCE' | 'AUTH_JWKS_URL' | 'AUTH_DEV_SECRET' | 'RATE_LIMIT_PER_MINUTE' | 'METRICS_TOKEN' | 'VAPID_PUBLIC_KEY'>> & {
      BETA_ACCESS?: BetaAccess;
    };
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

type LimitName = 'address' | 'signInFailures' | 'devToken' | 'person' | 'batch' | 'export' | 'clientErrors' | 'invite' | 'feedback' | 'usage' | 'spaceJoin';

const MINUTE = 60_000;
const ClientError = z.object({ message: z.string().trim().min(1).max(500), where: z.string().max(200).optional(), release: z.string().max(40).optional() });
const DeleteConfirm = z.object({ confirm: z.literal('DELETE', 'Type DELETE to confirm.') });
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const Ids = z.object({ ids: z.array(z.string().min(1).max(100)).max(5000) });
const MePatch = z.object({
  name: z.string().trim().max(80).optional(),
  timeZone: z.string().refine(isValidTimeZone, 'Unknown time zone.').optional(),
  /** Whether usage may be counted (see beta.ts). */
  usage: z.boolean().optional(),
});
const Join = z.object({ code: z.string().trim().min(1, 'Enter your invite code.').max(40) });
const Feedback = z.object({
  kind: z.enum(['problem', 'idea', 'praise'], 'Choose what kind of feedback this is.'),
  message: z.string().trim().min(1, 'Write a few words first.').max(2000, 'Keep it under 2,000 characters.'),
  screen: z.string().max(60).optional(),
  release: z.string().max(40).optional(),
});
const InviteRole = z.object({ role: z.enum(['editor', 'viewer'], 'Choose whether they can edit or only view.') });
const SpaceCode = z.object({ code: z.string().trim().min(1, 'Enter the invite code.').max(40) });
const Usage = z.object({ events: z.array(z.object({ name: z.string().max(40), n: z.number().int().min(1).max(1000) })).max(100) });

/** While the beta is invite-only, what someone without an invite may still do: see and leave their account, and talk to us. */
const WITHOUT_INVITE = new Set([
  'GET /v1/me',
  'PATCH /v1/me',
  'DELETE /v1/me',
  'GET /v1/export',
  'POST /v1/beta/join',
  'POST /v1/feedback',
  'POST /v1/client-errors',
  'DELETE /v1/push/subscriptions',
]);
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
  const access = betaAccess(config);
  /** The signed-in person as the app sees them. */
  const meOf = (u: AuthUser) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    timeZone: u.timeZone,
    access: access === 'open' || u.joinedBeta ? 'member' : 'invite-needed',
    usage: u.usage,
  });
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
    // Wrong invite codes: a handful an hour is plenty for typos, far too few to guess.
    invite: budget('invite', { max: 10, windowMs: 60 * MINUTE }),
    feedback: budget('feedback', { max: 10, windowMs: 60 * MINUTE }),
    usage: budget('usage', { max: 30, windowMs: MINUTE }),
    // Wrong Space invite codes, like beta codes: plenty for typos, far too few to guess.
    spaceJoin: budget('spaceJoin', { max: 10, windowMs: 60 * MINUTE }),
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
    if (err instanceof SharingError) return reply.code(err.status).send({ error: err.message });
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
    void countError(db, 'server').catch(() => {});
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
      // Counted once a day among the people using Finken; never in the way of the request itself.
      if (!req.user.seenToday) await markSeen(db, req.user.id).catch((err) => req.log.warn({ err: { message: (err as Error).message } }, 'could not count today'));
      if (access === 'invite' && !req.user.joinedBeta && !WITHOUT_INVITE.has(`${req.method} ${routeOf(req)}`)) {
        return reply.code(403).send({ error: 'Finken is in a closed beta. Enter your invite code to start.', code: 'invite_needed' });
      }
    });

    api.get('/v1/me', async (req) => meOf(req.user));

    api.patch('/v1/me', async (req) => {
      const patch = MePatch.parse(req.body ?? {});
      const [row] = await db.query<{ name: string; time_zone: string }>(
        'update users set name = coalesce($2, name), time_zone = coalesce($3, time_zone) where id = $1 returning name, time_zone',
        [req.user.id, patch.name ?? null, patch.timeZone ?? null],
      );
      if (patch.usage !== undefined) await setUsageConsent(db, req.user.id, patch.usage);
      const usage = patch.usage === undefined ? req.user.usage : patch.usage ? 'yes' : 'no';
      return meOf({ ...req.user, name: row.name, timeZone: row.time_zone, usage });
    });

    /** Joins the closed beta with an invite code. */
    api.post('/v1/beta/join', async (req, reply) => {
      const { code } = Join.parse(req.body ?? {});
      if (limited('invite', req.user.id, reply)) return reply;
      const result = await joinBeta(db, req.user.id, code);
      if (result === 'invalid') return reply.code(400).send({ error: 'That invite code is not right, or it has been used up. Check it and try again.' });
      if (result === 'joined') req.log.info({ user: req.user.id }, 'joined the beta');
      return meOf({ ...req.user, joinedBeta: true });
    });

    /** Feedback from inside the app, in the person's own words. */
    api.post('/v1/feedback', async (req, reply) => {
      const feedback = Feedback.parse(req.body ?? {});
      if (limited('feedback', req.user.id, reply)) return reply;
      return reply.code(201).send({ id: await saveFeedback(db, req.user.id, feedback) });
    });

    /** Usage counts, kept only for people who said yes; for everyone else they are dropped. */
    api.post('/v1/usage', async (req, reply) => {
      if (limited('usage', req.user.id, reply)) return reply;
      const { events } = Usage.parse(req.body ?? {});
      if (req.user.usage === 'yes') await recordUsage(db, req.user.id, events);
      return reply.code(204).send();
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
      await countError(db, 'client');
      req.log.warn({ user: req.user.id, client: report }, 'client error');
      return reply.code(204).send();
    });

    api.get<{ Querystring: { since?: string } }>('/v1/changes', async (req) => {
      const since = Number(req.query.since ?? 0);
      const page = await changesSince(db, req.user, Number.isSafeInteger(since) && since >= 0 ? since : 0);
      // Which Spaces this person is in, and as what: devices remove Spaces they have left.
      return { ...page, memberships: await membershipList(db, req.user.id) };
    });

    // ── Sharing a Space ──────────────────────────────────────────────────────
    type SpaceParams = { Params: { spaceId: string } };

    /** Who is in the Space, and what each person may do. */
    api.get<SpaceParams>('/v1/spaces/:spaceId/members', async (req) => ({ members: await listMembers(db, req.params.spaceId, req.user.id) }));

    /** The owner changes a member's role. */
    api.patch<{ Params: { spaceId: string; userId: string } }>('/v1/spaces/:spaceId/members/:userId', async (req) => {
      const { role } = InviteRole.parse(req.body ?? {});
      await changeRole(db, req.params.spaceId, req.user.id, req.params.userId, role);
      return { members: await listMembers(db, req.params.spaceId, req.user.id) };
    });

    /** The owner removes a member, or a member leaves. */
    api.delete<{ Params: { spaceId: string; userId: string } }>('/v1/spaces/:spaceId/members/:userId', async (req, reply) => {
      await removeMember(db, req.params.spaceId, req.user.id, req.params.userId);
      req.log.info({ user: req.user.id, space: req.params.spaceId, left: req.params.userId === req.user.id }, 'member removed');
      return reply.code(204).send();
    });

    /** The owner invites one person, as an editor or a viewer. */
    api.post<SpaceParams>('/v1/spaces/:spaceId/invites', async (req, reply) => {
      const { role } = InviteRole.parse(req.body ?? {});
      return reply.code(201).send(await createInvite(db, req.params.spaceId, req.user.id, role));
    });

    api.get<SpaceParams>('/v1/spaces/:spaceId/invites', async (req) => ({ invites: await listInvites(db, req.params.spaceId, req.user.id) }));

    api.delete<{ Params: { spaceId: string; inviteId: string } }>('/v1/spaces/:spaceId/invites/:inviteId', async (req, reply) => {
      await cancelInvite(db, req.params.spaceId, req.user.id, Number.parseInt(req.params.inviteId, 10) || -1);
      return reply.code(204).send();
    });

    /** Joins a Space with an invite code. */
    api.post('/v1/spaces/join', async (req, reply) => {
      const { code } = SpaceCode.parse(req.body ?? {});
      if (limited('spaceJoin', req.user.id, reply)) return reply;
      const joined = await joinSpace(db, req.user.id, code);
      if (!joined.already) req.log.info({ user: req.user.id, space: joined.spaceId, role: joined.role }, 'joined a space');
      return joined;
    });
  });

  return app;
}
