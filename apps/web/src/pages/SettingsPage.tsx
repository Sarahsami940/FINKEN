import { currentTimeZone, DEFAULT_TIME_ZONE, deviceTimeZone, isValidTimeZone } from '@finken/domain/dates';
import { ArrowDownToLine, Bell, BellOff, Download, LogOut, MonitorSmartphone, RefreshCw, Trash2, UserRoundPlus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { FeedbackButton, USAGE_EXPLAINED, useUsageChoice } from '../components/beta/Beta';
import { SecurityCard } from '../components/beta/SecurityCard';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Field, Input, Select } from '../components/ui/Field';
import { Badge, PageHeader } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { account, useProfile } from '../data/account';
import { useAppState } from '../data/hooks';
import { installApp, usePwa } from '../data/pwa';
import { turnOffReminders, turnOnReminders, useReminders } from '../data/reminders';
import { leaveFinken, unsentChanges } from '../data/session';
import { store } from '../data/store';
import type { SyncStatus } from '../data/sync';
import { track } from '../data/usage';
import { PrototypeNotice, RegisterForm } from '../onboarding/AuthForms';
import { MoveData } from '../onboarding/MoveData';
import { BackLink } from './MoneyPages';

interface CreateAccountDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Lets a guest keep everything they have added by turning it into an account. */
export function CreateAccountDialog({ open, onClose }: CreateAccountDialogProps) {
  const { user } = useAppState();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create your Finken account"
      description="Your Spaces and everything you have added so far will move into your account."
      footer={
        <Button type="submit" form="convert-form" variant="primary" size="lg" block disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
      }
    >
      <div className="space-y-5">
        <RegisterForm
          formId="convert-form"
          initialName={user?.name ?? ''}
          onBusyChange={setBusy}
          onSubmit={async (input) => {
            const result = await store.convertGuestToAccount(input);
            if (result.ok) {
              toast('Account created. Your data came with you.');
              onClose();
            }
            return result;
          }}
        />
        <PrototypeNotice />
      </div>
    </Modal>
  );
}

/** Every zone the browser knows, with the user's own and the device's always included. */
function timeZoneOptions(selected: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    all = [];
  }
  return [...new Set([selected, deviceTimeZone(), DEFAULT_TIME_ZONE, ...all])].filter(isValidTimeZone).sort();
}

