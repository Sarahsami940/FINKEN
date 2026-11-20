/**
 * Phase 8: the closed beta, and knowing when it is safe to launch.
 *
 * - **Invites.** With `BETA_ACCESS=invite` (the default in staging and
 *   production), anyone can sign in, but only people who enter an invite
 *   code can keep records. Codes come in waves, so the beta widens step by
 *   step. Only a hash of each code is stored.
 * - **Feedback.** People send problems, ideas and praise from inside the
 *   app; the team reads them here and marks them seen or done.
 * - **Usage.** Which screens and features are used, counted per day, only
 *   for people who said yes (see `@finken/domain/usage`).
 * - **Health.** People seen per day and errors per day, with nobody named,
 *   plus a record of every nightly reconciliation.
 * - **Launch report.** Puts those together into a short list of gates that
 *   must all pass before the beta widens to everyone.
 *
 * Run as a command (see docs/BETA.md):
 *   npm run beta -w @finken/api -- invite --wave 1 --count 20
 *   npm run beta -w @finken/api -- report
 */
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isUsageEvent } from '@finken/domain/usage';
import type { Config } from './config';
import { loadConfig } from './config';
import { connect, type Db } from './db';
import type { ReconcileReport } from './reconcile';

/** Today on the server's calendar (UTC), which every daily count uses. */
const TODAY = `(now() at time zone 'utc')::date`;

// ── Access ──────────────────────────────────────────────────────────────────

export type BetaAccess = 'invite' | 'open';

/** Invite-only in staging and production unless set otherwise; open while developing. */
export function betaAccess(config: Pick<Config, 'NODE_ENV'> & { BETA_ACCESS?: BetaAccess }): BetaAccess {
  return config.BETA_ACCESS ?? (config.NODE_ENV === 'staging' || config.NODE_ENV === 'production' ? 'invite' : 'open');
}

// ── Invite codes ───────────────────────────────────────────────────────────

