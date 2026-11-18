import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CategoryIcon } from '../components/money/parts';
import { Button, IconButton } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Field, Input } from '../components/ui/Field';
import { CATEGORY_ICON_KEYS, iconFor } from '../components/ui/icons';
import { EmptyState, PageHeader, Segmented } from '../components/ui/Misc';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAppState, useSpaceData } from '../data/hooks';
import { store } from '../data/store';
import { colorOf, PALETTE_KEYS } from '../domain/palette';
import type { Category, CategoryKind, ID, CostType } from '../domain/types';
import { BackLink } from './MoneyPages';

const KIND_OPTIONS: { value: CategoryKind; label: string }[] = [
  { value: 'expense', label: 'Spending' },
  { value: 'income', label: 'Income' },
];

interface SubDraft {
  /** Stable key for React; `id` is set only for subcategories that already exist. */
  key: string;
  id?: ID;
  name: string;
}

let subKey = 0;

interface EditorProps {
  spaceId: ID;
  category: Category | null;
  kind: CategoryKind;
  /** How many transactions use this category today. */
  used: number;
  onClose: () => void;
}

function CategoryEditor({ spaceId, category, kind: initialKind, used, onClose }: EditorProps) {
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? initialKind);
  const [icon, setIcon] = useState(category?.icon ?? 'circle');
  const [color, setColor] = useState(category?.color ?? 'cobalt');
  const isBusiness = useAppState().spaces.find((sp) => sp.id === spaceId)?.type === 'business';
  const [costType, setCostType] = useState<CostType>(category?.costType ?? 'operating');
  const [subs, setSubs] = useState<SubDraft[]>(() => (category?.subcategories ?? []).map((s) => ({ key: s.id, id: s.id, name: s.name })));
  const [newSub, setNewSub] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function addSub() {
    const value = newSub.trim();
    if (!value) return;
    if (subs.some((s) => s.name.trim().toLowerCase() === value.toLowerCase())) return setError('That subcategory is already in the list.');
    setSubs([...subs, { key: `new-${subKey++}`, name: value }]);
    setNewSub('');
    setError(null);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // Anything still typed in the "add" box is included rather than silently dropped.
    const pending = newSub.trim();
    const all = pending && !subs.some((s) => s.name.trim().toLowerCase() === pending.toLowerCase()) ? [...subs, { key: 'pending', name: pending }] : subs;
    const draft = {
      name,
      kind,
      icon,
      color,
      ...(isBusiness && kind === 'expense' ? { costType } : {}),
      subcategories: all.map(({ id, name: subName }) => ({ id, name: subName })),
    };
    const result = category ? store.updateCategory(category.id, draft) : store.addCategory(spaceId, draft);
    if (!result.ok) return setError(result.error);
    toast(category ? 'Category updated' : `${name.trim()} added`);
    onClose();
  }

  function remove() {
    if (!category) return;
    const result = store.deleteCategory(category.id);
    setDeleting(false);
    if (!result.ok) return setError(result.error);
    toast(`${category.name} deleted`);
    onClose();
  }

  return (
    <>
      <Modal
        open={!deleting}
        onClose={onClose}
        title={category ? 'Edit category' : 'New category'}
        footer={
          <div className="flex gap-2">
            <Button type="submit" form="category-form" variant="primary" size="lg" block>
              {category ? 'Save changes' : 'Add category'}
            </Button>
            {category && (
              <Button size="lg" aria-label="Delete category" title="Delete" className="px-3.5 text-negative" onClick={() => setDeleting(true)}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        }
      >
        <form id="category-form" onSubmit={submit} noValidate className="space-y-5">
          <div className="flex items-end gap-3">
            <CategoryIcon icon={icon} color={color} />
            <Field label="Name" className="min-w-0 flex-1">
              {(id) => (
                <Input
                  id={id}
                  data-autofocus
                  value={name}
                  maxLength={28}
                  placeholder="e.g. Pets"
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                />
              )}
            </Field>
          </div>

          {!category && (
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Used for</p>
              <Segmented label="Category kind" value={kind} onChange={setKind} options={KIND_OPTIONS} className="flex w-full" />
            </div>
          )}

          {isBusiness && kind === 'expense' && (
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-ink-2">In profit and loss, this counts as</p>
              <Segmented
                label="Counts in profit and loss as"
                value={costType}
                onChange={setCostType}
                options={[
                  { value: 'direct', label: 'Cost of goods sold' },
                  { value: 'operating', label: 'Operating expense' },
                ]}
                className="flex w-full"
              />
              <p className="mt-1.5 text-xs text-ink-3">Cost of goods sold is what it costs to make or buy what you sell. Everything else is an operating expense.</p>
            </div>
          )}

          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-ink-2">Icon</legend>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_ICON_KEYS.map((key) => {
                const Icon = iconFor(key);
                const active = key === icon;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={key.replace(/-/g, ' ')}
                    aria-pressed={active}
                    onClick={() => setIcon(key)}
                    className={cn(
                      'flex size-10 items-center justify-center rounded-xl border transition-colors',
                      active ? 'border-accent bg-accent text-white' : 'border-line text-ink-2 hover:border-line-strong',
                    )}
                  >
                    <Icon aria-hidden className="size-[18px]" />
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-ink-2">Colour</legend>
            <div className="flex flex-wrap gap-2">
              {PALETTE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={key}
                  aria-pressed={key === color}
                  onClick={() => setColor(key)}
                  className={cn('size-8 rounded-full border-2 border-surface transition-shadow', key === color && 'ring-2 ring-ink')}
                  style={{ background: colorOf(key).fg }}
                />
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] font-semibold text-ink-2">Subcategories</legend>
            {subs.length > 0 && (
              <ul className="mb-2 space-y-2">
                {subs.map((sub) => (
                  <li key={sub.key} className="flex items-center gap-1.5">
                    <Input
                      aria-label="Subcategory name"
                      value={sub.name}
                      maxLength={28}
                      onChange={(e) => {
                        setSubs(subs.map((s) => (s.key === sub.key ? { ...s, name: e.target.value } : s)));
                        setError(null);
                      }}
                    />
                    <IconButton label={`Remove ${sub.name || 'subcategory'}`} onClick={() => setSubs(subs.filter((s) => s.key !== sub.key))}>
                      <X className="size-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-1.5">
              <Input
                aria-label="New subcategory"
                value={newSub}
                maxLength={28}
                placeholder="Add a subcategory"
                onChange={(e) => setNewSub(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSub();
                  }
                }}
              />
              <IconButton label="Add subcategory" onClick={addSub}>
                <Plus className="size-4" />
              </IconButton>
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="rounded-control bg-negative-soft px-3.5 py-2.5 text-sm font-semibold text-negative">
              {error}
            </p>
          )}
        </form>
      </Modal>
      <ConfirmDialog
        open={deleting}
        title={`Delete ${category?.name ?? 'category'}?`}
        message={
          used > 0
            ? `${used} ${used === 1 ? 'transaction uses' : 'transactions use'} this category. They will stay in your records, with the same amounts, and show as Uncategorised. This cannot be undone.`
            : 'No transactions use this category. This cannot be undone.'
        }
        confirmLabel="Delete category"
        destructive
        onConfirm={remove}
        onCancel={() => setDeleting(false)}
      />
    </>
  );
}

export function CategoriesPage() {
  const { space, categories, transactions } = useSpaceData();
  const [editor, setEditor] = useState<{ category: Category | null; kind: CategoryKind } | null>(null);
  if (!space) return null;
  const counts = new Map<string, number>();
  for (const t of transactions) if (t.categoryId) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);

  return (
    <div>
      <BackLink to="/more">More</BackLink>
      <PageHeader
        title="Categories"
        subtitle={`How money is grouped in ${space.name}`}
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditor({ category: null, kind: 'expense' })}>
            New category
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        {(['expense', 'income'] as const).map((kind) => {
          const list = categories.filter((c) => c.kind === kind);
          return (
            <Card key={kind}>
              <CardHeader
                title={kind === 'expense' ? 'Spending' : 'Income'}
                subtitle={`${list.length} ${list.length === 1 ? 'category' : 'categories'}`}
                action={
                  <IconButton label={`Add ${kind === 'expense' ? 'a spending' : 'an income'} category`} onClick={() => setEditor({ category: null, kind })}>
                    <Plus className="size-4" />
                  </IconButton>
                }
              />
              {list.length === 0 ? (
                <EmptyState
                  icon={Plus}
                  title="No categories yet"
                  message={kind === 'expense' ? 'Add one to group your spending.' : 'Add one to group your income.'}
                />
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((c) => (
                    <li key={c.id} className="flex items-center gap-1">
                      <Link
                        to={`/transactions?category=${encodeURIComponent(c.id)}`}
                        className="-ml-2 flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-canvas"
                      >
                        <CategoryIcon icon={c.icon} color={c.color} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-ink">{c.name}</span>
                          {(c.subcategories.length > 0 || (space.type === 'business' && c.kind === 'expense')) && (
                            <span className="block truncate text-xs text-ink-3">
                              {[space.type === 'business' && c.kind === 'expense' ? (c.costType === 'direct' ? 'Cost of goods sold' : 'Operating expense') : '', ...c.subcategories.map((s) => s.name)]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                        </span>
                        <span className="text-xs font-semibold text-ink-3">{counts.get(c.id) ?? 0}</span>
                      </Link>
                      <IconButton label={`Edit ${c.name}`} onClick={() => setEditor({ category: c, kind })} className="-mr-2">
                        <Pencil className="size-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {editor && (
        <CategoryEditor
          key={editor.category?.id ?? `new-${editor.kind}`}
          spaceId={space.id}
          category={editor.category}
          kind={editor.kind}
          used={editor.category ? (counts.get(editor.category.id) ?? 0) : 0}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
