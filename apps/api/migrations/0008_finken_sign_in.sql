-- Finken's own sign-in: accounts, passwords and sessions kept by Finken.
--
-- Passwords are never stored: only a scrypt hash with its own salt, which
-- cannot be turned back into the password. Session refresh tokens and email
-- link tokens are stored as SHA-256 hashes, so a copy of the database cannot
-- be used to sign in.

alter table users
  add column password_hash text check (password_hash is null or password_hash like 'scrypt$%'),
  add column password_changed_at timestamptz,
  add column email_verified_at timestamptz,
  -- Wrong passwords in a row, and until when the account must wait.
  add column failed_logins integer not null default 0,
  add column locked_until timestamptz;

-- One Finken account per email address.
create unique index users_password_email on users (lower(email)) where password_hash is not null;

-- A signed-in device. The refresh token (in a cookie the page cannot read)
-- changes every time it is used; using an old one ends the session, because
-- it means the token was copied.
create table sessions (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  refresh_hash text not null unique check (length(refresh_hash) = 64),
  previous_hash text check (previous_hash is null or length(previous_hash) = 64),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('logout', 'logout-all', 'password', 'reuse', 'reset'))
);
create index sessions_user on sessions (user_id);
create index sessions_previous on sessions (previous_hash) where previous_hash is not null;

-- One-time links sent by email: confirming the address, and setting a new password.
create table email_tokens (
  id bigint generated always as identity primary key,
  user_id text not null references users (id) on delete cascade,
  purpose text not null check (purpose in ('verify', 'reset')),
  token_hash text not null unique check (length(token_hash) = 64),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index email_tokens_user on email_tokens (user_id, purpose);