/** No 0/O or 1/I: codes are read aloud and typed from messages. 32 characters, so every byte maps evenly. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A new code such as FNK-7KQM-2XHD: 40 bits of chance, so it cannot be guessed within the rate limit. */
export function newInviteCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `FNK-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Spaces, dashes and case do not matter when someone types a code. */
export const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const hashCode = (code: string) =>
  createHash('sha256')
    .update(`finken-invite:${normaliseCode(code)}`)
    .digest('hex');

export interface InviteOptions {
  wave: number;
  count: number;
  /** How many people each code lets in. */
  uses?: number;
  /** Days until the codes stop working; none means they never expire. */
  days?: number;
  note?: string;
}

/** Makes invite codes and returns them. They are shown once: only their hashes are kept. */
export async function createInvites(db: Db, { wave, count, uses = 1, days, note = '' }: InviteOptions, make = newInviteCode): Promise<string[]> {
  if (!Number.isInteger(wave) || wave < 1) throw new Error('The wave must be a whole number from 1.');
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Make between 1 and 1,000 codes at a time.');
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = make();
    await db.query(
      `insert into beta_invites (code_hash, wave, max_uses, note, expires_at)
       values ($1, $2, $3, $4, case when $5::int is null then null else now() + make_interval(days => $5::int) end)`,
      [hashCode(code), wave, uses, note.slice(0, 80), days ?? null],
    );
    codes.push(code);
  }
  return codes;
}

export type JoinResult = 'joined' | 'already' | 'invalid';

/** Lets a person into the beta with a code. One message for every wrong code, so codes cannot be probed. */
export async function joinBeta(db: Db, userId: string, code: string): Promise<JoinResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx.query<{ joined: boolean }>('select beta_joined_at is not null as joined from users where id = $1 for update', [userId]);
    if (user?.joined) return 'already';
    const [invite] = await tx.query<{ wave: number }>(
      `update beta_invites set uses = uses + 1
       where code_hash = $1 and revoked_at is null and uses < max_uses and (expires_at is null or expires_at > now())
       returning wave`,
      [hashCode(code)],
    );
    if (!invite) return 'invalid';
    await tx.query('update users set beta_joined_at = now(), beta_wave = $2 where id = $1', [userId, invite.wave]);
    return 'joined';
  });
}

export interface Wave {
  wave: number;
  codes: number;
  places: number;
  used: number;
  revoked: number;
  people: number;
}

export async function listWaves(db: Db): Promise<Wave[]> {
  const rows = await db.query<{ wave: number; codes: string; places: string; used: string; revoked: string }>(
    `select wave, count(*)::text as codes, sum(max_uses)::text as places, sum(uses)::text as used, count(revoked_at)::text as revoked
     from beta_invites group by wave order by wave`,
  );
  const people = new Map(
    (await db.query<{ wave: number; n: string }>('select beta_wave as wave, count(*)::text as n from users where beta_wave is not null group by beta_wave')).map((r) => [
      r.wave,
      Number(r.n),
    ]),
  );
  return rows.map((r) => ({ wave: r.wave, codes: Number(r.codes), places: Number(r.places), used: Number(r.used), revoked: Number(r.revoked), people: people.get(r.wave) ?? 0 }));
}

/** Stops a wave's unused codes working. People already in stay in. */
export async function revokeWave(db: Db, wave: number): Promise<number> {
  return (await db.query('update beta_invites set revoked_at = now() where wave = $1 and revoked_at is null returning id', [wave])).length;
}

// ── Feedback ───────────────────────────────────────────────────────────────

export type FeedbackKind = 'problem' | 'idea' | 'praise';
export type FeedbackStatus = 'new' | 'seen' | 'done';

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  screen?: string;
  release?: string;
}

export async function saveFeedback(db: Db, userId: string, f: FeedbackInput): Promise<number> {
  const [row] = await db.query<{ id: string }>('insert into feedback (user_id, kind, message, screen, release) values ($1, $2, $3, $4, $5) returning id::text', [
    userId,
    f.kind,
    f.message,
    f.screen ?? '',
    f.release ?? '',
  ]);
  return Number(row.id);
}

export interface FeedbackItem {
  id: number;
  at: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  screen: string;
  release: string;
  wave: number | null;
  message: string;
}

/** Feedback for the team, newest first. Who sent it is not shown: only their beta wave. */
export async function listFeedback(db: Db, { all = false, limit = 100 } = {}): Promise<FeedbackItem[]> {
  const rows = await db.query<{ id: string; at: string; kind: FeedbackKind; status: FeedbackStatus; screen: string; release: string; wave: number | null; message: string }>(
    `select f.id::text, to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as at, f.kind, f.status, f.screen, f.release, u.beta_wave as wave, f.message
     from feedback f join users u on u.id = f.user_id
     where $1 or f.status = 'new' order by f.created_at desc, f.id desc limit $2`,
    [all, limit],
  );
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function markFeedback(db: Db, id: number, status: FeedbackStatus): Promise<boolean> {
  return (await db.query('update feedback set status = $2 where id = $1 returning id', [id, status])).length === 1;
}

// ── Usage, with consent ─────────────────────────────────────────────────────

/** How long usage counts are kept. */
export const USAGE_DAYS = 180;

export async function setUsageConsent(db: Db, userId: string, yes: boolean): Promise<void> {
  await db.query('update users set usage_consent = $2, usage_consent_at = now() where id = $1', [userId, yes ? 'yes' : 'no']);
  // Saying no removes what was counted before.
  if (!yes) await db.query('delete from usage_events where user_id = $1', [userId]);
}

/** Adds to today's counts. Unknown names are dropped. Returns how many counts were kept. */
export async function recordUsage(db: Db, userId: string, events: { name: string; n: number }[]): Promise<number> {
  const totals = new Map<string, number>();
  for (const e of events) if (isUsageEvent(e.name)) totals.set(e.name, Math.min(1000, (totals.get(e.name) ?? 0) + e.n));
  for (const [name, n] of totals) {
    await db.query(
      `insert into usage_events (user_id, day, event, n) values ($1, ${TODAY}, $2, $3)
       on conflict (user_id, day, event) do update set n = least(usage_events.n + excluded.n, 100000)`,
      [userId, name, n],
    );
  }
  return totals.size;
}

export async function forgetOldUsage(db: Db): Promise<number> {
  return (await db.query(`delete from usage_events where day < ${TODAY} - ${USAGE_DAYS} returning day`)).length;
}

// ── Health ─────────────────────────────────────────────────────────────────

/** Counts this person once for today. Cheap after the first request of the day: the caller checks `seenToday`. */
export async function markSeen(db: Db, userId: string): Promise<void> {
  await db.query(
    `with marked as (update users set last_seen_on = ${TODAY} where id = $1 and last_seen_on is distinct from ${TODAY} returning id)
     insert into daily_health (day, people) select ${TODAY}, 1 from marked
     on conflict (day) do update set people = daily_health.people + 1`,
    [userId],
  );
}

export async function countError(db: Db, side: 'client' | 'server'): Promise<void> {
  const column = side === 'client' ? 'client_errors' : 'server_errors';
  await db.query(`insert into daily_health (day, ${column}) values (${TODAY}, 1) on conflict (day) do update set ${column} = daily_health.${column} + 1`);
}

/** Keeps the result of a nightly reconciliation, for the launch report. */
export async function recordReconciliation(db: Db, report: ReconcileReport): Promise<void> {
  await db.query('insert into reconciliation_runs (started_at, finished_at, spaces, records, problems) values ($1, $2, $3, $4, $5)', [
    report.startedAt,
    report.finishedAt,
    report.spaces,
    report.records,
    report.problems.length,
  ]);
}

// ── Launch report ──────────────────────────────────────────────────────────

export interface Thresholds {
  /** People who joined the beta. */
  people: number;
  /** Days since the first person joined. */
  days: number;
  /** Nights in a row that reconciliation ran and found nothing. */
  nights: number;
  /** Errors (app and server) per person per day, over the last 7 days. */
  errorRate: number;
  /** A problem report must be looked at within this many days. */
  answerDays: number;
}

export const LAUNCH_THRESHOLDS: Thresholds = { people: 20, days: 21, nights: 14, errorRate: 0.05, answerDays: 3 };

export interface LaunchFacts {
  people: number;
  firstJoinDays: number | null;
  /** Nights, among the last `nights`, with at least one reconciliation run. */
  nightsRun: number;
  /** Problems found by those runs. */
  reconcileProblems: number;
  personDays7: number;
  errors7: { client: number; server: number };
  unansweredProblems: number;
  feedback: Record<FeedbackKind, number>;
  newFeedback: number;
  usageConsent: { yes: number; no: number; asked: number };
  topScreens: { screen: string; n: number }[];
}

export interface Gate {
  name: string;
  ok: boolean;
  detail: string;
}

export async function launchFacts(db: Db, t: Thresholds = LAUNCH_THRESHOLDS): Promise<LaunchFacts> {
  const num = (v: unknown) => Number(v ?? 0);
  const [joined] = await db.query<{ people: string; days: string | null }>(
    `select count(*)::text as people, floor(extract(epoch from now() - min(beta_joined_at)) / 86400)::text as days from users where beta_joined_at is not null`,
  );
  const [runs] = await db.query<{ nights: string; problems: string | null }>(
    `select count(distinct (started_at at time zone 'utc')::date)::text as nights, sum(problems)::text as problems
     from reconciliation_runs where (started_at at time zone 'utc')::date > ${TODAY} - $1::int`,
    [t.nights],
  );
  const [health] = await db.query<{ people: string | null; client: string | null; server: string | null }>(
    `select sum(people)::text as people, sum(client_errors)::text as client, sum(server_errors)::text as server from daily_health where day > ${TODAY} - 7`,
  );
  const [open] = await db.query<{ n: string }>(
    `select count(*)::text as n from feedback where kind = 'problem' and status = 'new' and created_at < now() - make_interval(days => $1::int)`,
    [t.answerDays],
  );
  const kinds = await db.query<{ kind: FeedbackKind; n: string; fresh: string }>(
    `select kind, count(*)::text as n, count(*) filter (where status = 'new')::text as fresh from feedback group by kind`,
  );
  const [consent] = await db.query<{ yes: string; no: string }>(
    `select count(*) filter (where usage_consent = 'yes')::text as yes, count(*) filter (where usage_consent = 'no')::text as no from users`,
  );
  const screens = await db.query<{ event: string; n: string }>(
    `select event, sum(n)::text as n from usage_events where event like 'screen:%' and day > ${TODAY} - 7 group by event order by sum(n) desc, event limit 5`,
  );
  const feedback: Record<FeedbackKind, number> = { problem: 0, idea: 0, praise: 0 };
  for (const k of kinds) feedback[k.kind] = num(k.n);
  return {
    people: num(joined.people),
    firstJoinDays: joined.days === null ? null : num(joined.days),
    nightsRun: num(runs.nights),
    reconcileProblems: num(runs.problems),
    personDays7: num(health.people),
    errors7: { client: num(health.client), server: num(health.server) },
    unansweredProblems: num(open.n),
    feedback,
    newFeedback: kinds.reduce((s, k) => s + num(k.fresh), 0),
    usageConsent: { yes: num(consent.yes), no: num(consent.no), asked: num(consent.yes) + num(consent.no) },
    topScreens: screens.map((s) => ({ screen: s.event.slice('screen:'.length), n: num(s.n) })),
  };
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;
const people = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'person' : 'people'}`;

