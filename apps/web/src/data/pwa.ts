/**
 * Finken as an installed app: the service worker that lets it open offline,
 * the "new version ready" prompt, and the browser's install prompt.
 * Only in the built app; during development every load is fresh.
 */
import { useSyncExternalStore } from 'react';
import { track } from './usage';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** A new version has downloaded and waits for the person to reload. */
  updateReady: boolean;
  /** The browser offers to install Finken. */
  canInstall: boolean;
  /** Running as an installed app. */
  installed: boolean;
  /** The whole app is kept on this device and opens offline. */
  offlineReady: boolean;
}

const standalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

let state: PwaState = { updateReady: false, canInstall: false, installed: standalone(), offlineReady: false };
const listeners = new Set<() => void>();
let waiting: ServiceWorker | null = null;
let installPrompt: InstallPrompt | null = null;

function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function usePwa(): PwaState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
    set({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    set({ canInstall: false, installed: true });
  });
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The new version took over because the person asked: show it.
    if (reloading || !waiting) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state !== 'installed') return;
          // With an older version in charge this is an update; otherwise the first install.
          if (navigator.serviceWorker.controller) {
            waiting = worker;
            set({ updateReady: true });
          } else set({ offlineReady: true });
        });
      };
      if (registration.waiting && navigator.serviceWorker.controller) {
        waiting = registration.waiting;
        set({ updateReady: true });
      }
      if (registration.active) set({ offlineReady: true });
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration.installing));
      // Look for a new version every hour while Finken is open.
      setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
    } catch (err) {
      console.warn('Finken could not set up offline use', err);
    }
  });
}

/** Switches to the new version; the page reloads once it has taken over. */
export function applyUpdate() {
  waiting?.postMessage('skip-waiting');
}

/** Opens the browser's own install prompt. */
export async function installApp(): Promise<boolean> {
  if (!installPrompt) return false;
  await installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  set({ canInstall: false, installed: outcome === 'accepted' || state.installed });
  if (outcome === 'accepted') track('install:done');
  return outcome === 'accepted';
}
