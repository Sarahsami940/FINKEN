/**
 * The reminder Finken sends: what needs attention today, across every Space.
 *
 * One notification a day at most, saying how many payments are due or
 * overdue and how much money is expected in, never amounts or names: it can
 * appear on a locked phone that someone else is looking at. Tapping it opens
 * Coming up, where everything is listed. The device (while Finken is open)
 * and the server (push, with an account) build it the same way, and with the
 * same tag, so a phone never shows it twice.
 */
import { addDays } from './dates';
import type { ISODate, Obligation, Recurring, Transaction } from './types';
import { type ExpectedEvent, expectedEvents, needsReminder } from './upcoming';

export interface Reminder {
  title: string;
  body: string;
  /** Notifications with the same tag replace each other: one a day. */
  tag: string;
  url: string;
  /** Changes when what needs attention changes; for not repeating the same reminder. */
  digest: string;
  counts: { overdue: number; dueToday: number; dueSoon: number; toReceive: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Today's reminder from these records, or null when nothing needs attention. */
export function dailyReminder(input: { recurring: Recurring[]; obligations: Obligation[]; transactions: Transaction[] }, anchor: ISODate): Reminder | null {
  // Reminders look at most two weeks ahead; each item's own lead time decides within that.
  const events = expectedEvents(input, { from: anchor, to: addDays(anchor, 14) }, anchor);
  const due = needsReminder(events, input.recurring, anchor);
  if (!due.length) return null;
  const out = (e: ExpectedEvent) => e.direction === 'out';
  const overdue = due.filter((e) => e.status === 'overdue' && out(e)).length;
  const dueToday = due.filter((e) => e.date === anchor && out(e)).length;
  const dueSoon = due.filter((e) => e.date > anchor && out(e)).length;
  const toReceive = due.filter((e) => !out(e)).length;

  const parts: string[] = [];
  if (overdue) parts.push(`${plural(overdue, 'payment is', 'payments are')} overdue`);
  if (dueToday) parts.push(`${plural(dueToday, 'payment is', 'payments are')} due today`);
  if (dueSoon) parts.push(`${plural(dueSoon, 'payment is', 'payments are')} due soon`);
  if (toReceive) parts.push(`${plural(toReceive, 'amount is', 'amounts are')} expected in`);
  const sentence = parts.join(', ').replace(/, ([^,]*)$/, ' and $1');
  const title = overdue ? 'Something is overdue' : dueToday ? 'Due today' : toReceive && !dueSoon ? 'Money expected' : 'Coming up';
  return {
    title,
    body: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. Open Finken to see them.`,
    tag: `finken-reminder-${anchor}`,
    url: '/money/upcoming',
    digest: due
      .map((e) => `${e.key}:${e.status}`)
      .sort()
      .join('|'),
    counts: { overdue, dueToday, dueSoon, toReceive },
  };
}