/** Installing Finken, and reminders on this device. */
function DeviceCard() {
  const app = useAppState();
  const pwa = usePwa();
  const reminders = useReminders();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

  async function toggle() {
    setBusy(true);
    try {
      if (reminders.on) {
        await turnOffReminders();
        toast('Reminders are off');
      } else {
        const answer = await turnOnReminders(app);
        if (answer === 'granted') toast('Reminders are on');
        else if (answer === 'denied') toast('Notifications are blocked for Finken. Allow them in your browser’s site settings, then try again.', { tone: 'error' });
        else if (answer === 'unsupported') toast('This browser cannot show notifications.', { tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="This device" subtitle="Finken works like an app on your phone or computer, and keeps working without a connection." />
      <div className="divide-y divide-line text-sm">
        <div className="flex flex-col gap-3 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-semibold text-ink">Install Finken</h3>
            <p className="text-ink-3">
              {pwa.installed
                ? 'Installed on this device.'
                : pwa.canInstall
                  ? 'Open it from your home screen or apps, like any other app.'
                  : ios
                    ? 'In Safari, tap Share, then Add to Home Screen.'
                    : 'Use your browser’s menu: Install Finken, or Add to Home screen.'}
              {pwa.offlineReady && ' Ready to open offline.'}
            </p>
          </div>
          {pwa.canInstall && !pwa.installed && (
            <Button icon={<MonitorSmartphone className="size-4" />} onClick={() => void installApp()}>
              Install
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-semibold text-ink">Reminders</h3>
            <p className="text-ink-3">
              {reminders.permission === 'unsupported'
                ? 'This browser cannot show notifications.'
                : reminders.on
                  ? reminders.pushed
                    ? 'On. Once a day, after 9 in the morning, when bills or money owed are due, even when Finken is closed.'
                    : 'On. Once a day when bills or money owed are due, while Finken is open on this device.'
                  : 'Get one notification a day when bills or money owed are due. It never shows amounts or names.'}
              {reminders.permission === 'denied' && ' Notifications are blocked for Finken in this browser’s site settings.'}
            </p>
          </div>
          {reminders.permission !== 'unsupported' && (
            <Button icon={reminders.on ? <BellOff className="size-4" /> : <Bell className="size-4" />} disabled={busy} onClick={() => void toggle()}>
              {reminders.on ? 'Turn off' : 'Turn on reminders'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** How this device's copy stands against the account, kept up to date. */
function useSyncStatus(): SyncStatus | null {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => {
    if (!account) return;
    void account.storage.status().then(setStatus);
    return account.storage.onStatus(setStatus);
  }, []);
  return status;
}

function syncText(status: SyncStatus | null): string {
  if (!status) return 'Checking…';
  const waiting = status.pending ? `${status.pending} ${status.pending === 1 ? 'change' : 'changes'} waiting to be sent` : null;
  if (!status.online) return waiting ? `Offline — ${waiting}` : 'Offline — everything here is saved and will sync later';
  if (waiting) return `Sending — ${waiting}`;
  return status.lastSynced ? `Up to date (${new Date(status.lastSynced).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : 'Up to date';
}

function formatTime(zone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(new Date());
}

/** The beta: whether usage is shared, and a way to send feedback. */
function BetaCard() {
  const profile = useProfile();
  const { busy, choose } = useUsageChoice();
  const sharing = profile?.usage === 'yes';
  return (
    <Card>
      <CardHeader title="The Finken beta" subtitle="Finken is being tested with a small group before it opens to everyone. Your feedback decides what is fixed first." />
      <div className="flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">Share usage</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-3">{USAGE_EXPLAINED}</p>
          <p role="status" className="mt-1.5 text-[13px] font-semibold text-ink-2">
            {sharing ? 'On: usage is counted.' : profile?.usage === 'no' ? 'Off: nothing is counted.' : 'Off: you have not been asked yet.'}
          </p>
        </div>
        <Button className="shrink-0" disabled={busy || !profile} onClick={() => void choose(!sharing)}>
          {sharing ? 'Stop sharing' : 'Share usage'}
        </Button>
      </div>
      <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] leading-relaxed text-ink-3">Something wrong, missing or good? A person reads every message.</p>
        <FeedbackButton className="shrink-0" />
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { user, persistent, transactions, spaces } = useAppState();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const sync = useSyncStatus();
  if (!user) return null;

  async function downloadAll() {
    if (!account) return;
    setExporting(true);
    try {
      const { name, text } = await account.exportAll();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Your data was saved to your downloads');
      track('export:done');
    } catch (err) {
      toast((err as Error).message || 'Your data could not be downloaded. Try again.', { tone: 'error' });
    } finally {
      setExporting(false);
    }
  }

  async function deleteForGood() {
    if (!account) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await turnOffReminders().catch(() => {});
      await account.deleteAccount();
      window.history.replaceState(null, '', '/');
      window.location.reload();
    } catch (err) {
      setDeleteError((err as Error).message || 'Your account could not be deleted. Try again.');
      setBusy(false);
    }
  }

  async function askToLeave() {
    setUnsent(await unsentChanges());
    setLeaving(true);
  }

  const trimmed = name.trim();
  const zone = user.timeZone ?? currentTimeZone();
  const ownSpaceIds = new Set(spaces.map((s) => s.id));
  const recordCount = transactions.filter((t) => ownSpaceIds.has(t.spaceId)).length;

  function saveProfile(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    store.updateUser({ name: trimmed });
    toast('Profile saved');
  }

  async function reset() {
    setBusy(true);
    try {
      await store.resetDemoData();
      toast('Demo data restored');
    } catch {
      toast('The demo data could not be restored', { tone: 'error' });
    } finally {
      setBusy(false);
      setResetting(false);
    }
  }

  return (
    <div>
      <BackLink to="/more">More</BackLink>
      <PageHeader title="Settings and profile" />
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardHeader
            title="Profile"
            subtitle={user.isGuest ? 'You are using Finken as a guest.' : user.email}
            action={<Badge tone={user.isGuest ? 'neutral' : 'accent'}>{user.isGuest ? 'Guest' : 'Account'}</Badge>}
          />
          <form onSubmit={saveProfile} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Your name" className="flex-1">
              {(id) => <Input id={id} value={name} maxLength={40} placeholder={user.isGuest ? 'Optional' : undefined} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Button type="submit" variant="primary" disabled={!trimmed || trimmed === user.name}>
              Save
            </Button>
          </form>
          <Field label="Time zone" hint={`Decides what "today" and "this month" mean. It is ${formatTime(zone)} there now.`} className="mt-4">
            {(id) => (
              <Select
                id={id}
                value={zone}
                onChange={(e) => {
                  store.updateUser({ timeZone: e.target.value });
                  toast('Time zone saved');
                }}
              >
                {timeZoneOptions(zone).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </Card>

        {user.isGuest && (
          <Card className="border-accent/30 bg-accent-soft/40">
            <CardHeader title="Create your Finken account" subtitle="Keep what you have added under your own login, separate from the demo. Everything moves across with you." />
            <Button variant="primary" icon={<UserRoundPlus className="size-4" />} onClick={() => setCreating(true)}>
              Create account
            </Button>
          </Card>
        )}

        <Card>
          <CardHeader title="Your data" />
          <dl className="divide-y divide-line text-sm">
            <div className="flex justify-between gap-6 py-3 first:pt-0">
              <dt className="text-ink-3">Where it is stored</dt>
              <dd className="text-right font-semibold text-ink">
                {account ? 'In your Finken account, with a copy on this device' : persistent ? 'On this device, in this browser' : 'In memory only (not saved)'}
              </dd>
            </div>
            {account && (
              <div className="flex justify-between gap-6 py-3">
                <dt className="text-ink-3">Sync</dt>
                <dd className="text-right font-semibold text-ink">
                  <span role="status">{syncText(sync)}</span>
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-6 py-3">
              <dt className="text-ink-3">Records</dt>
              <dd className="text-right font-semibold text-ink">
                {recordCount} {recordCount === 1 ? 'transaction' : 'transactions'} in {spaces.length} {spaces.length === 1 ? 'Space' : 'Spaces'}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            {account
              ? 'Finken works offline. Changes made without a connection are kept on this device and sent as soon as it is back.'
              : `Nothing is sent to a server, ${user.isGuest ? 'with or without an account' : 'even with an account'}. Clearing this browser's site data removes your Finken records.`}
          </p>
        </Card>

        <DeviceCard />

        <SecurityCard />

        {account && <BetaCard />}

        {account && (
          <Card>
            <CardHeader title="Your rights over your data" subtitle="Take a copy of everything Finken holds about you, or delete your account and everything in it." />
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button icon={<Download className="size-4" />} disabled={exporting} onClick={() => void downloadAll()}>
                {exporting ? 'Preparing…' : 'Download all your data'}
              </Button>
              <Button variant="ghost" className="text-negative hover:text-negative" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>
                Delete account
              </Button>
            </div>
          </Card>
        )}

        {account && (
          <Card>
            <CardHeader
              title="Data saved in this browser"
              subtitle="Spaces from before you signed in, saved only in this browser. Move them into your account to have them on every device."
            />
            <Button icon={<ArrowDownToLine className="size-4" />} onClick={() => setMoving(true)}>
              Move data from this browser
            </Button>
          </Card>
        )}

        {user.isGuest && (
          <Card>
            <CardHeader title="Demo data" subtitle="Replace your guest Spaces with a fresh set of sample data." />
            <Button icon={<RefreshCw className="size-4" />} onClick={() => setResetting(true)}>
              Restore demo data
            </Button>
          </Card>
        )}

        <Card>
          <CardHeader
            title={user.isGuest ? 'Leave the demo' : 'Log out'}
            subtitle={
              user.isGuest
                ? 'Go back to the welcome screen. Your guest data stays in this browser and reopens when you choose Try Finken again.'
                : account
                  ? 'Your data stays in your account. This device’s copy is removed, so the next person to use it starts clean.'
                  : 'Your data stays in this browser. Log in again with your email and password to see it.'
            }
          />
          <Button icon={<LogOut className="size-4" />} onClick={() => (user.isGuest ? void leaveFinken() : void askToLeave())}>
            {user.isGuest ? 'Leave the demo' : 'Log out'}
          </Button>
        </Card>
      </div>

      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
      {account && (
        <Modal
          open={deleting}
          onClose={() => {
            setDeleting(false);
            setConfirmText('');
            setDeleteError(null);
          }}
          size="sm"
          title="Delete your account?"
          description="Your account, every Space you own and everything in them will be deleted for good. This cannot be undone."
          footer={
            <Button variant="danger" size="lg" block disabled={confirmText !== 'DELETE' || busy} onClick={() => void deleteForGood()}>
              {busy ? 'Deleting…' : 'Delete my account for good'}
            </Button>
          }
        >
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-ink-2">
              Download your data first if you want to keep a copy. Backups of Finken are kept for 35 days, then your data is gone from those too.
            </p>
            <Field label="Type DELETE to confirm" error={deleteError}>
              {(id) => <Input id={id} data-autofocus autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />}
            </Field>
          </div>
        </Modal>
      )}
      {account && (
        <Modal open={moving} onClose={() => setMoving(false)} title="Move data from this browser" description="Choose which Spaces to bring into your account.">
          {moving && <MoveData account={account} email={user.email} laterLabel="Close" doneLabel="Close" onDone={() => setMoving(false)} />}
        </Modal>
      )}
      <ConfirmDialog
        open={resetting}
        title="Restore demo data?"
        message="This replaces your guest Spaces and their transactions with the original sample data. Anything you added as a guest will be removed."
        confirmLabel={busy ? 'Restoring…' : 'Restore'}
        destructive
        onConfirm={reset}
        onCancel={() => setResetting(false)}
      />
      <ConfirmDialog
        open={leaving}
        title="Log out of Finken?"
        message={
          account
            ? unsent
              ? `${unsent} ${unsent === 1 ? 'change has' : 'changes have'} not reached your account yet, because there is no connection. Logging out now loses ${unsent === 1 ? 'it' : 'them'}. Wait until you are back online to keep ${unsent === 1 ? 'it' : 'them'}.`
              : 'Everything is in your account. Sign in again to see it.'
            : 'You will need your email and password to get back in. There is no password recovery in this prototype.'
        }
        confirmLabel={unsent ? 'Log out and lose changes' : 'Log out'}
        destructive={unsent > 0}
        onConfirm={() => void leaveFinken()}
        onCancel={() => setLeaving(false)}
      />
    </div>
  );
}
