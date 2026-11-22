-- Devices that asked for reminders. Each is a browser's push address with
-- its encryption keys; removing the account removes its devices.
create table push_subscriptions (
  id bigint generated always as identity primary key,
  user_id text not null references users (id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 1000 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  created_at timestamptz not null default now(),
  failures integer not null default 0
);
create index push_subscriptions_user on push_subscriptions (user_id);

-- The last reminder sent to each person, so it goes at most once a day and
-- only when there is something new to say.
alter table users
  add column last_reminder_on date,
  add column last_reminder_digest text;
