/**
 * Sharing a Space (Business Mode's team members, or a family).
 *
 * - **Roles.** owner: everything, including who else is in the Space.
 *   editor: adds and changes records (staff, a partner, an accountant).
 *   viewer: sees records and reports, changes nothing. The batch endpoint
 *   enforces these on every save (records.ts); this file manages who has
 *   which.
 * - **Invites.** The owner makes a one-person invite with a role. Its code
 *   works once, within 7 days, and only its hash is stored.
 * - **Joining.** The new member gets every record of the Space through the
 *   ordinary change feed: joining gives the Space's records new change
 *   numbers, so a device that already synced past them still receives them.
 * - **Leaving.** A member who leaves or is removed no longer sees the Space;
 *   the change feed's list of memberships tells their devices to remove it.
 */

import { hashCode, newInviteCode } from './beta';
import { COLLECTION_NAMES, COLLECTIONS } from './collections';
import type { Db } from './db';
import type { Role } from './records';

export const INVITE_DAYS = 7;

export class SharingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const NOT_FOUND = 'That Space could not be found, or you cannot manage who is in it.';
const BAD_CODE = 'That invite is not right, has been used, or has expired. Ask the Space’s owner for a new one.';

async function roleIn(db: Db, spaceId: string, userId: string): Promise<Role | null> {
  const [row] = await db.query<{ role: Role }>(
    'select m.role from space_members m join spaces s on s.id = m.space_id where m.space_id = $1 and m.user_id = $2 and s.deleted_at is null',
    [spaceId, userId],
  );
  return row?.role ?? null;
}

async function mustOwn(db: Db, spaceId: string, userId: string) {
  if ((await roleIn(db, spaceId, userId)) !== 'owner') throw new SharingError(NOT_FOUND, 404);
}

/** Every record of the Space takes a new change number, so new members' devices receive them. */
async function resend(tx: Db, spaceId: string) {
  for (const name of COLLECTION_NAMES) {
    const scope = name === 'spaces' ? 'id' : 'space_id';
    await tx.query(`update ${COLLECTIONS[name].table} set ${scope} = ${scope} where ${scope} = $1`, [spaceId]);
  }
}

export interface Member {
  userId: string;
  name: string;
  /** Shown to the owner only. */
  email: string | null;
  role: Role;
  since: string;
  you: boolean;
}

/** Who is in the Space. Any member can see the names and roles; only the owner sees emails. */
export async function listMembers(db: Db, spaceId: string, userId: string): Promise<Member[]> {
  const mine = await roleIn(db, spaceId, userId);
  if (!mine) throw new SharingError(NOT_FOUND, 404);
  const rows = await db.query<{ user_id: string; name: string; email: string | null; role: Role; since: string }>(
    `select m.user_id, u.name, u.email, m.role, to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD') as since
     from space_members m join users u on u.id = m.user_id where m.space_id = $1
     order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end, m.created_at`,
    [spaceId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: mine === 'owner' || r.user_id === userId ? r.email : null,
    role: r.role,
    since: r.since,
    you: r.user_id === userId,
  }));
}

export interface Invite {
  id: number;
  role: 'editor' | 'viewer';
  createdAt: string;
  expiresAt: string;
}

/** A new invite for one person. The code is returned once and never stored. */
export async function createInvite(db: Db, spaceId: string, userId: string, role: 'editor' | 'viewer', make = newInviteCode): Promise<Invite & { code: string }> {
  await mustOwn(db, spaceId, userId);
  const open = await db.query('select id from space_invites where space_id = $1 and used_at is null and revoked_at is null and expires_at > now()', [spaceId]);
  if (open.length >= 20) throw new SharingError('This Space already has 20 invites waiting. Cancel some first.', 409);
  // Space invites start SPC-, so nobody mistakes one for a beta invite.
  const code = make().replace(/^FNK-/, 'SPC-');
  const [row] = await db.query<{ id: string; created_at: string; expires_at: string }>(
    `insert into space_invites (space_id, code_hash, role, created_by, expires_at) values ($1, $2, $3, $4, now() + make_interval(days => $5::int))
     returning id::text, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at`,
    [spaceId, hashCode(code), role, userId, INVITE_DAYS],
  );
  return { id: Number(row.id), role, createdAt: row.created_at, expiresAt: row.expires_at, code };
}

