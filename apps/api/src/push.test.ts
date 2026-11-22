/**
 * Reminders pushed to devices: registering a device, who gets a reminder and
 * when, what it says, and forgetting devices that are gone.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { buildApp } from './app';
import { devToken } from './auth';
import { migrate } from './migrate';
import { allowedEndpoint, type PushTarget, sendReminders } from './push';
import { type TestDb, testDb } from './testing';

const SECRET = 'p'.repeat(40);
const VAPID = webpush.generateVAPIDKeys();
let db: TestDb;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await testDb();
  await migrate(db);
  app = buildApp({ db, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET, VAPID_PUBLIC_KEY: VAPID.publicKey } });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

/** A browser's push keys, as a real one would make them. */
function deviceKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

async function person(subject: string, timeZone = 'Asia/Karachi') {
  const headers = { authorization: `Bearer ${await devToken(SECRET, { subject })}` };
  const me = (await app.inject({ method: 'PATCH', url: '/v1/me', headers, payload: { timeZone } })).json() as { id: string };
  const space = `sp-${subject}`;
  const batch = {
    puts: {
      spaces: [{ id: space, name: 'Home', type: 'personal', icon: 'home', description: '', currency: 'PKR', status: 'active' }],
      accounts: [{ id: `${space}-bank`, spaceId: space, name: 'Bank', kind: 'bank', openingBalance: 0 }],
      recurring: [
        {
          id: `${space}-rent`,
          spaceId: space,
          name: 'Rent for the flat',
          amount: 4500000,
          type: 'expense',
          accountId: `${space}-bank`,
          frequency: 'monthly',
          startDate: '2026-01-20',
          nextDueDate: '2026-11-20',
          status: 'active',
          reminderDays: 3,
        },
      ],
    },
  };
  expect((await app.inject({ method: 'POST', url: '/v1/batch', headers, payload: batch })).statusCode).toBe(200);
  return { headers, me };
}

const subscribe = (headers: Record<string, string>, endpoint: string) =>
  app.inject({ method: 'POST', url: '/v1/push/subscriptions', headers, payload: { endpoint, keys: deviceKeys() } });

describe('registering a device', () => {
  it('gives out the public key, and takes only real push services', async () => {
    const { headers } = await person('reg-ana');
    expect((await app.inject({ method: 'GET', url: '/v1/push/key', headers })).json()).toEqual({ publicKey: VAPID.publicKey });
    expect((await subscribe(headers, 'https://fcm.googleapis.com/fcm/send/abc')).statusCode).toBe(201);
    expect((await subscribe(headers, 'https://wns2-par02p.notify.windows.com/w/?token=x')).statusCode).toBe(201);
    for (const bad of ['https://evil.example.com/push', 'https://fcm.googleapis.com.evil.com/x', 'http://fcm.googleapis.com/x', 'https://169.254.169.254/latest']) {
      const res = await subscribe(headers, bad);
      expect(res.statusCode, bad).toBe(400);
    }
    expect(allowedEndpoint('https://web.push.apple.com/QGr')).toBe(true);
    expect(allowedEndpoint('not a url')).toBe(false);
  });

  it('says so when the server sends no reminders', async () => {
    const quiet = buildApp({ db, config: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_MODE: 'dev', AUTH_DEV_SECRET: SECRET } });
    const { headers } = await person('reg-quiet');
    expect((await quiet.inject({ method: 'GET', url: '/v1/push/key', headers })).json()).toEqual({ error: 'Reminders from the server are not set up.' });
    await quiet.close();
  });

  it('removes a device when asked, and moves one that signs in as someone else', async () => {
    const a = await person('reg-move-a');
    const b = await person('reg-move-b');
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/shared';
    await subscribe(a.headers, endpoint);
    await subscribe(b.headers, endpoint);
    const owner = await db.query<{ user_id: string }>('select user_id from push_subscriptions where endpoint = $1', [endpoint]);
    expect(owner).toEqual([{ user_id: b.me.id }]);
    expect((await app.inject({ method: 'DELETE', url: '/v1/push/subscriptions', headers: b.headers, payload: { endpoint } })).statusCode).toBe(204);
    expect(await db.query('select 1 from push_subscriptions where endpoint = $1', [endpoint])).toEqual([]);
  });
});

