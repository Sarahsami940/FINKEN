import { type ComponentType, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './app/AppShell';
import { AddFlowProvider } from './components/money/AddFlow';
import { ToastProvider } from './components/ui/Toast';
import { account, useProfile } from './data/account';
import { useAppState } from './data/hooks';
import { startReminders } from './data/reminders';
import { store } from './data/store';
import { track } from './data/usage';
import { useLocalSpaces } from './onboarding/MoveData';
import { ConfirmEmailStep, FirstSpaceStep, InviteStep, MoveDataStep, Onboarding, ResetPasswordStep, SignInCallback } from './onboarding/Onboarding';
import { HomePage } from './pages/HomePage';
import { MoneyPage } from './pages/MoneyPages';
import { MorePage, SpacesPage } from './pages/MorePages';
import { SettingsPage } from './pages/SettingsPage';
import { TransactionsPage } from './pages/TransactionsPage';

/** Loads a named page export the first time its route is opened. */
function page<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}
const TodayPage = page(() => import('./pages/TodayPage'), 'TodayPage');
const SearchPage = page(() => import('./pages/SearchPage'), 'SearchPage');
const BusinessPage = page(() => import('./pages/BusinessPage'), 'BusinessPage');
const InsightsPage = page(() => import('./pages/InsightsPage'), 'InsightsPage');
const UpcomingPage = page(() => import('./pages/UpcomingPage'), 'UpcomingPage');
const CategoriesPage = page(() => import('./pages/CategoriesPage'), 'CategoriesPage');
const PeoplePage = page(() => import('./pages/OwedPages'), 'PeoplePage');
const PersonPage = page(() => import('./pages/OwedPages'), 'PersonPage');
const ObligationsPage = lazy(async () => ({ default: (await import('./pages/OwedPages')).ObligationsPage }));
const BudgetsPage = page(() => import('./pages/PlanningPages'), 'BudgetsPage');
const GoalsPage = page(() => import('./pages/PlanningPages'), 'GoalsPage');
const RecurringPage = page(() => import('./pages/PlanningPages'), 'RecurringPage');
const ImportPage = page(() => import('./pages/ImportPage'), 'ImportPage');

function Loading() {
  return (
    <div role="status" aria-label="Loading Finken" className="flex min-h-dvh items-center justify-center">
      <span className="animate-pulse text-2xl font-extrabold tracking-tight text-ink">
        finken<span className="text-accent">.</span>
      </span>
    </div>
  );
}

export function App() {
  const { ready, user, spaces } = useAppState();
  const profile = useProfile();

  const local = useLocalSpaces(account);
  const [moveClosed, setMoveClosed] = useState(false);

  useEffect(() => {
    void store.init().then(() => {
      if (store.getState().user) account?.start();
      startReminders(store.getState);
      track('app:open');
    });
  }, []);

  if (!ready || !local.spaces) return <Loading />;
  // Back from the sign-in provider's page.
  if (account?.provider && window.location.pathname === '/auth/callback') return <SignInCallback account={account} />;
  // Links from Finken's emails: setting a new password, and confirming the address.
  if (account && !account.provider && window.location.pathname === '/auth/reset') return <ResetPasswordStep account={account} />;
  if (account && !account.provider && window.location.pathname === '/auth/verify') return <ConfirmEmailStep account={account} />;
  // Nobody has entered yet: welcome, sign-up, login or guest.
  if (!user) return <Onboarding />;
  // The closed beta: signed in, but the invite code comes before anything else.
  if (account && profile?.access === 'invite-needed') return <InviteStep account={account} />;
  // Signed in to an account, with data saved in this browser from before: offer to bring it in.
  if (account && !moveClosed && !account.moveDismissed(user.id) && local.spaces.some((s) => !s.moved)) {
    return (
      <MoveDataStep
        account={account}
        onDone={(choice) => {
          if (choice === 'later') account?.dismissMove(user.id);
          setMoveClosed(true);
        }}
      />
    );
  }
  // A new account has no Spaces until its owner picks the first one.
  if (spaces.length === 0) return <FirstSpaceStep />;

  return (
    <BrowserRouter>
      <ToastProvider>
        <AddFlowProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<HomePage />} />
              <Route path="today" element={<TodayPage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="transactions" element={<TransactionsPage />} />
              <Route path="money" element={<MoneyPage />} />
              <Route path="business" element={<BusinessPage />} />
              <Route path="money/upcoming" element={<UpcomingPage />} />
              <Route path="money/budgets" element={<BudgetsPage />} />
              <Route path="money/goals" element={<GoalsPage />} />
              <Route path="money/recurring" element={<RecurringPage />} />
              <Route path="money/people" element={<PeoplePage />} />
              <Route path="money/people/:personId" element={<PersonPage />} />
              <Route path="money/loans" element={<ObligationsPage key="loans" section="loans" />} />
              <Route path="money/receivables" element={<ObligationsPage key="receivables" section="receivables" />} />
              <Route path="money/payables" element={<ObligationsPage key="payables" section="payables" />} />
              <Route path="money/*" element={<Navigate to="/money" replace />} />
              <Route path="insights" element={<InsightsPage />} />
              <Route path="more" element={<MorePage />} />
              <Route path="more/spaces" element={<SpacesPage />} />
              <Route path="more/categories" element={<CategoriesPage />} />
              <Route path="more/settings" element={<SettingsPage />} />
              <Route path="more/import" element={<ImportPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </AddFlowProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
