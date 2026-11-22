/**
 * Finken's own sign-in screens, with an account on Finken's server:
 * creating an account, logging in, a forgotten password, and the pages the
 * emailed links open. Passwords go straight to Finken's server over the
 * connection and are never kept on the device.
 */
import { deviceTimeZone } from '@finken/domain/dates';
import { ArrowLeft, Eye, EyeOff, MailCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import type { Account, FormResult } from '../data/account';
import { store } from '../data/store';

export const MIN_PASSWORD = 10;
const isDevelopment = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/** The token from an emailed link. It is after # so it never reaches a server log; it is removed from the address at once. */
export function tokenFromLink(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  window.history.replaceState(null, '', window.location.pathname);
  return token;
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
      {children}
    </p>
  );
}

/** A password field with a button to show what was typed. */
function PasswordInput({ id, value, onChange, autoComplete }: { id: string; value: string; onChange: (v: string) => void; autoComplete: 'new-password' | 'current-password' }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={shown ? 'text' : 'password'} autoComplete={autoComplete} value={value} maxLength={128} onChange={(e) => onChange(e.target.value)} className="pr-12" />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-ink-3 hover:text-ink"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
      </button>
    </div>
  );
}

/** After signing up or in: the store opens the account, and syncing starts. */
async function enter(account: Account): Promise<FormResult> {
  const opened = await store.signInWithProvider();
  if (!opened.ok) return opened;
  account.start();
  return { ok: true };
}

type Errors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'form', string>>;

function placeError(result: Extract<FormResult, { ok: false }>): Errors {
  const field = result.field === 'email' || result.field === 'password' || result.field === 'name' ? result.field : 'form';
  return { [field]: result.error };
}

export function AccountRegisterForm({ account, onLogin }: { account: Account; onLogin: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.email = 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (confirm !== password) found.confirm = 'The two passwords do not match.';
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    const result = await account.register({ name: name.trim(), email: email.trim(), password, timeZone: deviceTimeZone() });
    const opened = result.ok ? await enter(account) : result;
    setBusy(false);
    if (!opened.ok) setErrors(placeError(opened));
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Your name" error={errors.name}>
        {(id) => <Input id={id} autoComplete="name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Email" error={errors.email}>
        {(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
      </Field>
      <Field label="Password" hint={`At least ${MIN_PASSWORD} characters. A few unrelated words together are strong and easy to remember.`} error={errors.password}>
        {(id) => <PasswordInput id={id} autoComplete="new-password" value={password} onChange={setPassword} />}
      </Field>
      <Field label="Type the password again" error={errors.confirm}>
        {(id) => <PasswordInput id={id} autoComplete="new-password" value={confirm} onChange={setConfirm} />}
      </Field>
      {errors.form && <Alert>{errors.form}</Alert>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>
        {busy ? 'Creating your account…' : 'Create account'}
      </Button>
      <p className="text-center text-sm text-ink-2">
        Already have an account?{' '}
        <button type="button" onClick={onLogin} className="font-bold text-accent hover:text-accent-strong">
          Log in
        </button>
      </p>
    </form>
  );
}

export function AccountLoginForm({ account, onRegister, onForgot }: { account: Account; onRegister: () => void; onForgot: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    setError(null);
    const result = await account.logIn(email.trim(), password);
    const opened = result.ok ? await enter(account) : result;
    setBusy(false);
    if (!opened.ok) {
      setError(opened.error);
      setPassword('');
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password">{(id) => <PasswordInput id={id} autoComplete="current-password" value={password} onChange={setPassword} />}</Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>
        {busy ? 'Logging in…' : 'Log in'}
      </Button>
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <button type="button" onClick={() => onForgot(email)} className="font-bold text-accent hover:text-accent-strong">
          Forgot your password?
        </button>
        <button type="button" onClick={onRegister} className="font-bold text-accent hover:text-accent-strong">
          Create an account
        </button>
      </div>
    </form>
  );
}

/** Development servers only: opens the email Finken would have sent, since no mail server is set up there. */
function DevelopmentMail({ account, to }: { account: Account; to: string }) {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (!isDevelopment) return;
    void account.developmentMail(to).then((emails) => setLink(emails[0]?.link ?? null));
  }, [account, to]);
  if (!link) return null;
  return (
    <p className="mt-5 rounded-control border border-dashed border-line-strong px-3.5 py-3 text-[13px] text-ink-2">
      Development: no emails are sent here.{' '}
      <a href={link.replace(/^https?:\/\/[^/]+/, '')} className="font-bold text-accent hover:text-accent-strong">
        Open the email’s link
      </a>
    </p>
  );
}

export function ForgotPasswordForm({ account, initialEmail, onBack }: { account: Account; initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    const result = await account.forgotPassword(email.trim());
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setSentTo(email.trim());
  }

  if (sentTo) {
    return (
      <div role="status">
        <MailCheck aria-hidden className="mb-4 size-8 text-accent" />
        <p className="text-[15px] leading-relaxed text-ink-2">
          If <strong className="text-ink">{sentTo}</strong> has a Finken account, an email with a link to set a new password is on its way. The link works once, for 30 minutes.
        </p>
        <DevelopmentMail account={account} to={sentTo} />
        <Button size="lg" block className="mt-6" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
          Back to log in
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>
        {busy ? 'Sending…' : 'Email me a link'}
      </Button>
    </form>
  );
}

/** The page the "set a new password" email opens. */
export function ResetPasswordForm({ account, onDone }: { account: Account; onDone: () => void }) {
  const token = useRef<string | null>(null);
  token.current ??= tokenFromLink();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setErrors({ password: `Use at least ${MIN_PASSWORD} characters.` });
    if (confirm !== password) return setErrors({ confirm: 'The two passwords do not match.' });
    setBusy(true);
    const result = await account.resetPassword(token.current ?? '', password);
    // Signed in now: Finken remembers who, then opens fresh as this account.
    const opened = result.ok ? await store.signInWithProvider() : result;
    setBusy(false);
    if (!opened.ok) return setErrors(placeError(opened));
    onDone();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="New password" hint={`At least ${MIN_PASSWORD} characters. You will be signed out of every other device.`} error={errors.password}>
        {(id) => <PasswordInput id={id} autoComplete="new-password" value={password} onChange={setPassword} />}
      </Field>
      <Field label="Type it again" error={errors.confirm}>
        {(id) => <PasswordInput id={id} autoComplete="new-password" value={confirm} onChange={setConfirm} />}
      </Field>
      {errors.form && <Alert>{errors.form}</Alert>}
      <Button type="submit" variant="primary" size="lg" block disabled={busy}>
        {busy ? 'Saving…' : 'Set new password'}
      </Button>
    </form>
  );
}

/** The page the "confirm your email" link opens. */
export function useEmailConfirmation(account: Account) {
  const [state, setState] = useState<{ done: boolean; error: string | null }>({ done: false, error: null });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void account.confirmEmail(tokenFromLink()).then((r) => setState({ done: true, error: r.ok ? null : r.error }));
  }, [account]);
  return state;
}

export { Alert, DevelopmentMail, PasswordInput };
