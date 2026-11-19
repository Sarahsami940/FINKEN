import { SPACE_TYPE_META } from '@finken/domain/defaults';
import { CURRENCIES, DEFAULT_CURRENCY } from '@finken/domain/format';
import type { SpaceType } from '@finken/domain/types';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/Button';
import { cn } from '../components/ui/cn';
import { Field, Input, Select } from '../components/ui/Field';
import { iconFor } from '../components/ui/icons';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import { LoginForm, PrototypeNotice, RegisterForm } from './AuthForms';

function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-[22px] font-extrabold tracking-tight text-ink', className)}>
      finken<span className="text-accent">.</span>
    </span>
  );
}

/** The five questions Finken exists to answer (from the product vision). */
const QUESTIONS = ['Where is my money?', 'Where is it going?', "What's coming up?", 'What can I afford?', 'What should I do next?'];

function Welcome({ onStart, onTry, onLogin }: { onStart: () => void; onTry: () => void; onLogin: () => void }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-6 py-6 sm:px-10 lg:px-16 lg:py-10">
        <Wordmark />
        <div className="flex flex-1 flex-col justify-center py-12">
          <h1 className="max-w-md text-[40px] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-[56px]">Your Money, Made Simple.</h1>
          <p className="mt-5 max-w-md text-[17px] leading-relaxed text-ink-2">
            Finken keeps your income, spending and upcoming payments in one calm place — for yourself, your family or your business — and helps you see what to do next.
          </p>
          <div className="mt-8 flex max-w-md flex-col gap-3 sm:flex-row">
            <Button variant="primary" size="lg" block onClick={onStart}>
              Get Started
            </Button>
            <Button size="lg" block onClick={onTry}>
              Try Finken
            </Button>
          </div>
          <p className="mt-4 max-w-md text-sm text-ink-3">Try Finken opens a demo with sample data. No account needed — everything stays in this browser.</p>
          <p className="mt-6 text-sm text-ink-2">
            Already have an account?{' '}
            <button type="button" onClick={onLogin} className="font-bold text-accent hover:text-accent-strong">
              Log in
            </button>
          </p>
        </div>
      </div>

      <div className="hidden p-4 lg:block">
        <div className="flex h-full flex-col justify-center rounded-[2rem] bg-ink px-14 text-white">
          <p className="text-sm font-semibold text-white/60">Finken helps you answer</p>
          <ul className="mt-6 space-y-5">
            {QUESTIONS.map((question, i) => (
              <li key={question} className="flex items-baseline gap-5">
                <span className="money w-5 text-sm font-semibold text-white/40">{i + 1}</span>
                <span className="text-[28px] font-bold leading-tight tracking-tight">{question}</span>
              </li>
            ))}
          </ul>
          <p className="mt-10 max-w-sm text-[15px] leading-relaxed text-white/60">Simple on the surface. Intelligent underneath.</p>
        </div>
      </div>
    </div>
  );
}

