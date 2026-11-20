import { formatMoney } from '@finken/domain/format';
import type { ID } from '@finken/domain/types';
import { Check, CircleAlert, Download, Lock, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Button } from '../components/ui/Button';
import { cn } from '../components/ui/cn';
import { Field, Input } from '../components/ui/Field';
import { Badge } from '../components/ui/Misc';
import { ConfirmDialog } from '../components/ui/Modal';
import type { Account } from '../data/account';
import type { LocalSpace, MoveResult } from '../data/migration';

/** Spaces saved in this browser before accounts, reloaded whenever asked. */
export function useLocalSpaces(account: Account | null) {
  const [spaces, setSpaces] = useState<LocalSpace[] | null>(account ? null : []);
  const reload = useCallback(async () => {
    if (!account) return;
    try {
      setSpaces(await account.mover.list());
    } catch {
      setSpaces([]);
    }
  }, [account]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { spaces, reload };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

function summary(s: LocalSpace): string {
  const parts = [plural(s.counts.transactions ?? 0, 'transaction')];
  if (s.counts.obligations) parts.push(plural(s.counts.obligations, 'loan or debt', 'loans and debts'));
  if (s.counts.goals) parts.push(plural(s.counts.goals, 'goal'));
  return parts.join(' · ');
}

function whose(s: LocalSpace): string {
  if (s.owner.isGuest) return s.sample ? 'Tried as a guest, starting from sample data' : 'Made as a guest';
  return `Made with the account ${s.owner.email ?? s.owner.name} on this device`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Asks for the password of an account made on this device, so its Spaces can be moved. */
function Unlock({ account, email, onUnlocked }: { account: Account; email: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await account.mover.unlock(email, password);
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
      <Field label={`Password for ${email}`} error={error} className="flex-1">
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
      <Button type="submit" disabled={!password || busy} className="sm:mt-6">
        {busy ? 'Checking…' : 'Unlock'}
      </Button>
    </form>
  );
}

function ResultLine({ result }: { result: MoveResult }) {
  const ok = result.status !== 'failed';
  return (
    <li className="flex gap-3 py-3 first:pt-0">
      {ok ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-positive" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-negative" />}
      <div className="min-w-0 text-sm">
        <p className="font-bold text-ink">{result.name || 'A Space'}</p>
        {result.status === 'moved' && (
          <p className="text-ink-2">
            Moved {plural(result.counts?.transactions ?? 0, 'transaction')} and checked: the balance is {formatMoney(result.balance ?? 0, result.currency)} in your account, the
            same as on this device.
            {result.keptNewer ? ` ${plural(result.keptNewer, 'record was', 'records were')} already changed in your account since, and those newer changes were kept.` : ''}
          </p>
        )}
        {result.status === 'already' && <p className="text-ink-2">Already in your account.</p>}
        {result.status === 'failed' && <p className="text-negative">{result.message}</p>}
      </div>
    </li>
  );
}

interface MoveDataProps {
  account: Account;
  email?: string;
  /** Called when the person is finished here: after moving, or choosing not to now. */
  onDone: (choice: 'moved' | 'later') => void;
  laterLabel?: string;
  /** The finishing button once there is nothing left to choose. */
  doneLabel?: string;
}

/** Lets the person bring Spaces saved in this browser into their account. */
export function MoveData({ account, email, onDone, laterLabel = 'Not now', doneLabel = 'Continue to Finken' }: MoveDataProps) {
  const { spaces, reload } = useLocalSpaces(account);
  const [chosen, setChosen] = useState<Set<ID> | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<MoveResult[] | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const waiting = (spaces ?? []).filter((s) => !s.moved);
  const moved = (spaces ?? []).filter((s) => s.moved);
  // Your own Spaces are chosen to start with; sample data only if you want it.
  const selected = chosen ?? new Set(waiting.filter((s) => !s.sample && !s.owner.locked).map((s) => s.space.id));
  const movable = waiting.filter((s) => selected.has(s.space.id) && !s.owner.locked);

  function toggle(id: ID) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  }

  async function backup() {
    const ids = (movable.length ? movable : waiting).map((s) => s.space.id);
    download(`finken-backup-${new Date().toISOString().slice(0, 10)}.json`, await account.mover.backup(ids));
    setNotice('Backup saved to your downloads. Keep it until you are happy everything moved.');
  }

  async function move() {
    setResults(null);
    setNotice(null);
    const out = await account.mover.move(
      movable.map((s) => s.space.id),
      (done, total) => setProgress(done < total ? `Moving ${done + 1} of ${total}…` : 'Checking…'),
    );
    // Bring the moved Spaces onto this screen's copy straight away.
    await account.storage.sync().catch(() => {});
    setProgress(null);
    setResults(out);
    setChosen(new Set());
    await reload();
  }

  async function forget() {
    const n = await account.mover.forget(moved.map((s) => s.space.id));
    setForgetting(false);
    setNotice(`${plural(n, 'Space')} removed from this browser. ${n === 1 ? 'It is' : 'They are'} still in your account.`);
    await reload();
  }

  if (!spaces) return <p className="text-sm text-ink-3">Looking for data saved in this browser…</p>;

  const busy = progress !== null;
  return (
    <div>
      {waiting.length === 0 && !results && <p className="rounded-control bg-sunken px-3.5 py-3 text-sm text-ink-2">There is nothing left in this browser to move.</p>}

      {waiting.length > 0 && (
        <fieldset disabled={busy}>
          <legend className="sr-only">Spaces saved in this browser</legend>
          <ul className="space-y-3">
            {waiting.map((s) => (
              <li key={s.space.id} className={cn('rounded-card border border-line bg-surface p-4', selected.has(s.space.id) && !s.owner.locked && 'border-accent/50')}>
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-[var(--color-accent)]"
                    checked={selected.has(s.space.id) && !s.owner.locked}
                    disabled={s.owner.locked}
                    onChange={() => toggle(s.space.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-ink">{s.space.name}</span>
                      {s.sample && <Badge>Sample data</Badge>}
                      {s.owner.locked && (
                        <Badge tone="warning">
                          <Lock aria-hidden className="mr-1 inline size-3" />
                          Needs password
                        </Badge>
                      )}
                    </span>
                    <span className="mt-0.5 block text-sm text-ink-2">{summary(s)}</span>
                    <span className="block text-[13px] text-ink-3">{whose(s)}</span>
                  </span>
                </label>
                {s.owner.locked && s.owner.email && <Unlock account={account} email={s.owner.email} onUnlocked={() => void reload()} />}
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {notice && (
        <p role="status" className="mt-4 rounded-control bg-positive-soft px-3.5 py-2.5 text-sm font-semibold text-positive">
          {notice}
        </p>
      )}

      {results && results.length > 0 && (
        <div className="mt-5 rounded-card border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-bold text-ink">What happened</h2>
          <ul className="divide-y divide-line">
            {results.map((r) => (
              <ResultLine key={r.spaceId} result={r} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3">
        {waiting.length > 0 && (
          <Button variant="primary" size="lg" block disabled={busy || movable.length === 0} onClick={() => void move()}>
            {progress ?? (movable.length ? `Move ${plural(movable.length, 'Space')} into ${email ? email : 'your account'}` : 'Choose a Space to move')}
          </Button>
        )}
        {waiting.length > 0 && (
          <Button block icon={<Download className="size-4" />} disabled={busy} onClick={() => void backup()}>
            Save a backup file first
          </Button>
        )}
        {moved.length > 0 && (
          <Button block icon={<Trash2 className="size-4" />} disabled={busy} onClick={() => setForgetting(true)}>
            Remove moved Spaces from this browser
          </Button>
        )}
        <Button
          block
          variant={waiting.length === 0 || results?.some((r) => r.status === 'moved') ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() => onDone(results?.some((r) => r.status !== 'failed') ? 'moved' : 'later')}
        >
          {waiting.length === 0 || results?.some((r) => r.status === 'moved') ? doneLabel : laterLabel}
        </Button>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-ink-3">
        Each Space moves whole or not at all, and is checked figure by figure once it arrives. Nothing is removed from this browser unless you ask.
      </p>

      <ConfirmDialog
        open={forgetting}
        title="Remove moved Spaces from this browser?"
        message={`${plural(moved.length, 'Space')} that ${moved.length === 1 ? 'is' : 'are'} safely in your account will be removed from this browser for good. ${moved.length === 1 ? 'It stays' : 'They stay'} in your account.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void forget()}
        onCancel={() => setForgetting(false)}
      />
    </div>
  );
}