describe('the reminders job', () => {
  it('sends once a day, after 9 in each person’s own morning, counts only, and forgets gone devices', async () => {
    await db.query('delete from push_subscriptions');
    const karachi = await person('job-karachi', 'Asia/Karachi');
    const london = await person('job-london', 'Europe/London');
    const nothing = await person('job-nothing', 'Asia/Karachi');
    await db.query("update recurring set next_due_date = '2026-12-20' where space_id = 'sp-job-nothing'");
    await subscribe(karachi.headers, 'https://fcm.googleapis.com/fcm/send/karachi-phone');
    await subscribe(karachi.headers, 'https://fcm.googleapis.com/fcm/send/karachi-old-laptop');
    await subscribe(london.headers, 'https://fcm.googleapis.com/fcm/send/london');
    await subscribe(nothing.headers, 'https://fcm.googleapis.com/fcm/send/nothing');

    const sent: { endpoint: string; payload: Record<string, string> }[] = [];
    const send = async (target: PushTarget, payload: string) => {
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
      return { statusCode: target.endpoint.endsWith('old-laptop') ? 410 : 201 };
    };

    // 05:00 UTC on 20 Nov: 10:00 in Karachi, 05:00 in London.
    const morning = new Date('2026-11-20T05:00:00Z');
    expect(await sendReminders(db, send, morning)).toEqual({ people: 1, sent: 1, devicesForgotten: 1, failures: 0 });
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/karachi-phone', 'https://fcm.googleapis.com/fcm/send/karachi-old-laptop']);
    expect(sent[0].payload).toEqual({ title: 'Due today', body: '1 payment is due today. Open Finken to see them.', tag: 'finken-reminder-2026-11-20', url: '/money/upcoming' });
    expect(JSON.stringify(sent)).not.toMatch(/Rent|45,000|4500000/);
    expect(await db.query("select 1 from push_subscriptions where endpoint like '%old-laptop'")).toEqual([]);

    // An hour later: Karachi already had today's; London is still asleep.
    sent.length = 0;
    expect(await sendReminders(db, send, new Date('2026-11-20T06:00:00Z'))).toMatchObject({ sent: 0 });
    // 09:00 in London.
    expect(await sendReminders(db, send, new Date('2026-11-20T09:00:00Z'))).toMatchObject({ people: 1, sent: 1 });
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/london']);
    // The next morning, the rent is overdue in Karachi.
    sent.length = 0;
    await sendReminders(db, send, new Date('2026-11-21T05:00:00Z'));
    expect(sent.find((s) => s.endpoint.endsWith('karachi-phone'))?.payload.title).toBe('Something is overdue');
  });

  it('forgets a device after five failed tries, but not before', async () => {
    await db.query('delete from push_subscriptions');
    await db.query('update users set last_reminder_on = null');
    const p = await person('job-flaky');
    await subscribe(p.headers, 'https://fcm.googleapis.com/fcm/send/flaky');
    const failing = async () => ({ statusCode: 500 });
    for (let day = 0; day < 5; day++) {
      await db.query('update users set last_reminder_on = null');
      await sendReminders(db, failing, new Date('2026-11-20T05:00:00Z'));
      const left = await db.query('select 1 from push_subscriptions where endpoint like $1', ['%flaky']);
      expect(left.length, `after ${day + 1} failures`).toBe(day < 4 ? 1 : 0);
    }
  });

  it('builds real, encrypted Web Push requests', () => {
    const keys = deviceKeys();
    const request = webpush.generateRequestDetails({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }, JSON.stringify({ title: 'Due today' }), {
      vapidDetails: { subject: 'mailto:support@example.com', publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
      TTL: 43200,
    });
    expect(request.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: 43200 });
    expect(String(request.headers.Authorization)).toMatch(/^vapid t=.+, k=.+$/);
    // The message itself is unreadable on the way.
    expect(Buffer.from(request.body as Buffer).toString()).not.toContain('Due today');
  });

  it('goes with the account when it is deleted', async () => {
    const p = await person('job-delete');
    await subscribe(p.headers, 'https://fcm.googleapis.com/fcm/send/delete-me');
    expect((await app.inject({ method: 'DELETE', url: '/v1/me', headers: p.headers, payload: { confirm: 'DELETE' } })).statusCode).toBe(200);
    expect(await db.query("select 1 from push_subscriptions where endpoint like '%delete-me'")).toEqual([]);
  });
});
