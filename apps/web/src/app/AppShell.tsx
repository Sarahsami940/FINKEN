import { BriefcaseBusiness, ChevronDown, Info, Plus, RefreshCw, Search, X } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAddFlow } from '../components/money/AddFlow';
import { cn } from '../components/ui/cn';
import { useAppState } from '../data/hooks';
import { applyUpdate, usePwa } from '../data/pwa';
import { store } from '../data/store';
import { CreateAccountDialog } from '../pages/SettingsPage';
import { MONEY_SECTIONS, PRIMARY_NAV } from './nav';
import { SpaceSwitcher } from './SpaceSwitcher';

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link to="/" aria-label="Finken home" className={cn('inline-flex items-baseline text-[22px] font-extrabold tracking-tight text-ink', className)}>
      finken<span className="text-accent">.</span>
    </Link>
  );
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors',
    isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:bg-sunken hover:text-ink',
  );

function Sidebar() {
  const { openMenu } = useAddFlow();
  const { user, spaces, activeSpaceId } = useAppState();
  const isBusiness = spaces.find((sp) => sp.id === activeSpaceId)?.type === 'business';
  const { pathname } = useLocation();
  const inMoney = pathname.startsWith('/money');
  const [moneyOpen, setMoneyOpen] = useState(inMoney);

  useEffect(() => {
    if (inMoney) setMoneyOpen(true);
  }, [inMoney]);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-line bg-canvas px-4 py-5 lg:flex">
      <Wordmark className="px-2" />

      <div className="mt-6">
        <SpaceSwitcher variant="sidebar" />
      </div>

      <button
        type="button"
        onClick={openMenu}
        className="mt-4 flex h-11 items-center justify-center gap-2 rounded-control bg-ink text-sm font-bold text-white transition-[background-color,transform] hover:bg-ink/88 active:scale-[0.98]"
      >
        <Plus aria-hidden className="size-[18px]" strokeWidth={2.5} />
        Add
      </button>

      <NavLink
        to="/search"
        className={({ isActive }) =>
          cn(
            'mt-2 flex h-11 items-center gap-2.5 rounded-control border px-3.5 text-sm font-semibold transition-colors',
            isActive ? 'border-accent bg-surface text-ink' : 'border-line bg-surface text-ink-3 hover:border-line-strong hover:text-ink',
          )
        }
      >
        <Search aria-hidden className="size-[18px]" />
        <span className="flex-1">Search your money</span>
        <kbd className="rounded border border-line px-1.5 text-[11px] font-semibold text-ink-3">/</kbd>
      </NavLink>

      <nav aria-label="Main" className="mt-6 flex-1 space-y-1 overflow-y-auto">
        {PRIMARY_NAV.map((item) =>
          item.to === '/money' ? (
            <div key={item.to}>
              <div className="flex items-center gap-1">
                <NavLink to={item.to} end className={(s) => cn(linkClass(s), 'flex-1')}>
                  <item.icon aria-hidden className="size-[18px]" />
                  {item.label}
                </NavLink>
                <button
                  type="button"
                  aria-label={moneyOpen ? 'Hide Money sections' : 'Show Money sections'}
                  aria-expanded={moneyOpen}
                  onClick={() => setMoneyOpen((v) => !v)}
                  className="flex size-10 items-center justify-center rounded-xl text-ink-3 hover:bg-sunken hover:text-ink"
                >
                  <ChevronDown aria-hidden className={cn('size-4 transition-transform', moneyOpen && 'rotate-180')} />
                </button>
              </div>
              {moneyOpen && (
                <ul className="ml-[21px] mt-1 space-y-0.5 border-l border-line pl-3">
                  {MONEY_SECTIONS.map((section) => (
                    <li key={section.key}>
                      <NavLink
                        to={section.to}
                        className={({ isActive }) =>
                          cn(
                            'flex h-9 items-center rounded-lg px-3 text-[13px] font-semibold transition-colors',
                            isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:bg-sunken hover:text-ink',
                          )
                        }
                      >
                        {section.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : item.to === '/insights' && isBusiness ? (
            <div key={item.to} className="space-y-1">
              <NavLink to="/business" className={linkClass}>
                <BriefcaseBusiness aria-hidden className="size-[18px]" />
                Business
              </NavLink>
              <NavLink to={item.to} end={item.end} className={linkClass}>
                <item.icon aria-hidden className="size-[18px]" />
                {item.label}
              </NavLink>
            </div>
          ) : (
            <NavLink key={item.to} to={item.to} end={item.end} className={linkClass}>
              <item.icon aria-hidden className="size-[18px]" />
              {item.label}
            </NavLink>
          ),
        )}
      </nav>

      {user && (
        <Link to="/more/settings" className="mt-4 flex items-center gap-3 rounded-2xl p-2 transition-colors hover:bg-sunken">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-strong">
            {(user.name.trim() || (user.isGuest ? 'Guest' : (user.email ?? 'Y'))).charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-ink">{user.name || (user.isGuest ? 'Guest' : 'Your account')}</span>
            <span className="block truncate text-xs text-ink-3">{user.isGuest ? 'Saved only in this browser' : user.email}</span>
          </span>
        </Link>
      )}
    </aside>
  );
}

function MobileHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur-md lg:hidden">
      <Wordmark className="text-xl" />
      <div className="flex min-w-0 items-center gap-1.5">
        <Link to="/search" aria-label="Search your money" className="flex size-10 shrink-0 items-center justify-center rounded-xl text-ink-2 hover:bg-sunken hover:text-ink">
          <Search className="size-5" />
        </Link>
        <SpaceSwitcher variant="compact" />
      </div>
    </header>
  );
}

/** "/" opens search from anywhere, unless the user is typing. */
function useSearchShortcut() {
  const navigate = useNavigate();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      navigate('/search');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

function PageLoading() {
  return (
    <div role="status" aria-label="Loading" className="flex justify-center py-24">
      <span className="size-6 animate-spin rounded-full border-2 border-line border-t-accent" />
    </div>
  );
}

function BottomNav() {
  const { openMenu } = useAddFlow();
  return (
    <>
      <button
        type="button"
        aria-label="Add"
        onClick={openMenu}
        className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-30 flex size-14 items-center justify-center rounded-full bg-ink text-white shadow-raised transition-transform active:scale-95 lg:hidden"
      >
        <Plus aria-hidden className="size-6" strokeWidth={2.5} />
      </button>
      <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur-md lg:hidden">
        <ul className="mx-auto flex h-16 max-w-lg items-stretch">
          {PRIMARY_NAV.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn('flex h-full flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors', isActive ? 'text-accent' : 'text-ink-3')
                }
              >
                <item.icon aria-hidden className="size-5" />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function StorageNotice() {
  const { error, persistent } = useAppState();
  const message = error ?? (persistent ? null : 'This browser cannot save data, so changes will be lost when you close the tab.');
  if (!message) return null;
  return (
    <div role="alert" className="mb-5 flex items-center justify-between gap-3 rounded-control bg-warning-soft px-4 py-3 text-sm font-semibold text-warning">
      {message}
      {error && (
        <button type="button" aria-label="Dismiss" onClick={() => store.dismissError()} className="flex size-7 shrink-0 items-center justify-center rounded-lg hover:bg-warning/10">
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** A new version of Finken has downloaded: it starts when the person says so. */
function UpdateNotice() {
  const { updateReady } = usePwa();
  if (!updateReady) return null;
  return (
    <div role="status" className="mb-5 flex items-center gap-3 rounded-card border border-accent/30 bg-accent-soft/50 px-4 py-3.5">
      <RefreshCw aria-hidden className="size-[18px] shrink-0 text-accent" />
      <p className="min-w-0 flex-1 text-sm text-ink-2">
        <strong className="font-bold text-ink">A new version of Finken is ready.</strong> Everything you have saved stays as it is.
      </p>
      <button type="button" onClick={applyUpdate} className="shrink-0 rounded-control bg-ink px-3.5 py-2 text-sm font-bold text-white hover:bg-ink/88">
        Reload
      </button>
    </div>
  );
}

/** Tells guests, once, where their data lives and how to keep it. */
function GuestNotice() {
  const { user, guestNoticeDismissed } = useAppState();
  const [creating, setCreating] = useState(false);
  if (!user?.isGuest) return null;
  return (
    <>
      {!guestNoticeDismissed && (
        <div className="mb-5 flex items-start gap-3 rounded-card border border-line bg-surface px-4 py-3.5 shadow-card sm:items-center">
          <Info aria-hidden className="mt-0.5 size-[18px] shrink-0 text-accent sm:mt-0" />
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-ink-2">
            <strong className="font-bold text-ink">You are trying Finken as a guest.</strong> Everything you add is saved only in this browser.{' '}
            <button type="button" onClick={() => setCreating(true)} className="font-bold text-accent hover:text-accent-strong">
              Create an account
            </button>{' '}
            to keep it under your own login.
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => store.dismissGuestNotice()}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 hover:bg-sunken hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <CreateAccountDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  useSearchShortcut();
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the top on every route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="min-h-dvh">
      <Sidebar />
      <MobileHeader />
      <main className="px-4 pb-32 pt-6 sm:px-6 lg:ml-64 lg:px-10 lg:pb-16 lg:pt-10">
        <div className="mx-auto max-w-6xl">
          <UpdateNotice />
          <StorageNotice />
          <GuestNotice />
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
      <BottomNav />
    </div>
  );
}
