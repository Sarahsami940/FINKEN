/**
 * Reminders on this device: one notification a day saying what needs
 * attention, built by `dailyReminder` (counts only, never amounts or names).
 *
 * - **On this device**, Finken checks when it opens, when it comes back to
 *   the screen, and every half hour while open, and shows the day's reminder
 *   once (again only if something new needs attention).
 * - **With an account**, the device also asks Finken's server to push the
 *   reminder each morning, so it arrives even when Finken is closed. Both use
 *   the same tag, so a phone never shows two.
 *
 * Nothing is shown unless the person turns reminders on in Settings and the
 * browser allows notifications.
 */
import { today } from '@finken/domain/dates';
import { dailyReminder } from '@finken/domain/reminders';
import { useSyncExternalStore } from 'react';
import { account } from './account';
import type { AppState } from './store';
import { track } from './usage';

const PREF = 'finken:reminders';
const SHOWN = 'finken:reminded';

export type ReminderPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export interface RemindersState {
  on: boolean;
  permission: ReminderPermission;
  /** Reminders also come from the server when Finken is closed. */
  pushed: boolean;
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage, reminders are simply asked about again next time.
  }
};
const permission = (): ReminderPermission => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

let state: RemindersState = { on: read(PREF) === 'on', permission: permission(), pushed: read(`${PREF}:push`) === 'on' };
const listeners = new Set<() => void>();
function set(patch: Partial<RemindersState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useReminders(): RemindersState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Shows today's reminder if there is one and it has not been shown. Returns whether it showed. */
export async function checkReminders(app: AppState, anchor = today()): Promise<boolean> {
  if (!state.on || permission() !== 'granted' || !app.user) return false;
  const spaces = new Set(app.spaces.filter((s) => s.status === 'active').map((s) => s.id));
  const mine = <T extends { spaceId: string }>(list: T[]) => list.filter((r) => spaces.has(r.spaceId));
  const reminder = dailyReminder({ recurring: mine(app.recurring), obligations: mine(app.obligations), transactions: mine(app.transactions) }, anchor);
  if (!reminder) return false;
  const key = `${anchor}|${reminder.digest}`;
  if (read(SHOWN) === key) return false;
  write(SHOWN, key);
  const options: NotificationOptions = { body: reminder.body, tag: reminder.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: reminder.url } };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration) await registration.showNotification(reminder.title, options);
  else {
    const n = new Notification(reminder.title, options);
    n.onclick = () => {
      window.focus();
      window.location.assign(reminder.url);
    };
  }
  return true;
}

const fromBase64Url = (text: string) =>
  Uint8Array.from(
    atob(
      text
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(text.length / 4) * 4, '='),
    ),
    (c) => c.charCodeAt(0),
  );

/** With an account, asks the server to push reminders to this device too. Returns whether it could. */
async function subscribePush(): Promise<boolean> {
  if (!account || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const { publicKey } = await account.api.request<{ publicKey: string }>('GET', '/v1/push/key');
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) }));
    const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await account.api.request('POST', '/v1/push/subscriptions', { endpoint: json.endpoint, keys: json.keys });
    return true;
  } catch (err) {
    console.warn('Reminders will only show while Finken is open', err);
    return false;
  }
}

async function unsubscribePush() {
  if (!account || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await account.api.request('DELETE', '/v1/push/subscriptions', { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/** Turns reminders on: asks the browser first. Returns what the browser said. */
export async function turnOnReminders(app: AppState): Promise<ReminderPermission> {
  if (permission() === 'unsupported') return 'unsupported';
  const answer = permission() === 'granted' ? 'granted' : await Notification.requestPermission();
  set({ permission: answer as ReminderPermission });
  if (answer !== 'granted') return answer as ReminderPermission;
  write(PREF, 'on');
  set({ on: true });
  const pushed = await subscribePush();
  write(`${PREF}:push`, pushed ? 'on' : null);
  set({ pushed });
  write(SHOWN, null);
  track('reminders:on');
  await checkReminders(app);
  return 'granted';
}

export async function turnOffReminders() {
  write(PREF, null);
  write(`${PREF}:push`, null);
  set({ on: false, pushed: false });
  await unsubscribePush();
}

/** Checks now, when Finken comes back to the screen, and every half hour while it is open. */
export function startReminders(getState: () => AppState) {
  if (typeof window === 'undefined') return;
  const check = () => void checkReminders(getState()).catch(() => {});
  check();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  setInterval(check, 30 * 60 * 1000);
}
