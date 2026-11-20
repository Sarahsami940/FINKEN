/**
 * Moving data saved in this browser into a Finken account.
 *
 * Before accounts lived on the server, everything was saved in this browser:
 * a guest's Spaces, and the Spaces of any accounts created on this device.
 * This moves chosen Spaces into the signed-in account, safely:
 *
 * - **One Space at a time, all or nothing.** Each Space and everything in it is
 *   sent as one batch. The server runs the same money rules as on every save,
 *   and either keeps the whole Space or none of it.
 * - **Checked after moving.** Every record is read back from the account and
 *   compared with this device's copy, figure by figure. Only a Space that
 *   matches is marked as moved.
 * - **Safe to repeat.** Ids stay the same, so trying again after a lost
 *   connection never makes a second copy. A Space already moved is skipped,
 *   and an edit made in the account since then is never overwritten.
 * - **Nothing is deleted** from this device unless the person asks, and only
 *   for Spaces that were moved and checked.
 * - **Other people's data stays theirs.** Spaces of an account created on this
 *   device can only be moved after entering that account's password.
 */
import { totalBalance } from '@finken/domain/money';
import type { Account, ID, Space, Transaction, User } from '@finken/domain/types';
import { MONEY_FIELDS } from '@finken/domain/units';
import { type ApiClient, ApiError } from './api';
import { GUEST_ID, LocalAuthService } from './auth';
import { AuditedStorage, type CollectionName, type Entity, type StorageAdapter } from './storage';

/** Every kind of record that lives in a Space, in the order a batch lists them. */
export const SPACE_COLLECTIONS = ['spaces', 'accounts', 'categories', 'people', 'obligations', 'recurring', 'transactions', 'budgets', 'goals', 'goalEntries'] as const;
export type SpaceCollection = (typeof SPACE_COLLECTIONS)[number];

/** The most records of one kind the server takes in one batch. */
export const MAX_PER_KIND = 5000;

