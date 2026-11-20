/**
 * Reminders sent to people's phones and computers (Web Push).
 *
 * - A device that turns reminders on registers its browser's push address.
 *   Only the real push services are accepted (Google, Mozilla, Microsoft and
 *   Apple), so nobody can make Finken's server send requests elsewhere.
 * - The reminders job runs every hour (`node dist/push.js`). After 9 in
 *   the morning in each person's own time zone, if anything needs attention,
 *   it sends one reminder to each of their devices, at most once a day.
 * - The message is built by `dailyReminder` in the shared money rules: counts
 *   only, never amounts or names. Push messages are encrypted for the device.
 * - A device the push service says is gone is forgotten; one that keeps
 *   failing is forgotten after five tries.
 */
import { fileURLToPath } from 'node:url';
import { zonedParts } from '@finken/domain/dates';
import { dailyReminder, type Reminder } from '@finken/domain/reminders';
import type { Obligation, Recurring, Transaction } from '@finken/domain/types';
import webpush from 'web-push';
import { z } from 'zod';
import { loadConfig } from './config';
import { connect, type Db } from './db';
import { loadSpaces } from './records';

/** The hour, in each person's own time zone, from which the day's reminder may go. */
export const REMINDER_HOUR = 9;
const MAX_FAILURES = 5;

/** The push services browsers use. Anything else is refused. */
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

export const Subscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export function allowedEndpoint(endpoint: string, hosts: RegExp[] = PUSH_HOSTS): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && hosts.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

export async function saveSubscription(db: Db, userId: string, sub: z.infer<typeof Subscription>) {
  // The same device signing in as someone else moves to them.
  await db.query(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function removeSubscription(db: Db, userId: string, endpoint: string): Promise<boolean> {
  return (await db.query('delete from push_subscriptions where user_id = $1 and endpoint = $2 returning id', [userId, endpoint])).length > 0;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Sends one message. Resolves with the push service's status; throws on a network failure. */
export type Sender = (target: PushTarget, payload: string) => Promise<{ statusCode: number }>;

export function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): Sender {
  return async (target, payload) => {
    try {
      const res = await webpush.sendNotification(target, payload, { vapidDetails: vapid, TTL: 12 * 60 * 60, urgency: 'normal' });
      return { statusCode: res.statusCode };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status) return { statusCode: status };
      throw err;
    }
  };
}

export interface ReminderRun {
  people: number;
  sent: number;
  devicesForgotten: number;
  failures: number;
}

/** Sends today's reminder to everyone whose morning it is and who has something due. */
export async function sendReminders(db: Db, send: Sender, now: Date = new Date()): Promise<ReminderRun> {
  const run: ReminderRun = { people: 0, sent: 0, devicesForgotten: 0, failures: 0 };
  const people = await db.query<{ id: string; time_zone: string; last_reminder_on: string | null; last_reminder_digest: string | null }>(
    `select u.id, u.time_zone, to_char(u.last_reminder_on, 'YYYY-MM-DD') as last_reminder_on, u.last_reminder_digest
     from users u where exists (select 1 from push_subscriptions p where p.user_id = u.id)`,
  );
  for (const person of people) {
    const { date, hour } = zonedParts(person.time_zone, now);
    if (hour < REMINDER_HOUR || person.last_reminder_on === date) continue;
    const spaces = (await db.query<{ space_id: string }>('select space_id from space_members where user_id = $1', [person.id])).map((r) => r.space_id);
    if (!spaces.length) continue;
    const state = await loadSpaces(db, spaces);
    const reminder: Reminder | null = dailyReminder(
      {
        recurring: state.recurring as unknown as Recurring[],
        obligations: state.obligations as unknown as Obligation[],
        transactions: state.transactions as unknown as Transaction[],
      },
      date,
    );
    if (!reminder) continue;
    run.people++;
    const payload = JSON.stringify({ title: reminder.title, body: reminder.body, tag: reminder.tag, url: reminder.url });
    const devices = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'select id::text, endpoint, p256dh, auth from push_subscriptions where user_id = $1',
      [person.id],
    );
    for (const d of devices) {
      let status = 0;
      try {
        status = (await send({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload)).statusCode;
      } catch {
        status = 0;
      }
      if (status >= 200 && status < 300) {
        run.sent++;
        await db.query('update push_subscriptions set failures = 0 where id = $1', [d.id]);
      } else if (status === 404 || status === 410) {
        // The browser unsubscribed, or the person removed it.
        run.devicesForgotten++;
        await db.query('delete from push_subscriptions where id = $1', [d.id]);
      } else {
        run.failures++;
        const [row] = await db.query<{ failures: number }>('update push_subscriptions set failures = failures + 1 where id = $1 returning failures', [d.id]);
        if (row && row.failures >= MAX_FAILURES) {
          run.devicesForgotten++;
          await db.query('delete from push_subscriptions where id = $1', [d.id]);
        }
      }
    }
    // Sent (to at least one device) or not, today's reminder has been dealt with.
    await db.query('update users set last_reminder_on = $2, last_reminder_digest = $3 where id = $1', [person.id, date, reminder.digest]);
  }
  return run;
}

// Run directly, every hour: node dist/push.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY || !config.VAPID_SUBJECT) {
    console.log(JSON.stringify({ msg: 'reminders', skipped: 'VAPID keys are not set' }));
  } else {
    const db = connect(config.DATABASE_URL);
    try {
      const run = await sendReminders(db, webPushSender({ publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY, subject: config.VAPID_SUBJECT }));
      console.log(JSON.stringify({ msg: 'reminders', ...run }));
    } finally {
      await db.close();
    }
  }
}
