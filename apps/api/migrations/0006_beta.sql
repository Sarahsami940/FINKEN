-- Phase 8: the closed beta and the run-up to launch.

-- Invite codes. Only a hash of each code is kept, so a database copy cannot
-- be used to join. A code can be shared by several people (max_uses), and
-- codes are given out in waves so the beta can be widened step by step.
create table beta_invites (
  id bigint generated always as identity primary key,
  code_hash text not null unique check (length(code_hash) = 64),
  wave integer not null check (wave between 1 and 1000),
  max_uses integer not null default 1 check (max_uses between 1 and 10000),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  note text not null default '' check (length(note) <= 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

alter table users
  add column beta_joined_at timestamptz,
  add column beta_wave integer,
  -- Product analytics only with consent: null means not asked yet.
  add column usage_consent text check (usage_consent in ('yes', 'no')),
  add column usage_consent_at timestamptz,
  -- The last day this person used Finken (server time), so each day counts them once.
  add column last_seen_on date;

-- Feedback sent from inside the app. It is the person's own words, so it is
-- removed with their account and included in their export.
create table feedback (
  id bigint generated always as identity primary key,
  user_id text not null references users (id) on delete cascade,
  kind text not null check (kind in ('problem', 'idea', 'praise')),
  message text not null check (length(message) between 1 and 2000),
  screen text not null default '' check (length(screen) <= 60),
  release text not null default '' check (length(release) <= 40),
  status text not null default 'new' check (status in ('new', 'seen', 'done')),
  created_at timestamptz not null default now()
);
create index feedback_status on feedback (status, created_at);

-- Which parts of Finken people use, for those who said yes: a count per
-- person, day and event name. Event names come from a fixed list and never
-- hold amounts, names or anything typed.
create table usage_events (
  user_id text not null references users (id) on delete cascade,
  day date not null,
  event text not null check (event ~ '^[a-z]+:[a-z-]+$' and length(event) <= 40),
  n integer not null check (n > 0),
  primary key (user_id, day, event)
);
create index usage_events_day on usage_events (day);

-- Health per day, with nobody named: people seen, and errors on each side.
create table daily_health (
  day date primary key,
  people integer not null default 0,
  client_errors integer not null default 0,
  server_errors integer not null default 0
);

-- Every nightly reconciliation, so the launch report can see that it ran
-- each night and found nothing.
create table reconciliation_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  spaces integer not null,
  records integer not null,
  problems integer not null
);
create index reconciliation_runs_started on reconciliation_runs (started_at);
