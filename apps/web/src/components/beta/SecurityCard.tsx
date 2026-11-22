/**
 * Settings → Sign-in and security, for Finken's own sign-in: whether the
 * email is confirmed, changing the password, and signing out every other
 * device.
 */
import { KeyRound, LogOut, MailCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { account, useProfile } from '../../data/account';
import { useAppState } from '../../data/hooks';
import { DevelopmentMail, MIN_PASSWORD, PasswordInput } from '../../onboarding/AccountForms';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Field } from '../ui/Field';
import { Badge } from '../ui/Misc';
import { ConfirmDialog, Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'current' | 'password' | 'confirm' | 'form', string>>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account) return;
    if (!current) return setErrors({ current: 'Enter your current password.' });
    if (next.length < MIN_PASSWORD) return setErrors({ password: `Use at least ${MIN_PASSWORD} characters.` });
    if (confirm !== next) return setErrors({ confirm: 'The two passwords do not match.' });
    setBusy(true);
    const result = await account.changePassword(current, next);
    setBusy(false);
    if (!result.ok) return setErrors({ [result.field === 'current' || result.field === 'password' ? result.field : 'form']: result.error });
    toast('Password changed. Every other device has been signed out.');
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Change your password"
      description="Every other device you are signed in on will be signed out."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="change-password" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </>
      }
    >
      <form id="change-password" onSubmit={submit} noValidate className="space-y-4">
        <Field label="Current password" error={errors.current}>
          {(id) => <PasswordInput id={id} autoComplete="current-password" value={current} onChange={setCurrent} />}
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={errors.password}>
          {(id) => <PasswordInput id={id} autoComplete="new-password" value={next} onChange={setNext} />}
        </Field>
        <Field label="Type the new password again" error={errors.confirm}>
          {(id) => <PasswordInput id={id} autoComplete="new-password" value={confirm} onChange={setConfirm} />}
        </Field>
        {errors.form && (
          <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
            {errors.form}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function SecurityCard() {
  const profile = useProfile();
  const { user } = useAppState();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [resent, setResent] = useState(false);
  if (!account || account.provider || profile?.signIn !== 'password') return null;

  async function resend() {
    if (!account) return;
    const result = await account.resendConfirmation();
    if (!result.ok) return toast(result.error, { tone: 'error' });
    setResent(true);
    toast('We sent the link again. It works for 48 hours.');
  }

  async function signOutOthers() {
    if (!account) return;
    setSigningOut(false);
    const result = await account.signOutOthers();
    if (!result.ok) return toast(result.error, { tone: 'error' });
    toast(result.ended === 0 ? 'No other devices were signed in.' : `${result.ended} other ${result.ended === 1 ? 'device was' : 'devices were'} signed out.`);
  }

  return (
    <Card>
      <CardHeader title="Sign-in and security" subtitle="Your password is stored only as a scrambled code that cannot be turned back into it, not even by Finken." />
      <div className="divide-y divide-line">
        <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
              Email {profile.emailVerified ? <Badge tone="positive">Confirmed</Badge> : <Badge tone="warning">Not confirmed yet</Badge>}
            </h3>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {profile.emailVerified
                ? `${user?.email ?? 'Your email'} is where password reset links go.`
                : `Confirm ${user?.email ?? 'your email'} with the link we sent, so you can always reset your password.`}
            </p>
            {!profile.emailVerified && resent && user?.email && <DevelopmentMail account={account} to={user.email} />}
          </div>
          {!profile.emailVerified && (
            <Button className="shrink-0" icon={<MailCheck className="size-4" />} disabled={resent} onClick={() => void resend()}>
              {resent ? 'Link sent' : 'Send the link again'}
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-ink">Password</h3>
            <p className="mt-0.5 text-[13px] text-ink-3">Changing it signs out every other device.</p>
          </div>
          <Button className="shrink-0" icon={<KeyRound className="size-4" />} onClick={() => setChanging(true)}>
            Change password
          </Button>
        </div>
        <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-ink">Other devices</h3>
            <p className="mt-0.5 text-[13px] text-ink-3">Signed in on a phone or computer you no longer use? Sign it out from here.</p>
          </div>
          <Button className="shrink-0" icon={<LogOut className="size-4" />} onClick={() => setSigningOut(true)}>
            Sign out other devices
          </Button>
        </div>
      </div>
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
      <ConfirmDialog
        open={signingOut}
        title="Sign out every other device?"
        message="Every phone and computer signed in to your account, except this one, will need your password again."
        confirmLabel="Sign them out"
        onConfirm={() => void signOutOthers()}
        onCancel={() => setSigningOut(false)}
      />
    </Card>
  );
}
