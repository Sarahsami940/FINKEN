import { parseISODate } from '@finken/domain/dates';
import { SPACE_TYPE_META } from '@finken/domain/defaults';
import { CURRENCIES, DEFAULT_CURRENCY } from '@finken/domain/format';
import type { Space, SpaceType } from '@finken/domain/types';
import { Archive, ArchiveRestore, Check, ChevronRight, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MORE_SECTIONS } from '../app/nav';
import { SpaceGlyph } from '../app/SpaceSwitcher';
import { FeedbackButton } from '../components/beta/Beta';
import { JoinSpaceCard, ROLE_NAME, SpacePeopleDialog } from '../components/sharing/SpacePeople';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Input, Select } from '../components/ui/Field';
import { iconFor, SPACE_ICON_KEYS } from '../components/ui/icons';
import { Badge, PageHeader } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { account } from '../data/account';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import { BackLink } from './MoneyPages';

export function MorePage() {
  return (
    <div>
      <PageHeader title="More" subtitle="Spaces, categories and your settings" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MORE_SECTIONS.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className="group flex items-start gap-3.5 rounded-card border border-line bg-surface p-4 shadow-card transition-colors hover:border-line-strong"
          >
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
              <section.icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-ink">{section.label}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{section.summary}</span>
            </span>
            <ChevronRight aria-hidden className="mt-2.5 size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
      {account && (
        <div className="mt-6 flex flex-col items-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-bold text-ink">Finken is in beta</h2>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-3">Something wrong, missing or good? Tell the team; a person reads every message.</p>
          </div>
          <FeedbackButton />
        </div>
      )}
    </div>
  );
}

// ── Spaces ─────────────────────────────────────────────────────────────────

const SPACE_TYPES = Object.keys(SPACE_TYPE_META) as SpaceType[];

