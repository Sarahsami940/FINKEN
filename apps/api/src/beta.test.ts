/**
 * Phase 8: the closed beta. Invite codes, feedback, usage with consent,
 * daily health, and the launch gates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { devToken } from './auth';
import {
  createInvites,
  formatReport,
  hashCode,
  LAUNCH_THRESHOLDS,
  type LaunchFacts,
  launchFacts,
  launchGates,
  listFeedback,
  listWaves,
  newInviteCode,
  normaliseCode,
  recordReconciliation,
  revokeWave,
  runCommand,
} from './beta';
import type { Db } from './db';
import { migrate } from './migrate';
import { testDb } from './testing';

const SECRET = 'b'.repeat(40);
const CONFIG = { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET, BETA_ACCESS: 'invite' } as const;

let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: CONFIG });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const auth = async (subject: string) => ({ authorization: `Bearer ${await devToken(SECRET, { subject, email: `${subject}@example.com`, name: subject })}` });
const me = async (headers: Record<string, string>) => (await app.inject({ method: 'GET', url: '/v1/me', headers })).json() as { id: string; access: string; usage: string | null };
const join = (headers: Record<string, string>, code: string) => app.inject({ method: 'POST', url: '/v1/beta/join', headers, payload: { code } });

describe('invite codes', () => {
  it('look like FNK-XXXX-XXXX, avoid look-alike characters, and are stored only as hashes', async () => {
    const codes = new Set(Array.from({ length: 200 }, newInviteCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^FNK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normaliseCode(' fnk-ab2c -d3ef ')).toBe('FNKAB2CD3EF');
    expect(hashCode('fnk ab2c d3ef')).toBe(hashCode('FNK-AB2C-D3EF'));

    const [code] = await createInvites(db, { wave: 9, count: 1 });
    const stored = await db.query<{ code_hash: string }>('select code_hash from beta_invites where wave = 9');
    expect(stored).toEqual([{ code_hash: hashCode(code) }]);
    expect(JSON.stringify(stored)).not.toContain(code.slice(4));
  });

  it('let people in one at a time, as many as each code allows', async () => {
    const [code] = await createInvites(db, { wave: 1, count: 1, uses: 2, note: 'friends' });
    const ali = await auth('invite-ali');
    const bo = await auth('invite-bo');
    const cy = await auth('invite-cy');

    // Signed in, but not in yet: can see the account, not keep records.
    expect(await me(ali)).toMatchObject({ access: 'invite-needed', usage: null });
    const blocked = await app.inject({ method: 'GET', url: '/v1/records/spaces', headers: ali });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: 'Finken is in a closed beta. Enter your invite code to start.', code: 'invite_needed' });
    expect((await app.inject({ method: 'POST', url: '/v1/batch', headers: ali, payload: { puts: {} } })).statusCode).toBe(403);
    // Leaving, exporting and talking to us still work.
    expect((await app.inject({ method: 'GET', url: '/v1/export', headers: ali })).statusCode).toBe(200);

    // Typed loosely, it still works.
    const joined = await join(ali, code.toLowerCase().replace(/-/g, ' '));
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toMatchObject({ access: 'member' });
    expect((await app.inject({ method: 'GET', url: '/v1/records/spaces', headers: ali })).statusCode).toBe(200);
    // Joining again uses nothing up.
    expect((await join(ali, code)).statusCode).toBe(200);

    expect((await join(bo, code)).statusCode).toBe(200);
    const full = await join(cy, code);
    expect(full.statusCode).toBe(400);
    expect(full.json().error).toBe('That invite code is not right, or it has been used up. Check it and try again.');
    expect((await join(cy, 'FNK-NOPE-NOPE')).json().error).toBe(full.json().error);

    expect((await listWaves(db)).find((w) => w.wave === 1)).toEqual({ wave: 1, codes: 1, places: 2, used: 2, revoked: 0, people: 2 });
  });

  it('stop working when revoked or expired', async () => {
    const [revoked] = await createInvites(db, { wave: 2, count: 1 });
    expect(await revokeWave(db, 2)).toBe(1);
    const dee = await auth('invite-dee');
    expect((await join(dee, revoked)).statusCode).toBe(400);

    const [expired] = await createInvites(db, { wave: 3, count: 1, days: 1 });
    await db.query(`update beta_invites set expires_at = now() - interval '1 minute' where wave = 3`);
    expect((await join(dee, expired)).statusCode).toBe(400);
  });

  it('cannot be guessed: wrong codes are limited per person', async () => {
    const small = buildApp({ db, config: CONFIG, limits: { invite: { max: 3, windowMs: 60_000 } } });
    const eve = await auth('invite-eve');
    for (let i = 0; i < 3; i++)
      expect((await small.inject({ method: 'POST', url: '/v1/beta/join', headers: eve, payload: { code: `FNK-AAAA-AAA${i + 2}` } })).statusCode).toBe(400);
    expect((await small.inject({ method: 'POST', url: '/v1/beta/join', headers: eve, payload: { code: 'FNK-AAAA-AAA9' } })).statusCode).toBe(429);
    await small.close();
  });

  it('are not needed once the beta is open', async () => {
    const open = buildApp({ db, config: { ...CONFIG, BETA_ACCESS: 'open' } });
    const headers = await auth('open-fay');
    expect((await open.inject({ method: 'GET', url: '/v1/me', headers })).json()).toMatchObject({ access: 'member' });
    expect((await open.inject({ method: 'GET', url: '/v1/records/spaces', headers })).statusCode).toBe(200);
    await open.close();
  });
});

describe('feedback', () => {
  it('is saved in the person’s words, can be sent before joining, and reaches the team without their name', async () => {
    const headers = await auth('feedback-gus');
    const sent = await app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers,
      payload: { kind: 'problem', message: '  The import screen froze on my HBL file.  ', screen: 'import', release: '0.1.0' },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/v1/feedback', headers, payload: { kind: 'idea', message: '   ' } })).json().error).toBe('Write a few words first.');
    expect((await app.inject({ method: 'POST', url: '/v1/feedback', headers, payload: { kind: 'rant', message: 'x' } })).statusCode).toBe(400);

    const [item] = await listFeedback(db);
    expect(item).toMatchObject({ kind: 'problem', status: 'new', screen: 'import', message: 'The import screen froze on my HBL file.', wave: null });
    expect(JSON.stringify(item)).not.toContain('feedback-gus');

    const lines: string[] = [];
    expect(await runCommand(db, ['mark', '--id', String(item.id), '--status', 'done'], (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([`Marked #${item.id} as done.`]);
    expect(await listFeedback(db)).toEqual([]);
    expect(await listFeedback(db, { all: true })).toHaveLength(1);

    // It is theirs: in their export, and gone with their account.
    const exported = (await app.inject({ method: 'GET', url: '/v1/export', headers })).json() as { feedback: { message: string }[] };
    expect(exported.feedback.map((f) => f.message)).toEqual(['The import screen froze on my HBL file.']);
    expect((await app.inject({ method: 'DELETE', url: '/v1/me', headers, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await listFeedback(db, { all: true })).toEqual([]);
  });
});

describe('usage', () => {
  it('is counted only after the person says yes, from the fixed list only, and is removed when they say no', async () => {
    const [code] = await createInvites(db, { wave: 4, count: 1 });
    const headers = await auth('usage-hal');
    await join(headers, code);
    const send = (events: { name: string; n: number }[]) => app.inject({ method: 'POST', url: '/v1/usage', headers, payload: { events } });
    const counted = async () => db.query<{ event: string; n: number }>(`select event, n from usage_events where user_id = $1 order by event`, [(await me(headers)).id]);

    // Not asked yet: dropped.
    expect((await send([{ name: 'screen:home', n: 1 }])).statusCode).toBe(204);
    expect(await counted()).toEqual([]);

    const yes = await app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { usage: true } });
    expect(yes.json()).toMatchObject({ usage: 'yes' });
    await send([
      { name: 'screen:home', n: 2 },
      { name: 'add:expense', n: 1 },
      { name: 'screen:home', n: 1 },
      { name: 'search:Ali owes me', n: 1 },
      { name: 'add:expense:125050', n: 1 },
    ]);
    await send([{ name: 'add:expense', n: 4 }]);
    expect(await counted()).toEqual([
      { event: 'add:expense', n: 5 },
      { event: 'screen:home', n: 3 },
    ]);

    expect((await app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { usage: false } })).json()).toMatchObject({ usage: 'no' });
    expect(await counted()).toEqual([]);
    await send([{ name: 'screen:home', n: 1 }]);
    expect(await counted()).toEqual([]);
  });
});

describe('daily health', () => {
  it('counts each person once a day, and errors on each side, with nobody named', async () => {
    await db.query('delete from daily_health');
    const headers = await auth('health-ivy');
    for (let i = 0; i < 3; i++) await me(headers);
    await me(await auth('health-jo'));
    await app.inject({ method: 'POST', url: '/v1/client-errors', headers, payload: { message: 'TypeError: x is undefined' } });
    const [row] = await db.query<{ people: number; client_errors: number; server_errors: number }>('select people, client_errors, server_errors from daily_health');
    expect(row).toEqual({ people: 2, client_errors: 1, server_errors: 0 });
  });
});

describe('the launch gates', () => {
  const ready: LaunchFacts = {
    people: 34,
    firstJoinDays: 25,
    nightsRun: 14,
    reconcileProblems: 0,
    personDays7: 180,
    errors7: { client: 3, server: 1 },
    unansweredProblems: 0,
    feedback: { problem: 6, idea: 9, praise: 4 },
    newFeedback: 2,
    usageConsent: { yes: 20, no: 8, asked: 28 },
    topScreens: [{ screen: 'home', n: 410 }],
  };

  it('all pass when the beta is big enough, long enough, clean and quiet', () => {
    const gates = launchGates(ready);
    expect(gates.map((g) => g.ok)).toEqual([true, true, true, true, true]);
    expect(formatReport(ready, gates)).toMatch(/^Ready to widen the beta to everyone\./);
  });

  it('each holds the launch for its own reason', () => {
    const failing = (patch: Partial<LaunchFacts>) =>
      launchGates({ ...ready, ...patch })
        .filter((g) => !g.ok)
        .map((g) => g.name);
    expect(failing({ people: 19 })).toEqual(['Enough people are in the beta']);
    expect(failing({ firstJoinDays: 20 })).toEqual(['The beta has run long enough']);
    expect(failing({ nightsRun: 13 })).toEqual(['Reconciliation ran every night and found nothing']);
    expect(failing({ reconcileProblems: 1 })).toEqual(['Reconciliation ran every night and found nothing']);
    expect(failing({ errors7: { client: 9, server: 1 } })).toEqual(['Errors are rare']);
    expect(failing({ unansweredProblems: 1 })).toEqual(['Every problem report has been looked at']);
    expect(failing({ personDays7: 0, errors7: { client: 1, server: 0 } })).toEqual(['Errors are rare']);
    const gate = launchGates({ ...ready, unansweredProblems: 2 }).at(-1)!;
    expect(gate.detail).toBe(`2 problem reports waiting more than ${LAUNCH_THRESHOLDS.answerDays} days.`);
  });

  it('are worked out from the database, and the command exits 1 until they pass', async () => {
    const now = new Date();
    for (let night = 0; night < 3; night++) {
      const at = new Date(now.getTime() - night * 86_400_000).toISOString();
      await recordReconciliation(db, { startedAt: at, finishedAt: at, spaces: 4, records: 100, problems: [] });
    }
    const facts = await launchFacts(db);
    expect(facts.nightsRun).toBe(3);
    expect(facts.reconcileProblems).toBe(0);
    expect(facts.people).toBeGreaterThanOrEqual(3);
    expect(facts.usageConsent).toMatchObject({ yes: 0, no: 1 });

    const lines: string[] = [];
    expect(await runCommand(db, ['report', '--json'], (l) => lines.push(l))).toBe(1);
    const report = JSON.parse(lines[0]) as { ready: boolean; gates: { name: string; ok: boolean }[] };
    expect(report.ready).toBe(false);
    expect(report.gates.find((g) => g.name.startsWith('Reconciliation'))?.ok).toBe(false);
  });

  it('the command makes codes, lists waves and explains itself', async () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(await runCommand(db, ['invite', '--wave', '7', '--count', '3', '--uses', '5'], print)).toBe(0);
    expect(lines[0]).toBe('Wave 7: 3 codes, each for 5 people.');
    expect(lines.slice(1)).toHaveLength(3);
    lines.length = 0;
    await runCommand(db, ['waves'], print);
    expect(lines).toContain('Wave 7: 3 codes, 0 of 15 places used, 0 people joined.');
    lines.length = 0;
    expect(await runCommand(db, ['nonsense'], print)).toBe(1);
    expect(lines[0]).toMatch(/^Finken beta commands:/);
    await expect(runCommand(db, ['invite', '--count', '2'], print)).rejects.toThrow('The wave must be a whole number from 1.');
  });
});
