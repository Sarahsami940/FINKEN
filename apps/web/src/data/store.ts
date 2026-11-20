/**
 * The central app store.
 *
 * Holds an in-memory copy of every collection, exposes it to React through
 * `useSyncExternalStore`, and writes every change through the storage
 * adapter. UI components never touch storage directly — they call the
 * actions below, and every screen re-derives its numbers from the result.
 *
 * Sessions: `state.user` is whoever is using Finken right now (a guest or a
 * signed-in account), and `state.spaces` holds only that user's Spaces.
 * Other users' Spaces stay in storage and are never exposed to the UI.
 */

import { MAX_IMPORT_ROWS } from '@finken/domain/csvImport';
import { deviceTimeZone, isValidTimeZone, setTimeZone, today } from '@finken/domain/dates';
import { defaultAccounts, defaultCategories } from '@finken/domain/defaults';
import { isMinorAmount } from '@finken/domain/format';
import { checkTransaction, isPrincipal, obligationPosition, openingType, settlementType, sharedAmount } from '@finken/domain/money';
import { goalSaved, nextRecurringDate } from '@finken/domain/planning';
import { buildSeed } from '@finken/domain/seed';
import type {
  Account,
  AccountDraft,
  Budget,
  BudgetDraft,
  Category,
  CategoryDraft,
  Goal,
  GoalDraft,
  GoalEntry,
  ID,
  ISODate,
  Obligation,
  ObligationDraft,
  ObligationPatch,
  Person,
  PersonDraft,
  Recurring,
  RecurringDraft,
  Space,
  SpaceDraft,
  SpaceType,
  Transaction,
  TransactionDraft,
  User,
} from '@finken/domain/types';
import { account } from './account';
import { AuthError, type AuthService, GUEST_ID, LocalAuthService, type RegistrationInput } from './auth';
import { AuditedStorage, type CollectionName, createStorage, type Entity, type SpaceRole, type StorageAdapter } from './storage';

export interface AppState {
  ready: boolean;
  /** False when the browser has no IndexedDB and data lives only in memory. */
  persistent: boolean;
  error: string | null;
  /** The current session's user, or null when nobody has entered Finken yet. */
  user: User | null;
  /** Spaces the current user owns or, with an account, belongs to. */
  spaces: Space[];
  /** With an account: the user's role in each Space. Spaces missing here are theirs (owner). */
  roles: Record<ID, SpaceRole>;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  recurring: Recurring[];
  people: Person[];
  obligations: Obligation[];
  budgets: Budget[];
  goals: Goal[];
  goalEntries: GoalEntry[];
  activeSpaceId: ID | null;
  guestNoticeDismissed: boolean;
}

/** Outcome of a write. `error` is safe to show to the user. */
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

interface MetaRecord extends Entity {
  value: string;
}

/** Outcome of an account action; `error` is safe to show to the user. */
export type AuthResult = { ok: true } | { ok: false; error: string; field?: keyof RegistrationInput };

const INITIAL: AppState = {
  ready: false,
  persistent: true,
  error: null,
  user: null,
  spaces: [],
  roles: {},
  accounts: [],
  categories: [],
  transactions: [],
  recurring: [],
  people: [],
  obligations: [],
  budgets: [],
  goals: [],
  goalEntries: [],
  activeSpaceId: null,
  guestNoticeDismissed: false,
};

/** What a change in a view-only Space is told. */
export const VIEW_ONLY = 'You can view this Space but not change it. Ask its owner to let you edit.';

const META_SESSION = 'sessionUserId';
const META_GUEST_NOTICE = 'guestNoticeDismissed';
const activeSpaceKey = (userId: ID) => `activeSpace:${userId}`;

const newId = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();

