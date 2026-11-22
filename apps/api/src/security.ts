/**
 * Protections every request goes through.
 *
 * - **Rate limits.** Each signed-in person, and each address before sign-in,
 *   has a budget of requests per minute. Over it, the answer is 429 with
 *   Retry-After, and nothing is done. The counts live in this process: with
 *   several API instances behind a load balancer each keeps its own, so the
 *   real limit is the budget times the instances. Move them to a shared store
 *   (Redis, or the database) before running more than a few instances.
 * - **Headers.** The API only ever answers with JSON, so browsers are told to
 *   treat it as nothing else, never frame it and never cache it.
 * - **Logs.** One line per request with its id, method, route, status, time
 *   and the internal user id. Never bodies, query values, tokens, emails or
 *   IP addresses: financial data and personal details stay out of logs.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
}

/** A fixed-window counter per key. Old windows are dropped as they expire. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private sweepAt = 0;

  constructor(
    private limit: Limit,
    private now: () => number = Date.now,
  ) {}

  /** Counts one request for `key`. Returns how long to wait, in seconds, when over the limit. */
  take(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    if (now >= this.sweepAt) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      this.sweepAt = now + this.limit.windowMs;
    }
    let slot = this.hits.get(key);
    if (!slot || slot.resetAt <= now) {
      slot = { count: 0, resetAt: now + this.limit.windowMs };
      this.hits.set(key, slot);
    }
    slot.count++;
    if (slot.count <= this.limit.max) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((slot.resetAt - now) / 1000)) };
  }
}

export const TOO_MANY = 'Too many requests. Wait a minute, then try again.';

/** Sends 429 when `key` is over its limit; returns true if the request was stopped. */
export function overLimit(limiter: RateLimiter, key: string, reply: FastifyReply): boolean {
  const result = limiter.take(key);
  if (result.ok) return false;
  reply.header('retry-after', String(result.retryAfter));
  void reply.code(429).send({ error: TOO_MANY });
  return true;
}

export function securityHeaders(production: boolean) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('cache-control', 'no-store');
    if (production) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  };
}

/** The route pattern, not the URL: ids and query values never reach logs or metrics. */
export const routeOf = (req: FastifyRequest) => req.routeOptions?.url ?? 'unknown';

/** What a log line may say about a request. */
export const requestSerializer = (req: FastifyRequest) => ({ id: req.id, method: req.method, route: routeOf(req) });
export const replySerializer = (reply: FastifyReply) => ({ status: reply.statusCode });
