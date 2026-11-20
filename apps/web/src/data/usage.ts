/**
 * Usage counting for the beta, only for people who said yes.
 *
 * Counts fixed event names (see `@finken/domain/usage`): which screens are
 * opened and which features are used. Never amounts, names, descriptions,
 * search words or anything typed. Counts are kept in memory and sent about
 * once a minute, and when Finken goes to the background.
 */
import { screenEvent } from '@finken/domain/usage';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { account } from './account';

declare const __FINKEN_RELEASE__: string | undefined;

/** Which release this is, sent with feedback so problems can be matched to a version. */
export const RELEASE = typeof __FINKEN_RELEASE__ === 'string' ? __FINKEN_RELEASE__ : 'dev';

const counts = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

const sharing = () => account?.profile?.usage === 'yes' && account.signedIn && !account.needsInvite;

/** Counts one use of an event. Does nothing unless the person said yes. */
export function track(name: string) {
  if (!sharing()) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
  startUsage();
}

/** Sends what has been counted. If it cannot be sent, the counts wait for next time. */
export async function flushUsage(): Promise<void> {
  if (!account || counts.size === 0) return;
  if (!sharing()) {
    counts.clear();
    return;
  }
  const events = [...counts].map(([name, n]) => ({ name, n: Math.min(n, 1000) }));
  counts.clear();
  try {
    await account.api.request('POST', '/v1/usage', { events }, { keepalive: true });
  } catch {
    for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + e.n);
  }
}

/** Stops counting and forgets anything not yet sent (after saying no). */
export function forgetUsage() {
  counts.clear();
}

function startUsage() {
  if (timer || typeof window === 'undefined') return;
  timer = setInterval(() => void flushUsage(), 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushUsage();
  });
}

/** Counts each screen as it is opened, by its name only. */
export function useScreenUsage() {
  const { pathname } = useLocation();
  useEffect(() => {
    const event = screenEvent(pathname);
    if (event) track(event);
  }, [pathname]);
}