/** Invites not yet used, for the owner. */
export async function listInvites(db: Db, spaceId: string, userId: string): Promise<Invite[]> {
  await mustOwn(db, spaceId, userId);
  const rows = await db.query<{ id: string; role: 'editor' | 'viewer'; created_at: string; expires_at: string }>(
    `select id::text, role, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires_at
     from space_invites where space_id = $1 and used_at is null and revoked_at is null and expires_at > now() order by id`,
    [spaceId],
  );
  return rows.map((r) => ({ id: Number(r.id), role: r.role, createdAt: r.created_at, expiresAt: r.expires_at }));
}

export async function cancelInvite(db: Db, spaceId: string, userId: string, inviteId: number): Promise<void> {
  await mustOwn(db, spaceId, userId);
  const rows = await db.query('update space_invites set revoked_at = now() where id = $1 and space_id = $2 and used_at is null and revoked_at is null returning id', [
    inviteId,
    spaceId,
  ]);
  if (!rows.length) throw new SharingError('That invite was already used or cancelled.', 404);
}

/** Joins the Space an invite is for. The same answer for every code that does not work. */
export async function joinSpace(db: Db, userId: string, code: string): Promise<{ spaceId: string; name: string; role: Role; already: boolean }> {
  return db.transaction(async (tx) => {
    // The batch lock: new change numbers must not interleave with a batch being written.
    await tx.query('select pg_advisory_xact_lock(7240)');
    const [invite] = await tx.query<{ id: string; space_id: string; role: 'editor' | 'viewer'; name: string }>(
      `select i.id::text, i.space_id, i.role, s.name from space_invites i join spaces s on s.id = i.space_id
       where i.code_hash = $1 and i.used_at is null and i.revoked_at is null and i.expires_at > now() and s.deleted_at is null for update of i`,
      [hashCode(code)],
    );
    if (!invite) throw new SharingError(BAD_CODE, 400);
    const current = await roleIn(tx, invite.space_id, userId);
    // Already in: the invite stays unused for whoever it was really meant for.
    if (current) return { spaceId: invite.space_id, name: invite.name, role: current, already: true };
    await tx.query('update space_invites set used_at = now(), used_by = $2 where id = $1', [invite.id, userId]);
    await tx.query('insert into space_members (space_id, user_id, role) values ($1, $2, $3)', [invite.space_id, userId, invite.role]);
    await resend(tx, invite.space_id);
    return { spaceId: invite.space_id, name: invite.name, role: invite.role, already: false };
  });
}

/** The owner changes what a member may do. The owner's own role never changes here. */
export async function changeRole(db: Db, spaceId: string, ownerId: string, memberId: string, role: 'editor' | 'viewer'): Promise<void> {
  await mustOwn(db, spaceId, ownerId);
  if (memberId === ownerId) throw new SharingError('You own this Space, so your role cannot change.', 400);
  const rows = await db.query(`update space_members set role = $3 where space_id = $1 and user_id = $2 and role <> 'owner' returning user_id`, [spaceId, memberId, role]);
  if (!rows.length) throw new SharingError('That person is not in this Space.', 404);
}

/** Removes a member (the owner doing it), or leaves the Space (the member doing it). The owner cannot leave. */
export async function removeMember(db: Db, spaceId: string, userId: string, memberId: string): Promise<void> {
  const mine = await roleIn(db, spaceId, userId);
  if (!mine || (memberId !== userId && mine !== 'owner')) throw new SharingError(NOT_FOUND, 404);
  if (memberId === userId && mine === 'owner') throw new SharingError('The owner cannot leave their own Space. Archive or delete it instead.', 400);
  const rows = await db.query(`delete from space_members where space_id = $1 and user_id = $2 and role <> 'owner' returning user_id`, [spaceId, memberId]);
  if (!rows.length) throw new SharingError('That person is not in this Space.', 404);
}

/** Every Space the user belongs to, with their role: sent with each page of the change feed. */
export async function membershipList(db: Db, userId: string): Promise<{ spaceId: string; role: Role }[]> {
  const rows = await db.query<{ space_id: string; role: Role }>('select space_id, role from space_members where user_id = $1 order by space_id', [userId]);
  return rows.map((r) => ({ spaceId: r.space_id, role: r.role }));
}