function authFailure(err: unknown): AuthResult {
  if (err instanceof AuthError) return { ok: false, error: err.message, field: err.field };
  console.error('Finken account action failed', err);
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

export class AppStore {
  private state: AppState = INITIAL;
  private listeners = new Set<() => void>();
  private storage: StorageAdapter & Partial<Pick<AuditedStorage, 'purgeMany'>>;
  private auth: AuthService;
  /** Spaces that belong to users other than the current one. */
  private otherSpaces: Space[] = [];
  private meta = new Map<string, string>();
  /** With an account: roles from the server (null before the first sync). */
  private roles: Record<ID, SpaceRole> | null = null;

  /** Pass a storage adapter to run against something other than this browser's IndexedDB (tests do). */
  /**
   * Pass a storage adapter to run against something other than this browser's
   * IndexedDB (tests do), and an auth service to sign in somewhere other than
   * this browser (the API does).
   */
  constructor(storage?: StorageAdapter, auth?: AuthService) {
    const { adapter, persistent } = storage ? { adapter: storage, persistent: true } : createStorage();
    // Every money record gets change history and is only ever soft-deleted.
    // A server that keeps that history itself (the API) is used as it is.
    this.storage = adapter.audited ? adapter : new AuditedStorage(adapter, () => this.state.user?.id);
    this.auth = auth ?? new LocalAuthService(this.storage);
    // A synced storage can change underneath: another device's changes, or a refused one undone.
    this.storage.subscribe?.((event) => {
      if (event.type === 'rejected') this.set({ error: `A change made earlier could not be saved: ${event.message}` });
      void this.reloadRecords();
    });
    this.state = { ...INITIAL, persistent };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Persist in the background; surface failures instead of losing them silently. */
  private persist(work: Promise<void>) {
    work.catch((err) => {
      console.error('Finken could not save a change', err);
      this.set({ error: 'A change could not be saved on this device.' });
    });
  }

  private save<T extends Entity>(collection: CollectionName, item: T) {
    this.persist(this.storage.put(collection, item));
  }

  private setMeta(id: string, value: string | null) {
    if (value === null) {
      this.meta.delete(id);
      this.persist(this.storage.remove('meta', id));
    } else {
      this.meta.set(id, value);
      this.save<MetaRecord>('meta', { id, value });
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private loading: Promise<void> | null = null;

  /** Loads saved data and restores the last session. Safe to call repeatedly. */
  init(): Promise<void> {
    return (this.loading ??= this.load());
  }

  private async load() {
    try {
      const [spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries, meta] = await Promise.all([
        this.storage.getAll<Space>('spaces'),
        this.storage.getAll<Account>('accounts'),
        this.storage.getAll<Category>('categories'),
        this.storage.getAll<Transaction>('transactions'),
        this.storage.getAll<Recurring>('recurring'),
        this.storage.getAll<Person>('people'),
        this.storage.getAll<Obligation>('obligations'),
        this.storage.getAll<Budget>('budgets'),
        this.storage.getAll<Goal>('goals'),
        this.storage.getAll<GoalEntry>('goalEntries'),
        this.storage.getAll<MetaRecord>('meta'),
      ]);
      this.meta = new Map(meta.map((m) => [m.id, m.value]));
      this.roles = (await this.storage.memberships?.()) ?? null;

      // Spaces saved before accounts existed have no owner: they were the guest's.
      const orphans = spaces.filter((s) => !s.ownerId);
      if (orphans.length > 0) {
        for (const space of orphans) space.ownerId = GUEST_ID;
        await this.storage.putMany('spaces', orphans);
      }

      const sessionId = this.meta.get(META_SESSION);
      const user = sessionId ? await this.auth.getUser(sessionId) : null;
      this.otherSpaces = spaces;
      // Recurring items saved before start dates existed began on their due date.
      const undated = recurring.filter((r) => !r.startDate);
      if (undated.length > 0) {
        for (const r of undated) r.startDate = r.nextDueDate;
        await this.storage.putMany('recurring', undated);
      }
      this.set({ accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries, guestNoticeDismissed: this.meta.get(META_GUEST_NOTICE) === '1' });
      this.applySession(user);
      this.set({ ready: true });
    } catch (err) {
      console.error('Finken could not load saved data', err);
      this.set({ ready: true, error: 'Finken could not open its saved data on this device.' });
    }
  }

  /** Reads everything again (after joining a shared Space, say), and resolves once it is in view. */
  async refresh(): Promise<void> {
    await this.reloadRecords();
  }

  /** Reads every record again from storage, keeping the session and the Space in view. */
  private async reloadRecords() {
    if (!this.state.ready) return;
    try {
      const [spaces, accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries] = await Promise.all([
        this.storage.getAll<Space>('spaces'),
        this.storage.getAll<Account>('accounts'),
        this.storage.getAll<Category>('categories'),
        this.storage.getAll<Transaction>('transactions'),
        this.storage.getAll<Recurring>('recurring'),
        this.storage.getAll<Person>('people'),
        this.storage.getAll<Obligation>('obligations'),
        this.storage.getAll<Budget>('budgets'),
        this.storage.getAll<Goal>('goals'),
        this.storage.getAll<GoalEntry>('goalEntries'),
      ]);
      this.roles = (await this.storage.memberships?.()) ?? null;
      const active = this.state.activeSpaceId;
      this.otherSpaces = spaces;
      this.state = { ...this.state, spaces: [] };
      this.set({ accounts, categories, transactions, recurring, people, obligations, budgets, goals, goalEntries });
      this.applySession(this.state.user);
      if (active && this.state.spaces.some((s) => s.id === active && s.status === 'active')) this.set({ activeSpaceId: active });
    } catch (err) {
      console.error('Finken could not refresh its data', err);
    }
  }

  /** Points the store at `user`: their Spaces become visible, everyone else's are hidden. */
  private applySession(user: User | null) {
    // Users from before time zones existed take this device's zone, once.
    if (user && !user.timeZone) {
      user = { ...user, timeZone: deviceTimeZone() };
      this.persist(this.auth.updateUser(user));
    }
    setTimeZone(user?.timeZone);
    const all = [...this.state.spaces, ...this.otherSpaces];
    // With an account, this device's copy holds only Spaces the person belongs to, shared ones included.
    const mine = (s: Space) => Boolean(user) && (s.ownerId === user!.id || (Boolean(this.storage.memberships) && !user!.isGuest));
    const owned = sortSpaces(all.filter(mine));
    this.otherSpaces = all.filter((s) => !mine(s));
    const saved = user ? this.meta.get(activeSpaceKey(user.id)) : undefined;
    const active = owned.find((s) => s.id === saved && s.status === 'active') ?? owned.find((s) => s.status === 'active');
    this.set({ user, spaces: owned, roles: this.roles ?? {}, activeSpaceId: active?.id ?? null });
  }

  private startSession(user: User) {
    this.setMeta(META_SESSION, user.id);
    this.applySession(user);
  }

  dismissError() {
    this.set({ error: null });
  }

  // ── Sessions and accounts ────────────────────────────────────────────────

  /**
   * Enters Finken without an account. The guest gets demo Spaces the first
   * time; after that their own local data is kept and reopened.
   */
  async enterGuest(startIn?: SpaceType): Promise<AuthResult> {
    try {
      const guest = await this.auth.ensureGuest();
      const hasSpaces = [...this.state.spaces, ...this.otherSpaces].some((s) => s.ownerId === guest.id);
      const seededIds = hasSpaces ? null : await this.writeSeed(guest.id);
      this.startSession(guest);
      const preferred = seededIds?.[startIn ?? 'personal'] ?? this.state.spaces.find((s) => s.status === 'active' && s.type === startIn)?.id;
      if (preferred) this.setActiveSpace(preferred);
      return { ok: true };
    } catch (err) {
      return authFailure(err);
    }
  }

  async register(input: RegistrationInput): Promise<AuthResult> {
    try {
      this.startSession(await this.auth.register(input));
      return { ok: true };
    } catch (err) {
      return authFailure(err);
    }
  }

  async login(email: string, password: string): Promise<AuthResult> {
    try {
      this.startSession(await this.auth.login(email, password));
      return { ok: true };
    } catch (err) {
      return authFailure(err);
    }
  }

  /**
   * Starts a session for whoever the sign-in provider says is signed in: on a
   * new device, or after the provider's own sign-in screen. Their records then
   * arrive from the server.
   */
  async signInWithProvider(): Promise<AuthResult> {
    try {
      const user = await this.auth.current?.();
      if (!user) return { ok: false, error: 'Sign in again.' };
      this.startSession(user);
      return { ok: true };
    } catch (err) {
      return authFailure(err);
    }
  }

  /** Turns the guest into an account, keeping every Space and record they made. */
  async convertGuestToAccount(input: RegistrationInput): Promise<AuthResult> {
    const guest = this.state.user;
    if (!guest?.isGuest) return { ok: false, error: 'You already have an account.' };
    try {
      // The account keeps the time zone the guest chose.
      const user = { ...(await this.auth.register(input)), timeZone: guest.timeZone ?? deviceTimeZone() };
      await this.auth.updateUser(user);
      const moved = this.state.spaces.map((s) => ({ ...s, ownerId: user.id }));
      await this.storage.putMany('spaces', moved);
      const active = this.state.activeSpaceId;
      this.setMeta(activeSpaceKey(guest.id), null);
      if (active) this.setMeta(activeSpaceKey(user.id), active);
      await this.auth.removeUser(guest.id);
      this.set({ spaces: moved });
      this.startSession(user);
      return { ok: true };
    } catch (err) {
      return authFailure(err);
    }
  }

  /** Ends the session. Data stays on this device for next time. */
  signOut() {
    this.setMeta(META_SESSION, null);
    this.applySession(null);
  }

  updateUser(patch: Partial<Pick<User, 'name' | 'timeZone'>>) {
    if (!this.state.user) return;
    if (patch.timeZone !== undefined && !isValidTimeZone(patch.timeZone)) return;
    const user = { ...this.state.user, ...patch };
    setTimeZone(user.timeZone);
    this.set({ user });
    this.persist(this.auth.updateUser(user));
  }

  dismissGuestNotice() {
    this.set({ guestNoticeDismissed: true });
    this.setMeta(META_GUEST_NOTICE, '1');
  }

  // ── Demo data ────────────────────────────────────────────────────────────

  private async writeSeed(ownerId: ID) {
    const seed = buildSeed(ownerId);
    await Promise.all([
      this.storage.putMany('spaces', seed.spaces),
      this.storage.putMany('accounts', seed.accounts),
      this.storage.putMany('categories', seed.categories),
      this.storage.putMany('transactions', seed.transactions),
      this.storage.putMany('recurring', seed.recurring),
      this.storage.putMany('people', seed.people),
      this.storage.putMany('obligations', seed.obligations),
      this.storage.putMany('budgets', seed.budgets),
      this.storage.putMany('goals', seed.goals),
      this.storage.putMany('goalEntries', seed.goalEntries),
    ]);
    this.otherSpaces = [...this.otherSpaces, ...seed.spaces];
    this.set({
      accounts: [...this.state.accounts, ...seed.accounts],
      categories: [...this.state.categories, ...seed.categories],
      transactions: [...this.state.transactions, ...seed.transactions],
      recurring: [...this.state.recurring, ...seed.recurring],
      people: [...this.state.people, ...seed.people],
      obligations: [...this.state.obligations, ...seed.obligations],
      budgets: [...this.state.budgets, ...seed.budgets],
      goals: [...this.state.goals, ...seed.goals],
      goalEntries: [...this.state.goalEntries, ...seed.goalEntries],
    });
    return seed.spaceIdByType;
  }

  /** Removes the given Spaces and every record inside them, in memory and in storage. */
  /** Pass `erase` only when replacing demo data: the records are then gone for good instead of kept as deleted. */
  private async purgeSpaces(ids: ID[], erase = false) {
    const remove = (c: CollectionName, list: ID[]) => (erase && this.storage.purgeMany ? this.storage.purgeMany(c, list) : this.storage.removeMany(c, list));
    const gone = new Set(ids);
    const owned = <T extends { id: ID; spaceId: ID }>(items: T[]) => items.filter((i) => gone.has(i.spaceId)).map((i) => i.id);
    const kept = <T extends { spaceId: ID }>(items: T[]) => items.filter((i) => !gone.has(i.spaceId));
    const s = this.state;
    const work = Promise.all([
      remove('transactions', owned(s.transactions)),
      remove('categories', owned(s.categories)),
      remove('accounts', owned(s.accounts)),
      remove('recurring', owned(s.recurring)),
      remove('people', owned(s.people)),
      remove('obligations', owned(s.obligations)),
      remove('budgets', owned(s.budgets)),
      remove('goals', owned(s.goals)),
      remove('goalEntries', owned(s.goalEntries)),
      remove('spaces', ids),
    ]);
    this.set({
      spaces: s.spaces.filter((sp) => !gone.has(sp.id)),
      transactions: kept(s.transactions),
      categories: kept(s.categories),
      accounts: kept(s.accounts),
      recurring: kept(s.recurring),
      people: kept(s.people),
      obligations: kept(s.obligations),
      budgets: kept(s.budgets),
      goals: kept(s.goals),
      goalEntries: kept(s.goalEntries),
    });
    await work;
  }

  /** Guest only: replaces the guest's Spaces with a fresh demo set. */
  async resetDemoData() {
    const user = this.state.user;
    if (!user?.isGuest) return;
    await this.purgeSpaces(
      this.state.spaces.map((s) => s.id),
      true,
    );
    const ids = await this.writeSeed(user.id);
    this.applySession(user);
    if (ids.personal) this.setActiveSpace(ids.personal);
  }

  // ── Spaces ───────────────────────────────────────────────────────────────

  setActiveSpace(id: ID) {
    const space = this.state.spaces.find((s) => s.id === id);
    if (space?.status !== 'active' || !this.state.user) return;
    this.set({ activeSpaceId: id });
    this.setMeta(activeSpaceKey(this.state.user.id), id);
  }

  createSpace(draft: SpaceDraft): Space | null {
    const user = this.state.user;
    if (!user) return null;
    const space: Space = { ...draft, id: newId(), ownerId: user.id, createdAt: stamp(), status: 'active' };
    const categories = defaultCategories(space.id, space.type);
    const accounts = defaultAccounts(space.id);
    this.set({
      spaces: sortSpaces([...this.state.spaces, space]),
      categories: [...this.state.categories, ...categories],
      accounts: [...this.state.accounts, ...accounts],
    });
    this.save('spaces', space);
    this.persist(this.storage.putMany('categories', categories));
    this.persist(this.storage.putMany('accounts', accounts));
    return space;
  }

  updateSpace(id: ID, patch: Partial<SpaceDraft>) {
    const current = this.state.spaces.find((s) => s.id === id);
    if (!current) return;
    const space = { ...current, ...patch };
    this.set({ spaces: this.state.spaces.map((s) => (s.id === id ? space : s)) });
    this.save('spaces', space);
  }

  /** Archives or restores a Space. The last active Space cannot be archived. */
  setSpaceArchived(id: ID, archived: boolean): boolean {
    const current = this.state.spaces.find((s) => s.id === id);
    if (!current) return false;
    const activeOthers = this.state.spaces.filter((s) => s.status === 'active' && s.id !== id);
    if (archived && activeOthers.length === 0) return false;
    const space: Space = { ...current, status: archived ? 'archived' : 'active' };
    this.set({ spaces: this.state.spaces.map((s) => (s.id === id ? space : s)) });
    this.save('spaces', space);
    if (archived && this.state.activeSpaceId === id) this.setActiveSpace(activeOthers[0].id);
    return true;
  }

  /** Deletes a Space and every record that belongs to it. */
  deleteSpace(id: ID): boolean {
    const nextActive = this.state.spaces.find((s) => s.id !== id && s.status === 'active');
    if (!nextActive || !this.state.spaces.some((s) => s.id === id)) return false;
    const wasActive = this.state.activeSpaceId === id;
    this.persist(this.purgeSpaces([id]));
    if (wasActive) this.setActiveSpace(nextActive.id);
    return true;
  }

  // ── Transactions ─────────────────────────────────────────────────────────

  /** Checks a draft against the engine rules and the Space it claims to belong to. */
  private check(draft: TransactionDraft, editingId?: ID): string | null {
    // Transactions must belong to a Space the current user owns.
    if (!this.state.spaces.some((sp) => sp.id === draft.spaceId)) return 'That Space no longer exists.';
    if (!this.canEdit(draft.spaceId)) return VIEW_ONLY;
    const { accounts, categories, transactions, obligations } = this.state;
    return checkTransaction(draft, { accounts, categories, transactions, obligations }, editingId);
  }

  /*
   * Safe retries. Each action below that records money takes an optional
   * `requestId`: the id the new record will have. The screen picks it when it
   * opens, so pressing Save twice, or a network retry later, finds the record
   * already saved and returns it instead of recording the money twice.
   */
  private repeated(requestId: ID | undefined): Transaction | undefined {
    return requestId ? this.state.transactions.find((t) => t.id === requestId) : undefined;
  }

  /**
   * Adds the lines of an imported file to one account, all or nothing: if
   * any line breaks a money rule, nothing is added and the line is named.
   * Each line's id comes from its contents (see `planImport`), so a line that
   * is already here, from an earlier import of the same file, is skipped.
   * Everything goes in one save, which the server also checks as a whole.
   */
  importTransactions(
    spaceId: ID,
    accountId: ID,
    lines: { id: ID; line: number; date?: ISODate; description: string; amount?: number; type?: 'expense' | 'income'; categoryId?: ID; subcategoryId?: ID }[],
  ): Result<{ added: number; skipped: number }> {
    const space = this.state.spaces.find((sp) => sp.id === spaceId);
    if (!space) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    if (lines.length > MAX_IMPORT_ROWS) return { ok: false, error: `Import at most ${MAX_IMPORT_ROWS.toLocaleString('en')} lines at a time. Split the file and import each part.` };
    const have = new Set(this.state.transactions.map((t) => t.id));
    const now = stamp();
    const added: Transaction[] = [];
    let skipped = 0;
    for (const l of lines) {
      if (!l.id || !l.date || !l.amount || !l.type) return { ok: false, error: `Line ${l.line} cannot be imported.` };
      if (have.has(l.id)) {
        skipped++;
        continue;
      }
      const draft: TransactionDraft = {
        spaceId,
        accountId,
        type: l.type,
        amount: l.amount,
        date: l.date,
        description: l.description || (l.type === 'income' ? 'Money in' : 'Money out'),
        categoryId: l.categoryId,
        subcategoryId: l.subcategoryId,
      };
      const { accounts, categories, obligations } = this.state;
      const error = checkTransaction(draft, { accounts, categories, transactions: [...this.state.transactions, ...added], obligations });
      if (error) return { ok: false, error: `Line ${l.line}: ${error}` };
      added.push({ ...normalize(draft), id: l.id, currency: space.currency, createdAt: now, updatedAt: now, status: 'confirmed' });
      have.add(l.id);
    }
    if (added.length) {
      this.set({ transactions: [...this.state.transactions, ...added] });
      this.persist(this.storage.putMany('transactions', added));
    }
    return { ok: true, added: added.length, skipped };
  }

  addTransaction(draft: TransactionDraft, requestId?: ID): Result<{ transaction: Transaction }> {
    const repeat = this.repeated(requestId);
    if (repeat) return { ok: true, transaction: repeat };
    const error = this.check(draft);
    if (error) return { ok: false, error };
    const space = this.state.spaces.find((sp) => sp.id === draft.spaceId)!;
    const now = stamp();
    const transaction: Transaction = {
      ...normalize(draft),
      id: requestId ?? newId(),
      currency: space.currency,
      createdAt: now,
      updatedAt: now,
      status: 'confirmed',
    };
    this.set({ transactions: [...this.state.transactions, transaction] });
    this.save('transactions', transaction);
    return { ok: true, transaction };
  }

  updateTransaction(id: ID, draft: TransactionDraft): Result {
    const current = this.state.transactions.find((t) => t.id === id);
    if (!current) return { ok: false, error: 'That transaction no longer exists.' };
    if (draft.spaceId !== current.spaceId) return { ok: false, error: 'A transaction cannot be moved to another Space.' };
    // Links the form does not edit are carried over from the saved record.
    const merged: TransactionDraft = {
      ...draft,
      recurringId: draft.recurringId ?? current.recurringId,
      personId: draft.personId ?? current.personId,
      obligationId: draft.obligationId ?? current.obligationId,
      refundOfId: draft.refundOfId ?? current.refundOfId,
    };
    const error = this.check(merged, id);
    if (error) return { ok: false, error };
    const { id: _id, currency, createdAt, status } = current;
    const transaction: Transaction = { ...normalize(merged), id: _id, currency, createdAt, status, updatedAt: stamp() };
    this.set({ transactions: this.state.transactions.map((t) => (t.id === id ? transaction : t)) });
    this.save('transactions', transaction);
    return { ok: true };
  }

  /** Adds, changes or clears the note on a transaction without touching anything else. */
  setTransactionNotes(id: ID, notes: string): Result {
    const current = this.state.transactions.find((t) => t.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That transaction no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const transaction: Transaction = { ...current, notes: notes.trim() || undefined, updatedAt: stamp() };
    this.set({ transactions: this.state.transactions.map((t) => (t.id === id ? transaction : t)) });
    this.save('transactions', transaction);
    return { ok: true };
  }

  /** Why a transaction cannot be deleted yet, or null when it can. */
  deleteBlocker(id: ID): string | null {
    if (this.state.transactions.some((t) => t.refundOfId === id)) return 'This expense has a refund recorded against it. Delete the refund first.';
    if (this.state.obligations.some((o) => o.sourceTransactionId === id)) return 'Someone owes you a share of this expense. Remove that record first.';
    return null;
  }

  deleteTransaction(id: ID): Transaction | null {
    const current = this.state.transactions.find((t) => t.id === id);
    // Only records in the current user's Spaces can be removed.
    if (!current || !this.state.spaces.some((s) => s.id === current.spaceId)) return null;
    if (this.deleteBlocker(id)) return null;
    this.set({ transactions: this.state.transactions.filter((t) => t.id !== id) });
    this.persist(this.storage.remove('transactions', id));
    return current;
  }

  /** Puts back a transaction that was just deleted (undo). */
  restoreTransaction(transaction: Transaction) {
    if (this.state.transactions.some((t) => t.id === transaction.id)) return;
    if (!this.state.spaces.some((s) => s.id === transaction.spaceId)) return;
    this.set({ transactions: [...this.state.transactions, transaction] });
    this.save('transactions', transaction);
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  private ownsSpace(spaceId: ID) {
    return this.state.spaces.some((sp) => sp.id === spaceId);
  }

  /** The user's role in a Space: owner unless an account says otherwise. */
  roleIn(spaceId: ID | null | undefined): SpaceRole {
    return (spaceId && this.state.roles[spaceId]) || 'owner';
  }

  /** False in a Space the user may only view. */
  canEdit(spaceId: ID | null | undefined): boolean {
    return this.roleIn(spaceId) !== 'viewer';
  }

  private accountNameError(spaceId: ID, name: string, exceptId?: ID): string | null {
    if (!name) return 'Give this account a name.';
    const taken = this.state.accounts.some((acc) => acc.spaceId === spaceId && acc.id !== exceptId && acc.name.toLowerCase() === name.toLowerCase());
    return taken ? 'You already have an account with that name.' : null;
  }

  addAccount(spaceId: ID, draft: AccountDraft): Result<{ account: Account }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const name = draft.name.trim();
    const error = this.accountNameError(spaceId, name);
    if (error) return { ok: false, error };
    if (!isMinorAmount(draft.openingBalance)) return { ok: false, error: 'Enter a starting balance.' };
    const account: Account = { id: newId(), spaceId, name, kind: draft.kind, openingBalance: draft.openingBalance };
    this.set({ accounts: [...this.state.accounts, account] });
    this.save('accounts', account);
    return { ok: true, account };
  }

  updateAccount(id: ID, draft: AccountDraft): Result {
    const current = this.state.accounts.find((acc) => acc.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That account no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const name = draft.name.trim();
    const error = this.accountNameError(current.spaceId, name, id);
    if (error) return { ok: false, error };
    if (!isMinorAmount(draft.openingBalance)) return { ok: false, error: 'Enter a starting balance.' };
    const account: Account = { ...current, name, kind: draft.kind, openingBalance: draft.openingBalance };
    this.set({ accounts: this.state.accounts.map((acc) => (acc.id === id ? account : acc)) });
    this.save('accounts', account);
    return { ok: true };
  }

  /** True when any record still points at the account, so it cannot simply disappear. */
  accountInUse(id: ID): boolean {
    return this.state.transactions.some((t) => t.accountId === id || t.toAccountId === id) || this.state.recurring.some((r) => r.accountId === id);
  }

  private isLastActiveAccount(account: Account) {
    return !this.state.accounts.some((acc) => acc.spaceId === account.spaceId && acc.id !== account.id && !acc.archived);
  }

  setAccountArchived(id: ID, archived: boolean): Result {
    const current = this.state.accounts.find((acc) => acc.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That account no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (archived && this.isLastActiveAccount(current)) return { ok: false, error: 'Keep at least one account in this Space.' };
    if (archived && this.state.recurring.some((r) => r.accountId === id && r.status === 'active')) {
      return { ok: false, error: 'An upcoming payment still uses this account.' };
    }
    const account: Account = { ...current, archived: archived || undefined };
    this.set({ accounts: this.state.accounts.map((acc) => (acc.id === id ? account : acc)) });
    this.save('accounts', account);
    return { ok: true };
  }

  /** Removes an account that nothing refers to. Used accounts can only be archived. */
  deleteAccount(id: ID): Result {
    const current = this.state.accounts.find((acc) => acc.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That account no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (this.accountInUse(id)) return { ok: false, error: 'This account has transactions. Archive it instead.' };
    if (!current.archived && this.isLastActiveAccount(current)) return { ok: false, error: 'Keep at least one account in this Space.' };
    this.set({ accounts: this.state.accounts.filter((acc) => acc.id !== id) });
    this.persist(this.storage.remove('accounts', id));
    return { ok: true };
  }

  // ── Categories ───────────────────────────────────────────────────────────

  private categoryError(spaceId: ID, draft: CategoryDraft, exceptId?: ID): string | null {
    const name = draft.name.trim();
    if (!name) return 'Give this category a name.';
    const clash = this.state.categories.some((c) => c.spaceId === spaceId && c.kind === draft.kind && c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());
    if (clash) return 'You already have a category with that name.';
    const subs = draft.subcategories.map((sub) => sub.name.trim().toLowerCase()).filter(Boolean);
    if (new Set(subs).size !== subs.length) return 'Two subcategories have the same name.';
    return null;
  }

  private buildSubcategories(draft: CategoryDraft) {
    return draft.subcategories.map((sub) => ({ id: sub.id ?? newId(), name: sub.name.trim() })).filter((sub) => sub.name);
  }

  addCategory(spaceId: ID, draft: CategoryDraft): Result<{ category: Category }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.categoryError(spaceId, draft);
    if (error) return { ok: false, error };
    const category: Category = {
      id: newId(),
      spaceId,
      name: draft.name.trim(),
      kind: draft.kind,
      icon: draft.icon,
      color: draft.color,
      subcategories: this.buildSubcategories(draft),
      ...(draft.kind === 'expense' && draft.costType ? { costType: draft.costType } : {}),
    };
    this.set({ categories: [...this.state.categories, category] });
    this.save('categories', category);
    return { ok: true, category };
  }

  /** Renames or restyles a category. Its kind is fixed once it exists. */
  updateCategory(id: ID, draft: CategoryDraft): Result {
    const current = this.state.categories.find((c) => c.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That category no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const fixed = { ...draft, kind: current.kind };
    const error = this.categoryError(current.spaceId, fixed, id);
    if (error) return { ok: false, error };
    const category: Category = {
      ...current,
      name: draft.name.trim(),
      icon: draft.icon,
      color: draft.color,
      subcategories: this.buildSubcategories(fixed),
      costType: current.kind === 'expense' ? (draft.costType ?? current.costType) : undefined,
    };
    // Transactions that used a removed subcategory fall back to the category alone.
    const keptSubs = new Set(category.subcategories.map((sub) => sub.id));
    const touched = this.state.transactions
      .filter((t) => t.categoryId === id && t.subcategoryId && !keptSubs.has(t.subcategoryId))
      .map((t) => ({ ...t, subcategoryId: undefined }));
    this.replaceTransactions(touched);
    this.set({ categories: this.state.categories.map((c) => (c.id === id ? category : c)) });
    this.save('categories', category);
    return { ok: true };
  }

  /** Deletes a category. Anything filed under it becomes uncategorised; no money is lost. */
  deleteCategory(id: ID): Result<{ uncategorised: number }> {
    const current = this.state.categories.find((c) => c.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That category no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const touched = this.state.transactions.filter((t) => t.categoryId === id).map((t) => ({ ...t, categoryId: undefined, subcategoryId: undefined }));
    this.replaceTransactions(touched);
    const recurring = this.state.recurring.filter((r) => r.categoryId === id).map((r) => ({ ...r, categoryId: undefined }));
    if (recurring.length > 0) {
      const byId = new Map(recurring.map((r) => [r.id, r]));
      this.set({ recurring: this.state.recurring.map((r) => byId.get(r.id) ?? r) });
      this.persist(this.storage.putMany('recurring', recurring));
    }
    // A budget for a category that no longer exists would silently count nothing.
    const budgets = this.state.budgets.filter((b) => b.categoryId === id).map((b) => b.id);
    if (budgets.length > 0) {
      this.set({ budgets: this.state.budgets.filter((b) => b.categoryId !== id) });
      this.persist(this.storage.removeMany('budgets', budgets));
    }
    this.set({ categories: this.state.categories.filter((c) => c.id !== id) });
    this.persist(this.storage.remove('categories', id));
    return { ok: true, uncategorised: touched.length };
  }

  private replaceTransactions(changed: Transaction[]) {
    if (changed.length === 0) return;
    const byId = new Map(changed.map((t) => [t.id, t]));
    this.set({ transactions: this.state.transactions.map((t) => byId.get(t.id) ?? t) });
    this.persist(this.storage.putMany('transactions', changed));
  }

  // ── People and money owed ────────────────────────────────────────────────

  private personError(spaceId: ID, name: string, exceptId?: ID): string | null {
    if (!name) return 'Enter a name.';
    const taken = this.state.people.some((pp) => pp.spaceId === spaceId && pp.id !== exceptId && pp.name.toLowerCase() === name.toLowerCase());
    return taken ? 'You already have someone with that name.' : null;
  }

  addPerson(spaceId: ID, input: PersonDraft): Result<{ person: Person }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const name = input.name.trim();
    const error = this.personError(spaceId, name);
    if (error) return { ok: false, error };
    const person: Person = {
      id: newId(),
      spaceId,
      name,
      phone: input.phone?.trim() || undefined,
      email: input.email?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      role: input.role,
      createdAt: stamp(),
    };
    this.set({ people: [...this.state.people, person] });
    this.save('people', person);
    return { ok: true, person };
  }

  updatePerson(id: ID, input: PersonDraft): Result {
    const current = this.state.people.find((pp) => pp.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That person no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const name = input.name.trim();
    const error = this.personError(current.spaceId, name, id);
    if (error) return { ok: false, error };
    const person: Person = {
      ...current,
      name,
      phone: input.phone?.trim() || undefined,
      email: input.email?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      role: input.role ?? current.role,
    };
    this.set({ people: this.state.people.map((pp) => (pp.id === id ? person : pp)) });
    this.save('people', person);
    return { ok: true };
  }

  /** True when money has ever been recorded with this person. */
  personInUse(id: ID): boolean {
    return this.state.obligations.some((o) => o.personId === id) || this.state.transactions.some((t) => t.personId === id);
  }

  /** Removes a person with no history. Anyone with records stays, so their history keeps its name. */
  deletePerson(id: ID): Result {
    const current = this.state.people.find((pp) => pp.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That person no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (this.personInUse(id)) return { ok: false, error: 'There are records with this person, so they cannot be removed.' };
    this.set({ people: this.state.people.filter((pp) => pp.id !== id) });
    this.persist(this.storage.remove('people', id));
    return { ok: true };
  }

  /**
   * Records money owed. For loans, pass `accountId` to also record the money
   * changing hands; that movement is principal, never income or spending.
   */
  addObligation(draft: ObligationDraft, opening?: { accountId: ID }, requestId?: ID): Result<{ obligation: Obligation }> {
    const repeat = requestId ? this.state.obligations.find((o) => o.id === requestId) : undefined;
    if (repeat) return { ok: true, obligation: repeat };
    const space = this.state.spaces.find((sp) => sp.id === draft.spaceId);
    if (!space) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(draft.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (!isMinorAmount(draft.amount) || draft.amount <= 0) return { ok: false, error: 'Enter an amount greater than zero.' };
    const person = this.state.people.find((pp) => pp.id === draft.personId && pp.spaceId === draft.spaceId);
    if (!person) return { ok: false, error: 'Choose a person from this Space.' };
    const title = draft.title.trim();
    if (!title) return { ok: false, error: 'Add a short description.' };
    if (draft.sourceTransactionId) {
      const source = this.state.transactions.find((t) => t.id === draft.sourceTransactionId && t.spaceId === draft.spaceId);
      if (draft.kind !== 'receivable' || source?.type !== 'expense') return { ok: false, error: 'Only a share of an expense can be linked this way.' };
      // Shares can never add up to more than the expense they are part of.
      const left = source.amount - sharedAmount(source.id, this.state.obligations);
      if (draft.amount > left) return { ok: false, error: 'The shares add up to more than the expense itself.' };
    }
    const terms = this.termsError(draft);
    if (terms) return { ok: false, error: terms };
    const now = stamp();
    const obligation: Obligation = {
      ...draft,
      title,
      notes: draft.notes?.trim() || undefined,
      id: requestId ?? newId(),
      currency: space.currency,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.set({ obligations: [...this.state.obligations, obligation] });

    const type = openingType(draft.kind);
    if (opening && type) {
      const moved = this.addTransaction({
        spaceId: draft.spaceId,
        type,
        amount: draft.amount,
        date: draft.date,
        description: title,
        accountId: opening.accountId,
        personId: person.id,
        obligationId: obligation.id,
      });
      if (!moved.ok) {
        // Nothing was saved yet, so the half-made record is simply dropped.
        this.set({ obligations: this.state.obligations.filter((o) => o.id !== obligation.id) });
        return moved;
      }
    }
    this.save('obligations', obligation);
    return { ok: true, obligation };
  }

  /**
   * Records money paid against an obligation. The engine picks the type, so a
   * loan repayment can never be booked as income or as an ordinary expense.
   */
  settleObligation(
    id: ID,
    input: { amount: number; date: ISODate; accountId: ID; description?: string; categoryId?: ID; notes?: string },
    requestId?: ID,
  ): Result<{ transaction: Transaction }> {
    const repeat = this.repeated(requestId);
    if (repeat) return { ok: true, transaction: repeat };
    const o = this.state.obligations.find((item) => item.id === id);
    if (!o) return { ok: false, error: 'That record no longer exists.' };
    if (o.status === 'cancelled') return { ok: false, error: 'This was written off, so nothing more can be recorded against it.' };
    const type = settlementType(o);
    const source = o.sourceTransactionId ? this.state.transactions.find((t) => t.id === o.sourceTransactionId) : undefined;
    return this.addTransaction(
      {
        spaceId: o.spaceId,
        type,
        amount: input.amount,
        date: input.date,
        description: input.description?.trim() || o.title,
        accountId: input.accountId,
        personId: o.personId,
        obligationId: o.id,
        notes: input.notes,
        // A share of a cost comes back against that cost and its category.
        refundOfId: type === 'refund' ? source?.id : undefined,
        categoryId: type === 'refund' ? source?.categoryId : input.categoryId,
        subcategoryId: type === 'refund' ? source?.subcategoryId : undefined,
      },
      requestId,
    );
  }

  private termsError(o: Pick<Obligation, 'amount' | 'date'> & Partial<Pick<Obligation, 'dueDate' | 'interestRate' | 'instalmentAmount'>>): string | null {
    if (o.dueDate && o.dueDate < o.date) return 'The due date cannot be before the start date.';
    if (o.interestRate !== undefined && (!Number.isFinite(o.interestRate) || o.interestRate < 0 || o.interestRate > 1000)) return 'Enter the interest as a yearly percentage.';
    if (o.instalmentAmount !== undefined && (!isMinorAmount(o.instalmentAmount) || o.instalmentAmount <= 0 || o.instalmentAmount > o.amount)) {
      return 'An instalment must be more than zero and no more than the full amount.';
    }
    return null;
  }

  /** Changes the terms of an obligation. The amount can never drop below what has already been settled. */
  updateObligation(id: ID, patch: ObligationPatch): Result {
    const current = this.state.obligations.find((o) => o.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That record no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const title = patch.title.trim();
    if (!title) return { ok: false, error: 'Add a short description.' };
    if (!isMinorAmount(patch.amount) || patch.amount <= 0) return { ok: false, error: 'Enter an amount greater than zero.' };
    const { settled } = obligationPosition(current, this.state.transactions);
    if (patch.amount < settled) return { ok: false, error: 'The amount cannot be less than what has already been settled.' };
    const opens = openingType(current.kind);
    const handedOver = this.state.transactions.reduce((sum, t) => (t.obligationId === id && t.type === opens ? sum + t.amount : sum), 0);
    if (patch.amount < handedOver) return { ok: false, error: 'The amount cannot be less than the money already handed over.' };
    if (current.sourceTransactionId) {
      const source = this.state.transactions.find((t) => t.id === current.sourceTransactionId);
      if (source && patch.amount > source.amount - sharedAmount(source.id, this.state.obligations, id)) {
        return { ok: false, error: 'The shares add up to more than the expense itself.' };
      }
    }
    const terms = this.termsError(patch);
    if (terms) return { ok: false, error: terms };
    const hasInstalment = Boolean(patch.instalmentAmount);
    const obligation: Obligation = {
      ...current,
      title,
      amount: patch.amount,
      date: patch.date,
      dueDate: patch.dueDate || undefined,
      notes: patch.notes?.trim() || undefined,
      interestRate: patch.interestRate || undefined,
      instalmentAmount: hasInstalment ? patch.instalmentAmount : undefined,
      instalmentFrequency: hasInstalment ? (patch.instalmentFrequency ?? 'monthly') : undefined,
      updatedAt: stamp(),
    };
    this.set({ obligations: this.state.obligations.map((o) => (o.id === id ? obligation : o)) });
    this.save('obligations', obligation);
    return { ok: true };
  }

  /**
   * Records interest on a loan. Unlike a repayment it is real spending (or
   * income, on money you lent) and does not reduce what is owed.
   */
  recordInterest(id: ID, input: { amount: number; date: ISODate; accountId: ID; categoryId?: ID }, requestId?: ID): Result<{ transaction: Transaction }> {
    const o = this.state.obligations.find((item) => item.id === id);
    if (!o || (o.kind !== 'borrowed' && o.kind !== 'lent')) return { ok: false, error: 'Interest can only be recorded on a loan.' };
    return this.addTransaction(
      {
        spaceId: o.spaceId,
        type: o.kind === 'borrowed' ? 'expense' : 'income',
        amount: input.amount,
        date: input.date,
        description: `Interest: ${o.title}`,
        accountId: input.accountId,
        categoryId: input.categoryId,
        personId: o.personId,
        obligationId: o.id,
      },
      requestId,
    );
  }

  /**
   * Splits an expense you paid: each other person's share becomes money they
   * owe you. Nothing is saved unless every share is valid.
   */
  splitExpense(expenseId: ID, shares: { personId: ID; amount: number }[], dueDate?: ISODate): Result<{ count: number }> {
    const expense = this.state.transactions.find((t) => t.id === expenseId);
    if (expense?.type !== 'expense' || !this.ownsSpace(expense.spaceId)) return { ok: false, error: 'Only an expense can be shared.' };
    if (!this.canEdit(expense.spaceId)) return { ok: false, error: VIEW_ONLY };
    const valid = shares.filter((share) => share.amount > 0);
    if (valid.length === 0) return { ok: false, error: 'Choose at least one person to share this with.' };
    if (new Set(valid.map((share) => share.personId)).size !== valid.length) return { ok: false, error: 'Each person can only be added once.' };
    const total = valid.reduce((sum, share) => sum + share.amount, 0);
    const left = expense.amount - sharedAmount(expense.id, this.state.obligations);
    if (total > left + 1e-6) return { ok: false, error: 'The shares add up to more than the expense itself.' };
    const before = this.state.obligations;
    for (const share of valid) {
      const person = this.state.people.find((pp) => pp.id === share.personId);
      const result = this.addObligation({
        spaceId: expense.spaceId,
        kind: 'receivable',
        personId: share.personId,
        title: `${possessive(person?.name ?? 'Their')} share of ${expense.description || 'an expense'}`,
        amount: share.amount,
        date: expense.date,
        dueDate,
        sourceTransactionId: expense.id,
      });
      if (!result.ok) {
        // Undo the shares already made so a split is all or nothing.
        const made = this.state.obligations.filter((o) => !before.includes(o));
        this.set({ obligations: before });
        this.persist(
          this.storage.removeMany(
            'obligations',
            made.map((o) => o.id),
          ),
        );
        return result;
      }
    }
    return { ok: true, count: valid.length };
  }

  /** Writes off (or reopens) what is left of an obligation. Recorded payments stay as they are. */
  setObligationCancelled(id: ID, cancelled: boolean): Result {
    const current = this.state.obligations.find((o) => o.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That record no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const obligation: Obligation = { ...current, status: cancelled ? 'cancelled' : 'open', updatedAt: stamp() };
    this.set({ obligations: this.state.obligations.map((o) => (o.id === id ? obligation : o)) });
    this.save('obligations', obligation);
    return { ok: true };
  }

  /** Deletes an obligation nothing was ever recorded against. Otherwise write it off. */
  deleteObligation(id: ID): Result {
    const current = this.state.obligations.find((o) => o.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That record no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (this.state.transactions.some((t) => t.obligationId === id)) {
      return { ok: false, error: 'Money has been recorded against this. Write it off instead of deleting it.' };
    }
    this.set({ obligations: this.state.obligations.filter((o) => o.id !== id) });
    this.persist(this.storage.remove('obligations', id));
    return { ok: true };
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  private budgetError(spaceId: ID, draft: BudgetDraft): string | null {
    if (!draft.name.trim()) return 'Give this budget a name.';
    if (!isMinorAmount(draft.amount) || draft.amount <= 0) return 'Enter an amount greater than zero.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) return 'Choose a start date.';
    if (draft.frequency === 'custom' && !draft.endDate) return 'Choose an end date for this budget.';
    if (draft.endDate && draft.endDate < draft.startDate) return 'The end date cannot be before the start date.';
    if (draft.categoryId) {
      const category = this.state.categories.find((c) => c.id === draft.categoryId && c.spaceId === spaceId);
      if (category?.kind !== 'expense') return 'Choose a spending category from this Space.';
      if (draft.subcategoryId && !category.subcategories.some((sub) => sub.id === draft.subcategoryId)) return 'That subcategory no longer exists.';
    } else if (draft.subcategoryId) {
      return 'Choose a category first.';
    }
    return null;
  }

  private buildBudget(draft: BudgetDraft) {
    return {
      name: draft.name.trim(),
      amount: draft.amount,
      frequency: draft.frequency,
      startDate: draft.startDate,
      endDate: draft.endDate || undefined,
      categoryId: draft.categoryId || undefined,
      subcategoryId: draft.categoryId ? draft.subcategoryId || undefined : undefined,
    };
  }

  addBudget(spaceId: ID, draft: BudgetDraft): Result<{ budget: Budget }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.budgetError(spaceId, draft);
    if (error) return { ok: false, error };
    const budget: Budget = { ...this.buildBudget(draft), id: newId(), spaceId, createdAt: stamp() };
    this.set({ budgets: [...this.state.budgets, budget] });
    this.save('budgets', budget);
    return { ok: true, budget };
  }

  updateBudget(id: ID, draft: BudgetDraft): Result {
    const current = this.state.budgets.find((item) => item.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That budget no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.budgetError(current.spaceId, draft);
    if (error) return { ok: false, error };
    const budget: Budget = { ...this.buildBudget(draft), id, spaceId: current.spaceId, createdAt: current.createdAt };
    this.set({ budgets: this.state.budgets.map((item) => (item.id === id ? budget : item)) });
    this.save('budgets', budget);
    return { ok: true };
  }

  /** Removes a budget. Transactions are untouched: a budget only measures them. */
  deleteBudget(id: ID): Result {
    const current = this.state.budgets.find((item) => item.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That budget no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    this.set({ budgets: this.state.budgets.filter((item) => item.id !== id) });
    this.persist(this.storage.remove('budgets', id));
    return { ok: true };
  }

  // ── Goals ────────────────────────────────────────────────────────────────

  private goalError(draft: GoalDraft): string | null {
    if (!draft.name.trim()) return 'Give this goal a name.';
    if (!isMinorAmount(draft.targetAmount) || draft.targetAmount <= 0) return 'Enter a target greater than zero.';
    return null;
  }

  /** Creates a goal. `alreadySaved` records what was set aside before Finken, as its first entry. */
  addGoal(spaceId: ID, draft: GoalDraft, alreadySaved = 0): Result<{ goal: Goal }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.goalError(draft);
    if (error) return { ok: false, error };
    if (!isMinorAmount(alreadySaved) || alreadySaved < 0) return { ok: false, error: 'The amount already saved cannot be negative.' };
    const goal: Goal = {
      id: newId(),
      spaceId,
      name: draft.name.trim(),
      targetAmount: draft.targetAmount,
      targetDate: draft.targetDate || undefined,
      description: draft.description.trim(),
      icon: draft.icon,
      createdAt: stamp(),
    };
    this.set({ goals: [...this.state.goals, goal] });
    this.save('goals', goal);
    if (alreadySaved > 0) this.addGoalEntry(goal.id, { amount: alreadySaved, date: today(), note: 'Already saved' });
    return { ok: true, goal };
  }

  updateGoal(id: ID, draft: GoalDraft): Result {
    const current = this.state.goals.find((item) => item.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That goal no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.goalError(draft);
    if (error) return { ok: false, error };
    const goal: Goal = {
      ...current,
      name: draft.name.trim(),
      targetAmount: draft.targetAmount,
      targetDate: draft.targetDate || undefined,
      description: draft.description.trim(),
      icon: draft.icon,
    };
    this.set({ goals: this.state.goals.map((item) => (item.id === id ? goal : item)) });
    this.save('goals', goal);
    return { ok: true };
  }

  /** Deletes a goal and its entries. No account balance changes, because none ever did. */
  deleteGoal(id: ID): Result {
    const current = this.state.goals.find((item) => item.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That goal no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const entries = this.state.goalEntries.filter((e) => e.goalId === id).map((e) => e.id);
    this.set({ goals: this.state.goals.filter((item) => item.id !== id), goalEntries: this.state.goalEntries.filter((e) => e.goalId !== id) });
    this.persist(this.storage.remove('goals', id));
    this.persist(this.storage.removeMany('goalEntries', entries));
    return { ok: true };
  }

  /**
   * Sets money aside for a goal (positive) or takes it back out (negative).
   * This is an allocation only: no transaction is created and nothing is spent.
   */
  addGoalEntry(goalId: ID, input: { amount: number; date: ISODate; note?: string }, requestId?: ID): Result<{ entry: GoalEntry }> {
    const repeat = requestId ? this.state.goalEntries.find((e) => e.id === requestId) : undefined;
    if (repeat) return { ok: true, entry: repeat };
    const goal = this.state.goals.find((item) => item.id === goalId);
    if (!goal || !this.ownsSpace(goal.spaceId)) return { ok: false, error: 'That goal no longer exists.' };
    if (!this.canEdit(goal.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (!isMinorAmount(input.amount) || input.amount === 0) return { ok: false, error: 'Enter an amount greater than zero.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: 'Choose a date.' };
    const saved = goalSaved(goalId, this.state.goalEntries);
    if (input.amount < 0 && -input.amount > saved) return { ok: false, error: 'You cannot take out more than has been saved.' };
    const entry: GoalEntry = {
      id: requestId ?? newId(),
      spaceId: goal.spaceId,
      goalId,
      amount: input.amount,
      date: input.date,
      note: input.note?.trim() || undefined,
      createdAt: stamp(),
    };
    this.set({ goalEntries: [...this.state.goalEntries, entry] });
    this.save('goalEntries', entry);
    return { ok: true, entry };
  }

  /** Removes one entry, as long as the goal's saved total would not go below zero. */
  deleteGoalEntry(id: ID): Result {
    const entry = this.state.goalEntries.find((e) => e.id === id);
    if (!entry || !this.ownsSpace(entry.spaceId)) return { ok: false, error: 'That entry no longer exists.' };
    if (!this.canEdit(entry.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (goalSaved(entry.goalId, this.state.goalEntries) - entry.amount < 0) {
      return { ok: false, error: 'Removing this would leave less than zero saved. Remove a withdrawal first.' };
    }
    this.set({ goalEntries: this.state.goalEntries.filter((e) => e.id !== id) });
    this.persist(this.storage.remove('goalEntries', id));
    return { ok: true };
  }

  // ── Recurring commitments ────────────────────────────────────────────────

  private recurringError(spaceId: ID, draft: RecurringDraft): string | null {
    if (!draft.name.trim()) return 'Give this a name.';
    if (!isMinorAmount(draft.amount) || draft.amount <= 0) return 'Enter an amount greater than zero.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) return 'Choose a start date.';
    if (draft.endDate && draft.endDate < draft.startDate) return 'The end date cannot be before the start date.';
    if (draft.frequency === 'custom' && !(Number.isInteger(draft.intervalDays) && draft.intervalDays! >= 1 && draft.intervalDays! <= 3650)) {
      return 'Enter how many days apart it repeats.';
    }
    if (draft.reminderDays !== undefined && !(Number.isInteger(draft.reminderDays) && draft.reminderDays >= 0 && draft.reminderDays <= 60)) {
      return 'A reminder can be up to 60 days before.';
    }
    if (!this.state.accounts.some((acc) => acc.id === draft.accountId && acc.spaceId === spaceId)) return 'Choose an account from this Space.';
    if (draft.obligationId) {
      const o = this.state.obligations.find((item) => item.id === draft.obligationId && item.spaceId === spaceId);
      if (!o) return 'The record this pays towards no longer exists.';
      const paying = o.kind === 'borrowed' || o.kind === 'payable';
      if (paying !== (draft.type === 'expense')) return 'That record does not match the direction of this payment.';
    } else if (draft.categoryId) {
      const category = this.state.categories.find((c) => c.id === draft.categoryId && c.spaceId === spaceId);
      if (!category || category.kind !== draft.type) return draft.type === 'income' ? 'Choose an income category.' : 'Choose a spending category.';
    }
    return null;
  }

  private buildRecurring(draft: RecurringDraft) {
    return {
      name: draft.name.trim(),
      amount: draft.amount,
      type: draft.type,
      accountId: draft.accountId,
      frequency: draft.frequency,
      intervalDays: draft.frequency === 'custom' ? draft.intervalDays : undefined,
      startDate: draft.startDate,
      endDate: draft.endDate || undefined,
      reminderDays: draft.reminderDays,
      obligationId: draft.obligationId || undefined,
      // A payment towards a loan takes its meaning from the loan, not a category.
      categoryId: draft.obligationId ? undefined : draft.categoryId || undefined,
    };
  }

  addRecurring(spaceId: ID, draft: RecurringDraft): Result<{ recurring: Recurring }> {
    if (!this.ownsSpace(spaceId)) return { ok: false, error: 'That Space no longer exists.' };
    if (!this.canEdit(spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.recurringError(spaceId, draft);
    if (error) return { ok: false, error };
    const recurring: Recurring = { ...this.buildRecurring(draft), id: newId(), spaceId, nextDueDate: draft.startDate, status: 'active' };
    this.set({ recurring: [...this.state.recurring, recurring] });
    this.save('recurring', recurring);
    return { ok: true, recurring };
  }

  /** Changes a recurring item. Pass `nextDueDate` to move the next occurrence. */
  updateRecurring(id: ID, draft: RecurringDraft, nextDueDate?: ISODate): Result {
    const current = this.state.recurring.find((r) => r.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That item no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const error = this.recurringError(current.spaceId, draft);
    if (error) return { ok: false, error };
    const next = nextDueDate ?? current.nextDueDate;
    if (next < draft.startDate) return { ok: false, error: 'The next due date cannot be before the start date.' };
    if (draft.endDate && next > draft.endDate) return { ok: false, error: 'The next due date is after the end date.' };
    const recurring: Recurring = { ...this.buildRecurring(draft), id, spaceId: current.spaceId, nextDueDate: next, status: current.status === 'ended' ? 'active' : current.status };
    this.set({ recurring: this.state.recurring.map((r) => (r.id === id ? recurring : r)) });
    this.save('recurring', recurring);
    return { ok: true };
  }

  /** Pauses, resumes or cancels. A resumed item skips any dates it missed while stopped. */
  setRecurringStatus(id: ID, status: 'active' | 'paused' | 'cancelled'): Result {
    const current = this.state.recurring.find((r) => r.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That item no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    let nextDueDate = current.nextDueDate;
    if (status === 'active' && current.status !== 'active' && nextDueDate < today()) {
      nextDueDate = nextRecurringDate(current, addDaysISO(today(), -1));
      if (current.endDate && nextDueDate > current.endDate) return { ok: false, error: 'This has passed its end date. Edit the end date to resume it.' };
    }
    const recurring: Recurring = { ...current, status, nextDueDate };
    this.set({ recurring: this.state.recurring.map((r) => (r.id === id ? recurring : r)) });
    this.save('recurring', recurring);
    return { ok: true };
  }

  /** Removes a recurring item. Transactions already confirmed from it are kept. */
  deleteRecurring(id: ID): Result {
    const current = this.state.recurring.find((r) => r.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That item no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    this.set({ recurring: this.state.recurring.filter((r) => r.id !== id) });
    this.persist(this.storage.remove('recurring', id));
    return { ok: true };
  }

  /** Moves an item on to its following date, ending it when that passes the end date. */
  private advanceRecurring(item: Recurring) {
    const nextDueDate = nextRecurringDate(item, item.nextDueDate);
    const next: Recurring = item.endDate && nextDueDate > item.endDate ? { ...item, status: 'ended', snoozedUntil: undefined } : { ...item, nextDueDate, snoozedUntil: undefined };
    this.set({ recurring: this.state.recurring.map((r) => (r.id === item.id ? next : r)) });
    this.save('recurring', next);
  }

  /** Hides the reminder for a recurring item or obligation until `until`. Pass null to bring it back. */
  snoozeReminder(source: 'recurring' | 'obligation', id: ID, until: ISODate | null): Result {
    if (source === 'recurring') {
      const current = this.state.recurring.find((r) => r.id === id);
      if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That item no longer exists.' };
      if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
      const next: Recurring = { ...current, snoozedUntil: until ?? undefined };
      this.set({ recurring: this.state.recurring.map((r) => (r.id === id ? next : r)) });
      this.save('recurring', next);
      return { ok: true };
    }
    const current = this.state.obligations.find((o) => o.id === id);
    if (!current || !this.ownsSpace(current.spaceId)) return { ok: false, error: 'That record no longer exists.' };
    if (!this.canEdit(current.spaceId)) return { ok: false, error: VIEW_ONLY };
    const next: Obligation = { ...current, snoozedUntil: until ?? undefined };
    this.set({ obligations: this.state.obligations.map((o) => (o.id === id ? next : o)) });
    this.save('obligations', next);
    return { ok: true };
  }

  /** Skips one occurrence without recording anything. */
  skipRecurring(id: ID): Result {
    const item = this.state.recurring.find((r) => r.id === id);
    if (!item || !this.ownsSpace(item.spaceId)) return { ok: false, error: 'That item no longer exists.' };
    if (!this.canEdit(item.spaceId)) return { ok: false, error: VIEW_ONLY };
    this.advanceRecurring(item);
    return { ok: true };
  }

  /**
   * Confirms an expected payment: records the real transaction and moves the
   * commitment to its next due date. Nothing is ever paid automatically.
   */
  confirmRecurring(id: ID, date: ISODate = today(), amount?: number, requestId?: ID): Result<{ transaction: Transaction }> {
    const repeat = this.repeated(requestId);
    if (repeat) return { ok: true, transaction: repeat };
    const item = this.state.recurring.find((r) => r.id === id);
    if (!item || !this.ownsSpace(item.spaceId)) return { ok: false, error: 'That item no longer exists.' };
    if (!this.canEdit(item.spaceId)) return { ok: false, error: VIEW_ONLY };
    if (item.status !== 'active') return { ok: false, error: 'Resume this item before marking it paid.' };
    const value = amount ?? item.amount;
    const linked = item.obligationId ? this.state.obligations.find((o) => o.id === item.obligationId) : undefined;
    const result = linked
      ? this.settleObligation(linked.id, { amount: value, date, accountId: item.accountId, description: item.name }, requestId)
      : this.addTransaction(
          {
            spaceId: item.spaceId,
            type: item.type,
            amount: value,
            date,
            description: item.name,
            accountId: item.accountId,
            categoryId: item.categoryId,
            recurringId: item.id,
          },
          requestId,
        );
    if (!result.ok) return result;
    this.advanceRecurring(item);
    return { ok: true, transaction: result.transaction };
  }
}

function addDaysISO(iso: ISODate, days: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Strips every field a transaction of this type must not carry. */
function normalize(draft: TransactionDraft): TransactionDraft {
  const isTransfer = draft.type === 'transfer';
  const categorised = !isTransfer && !isPrincipal(draft.type);
  return {
    ...draft,
    description: draft.description.trim(),
    notes: draft.notes?.trim() || undefined,
    categoryId: categorised ? draft.categoryId || undefined : undefined,
    subcategoryId: categorised && draft.categoryId ? draft.subcategoryId || undefined : undefined,
    toAccountId: isTransfer ? draft.toAccountId : undefined,
    refundOfId: draft.type === 'refund' ? draft.refundOfId || undefined : undefined,
    obligationId: isTransfer ? undefined : draft.obligationId || undefined,
    personId: isTransfer ? undefined : draft.personId || undefined,
    recurringId: draft.type === 'expense' || draft.type === 'income' ? draft.recurringId : undefined,
  };
}

/** "Ahmed's", "Anas'", and "Their" left as it is. */
function possessive(name: string): string {
  if (name === 'Their') return name;
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function sortSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
}

/** The app's one store: on the account's server when account mode is on, otherwise in this browser. */
export const store = account ? new AppStore(account.storage, account.auth) : new AppStore();
