-- Shared building blocks for the tables added in Phase 2.

-- Keeps updated_at honest on every row change, whatever the client sends.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