function SpaceEditor({ space, onClose }: { space: Space | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(space?.name ?? '');
  const [type, setType] = useState<SpaceType>(space?.type ?? 'personal');
  const [icon, setIcon] = useState(space?.icon ?? SPACE_TYPE_META.personal.icon);
  const [description, setDescription] = useState(space?.description ?? '');
  const [currency, setCurrency] = useState(space?.currency ?? DEFAULT_CURRENCY);
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Give this Space a name.');
    const draft = { name: trimmed, type, icon, description: description.trim(), currency };
    if (space) {
      store.updateSpace(space.id, draft);
      toast('Space updated');
    } else {
      const created = store.createSpace(draft);
      if (!created) return setError('Your session has ended. Please log in again.');
      store.setActiveSpace(created.id);
      toast(`${created.name} is ready`);
    }
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={space ? 'Edit Space' : 'New Space'}
      description={space ? undefined : 'A Space keeps one part of your money separate, with its own categories and accounts.'}
      footer={
        <Button type="submit" form="space-form" variant="primary" size="lg" block>
          {space ? 'Save changes' : 'Create Space'}
        </Button>
      }
    >
      <form id="space-form" onSubmit={submit} noValidate className="space-y-5">
        <Field label="Name" error={error}>
          {(id) => (
            <Input
              id={id}
              data-autofocus
              value={name}
              maxLength={32}
              placeholder="e.g. Side Business"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" hint={space ? 'Fixed after a Space is created.' : 'Sets the starting categories.'}>
            {(id) => (
              <Select
                id={id}
                value={type}
                disabled={Boolean(space)}
                onChange={(e) => {
                  const next = e.target.value as SpaceType;
                  setType(next);
                  setIcon(SPACE_TYPE_META[next].icon);
                }}
              >
                {SPACE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SPACE_TYPE_META[t].label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Currency">
            {(id) => (
              <Select id={id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {Object.entries(CURRENCIES).map(([code, meta]) => (
                  <option key={code} value={code}>
                    {code} — {meta.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold text-ink-2">Icon</legend>
          <div className="flex flex-wrap gap-2">
            {SPACE_ICON_KEYS.map((key) => {
              const Icon = iconFor(key);
              const active = key === icon;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={key.replace('-', ' ')}
                  aria-pressed={active}
                  onClick={() => setIcon(key)}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-xl border transition-colors',
                    active ? 'border-accent bg-accent text-white' : 'border-line text-ink-2 hover:border-line-strong',
                  )}
                >
                  <Icon aria-hidden className="size-5" />
                </button>
              );
            })}
          </div>
        </fieldset>

        <Field label="Description">{(id) => <Input id={id} value={description} maxLength={80} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} />}</Field>
      </form>
    </Modal>
  );
}

export function SpacesPage() {
  const { spaces, activeSpaceId, transactions, roles } = useAppState();
  const toast = useToast();
  const [editor, setEditor] = useState<{ space: Space | null } | null>(null);
  const [deleting, setDeleting] = useState<Space | null>(null);
  const [people, setPeople] = useState<Space | null>(null);
  const [params, setParams] = useSearchParams();
  // An invite link opens this screen with the code filled in.
  const joinCode = params.get('join') ?? '';
  const activeCount = spaces.filter((s) => s.status === 'active').length;

  function archive(space: Space, archived: boolean) {
    if (store.setSpaceArchived(space.id, archived)) toast(archived ? `${space.name} archived` : `${space.name} restored`);
    else toast('Keep at least one active Space', { tone: 'error' });
  }

  function remove() {
    if (!deleting) return;
    const ok = store.deleteSpace(deleting.id);
    toast(ok ? `${deleting.name} deleted` : 'Keep at least one active Space', ok ? undefined : { tone: 'error' });
    setDeleting(null);
  }

  return (
    <div>
      <BackLink to="/more">More</BackLink>
      <PageHeader
        title="Spaces"
        subtitle="Each Space has its own transactions, categories and accounts"
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ space: null })}>
            New Space
          </Button>
        }
      />

      {account && (
        <div className="mb-4">
          <JoinSpaceCard
            key={joinCode}
            initialCode={joinCode}
            onJoined={async (spaceId) => {
              if (joinCode) setParams({}, { replace: true });
              // Its records have just arrived: show the Space straight away.
              await store.refresh();
              store.setActiveSpace(spaceId);
            }}
          />
        </div>
      )}

      <ul className="grid gap-3 md:grid-cols-2">
        {spaces.map((space) => {
          const current = space.id === activeSpaceId;
          const archived = space.status === 'archived';
          const count = transactions.filter((t) => t.spaceId === space.id).length;
          const lastActive = !archived && activeCount === 1;
          const role = roles[space.id] ?? 'owner';
          const owner = role === 'owner';
          return (
            <li key={space.id}>
              <Card className={cn('flex h-full flex-col !p-5', current && 'border-accent ring-3 ring-accent/10', archived && 'opacity-75')}>
                <div className="flex items-start gap-3.5">
                  <SpaceGlyph space={space} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-bold text-ink">{space.name}</h2>
                      {current && <Badge tone="accent">Current</Badge>}
                      {archived && <Badge>Archived</Badge>}
                      {!owner && <Badge tone={role === 'viewer' ? 'warning' : 'neutral'}>Shared with you · {ROLE_NAME[role]}</Badge>}
                    </div>
                    <p className="mt-0.5 text-[13px] text-ink-3">
                      {SPACE_TYPE_META[space.type].label} · {space.currency} · {count} {count === 1 ? 'transaction' : 'transactions'}
                    </p>
                  </div>
                </div>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-ink-2">{space.description || SPACE_TYPE_META[space.type].description}</p>
                <p className="mt-2 text-xs text-ink-3">
                  Created {parseISODate(space.createdAt.slice(0, 10)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
                <div className="mt-4 flex items-center gap-1 border-t border-line pt-3">
                  {archived ? (
                    <Button size="sm" icon={<ArchiveRestore className="size-4" />} onClick={() => archive(space, false)}>
                      Restore
                    </Button>
                  ) : current ? (
                    <span className="inline-flex h-9 items-center gap-1.5 px-1 text-sm font-semibold text-accent">
                      <Check aria-hidden className="size-4" /> In use
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => {
                        store.setActiveSpace(space.id);
                        toast(`Switched to ${space.name}`);
                      }}
                    >
                      Switch to this
                    </Button>
                  )}
                  <span className="flex-1" />
                  {account && (
                    <IconButton label={owner ? `Share ${space.name}` : `People in ${space.name}`} onClick={() => setPeople(space)}>
                      <Users className="size-4" />
                    </IconButton>
                  )}
                  {role !== 'viewer' && (
                    <IconButton label={`Edit ${space.name}`} onClick={() => setEditor({ space })}>
                      <Pencil className="size-4" />
                    </IconButton>
                  )}
                  {owner && !archived && (
                    <IconButton
                      label={lastActive ? 'Your only active Space cannot be archived' : `Archive ${space.name}`}
                      disabled={lastActive}
                      onClick={() => archive(space, true)}
                    >
                      <Archive className="size-4" />
                    </IconButton>
                  )}
                  {owner && (
                    <IconButton
                      label={lastActive ? 'Your only active Space cannot be deleted' : `Delete ${space.name}`}
                      disabled={lastActive}
                      onClick={() => setDeleting(space)}
                      className="hover:bg-negative-soft hover:text-negative"
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {editor && <SpaceEditor key={editor.space?.id ?? 'new'} space={editor.space} onClose={() => setEditor(null)} />}
      {people && <SpacePeopleDialog space={people} onClose={() => setPeople(null)} />}
      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Delete ${deleting?.name ?? 'Space'}?`}
        message="This permanently removes the Space with all of its transactions, categories, accounts and upcoming payments. It cannot be undone. Archive it instead if you might need it later."
        confirmLabel="Delete Space"
        destructive
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
