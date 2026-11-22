/**
 * Product usage, for the beta: which screens and features people use, only
 * from people who said yes. Shared by the web app (which counts) and the API
 * (which accepts only these names).
 *
 * Every event is a fixed name from the list below. None carries an amount,
 * a name, a description, an id or anything a person typed.
 */

/** Screens, by route. Ids in the address (a person, a record) are never part of the name. */
const SCREENS: [RegExp, string][] = [
  [/^\/$/, 'home'],
  [/^\/today$/, 'today'],
  [/^\/search$/, 'search'],
  [/^\/transactions$/, 'transactions'],
  [/^\/money$/, 'money'],
  [/^\/business$/, 'business'],
  [/^\/money\/upcoming$/, 'upcoming'],
  [/^\/money\/budgets$/, 'budgets'],
  [/^\/money\/goals$/, 'goals'],
  [/^\/money\/recurring$/, 'recurring'],
  [/^\/money\/people$/, 'people'],
  [/^\/money\/people\/[^/]+$/, 'person'],
  [/^\/money\/loans$/, 'loans'],
  [/^\/money\/receivables$/, 'receivables'],
  [/^\/money\/payables$/, 'payables'],
  [/^\/insights$/, 'insights'],
  [/^\/more$/, 'more'],
  [/^\/more\/spaces$/, 'spaces'],
  [/^\/more\/categories$/, 'categories'],
  [/^\/more\/settings$/, 'settings'],
  [/^\/more\/import$/, 'import'],
];

/** Things people do, counted (never what they entered). */
export const ACTIONS = ['app:open', 'add:expense', 'add:income', 'add:transfer', 'import:done', 'export:done', 'reminders:on', 'feedback:sent', 'install:done'] as const;

export const USAGE_EVENTS: ReadonlySet<string> = new Set([...SCREENS.map(([, name]) => `screen:${name}`), ...ACTIONS]);

/** The screen's name for an address, such as "transactions", or "other". Never includes ids. */
export function screenName(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return SCREENS.find(([pattern]) => pattern.test(path))?.[1] ?? 'other';
}

/** The usage event for opening a screen, or null for an address Finken does not name. */
export function screenEvent(pathname: string): string | null {
  const name = screenName(pathname);
  return name === 'other' ? null : `screen:${name}`;
}

export const isUsageEvent = (name: string): boolean => USAGE_EVENTS.has(name);