/** What must be true before the beta widens to everyone. Every gate must pass. */
export function launchGates(f: LaunchFacts, t: Thresholds = LAUNCH_THRESHOLDS): Gate[] {
  const errors = f.errors7.client + f.errors7.server;
  const rate = f.personDays7 ? errors / f.personDays7 : errors ? Number.POSITIVE_INFINITY : 0;
  return [
    { name: 'Enough people are in the beta', ok: f.people >= t.people, detail: `${people(f.people)} joined; ${t.people} needed.` },
    {
      name: 'The beta has run long enough',
      ok: (f.firstJoinDays ?? -1) >= t.days,
      detail: f.firstJoinDays === null ? 'Nobody has joined yet.' : `${plural(f.firstJoinDays, 'day')} since the first person joined; ${t.days} needed.`,
    },
    {
      name: 'Reconciliation ran every night and found nothing',
      ok: f.nightsRun >= t.nights && f.reconcileProblems === 0,
      detail: `Ran on ${f.nightsRun} of the last ${t.nights} nights and found ${plural(f.reconcileProblems, 'problem')}.`,
    },
    {
      name: 'Errors are rare',
      ok: rate <= t.errorRate,
      detail: `${plural(errors, 'error')} (${f.errors7.client} in the app, ${f.errors7.server} on the server) over ${plural(f.personDays7, 'person-day')} in the last 7 days; at most ${t.errorRate} per person-day allowed.`,
    },
    {
      name: 'Every problem report has been looked at',
      ok: f.unansweredProblems === 0,
      detail: f.unansweredProblems ? `${plural(f.unansweredProblems, 'problem report')} waiting more than ${t.answerDays} days.` : 'None waiting.',
    },
  ];
}

