import { Info } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Field, Input } from '../components/ui/Field';
import { MIN_PASSWORD_LENGTH, type RegistrationErrors, type RegistrationInput, validateRegistration } from '../data/auth';
import type { AuthResult } from '../data/store';

/** Shown wherever a password is asked for, so nobody mistakes this for real security. */
export function PrototypeNotice() {
  return (
    <p className="flex gap-2.5 rounded-control bg-sunken px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span>This is a prototype. Your account is kept only in this browser and is not securely protected, so please do not reuse a password from another service.</span>
    </p>
  );
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
      {message}
    </p>
  );
}

interface RegisterFormProps {
  formId: string;
  initialName?: string;
  onSubmit: (input: RegistrationInput) => Promise<AuthResult>;
  onBusyChange?: (busy: boolean) => void;
}

/** Name, email, password and confirmation. The submit button lives with the caller (via `formId`). */
export function RegisterForm({ formId, initialName = '', onSubmit, onBusyChange }: RegisterFormProps) {
  const [input, setInput] = useState<RegistrationInput>({ name: initialName, email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const change = (key: keyof RegistrationInput) => (e: { target: { value: string } }) => {
    setInput((prev) => ({ ...prev, [key]: e.target.value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    setFormError(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateRegistration(input);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    onBusyChange?.(true);
    const result = await onSubmit(input);
    onBusyChange?.(false);
    if (result.ok) return;
    if (result.field) setErrors({ [result.field]: result.error });
    else setFormError(result.error);
  }

  return (
    <form id={formId} onSubmit={submit} noValidate className="space-y-4">
      <Field label="Name" error={errors.name}>
        {(id) => <Input id={id} data-autofocus autoComplete="name" value={input.name} maxLength={40} onChange={change('name')} />}
      </Field>
      <Field label="Email" error={errors.email}>
        {(id) => <Input id={id} type="email" autoComplete="email" value={input.email} maxLength={120} onChange={change('email')} />}
      </Field>
      <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={errors.password}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={input.password} onChange={change('password')} />}
      </Field>
      <Field label="Confirm password" error={errors.confirmPassword}>
        {(id) => <Input id={id} type="password" autoComplete="new-password" value={input.confirmPassword} onChange={change('confirmPassword')} />}
      </Field>
      <FormError message={formError} />
    </form>
  );
}

interface LoginFormProps {
  formId: string;
  onSubmit: (email: string, password: string) => Promise<AuthResult>;
  onBusyChange?: (busy: boolean) => void;
}

export function LoginForm({ formId, onSubmit, onBusyChange }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Enter your email and password.');
    onBusyChange?.(true);
    const result = await onSubmit(email, password);
    onBusyChange?.(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <form id={formId} onSubmit={submit} noValidate className="space-y-4">
      <Field label="Email">
        {(id) => (
          <Input
            id={id}
            data-autofocus
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      <Field label="Password">
        {(id) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
        )}
      </Field>
      <FormError message={error} />
    </form>
  );
}
