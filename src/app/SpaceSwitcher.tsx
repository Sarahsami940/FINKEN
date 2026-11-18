import { Check, ChevronsUpDown, Settings2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SPACE_TYPE_META } from '../data/defaults';
import { useAppState } from '../data/hooks';
import { store } from '../data/store';
import type { Space } from '../domain/types';
import { cn } from '../components/ui/cn';
import { Dropdown, DropdownItem } from '../components/ui/Dropdown';
import { iconFor } from '../components/ui/icons';
import { useToast } from '../components/ui/Toast';

export function SpaceGlyph({ space, size = 'md' }: { space: Pick<Space, 'icon'>; size?: 'sm' | 'md' }) {
  const Icon = iconFor(space.icon);
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-accent text-white',
        size === 'md' ? 'size-9' : 'size-7',
      )}
    >
      <Icon className={size === 'md' ? 'size-[18px]' : 'size-4'} />
    </span>
  );
}

interface SpaceSwitcherProps {
  variant: 'sidebar' | 'compact';
}

/** Shows the active Space at all times and switches between Spaces in one tap. */
export function SpaceSwitcher({ variant }: SpaceSwitcherProps) {
  const { spaces, activeSpaceId } = useAppState();
  const navigate = useNavigate();
  const toast = useToast();
  const active = spaces.find((s) => s.id === activeSpaceId);
  const available = spaces.filter((s) => s.status === 'active');
  if (!active) return null;

  return (
    <Dropdown
      align={variant === 'compact' ? 'right' : 'left'}
      menuClassName={variant === 'sidebar' ? 'w-full' : 'w-64'}
      trigger={(props) =>
        variant === 'sidebar' ? (
          <button
            type="button"
            {...props}
            aria-label={`Current Space: ${active.name}. Switch Space`}
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-2.5 text-left transition-colors hover:border-line-strong"
          >
            <SpaceGlyph space={active} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-ink">{active.name}</span>
              <span className="block truncate text-xs text-ink-3">{SPACE_TYPE_META[active.type].label} Space</span>
            </span>
            <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-ink-3" />
          </button>
        ) : (
          <button
            type="button"
            {...props}
            aria-label={`Current Space: ${active.name}. Switch Space`}
            className="flex h-10 max-w-44 items-center gap-2 rounded-full border border-line bg-surface pl-1.5 pr-3 transition-colors hover:border-line-strong"
          >
            <SpaceGlyph space={active} size="sm" />
            <span className="truncate text-sm font-bold text-ink">{active.name}</span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-ink-3" />
          </button>
        )
      }
    >
      {(close) => (
        <>
          <p className="px-3 pb-1 pt-2 text-xs font-semibold text-ink-3">Your Spaces</p>
          {available.map((space) => (
            <DropdownItem
              key={space.id}
              selected={space.id === active.id}
              icon={<SpaceGlyph space={space} size="sm" />}
              hint={space.id === active.id ? <Check aria-label="Current" className="size-4 text-accent" /> : undefined}
              onSelect={() => {
                close();
                if (space.id === active.id) return;
                store.setActiveSpace(space.id);
                toast(`Switched to ${space.name}`);
              }}
            >
              {space.name}
            </DropdownItem>
          ))}
          <div className="my-1.5 border-t border-line" />
          <DropdownItem
            icon={<Settings2 aria-hidden className="size-4 text-ink-3" />}
            onSelect={() => {
              close();
              navigate('/more/spaces');
            }}
          >
            Manage Spaces
          </DropdownItem>
        </>
      )}
    </Dropdown>
  );
}