export function formatReport(f: LaunchFacts, gates: Gate[]): string {
  const ready = gates.every((g) => g.ok);
  return [
    ready ? 'Ready to widen the beta to everyone.' : 'Not ready to launch yet.',
    '',
    ...gates.map((g) => `${g.ok ? '[pass]' : '[ wait ]'} ${g.name}\n         ${g.detail}`),
    '',
    `Feedback: ${f.feedback.problem} problems, ${f.feedback.idea} ideas, ${f.feedback.praise} praise (${f.newFeedback} not looked at yet).`,
    `Usage sharing: ${f.usageConsent.yes} said yes, ${f.usageConsent.no} said no.`,
    f.topScreens.length ? `Most used screens this week: ${f.topScreens.map((s) => `${s.screen} (${s.n})`).join(', ')}.` : 'No usage counted this week.',
  ].join('\n');
}

// ── The command ────────────────────────────────────────────────────────────

const HELP = `Finken beta commands:
  invite --wave N [--count 10] [--uses 1] [--days 30] [--note "who it is for"]
                         Make invite codes. They are printed once and never stored.
  waves                  How many codes each wave has, and how many people joined.
  revoke --wave N        Stop a wave's unused codes working.
  feedback [--all]       Feedback not looked at yet (or everything).
  mark --id N --status seen|done
                         Mark feedback as looked at, or dealt with.
  report [--json]        The launch gates. Exits 1 until every gate passes.`;

