import { LogOut, RefreshCw, UserRoundPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { Field, Input } from '../components/ui/Field';
import { Badge, PageHeader } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import { PrototypeNotice, RegisterForm } from '../onboarding/AuthForms';
import { BackLink } from './MoneyPages';

/** Ends the session and returns to the welcome screen at the app root. */
export function leaveFinken() {
  window.history.replaceState(null, '', '/');
  store.signOut();
}

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

export function SettingsPage() {
  const { user, persistent, transactions, spaces } = useAppState();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const trimmed = name.trim();
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
        </Card>

        {user.isGuest && (
          <Card className="border-accent/30 bg-accent-soft/40">
            <CardHeader
              title="Create your Finken account"
              subtitle="Keep what you have added under your own login, separate from the demo. Everything moves across with you."
            />
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
              <dd className="text-right font-semibold text-ink">{persistent ? 'On this device, in this browser' : 'In memory only (not saved)'}</dd>
            </div>
            <div className="flex justify-between gap-6 py-3">
              <dt className="text-ink-3">Records</dt>
              <dd className="text-right font-semibold text-ink">
                {recordCount} {recordCount === 1 ? 'transaction' : 'transactions'} in {spaces.length} {spaces.length === 1 ? 'Space' : 'Spaces'}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            Nothing is sent to a server, {user.isGuest ? 'with or without an account' : 'even with an account'}. Clearing this browser's site data
            removes your Finken records.
          </p>
        </Card>

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
                : 'Your data stays in this browser. Log in again with your email and password to see it.'
            }
          />
          <Button icon={<LogOut className="size-4" />} onClick={() => (user.isGuest ? leaveFinken() : setLeaving(true))}>
            {user.isGuest ? 'Leave the demo' : 'Log out'}
          </Button>
        </Card>
      </div>

      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
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
        message="You will need your email and password to get back in. There is no password recovery in this prototype."
        confirmLabel="Log out"
        onConfirm={leaveFinken}
        onCancel={() => setLeaving(false)}
      />
    </div>
  );
}
