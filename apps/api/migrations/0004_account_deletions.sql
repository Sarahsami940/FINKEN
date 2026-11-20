-- Accounts that were deleted. The internal user id is kept for 35 days, as
-- long as backups last, so that an account deleted after a backup was taken
-- can be deleted again if that backup is ever restored. After that only the
-- date and counts remain, which say nothing about whose account it was.
create table account_deletions (
  id bigint generated always as identity primary key,
  deleted_at timestamptz not null default now(),
  user_id text,
  spaces integer not null check (spaces >= 0),
  records integer not null check (records >= 0)
);
create index account_deletions_recent on account_deletions (deleted_at) where user_id is not null;