export async function runCommand(db: Db, argv: string[], print: (line: string) => void = console.log): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      wave: { type: 'string' },
      count: { type: 'string' },
      uses: { type: 'string' },
      days: { type: 'string' },
      note: { type: 'string' },
      all: { type: 'boolean' },
      id: { type: 'string' },
      status: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const int = (v: string | undefined, fallback?: number) => (v === undefined ? fallback : Number.parseInt(v, 10));
  switch (positionals[0]) {
    case 'invite': {
      const codes = await createInvites(db, {
        wave: int(values.wave) ?? Number.NaN,
        count: int(values.count, 10)!,
        uses: int(values.uses, 1),
        days: int(values.days),
        note: values.note,
      });
      print(`Wave ${values.wave}: ${plural(codes.length, 'code')}, each for ${people(int(values.uses, 1)!)}.`);
      for (const c of codes) print(c);
      return 0;
    }
    case 'waves':
      for (const w of await listWaves(db))
        print(`Wave ${w.wave}: ${plural(w.codes, 'code')}, ${w.used} of ${w.places} places used, ${people(w.people)} joined${w.revoked ? `, ${w.revoked} revoked` : ''}.`);
      return 0;
    case 'revoke':
      print(`Stopped ${plural(await revokeWave(db, int(values.wave) ?? Number.NaN), 'code')}.`);
      return 0;
    case 'feedback': {
      const items = await listFeedback(db, { all: values.all });
      if (!items.length) print(values.all ? 'No feedback yet.' : 'Nothing new.');
      for (const f of items) print(`#${f.id}  ${f.at}  ${f.kind}  ${f.status}  ${f.screen || '-'}  wave ${f.wave ?? '-'}\n    ${f.message.replace(/\s+/g, ' ')}`);
      return 0;
    }
    case 'mark': {
      const status = values.status as FeedbackStatus;
      if (!['new', 'seen', 'done'].includes(status)) throw new Error('--status must be new, seen or done.');
      const ok = await markFeedback(db, int(values.id) ?? -1, status);
      print(ok ? `Marked #${values.id} as ${status}.` : `There is no feedback #${values.id}.`);
      return ok ? 0 : 1;
    }
    case 'report': {
      const facts = await launchFacts(db);
      const gates = launchGates(facts);
      print(values.json ? JSON.stringify({ msg: 'launch report', ready: gates.every((g) => g.ok), gates, facts }) : formatReport(facts, gates));
      return gates.every((g) => g.ok) ? 0 : 1;
    }
    default:
      print(HELP);
      return positionals[0] ? 1 : 0;
  }
}

// Run directly: npm run beta -w @finken/api -- <command> (in production: node dist/beta.js <command>).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = connect(loadConfig().DATABASE_URL);
  try {
    process.exitCode = await runCommand(db, process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