/** Kept by the server itself, so never compared. */
const SERVER_FIELDS = new Set(['ownerId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'version', 'deletedAt', 'deletedBy', 'editedAt']);

const MOVED_KEY = (spaceId: ID) => `moved:${spaceId}`;
const BACKUP_FORMAT = 'finken-backup';

export interface LocalOwner {
  id: ID;
  name: string;
  email?: string;
  isGuest: boolean;
  /** An account created on this device: its password is needed before its Spaces can be moved. */
  locked: boolean;
}

export interface MovedMark {
  /** The account it was moved to. */
  userId: ID;
  at: string;
}

export interface LocalSpace {
  space: Space;
  owner: LocalOwner;
  /** Records in the Space, by kind (the Space itself not counted). */
  counts: Partial<Record<SpaceCollection, number>>;
  /** Still the sample data Finken starts a guest with (it may have been edited). */
  sample: boolean;
  moved: MovedMark | null;
}

export type SpaceRecords = Record<SpaceCollection, Entity[]>;

export interface MoveResult {
  spaceId: ID;
  name: string;
  status: 'moved' | 'already' | 'failed';
  /** Why it failed, in words the person can act on. */
  message?: string;
  counts?: Partial<Record<SpaceCollection, number>>;
  /** The Space's total balance, the same on this device and in the account. */
  balance?: number;
  currency?: string;
  /** Records the account already had a later edit of; the account's version was kept. */
  keptNewer?: number;
}

const isSample = (id: ID) => /^sp-[0-9a-f]{8}-(personal|business|family)$/.test(id);

const recordsOf = <T extends Entity>(rows: T[], spaceId: ID, kind: SpaceCollection) =>
  kind === 'spaces' ? rows.filter((r) => r.id === spaceId) : rows.filter((r) => (r as { spaceId?: ID }).spaceId === spaceId);

/** A record named the way the person would recognise it. */
function describe(kind: SpaceCollection, record: Entity | undefined): string {
  const r = (record ?? {}) as unknown as Record<string, unknown>;
  const name = (r.description || r.name || r.title || r.note) as string | undefined;
  const what: Record<SpaceCollection, string> = {
    spaces: 'The Space',
    accounts: 'An account',
    categories: 'A category',
    people: 'A person',
    obligations: 'Money owed',
    recurring: 'A recurring item',
    transactions: 'A transaction',
    budgets: 'A budget',
    goals: 'A goal',
    goalEntries: 'A goal entry',
  };
  if (!record) return what[kind];
  const label = name ? `"${name}"` : what[kind].replace(/^An? /, '').replace(/^The /, '');
  return r.date ? `${label} on ${r.date}` : label;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What differs between this device's copy of a record and the account's, or null when they match. */
function difference(kind: SpaceCollection, local: Entity, server: Entity | undefined): string | null {
  if (!server || (server as { deletedAt?: string }).deletedAt) return 'is missing from the account';
  const l = local as unknown as Record<string, unknown>;
  const s = server as unknown as Record<string, unknown>;
  // Everything the account stored must be what this device has.
  for (const [key, value] of Object.entries(s)) {
    if (SERVER_FIELDS.has(key) || key === 'id') continue;
    const mine = l[key];
    // Fields left empty here are stored with their usual empty value.
    if ((mine === undefined || mine === null) && (value === '' || value === false)) continue;
    if (!same(mine, value)) return `has a different ${key}`;
  }
  // And nothing that carries money or a link may have been lost on the way.
  const money: readonly string[] = (MONEY_FIELDS as Record<string, readonly string[]>)[kind] ?? [];
  for (const key of Object.keys(l)) {
    if (SERVER_FIELDS.has(key) || l[key] === undefined || l[key] === null) continue;
    if ((money.includes(key) || key.endsWith('Id')) && !(key in s)) return `lost its ${key}`;
  }
  return null;
}

export class LocalDataMover {
  /** This browser's saved data with deleted records hidden, as the app saw it. */
  private view: StorageAdapter;
  private localAuth: LocalAuthService;
  private unlocked = new Set<ID>([GUEST_ID]);

  constructor(
    /** This browser's saved data (the database Finken used before accounts). */
    private local: StorageAdapter,
    private api: ApiClient,
    private clock: () => Date = () => new Date(),
  ) {
    this.view = new AuditedStorage(local, () => undefined);
    this.localAuth = new LocalAuthService(local);
  }

  private async marks(): Promise<Map<ID, MovedMark>> {
    const meta = await this.local.getAll<Entity & { value: string }>('meta');
    const out = new Map<ID, MovedMark>();
    for (const m of meta) {
      if (!m.id.startsWith('moved:')) continue;
      try {
        out.set(m.id.slice('moved:'.length), JSON.parse(m.value) as MovedMark);
      } catch {
        // An unreadable mark counts as not moved: moving again is safe.
      }
    }
    return out;
  }

  /** Every Space saved in this browser, with who made it and whether it has been moved. */
  async list(): Promise<LocalSpace[]> {
    const [spaces, users, credentials, marks] = await Promise.all([
      this.view.getAll<Space>('spaces'),
      this.local.getAll<User>('users'),
      this.local.getAll<Entity>('credentials'),
      this.marks(),
    ]);
    const all = Object.fromEntries(await Promise.all(SPACE_COLLECTIONS.filter((c) => c !== 'spaces').map(async (c) => [c, await this.view.getAll(c)] as const))) as Record<
      SpaceCollection,
      Entity[]
    >;
    const withPassword = new Set(credentials.map((c) => c.id));
    const owners = new Map(users.map((u) => [u.id, u]));
    return spaces
      .map((space) => {
        // Spaces saved before accounts existed belong to the guest.
        const ownerId = space.ownerId || GUEST_ID;
        const user = owners.get(ownerId);
        const owner: LocalOwner = {
          id: ownerId,
          name: user?.name ?? '',
          email: user?.email,
          isGuest: ownerId === GUEST_ID || Boolean(user?.isGuest),
          locked: withPassword.has(ownerId) && !this.unlocked.has(ownerId),
        };
        const counts: LocalSpace['counts'] = {};
        for (const c of SPACE_COLLECTIONS) {
          if (c === 'spaces') continue;
          const n = all[c].filter((r) => (r as { spaceId?: ID }).spaceId === space.id).length;
          if (n) counts[c] = n;
        }
        return { space, owner, counts, sample: isSample(space.id), moved: marks.get(space.id) ?? null };
      })
      .sort((a, b) => Number(a.owner.isGuest) - Number(b.owner.isGuest) || a.space.createdAt.localeCompare(b.space.createdAt));
  }

  /**
   * Proves the person may move an account's Spaces: the password of the
   * account made on this device. Returns that account's id.
   */
  async unlock(email: string, password: string): Promise<ID> {
    const user = await this.localAuth.login(email, password);
    this.unlocked.add(user.id);
    return user.id;
  }

  /** Every record in one Space, as this device has it. */
  async read(spaceId: ID): Promise<SpaceRecords> {
    const out = {} as SpaceRecords;
    for (const c of SPACE_COLLECTIONS) out[c] = recordsOf(await this.view.getAll(c), spaceId, c);
    return out;
  }

  /** A file with everything in these Spaces, to keep before moving. */
  async backup(spaceIds: ID[]): Promise<string> {
    const spaces = [];
    for (const id of spaceIds) spaces.push(await this.read(id));
    return JSON.stringify({ format: BACKUP_FORMAT, version: 1, savedAt: this.clock().toISOString(), spaces }, null, 2);
  }

  /** Moves these Spaces into the signed-in account, one at a time. Reports on each. */
  async move(spaceIds: ID[], onProgress?: (done: number, total: number) => void): Promise<MoveResult[]> {
    const me = await this.api.request<{ id: ID }>('GET', '/v1/me');
    const listed = new Map((await this.list()).map((s) => [s.space.id, s]));
    const results: MoveResult[] = [];
    for (const [i, id] of spaceIds.entries()) {
      onProgress?.(i, spaceIds.length);
      const entry = listed.get(id);
      results.push(entry ? await this.moveOne(entry, me.id) : { spaceId: id, name: '', status: 'failed', message: 'This Space is no longer saved on this device.' });
    }
    onProgress?.(spaceIds.length, spaceIds.length);
    return results;
  }

  private async moveOne({ space, owner, moved }: LocalSpace, userId: ID): Promise<MoveResult> {
    const base = { spaceId: space.id, name: space.name, currency: space.currency };
    const fail = (message: string): MoveResult => ({ ...base, status: 'failed', message });
    if (moved?.userId === userId) return { ...base, status: 'already' };
    if (moved) return fail('This Space was already moved to a different Finken account.');
    if (owner.locked) return fail(`Enter the password for ${owner.email ?? 'the account that made it'} first.`);

    const records = await this.read(space.id);
    const big = SPACE_COLLECTIONS.find((c) => records[c].length > MAX_PER_KIND);
    if (big) return fail(`This Space has more than ${MAX_PER_KIND.toLocaleString('en')} ${big} to move at once. Contact support and we will move it for you.`);

    // The edits were made when they were saved here, not now: an edit made
    // in the account since then is later, and wins.
    const now = this.clock().getTime();
    let latest = 0;
    for (const c of SPACE_COLLECTIONS) {
      for (const r of records[c] as { updatedAt?: string; createdAt?: string }[]) {
        const t = Date.parse(r.updatedAt ?? r.createdAt ?? '');
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    }
    latest = latest ? Math.min(latest, now) : now;

    const puts = Object.fromEntries(SPACE_COLLECTIONS.filter((c) => records[c].length).map((c) => [c, records[c]]));
    let superseded: Partial<Record<CollectionName, string[]>> = {};
    try {
      const answer = await this.api.request<{ superseded?: Partial<Record<CollectionName, string[]>> }>('POST', '/v1/batch', {
        editedAt: new Date(latest).toISOString(),
        puts,
        deletes: {},
      });
      superseded = answer.superseded ?? {};
    } catch (err) {
      if (!(err instanceof ApiError)) return fail('Finken could not reach its server. Nothing in this Space was moved; try again when you are back online.');
      if (err.status === 401) return fail('Your sign-in has ended. Sign in again, then try again.');
      if (err.status === 403) return fail('This Space is already in another Finken account, so it cannot be moved into this one.');
      if (err.status >= 500 || err.status === 429) return fail('Finken’s server is busy. Nothing in this Space was moved; try again in a few minutes.');
      const kind = err.where?.collection as SpaceCollection | undefined;
      const which =
        kind && err.where?.id && records[kind]
          ? `${describe(
              kind,
              records[kind].find((r) => r.id === err.where?.id),
            )}: `
          : '';
      if (err.status === 400) {
        const field = err.message.split(':')[0];
        return fail(
          `Nothing in this Space was moved. ${which ? which.slice(0, -2) : 'A record'} was saved by an older version of Finken in a form the account cannot take (${field}). Contact support and we will move it for you.`,
        );
      }
      return fail(`Nothing in this Space was moved. ${which}${err.message} Fix it in Finken on this device, then try again.`);
    }

    // Read everything back and compare it with this device's copy.
    const keptNewer = new Set(Object.values(superseded).flat());
    const server = {} as SpaceRecords;
    for (const c of SPACE_COLLECTIONS) {
      const ids = records[c].map((r) => r.id);
      server[c] = ids.length ? (await this.api.request<{ records: Entity[] }>('POST', `/v1/records/${c}/get`, { ids })).records : [];
      const byId = new Map(server[c].map((r) => [r.id, r]));
      for (const record of records[c]) {
        if (keptNewer.has(record.id)) continue;
        const problem = difference(c, record, byId.get(record.id));
        if (problem) return fail(`The account's copy did not match this device: ${describe(c, record)} ${problem}. Nothing was removed from this device; try again.`);
      }
    }
    const balance = totalBalance(records.accounts as Account[], records.transactions as Transaction[]);
    if (!keptNewer.size && balance !== totalBalance(server.accounts as Account[], server.transactions as Transaction[])) {
      return fail('The balances in the account did not match this device. Nothing was removed from this device; try again.');
    }

    const mark: MovedMark = { userId, at: this.clock().toISOString() };
    await this.local.put('meta', { id: MOVED_KEY(space.id), value: JSON.stringify(mark) });
    const counts: MoveResult['counts'] = {};
    for (const c of SPACE_COLLECTIONS) if (c !== 'spaces' && records[c].length) counts[c] = records[c].length;
    return { ...base, status: 'moved', counts, balance, keptNewer: keptNewer.size };
  }

  /**
   * Removes moved Spaces from this device for good. Only Spaces that were
   * moved and checked are touched; they stay in the account.
   */
  async forget(spaceIds: ID[]): Promise<number> {
    const marks = await this.marks();
    const ids = spaceIds.filter((id) => marks.has(id));
    for (const id of ids) {
      for (const c of [...SPACE_COLLECTIONS].reverse()) {
        // Deleted records too: nothing of the Space stays behind.
        const rows = recordsOf(await this.local.getAll(c), id, c).map((r) => r.id);
        // This is the raw saved data, so removing here really removes.
        if (rows.length) await this.local.removeMany(c, rows);
      }
    }
    return ids.length;
  }
}
