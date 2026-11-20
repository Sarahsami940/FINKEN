-- Finken's records, mirroring packages/domain/src/types.ts.
--
-- Rules the database enforces, whatever the API or a buggy client sends:
-- - money is a whole number of paisa (bigint), within JavaScript's safe range,
--   and positive wherever the model says so;
-- - every record belongs to one Space, and every link between records stays
--   inside that Space (composite foreign keys on (space_id, id));
-- - kinds, types and statuses are one of the known values;
-- - links are checked at commit, so a batch can save records that point at
--   each other (a loan and its first payment) in any order.
-- Every money record carries its change history and is only ever soft-deleted.

-- A change counter shared by every table: each insert or update takes the next
-- number, so a device can ask for "everything changed since N" (Phase 3 sync).
create sequence change_seq;

create or replace function next_change() returns trigger
language plpgsql as $$
begin
  new.seq := nextval('change_seq');
  return new;
end;
$$;

-- Largest amount JavaScript can hold exactly: 90 trillion rupees.
create domain minor_units as bigint check (value between -9007199254740991 and 9007199254740991);

create table users (
  id text primary key,
  auth_subject text not null unique,
  email text,
  name text not null default '' check (length(name) <= 80),
  time_zone text not null default 'Asia/Karachi',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger users_updated_at before update on users for each row execute function set_updated_at();

create table spaces (
  id text primary key check (length(id) between 1 and 100),
  owner_id text not null references users (id),
  name text not null check (length(trim(name)) between 1 and 80),
  type text not null check (type in ('personal', 'business', 'family', 'other')),
  icon text not null default '',
  description text not null default '' check (length(description) <= 500),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null
);

-- Who can use a Space. Every request is checked against this table.
create table space_members (
  space_id text not null references spaces (id),
  user_id text not null references users (id),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
create index space_members_user on space_members (user_id);

create table accounts (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('cash', 'bank', 'wallet', 'other')),
  opening_balance minor_units not null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id)
);

create table categories (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('expense', 'income')),
  icon text not null default '',
  color text not null default '',
  subcategories jsonb not null default '[]' check (jsonb_typeof(subcategories) = 'array'),
  cost_type text check (cost_type in ('direct', 'operating')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id)
);

create table people (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  phone text,
  email text,
  notes text check (length(notes) <= 2000),
  role text check (role in ('customer', 'supplier', 'lender', 'other')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id)
);

create table obligations (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  kind text not null check (kind in ('receivable', 'payable', 'lent', 'borrowed')),
  person_id text not null,
  title text not null check (length(trim(title)) between 1 and 120),
  amount minor_units not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  date date not null,
  due_date date check (due_date >= date),
  source_transaction_id text,
  interest_rate numeric(7, 3) check (interest_rate between 0 and 1000),
  instalment_amount minor_units check (instalment_amount > 0 and instalment_amount <= amount),
  instalment_frequency text check (instalment_frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  notes text check (length(notes) <= 2000),
  snoozed_until date,
  status text not null check (status in ('open', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id),
  foreign key (space_id, person_id) references people (space_id, id) deferrable initially deferred
);

create table recurring (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  amount minor_units not null check (amount > 0),
  type text not null check (type in ('expense', 'income')),
  category_id text,
  account_id text not null,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom')),
  interval_days integer check (interval_days between 1 and 3650),
  start_date date not null,
  end_date date check (end_date >= start_date),
  next_due_date date not null,
  reminder_days integer check (reminder_days between 0 and 60),
  obligation_id text,
  snoozed_until date,
  status text not null check (status in ('active', 'paused', 'cancelled', 'ended')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id),
  check ((frequency = 'custom') = (interval_days is not null)),
  foreign key (space_id, category_id) references categories (space_id, id) deferrable initially deferred,
  foreign key (space_id, account_id) references accounts (space_id, id) deferrable initially deferred,
  foreign key (space_id, obligation_id) references obligations (space_id, id) deferrable initially deferred
);

-- The only table that moves money.
create table transactions (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  type text not null check (type in ('expense', 'income', 'transfer', 'refund', 'principal_in', 'principal_out')),
  amount minor_units not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  category_id text,
  subcategory_id text,
  date date not null,
  description text not null default '' check (length(description) <= 200),
  account_id text not null,
  to_account_id text,
  person_id text,
  obligation_id text,
  refund_of_id text,
  recurring_id text,
  notes text check (length(notes) <= 2000),
  status text not null check (status in ('confirmed', 'pending')),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id),
  -- A transfer has a destination and only a transfer does; it never goes to the same account.
  check ((type = 'transfer') = (to_account_id is not null)),
  check (to_account_id is null or to_account_id <> account_id),
  check (type <> 'refund' or refund_of_id is not null),
  check (type not in ('principal_in', 'principal_out') or obligation_id is not null),
  foreign key (space_id, account_id) references accounts (space_id, id) deferrable initially deferred,
  foreign key (space_id, to_account_id) references accounts (space_id, id) deferrable initially deferred,
  foreign key (space_id, category_id) references categories (space_id, id) deferrable initially deferred,
  foreign key (space_id, person_id) references people (space_id, id) deferrable initially deferred,
  foreign key (space_id, obligation_id) references obligations (space_id, id) deferrable initially deferred,
  foreign key (space_id, refund_of_id) references transactions (space_id, id) deferrable initially deferred,
  foreign key (space_id, recurring_id) references recurring (space_id, id) deferrable initially deferred
);
create index transactions_space_date on transactions (space_id, date);

-- A share of an expense points back at it.
alter table obligations
  add foreign key (space_id, source_transaction_id) references transactions (space_id, id) deferrable initially deferred;

create table budgets (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  category_id text,
  subcategory_id text,
  amount minor_units not null check (amount > 0),
  frequency text not null check (frequency in ('weekly', 'monthly', 'yearly', 'custom')),
  start_date date not null,
  end_date date check (end_date >= start_date),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id),
  foreign key (space_id, category_id) references categories (space_id, id) deferrable initially deferred
);

create table goals (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  name text not null check (length(trim(name)) between 1 and 80),
  target_amount minor_units not null check (target_amount > 0),
  target_date date,
  description text not null default '' check (length(description) <= 500),
  icon text not null default '',
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id)
);

-- Money set aside for a goal (positive) or taken back out (negative). Never a transaction.
create table goal_entries (
  id text primary key check (length(id) between 1 and 100),
  space_id text not null references spaces (id),
  goal_id text not null,
  amount minor_units not null check (amount <> 0),
  date date not null,
  note text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by text references users (id),
  updated_at timestamptz not null default now(),
  updated_by text references users (id),
  version integer not null default 1 check (version >= 1),
  deleted_at timestamptz,
  deleted_by text references users (id),
  seq bigint not null,
  unique (space_id, id),
  foreign key (space_id, goal_id) references goals (space_id, id) deferrable initially deferred
);

-- Every money table takes the next change number on every write.
do $$
declare t text;
begin
  foreach t in array array['spaces', 'accounts', 'categories', 'people', 'obligations', 'recurring', 'transactions', 'budgets', 'goals', 'goal_entries'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function next_change()', t || '_seq', t);
    if t = 'spaces' then
      execute 'create index spaces_changes on spaces (seq)';
    else
      execute format('create index %I on %I (space_id, seq)', t || '_changes', t);
    end if;
  end loop;
end;
$$;
