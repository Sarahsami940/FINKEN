import { useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_CURRENCY } from '../domain/format';
import type { Account, Budget, Category, Goal, GoalEntry, Obligation, Person, Recurring, Space, Transaction } from '../domain/types';
import { store, type AppState } from './store';

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export interface SpaceData {
  space: Space | null;
  currency: string;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  recurring: Recurring[];
  people: Person[];
  obligations: Obligation[];
  budgets: Budget[];
  goals: Goal[];
  goalEntries: GoalEntry[];
}

/** Everything belonging to one Space, for editors that work outside the active Space. */
export function useSpaceRecords(spaceId: string | null | undefined): SpaceData {
  const { spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries } = useAppState();
  return useMemo(() => {
    const space = spaces.find((s) => s.id === spaceId) ?? null;
    const own = <T extends { spaceId: string }>(items: T[]) => (space ? items.filter((i) => i.spaceId === space.id) : []);
    return {
      space,
      currency: space?.currency ?? DEFAULT_CURRENCY,
      accounts: own(accounts),
      categories: own(categories),
      transactions: own(transactions),
      recurring: own(recurring),
      people: own(people),
      obligations: own(obligations),
      budgets: own(budgets),
      goals: own(goals),
      goalEntries: own(goalEntries),
    };
  }, [spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries, spaceId]);
}

/**
 * Everything belonging to the active Space. This is the single place where
 * records are scoped, so screens can never mix data across Spaces.
 */
export function useSpaceData(): SpaceData {
  const { spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries, activeSpaceId } = useAppState();
  return useMemo(() => {
    const space = spaces.find((s) => s.id === activeSpaceId) ?? null;
    const own = <T extends { spaceId: string }>(items: T[]) => (space ? items.filter((i) => i.spaceId === space.id) : []);
    return {
      space,
      currency: space?.currency ?? DEFAULT_CURRENCY,
      accounts: own(accounts),
      categories: own(categories),
      transactions: own(transactions),
      recurring: own(recurring),
      people: own(people),
      obligations: own(obligations),
      budgets: own(budgets),
      goals: own(goals),
      goalEntries: own(goalEntries),
    };
  }, [spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries, activeSpaceId]);
}
