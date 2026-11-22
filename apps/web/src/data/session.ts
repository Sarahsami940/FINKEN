import { account } from './account';
import { turnOffReminders } from './reminders';
import { store } from './store';

/**
 * Ends the session and returns to the welcome screen at the app root. In
 * account mode this device's copy is forgotten too; the account keeps it all.
 */
export async function leaveFinken() {
  window.history.replaceState(null, '', '/');
  store.signOut();
  if (account) {
    // The next person on this device must not get this person's reminders.
    await turnOffReminders().catch(() => {});
    const providerSignOut = await account.signOut();
    // End the provider's own session too, when it offers that; it sends people back here.
    if (providerSignOut) window.location.assign(providerSignOut);
    // Start clean, so nothing of this account stays on screen for the next person.
    else window.location.reload();
  }
}

/** Changes made here that have not reached the account yet (0 when Finken keeps everything in this browser). */
export async function unsentChanges(): Promise<number> {
  if (!account) return 0;
  await account.storage.sync().catch(() => {});
  return (await account.storage.status()).pending;
}
