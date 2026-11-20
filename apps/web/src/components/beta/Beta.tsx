/**
 * The beta inside Finken: sending feedback from any screen, and the one-time
 * question about sharing usage. Both only exist with an account.
 */
import { screenName } from '@finken/domain/usage';
import { BarChart3, MessageSquareText } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { account, type FeedbackKind, useProfile } from '../../data/account';
import { forgetUsage, RELEASE, track } from '../../data/usage';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../ui/cn';
import { Field, Textarea } from '../ui/Field';
import { Segmented } from '../ui/Misc';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

const KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'problem', label: 'Something is wrong' },
  { value: 'idea', label: 'An idea' },
  { value: 'praise', label: 'Something I like' },
];

const SCREEN_LABEL: Record<string, string> = { other: 'this screen', home: 'Home', more: 'More', settings: 'Settings', import: 'Import' };
const labelFor = (screen: string) => SCREEN_LABEL[screen] ?? screen.charAt(0).toUpperCase() + screen.slice(1);

const MAX = 2000;

/** Feedback in the person's own words. The screen it is about is sent with it, and shown so nothing is hidden. */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pathname } = useLocation();
  const toast = useToast();
  const [kind, setKind] = useState<FeedbackKind>('problem');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const screen = screenName(pathname);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account) return;
    if (!message.trim()) return setError('Write a few words first.');
    setBusy(true);
    setError(null);
    const sent = await account.sendFeedback({ kind, message: message.trim(), screen, release: RELEASE });
    setBusy(false);
    if (!sent.ok) return setError(sent.error);
    track('feedback:sent');
    setMessage('');
    setKind('problem');
    onClose();
    toast('Thank you. Your feedback was sent to the Finken team.');
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send feedback"
      description="Tell the Finken team what went wrong, what you would like, or what works well. A person reads every message."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form="feedback-form" variant="primary" disabled={busy || !message.trim()}>
            {busy ? 'Sending…' : 'Send feedback'}
          </Button>
        </>
      }
    >
      <form id="feedback-form" onSubmit={submit} noValidate className="space-y-4">
        <div>
          <p aria-hidden className="mb-1.5 text-[13px] font-semibold text-ink-2">
            What is it about?
          </p>
          <Segmented label="What is it about?" value={kind} onChange={setKind} options={KINDS} className="w-full flex-wrap" />
        </div>
        <Field
          label="Your message"
          hint={`${message.length.toLocaleString('en-GB')} of ${MAX.toLocaleString('en-GB')} characters. Sent with it: the screen (${labelFor(screen)}) and the app version (${RELEASE}). Please leave out card or account numbers.`}
          error={error}
        >
          {(id) => (
            <Textarea
              id={id}
              data-autofocus
              rows={5}
              maxLength={MAX}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (error) setError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** A button that opens the feedback dialog. Hidden without an account, where there is nowhere to send it. */
export function FeedbackButton({ className, variant = 'secondary' }: { className?: string; variant?: 'secondary' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  if (!account) return null;
  return (
    <>
      <Button variant={variant} icon={<MessageSquareText className="size-4" />} className={className} onClick={() => setOpen(true)}>
        Send feedback
      </Button>
      <FeedbackDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Saves the answer to the usage question, and says so. */
export function useUsageChoice() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function choose(yes: boolean) {
    if (!account) return;
    setBusy(true);
    try {
      await account.setUsage(yes);
      if (!yes) forgetUsage();
      else track('screen:home');
      toast(yes ? 'Thank you. Finken will count which screens and features you use.' : 'Finken will not count how you use it.');
    } catch (err) {
      toast((err as Error).message || 'Your choice could not be saved. Try again.', { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return { busy, choose };
}

export const USAGE_EXPLAINED =
  'Finken counts which screens you open and which features you use, such as adding an expense or importing a file, to see what to improve during the beta. It never sends amounts, names, descriptions or anything you type. Counts are kept for 180 days.';

/** Asked once, on Home: may Finken count how it is used? Nothing is counted until the person says yes. */
export function UsageQuestion({ className }: { className?: string }) {
  const profile = useProfile();
  const { busy, choose } = useUsageChoice();
  if (!account || !profile || profile.access !== 'member' || profile.usage !== null) return null;
  return (
    <Card className={cn('border-accent/30 bg-accent-soft/40', className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-accent-strong">
          <BarChart3 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-ink">Help improve Finken during the beta?</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{USAGE_EXPLAINED} You can change this any time in Settings.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void choose(true)}>
              Share usage
            </Button>
            <Button disabled={busy} onClick={() => void choose(false)}>
              No thanks
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