/** Centred single-column frame shared by the sign-up, login and Space steps. */
function Frame({ onBack, backLabel = 'Back', children }: { onBack?: () => void; backLabel?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-10">
      <div className="flex h-10 items-center justify-between">
        <Wordmark />
        {onBack && (
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-3 hover:text-ink">
            {backLabel === 'Back' && <ArrowLeft aria-hidden className="size-4" />}
            {backLabel}
          </button>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">{children}</div>
    </div>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-7">
      <h1 className="text-[28px] font-extrabold leading-tight tracking-tight text-ink">{title}</h1>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-3">{subtitle}</p>
    </header>
  );
}

const SwitchLink = ({ prompt, label, onClick }: { prompt: string; label: string; onClick: () => void }) => (
  <p className="mt-5 text-center text-sm text-ink-2">
    {prompt}{' '}
    <button type="button" onClick={onClick} className="font-bold text-accent hover:text-accent-strong">
      {label}
    </button>
  </p>
);

const CHOICES: SpaceType[] = ['personal', 'business', 'family'];

function SpaceChoice({ value, onChange }: { value: SpaceType; onChange: (type: SpaceType) => void }) {
  return (
    <div role="radiogroup" aria-label="What would you like to manage?" className="space-y-2.5">
      {CHOICES.map((type) => {
        const meta = SPACE_TYPE_META[type];
        const Icon = iconFor(meta.icon);
        const active = type === value;
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(type)}
            className={cn(
              'flex w-full items-center gap-4 rounded-card border bg-surface p-4 text-left transition-colors',
              active ? 'border-accent ring-3 ring-accent/12' : 'border-line hover:border-line-strong',
            )}
          >
            <span aria-hidden className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', active ? 'bg-accent text-white' : 'bg-sunken text-ink-2')}>
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-ink">{meta.label}</span>
              <span className="block text-[13px] text-ink-3">{meta.description}</span>
            </span>
            <span
              aria-hidden
              className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border', active ? 'border-accent bg-accent text-white' : 'border-line-strong')}
            >
              {active && <Check className="size-3.5" strokeWidth={3} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Guest path: pick which demo Space to open first. */
function GuestSpaceStep({ onBack }: { onBack: () => void }) {
  const [type, setType] = useState<SpaceType>('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setBusy(true);
    const result = await store.enterGuest(type);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
    }
  }

  return (
    <Frame onBack={onBack}>
      <Heading title="What would you like to manage?" subtitle="Pick where to start. The demo includes all three, and you can switch any time." />
      <SpaceChoice value={type} onChange={setType} />
      {error && (
        <p role="alert" className="mt-4 text-sm font-semibold text-negative">
          {error}
        </p>
      )}
      <Button variant="primary" size="lg" block disabled={busy} onClick={enter} className="mt-6">
        {busy ? 'Opening…' : 'Open the demo'}
        {!busy && <ArrowRight aria-hidden className="size-4" />}
      </Button>
      <p className="mt-4 text-center text-[13px] leading-relaxed text-ink-3">You will be using Finken as a guest. Anything you add is saved only in this browser.</p>
    </Frame>
  );
}

/** Account path: a signed-in user with no Spaces yet creates their first one. */
export function FirstSpaceStep() {
  const { user } = useAppState();
  const [type, setType] = useState<SpaceType>('personal');
  const [name, setName] = useState<string | null>(null);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [error, setError] = useState<string | null>(null);
  const meta = SPACE_TYPE_META[type];
  // The name follows the chosen type until the user types their own.
  const shownName = name ?? meta.label;

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = shownName.trim();
    if (!trimmed) return setError('Give this Space a name.');
    const space = store.createSpace({ name: trimmed, type, icon: meta.icon, description: '', currency });
    if (space) store.setActiveSpace(space.id);
    else setError('Your session has ended. Please log in again.');
  }

  return (
    <Frame onBack={() => store.signOut()} backLabel="Log out">
      <Heading
        title={user?.name ? `Welcome, ${user.name.split(' ')[0]}` : 'Welcome'}
        subtitle="What would you like to manage first? This becomes your first Space — you can add more later."
      />
      <form onSubmit={submit} noValidate>
        <SpaceChoice value={type} onChange={setType} />
        <div className="mt-5 grid grid-cols-5 gap-3">
          <Field label="Space name" error={error} className="col-span-3">
            {(id) => (
              <Input
                id={id}
                value={shownName}
                maxLength={32}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          <Field label="Currency" className="col-span-2">
            {(id) => (
              <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {Object.keys(CURRENCIES).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary" size="lg" block className="mt-6">
          Start using Finken
        </Button>
      </form>
    </Frame>
  );
}

type Step = 'welcome' | 'register' | 'login' | 'guest';

/** Everything a visitor sees before they are inside Finken. */
export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);

  if (step === 'welcome') {
    return <Welcome onStart={() => setStep('register')} onTry={() => setStep('guest')} onLogin={() => setStep('login')} />;
  }
  if (step === 'guest') return <GuestSpaceStep onBack={() => setStep('welcome')} />;

  if (step === 'register') {
    return (
      <Frame onBack={() => setStep('welcome')}>
        <Heading title="Create your account" subtitle="An account keeps your Spaces separate from the demo and from anyone else using this browser." />
        <RegisterForm formId="register-form" onSubmit={(input) => store.register(input)} onBusyChange={setBusy} />
        <Button type="submit" form="register-form" variant="primary" size="lg" block disabled={busy} className="mt-6">
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
        <SwitchLink prompt="Already have an account?" label="Log in" onClick={() => setStep('login')} />
        <div className="mt-6">
          <PrototypeNotice />
        </div>
      </Frame>
    );
  }

  return (
    <Frame onBack={() => setStep('welcome')}>
      <Heading title="Welcome back" subtitle="Log in to the account you created in this browser." />
      <LoginForm formId="login-form" onSubmit={(email, password) => store.login(email, password)} onBusyChange={setBusy} />
      <Button type="submit" form="login-form" variant="primary" size="lg" block disabled={busy} className="mt-6">
        {busy ? 'Logging in…' : 'Log in'}
      </Button>
      <SwitchLink prompt="New to Finken?" label="Create an account" onClick={() => setStep('register')} />
      <div className="mt-6">
        <PrototypeNotice />
      </div>
    </Frame>
  );
}
