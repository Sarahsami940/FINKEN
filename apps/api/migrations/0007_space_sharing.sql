-- Phase 9: sharing a Space with a team (Business Mode), or with family.
--
-- The owner makes an invite for one person with the role they will have:
-- editor (adds and changes records: staff, a partner or an accountant) or
-- viewer (sees records and reports only). Each invite works once, for 7 days
-- unless set otherwise, and only a hash of its code is kept.
create table space_invites (
  id bigint generated always as identity primary key,
  space_id text not null references spaces (id) on delete cascade,
  code_hash text not null unique check (length(code_hash) = 64),
  role text not null check (role in ('editor', 'viewer')),
  created_by text not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text references users (id) on delete set null,
  revoked_at timestamptz
);
create index space_invites_space on space_invites (space_id);

