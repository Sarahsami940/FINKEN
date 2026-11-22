/**
 * Sharing a Space: who is in it, inviting someone, and joining with a code.
 * Only with an account; the server decides who may do what, and these
 * screens show the same rules.
 */
import type { ID, Space } from '@finken/domain/types';
import { Check, Copy, UserMinus, Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { account, type SpaceInvite, type SpaceMember } from '../../data/account';
import { store } from '../../data/store';
import { Button, IconButton } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Field, Input, Select } from '../ui/Field';
import { Badge } from '../ui/Misc';
import { ConfirmDialog, Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

export const ROLE_NAME: Record<SpaceMember['role'], string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };
export const ROLE_HELP: Record<'editor' | 'viewer', string> = {
  editor: 'Adds and changes records, such as staff, a partner or an accountant.',
  viewer: 'Sees every record and report, and changes nothing.',
};

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The link someone opens to join: Finken's Spaces screen, with the code filled in. */
const joinLink = (code: string) => `${window.location.origin}/more/spaces?join=${encodeURIComponent(code)}`;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard blocked: the text is on screen to copy by hand.
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** Who is in a Space. The owner can invite, change roles and remove; anyone else can leave. */
export function SpacePeopleDialog({ space, onClose }: { space: Space; onClose: () => void }) {
  const toast = useToast();
  const [members, setMembers] = useState<SpaceMember[] | null>(null);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [created, setCreated] = useState<(SpaceInvite & { code: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SpaceMember | null>(null);
  const owner = store.roleIn(space.id) === 'owner';

  const load = useCallback(async () => {
    if (!account) return;
    const list = await account.members(space.id);
    if (!list.ok) return setError(list.error);
    setMembers(list.value);
    if (owner) {
      const open = await account.invites(space.id);
      if (open.ok) setInvites(open.value);
    }
  }, [space.id, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeInvite(e: FormEvent) {
    e.preventDefault();
    if (!account) return;
    setBusy(true);
    const made = await account.invite(space.id, role);
    setBusy(false);
    if (!made.ok) return setError(made.error);
    setError(null);
    setCreated(made.value);
    await load();
  }

  async function change(member: SpaceMember, next: 'editor' | 'viewer') {
    if (!account) return;
    const done = await account.changeRole(space.id, member.userId, next);
    if (!done.ok) return toast(done.error, { tone: 'error' });
    setMembers(done.value);
    toast(`${member.name || 'They'} ${next === 'editor' ? 'can now edit' : 'can now only view'} ${space.name}`);
  }

  async function remove() {
    if (!account || !removing) return;
    const leaving = removing.you;
    const done = await account.removeMember(space.id, removing.userId);
    setRemoving(null);
    if (!done.ok) return toast(done.error, { tone: 'error' });
    toast(leaving ? `You left ${space.name}` : `${removing.name || 'They'} no longer has ${space.name}`);
    if (leaving) onClose();
    else await load();
  }

  async function cancel(invite: SpaceInvite) {
    if (!account) return;
    const done = await account.cancelInvite(space.id, invite.id);
    if (!done.ok) return toast(done.error, { tone: 'error' });
    if (created?.id === invite.id) setCreated(null);
    toast('Invite cancelled');
    await load();
  }

  return (
    <Modal open onClose={onClose} title={`People in ${space.name}`} description="Everyone here sees the same records. Each person's role decides whether they can change them.">
      {error && (
        <p role="alert" className="mb-4 rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
          {error}
        </p>
      )}
      {!members && !error && (
        <p role="status" className="py-6 text-center text-sm text-ink-3">
          Loading…
        </p>
      )}
      {members && (
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-strong">
                {(m.name || m.email || '?').charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-ink">
                  {m.name || m.email || 'Someone'}
                  {m.you && <span className="font-medium text-ink-3"> (you)</span>}
                </p>
                <p className="truncate text-xs text-ink-3">
                  {m.email ? `${m.email} · ` : ''}since {day(m.since)}
                </p>
              </div>
              {owner && m.role !== 'owner' ? (
                <div className="flex items-center gap-1">
                  <Select
                    aria-label={`What ${m.name || 'they'} can do`}
                    value={m.role}
                    onChange={(e) => void change(m, e.target.value as 'editor' | 'viewer')}
                    className="h-9 w-32 text-sm"
                  >
                    <option value="editor">Can edit</option>
                    <option value="viewer">Can view</option>
                  </Select>
                  <IconButton label={`Remove ${m.name || 'them'}`} onClick={() => setRemoving(m)} className="hover:bg-negative-soft hover:text-negative">
                    <UserMinus className="size-4" />
                  </IconButton>
                </div>
              ) : (
                <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_NAME[m.role]}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      {owner && members && (
        <section aria-labelledby="invite-heading" className="mt-5 border-t border-line pt-5">
          <h3 id="invite-heading" className="text-sm font-bold text-ink">
            Invite someone
          </h3>
          <p className="mt-0.5 text-[13px] text-ink-3">Each invite is for one person and works for 7 days. Send it to them directly.</p>
          <form onSubmit={makeInvite} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="They will be able to" hint={ROLE_HELP[role]} className="flex-1">
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
                  <option value="editor">Add and change records</option>
                  <option value="viewer">View only</option>
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={busy} className="sm:mb-6">
              {busy ? 'Making…' : 'Make an invite'}
            </Button>
          </form>
          {created && (
            <div role="status" className="mt-2 rounded-control border border-accent/30 bg-accent-soft/40 p-3.5">
              <p className="text-[13px] text-ink-2">
                Invite for someone who {created.role === 'editor' ? 'can edit' : 'can view'}, until {day(created.expiresAt)}. This code is shown only now:
              </p>
              <p className="mt-1.5 font-mono text-lg font-bold tracking-wider text-ink">{created.code}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton text={created.code} label="Copy code" />
                <CopyButton text={joinLink(created.code)} label="Copy link" />
              </div>
            </div>
          )}
          {invites.length > 0 && (
            <div className="mt-4">
              <h4 className="text-[13px] font-semibold text-ink-2">Waiting to be used</h4>
              <ul className="mt-1 divide-y divide-line">
                {invites.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="text-ink-2">
                      {ROLE_NAME[i.role]} · until {day(i.expiresAt)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => void cancel(i)}>
                      Cancel invite
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {!owner && members && (
        <div className="mt-5 border-t border-line pt-4">
          <Button icon={<UserMinus className="size-4" />} onClick={() => setRemoving(members.find((m) => m.you) ?? null)}>
            Leave this Space
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        title={removing?.you ? `Leave ${space.name}?` : `Remove ${removing?.name || 'this person'}?`}
        message={
          removing?.you
            ? 'Its records disappear from your devices. The owner keeps everything, and can invite you again.'
            : 'They lose this Space on all their devices straight away. Records they added stay in the Space.'
        }
        confirmLabel={removing?.you ? 'Leave Space' : 'Remove'}
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </Modal>
  );
}

/** Joins someone else's Space with the code they sent. A link with ?join= fills it in. */
export function JoinSpaceCard({ initialCode = '', onJoined }: { initialCode?: string; onJoined?: (spaceId: ID) => void | Promise<void> }) {
  const toast = useToast();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!account) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!account || !code.trim()) return;
    setBusy(true);
    setError(null);
    const joined = await account.joinSpace(code);
    setBusy(false);
    if (!joined.ok) return setError(joined.error);
    setCode('');
    toast(
      joined.value.already
        ? `You are already in ${joined.value.name}`
        : `You joined ${joined.value.name}: you ${joined.value.role === 'viewer' ? 'can view it' : 'can add and change records'}`,
    );
    await onJoined?.(joined.value.spaceId);
  }

  return (
    <Card>
      <CardHeader
        title="Join a Space"
        subtitle="Someone shared their Space with you? Enter the invite code they sent."
        action={<Users aria-hidden className="size-5 text-ink-3" />}
      />
      <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field label="Invite code" error={error} className="flex-1">
          {(id) => (
            <Input
              id={id}
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              placeholder="SPC-…"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError(null);
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy || !code.trim()} className="sm:mt-[26px]">
          {busy ? 'Joining…' : 'Join'}
        </Button>
      </form>
    </Card>
  );
}
