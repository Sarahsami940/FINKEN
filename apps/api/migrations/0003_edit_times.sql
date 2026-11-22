-- When each record was last edited on the device that made the change, as
-- opposed to when it reached the server (updated_at). When two devices change
-- the same record, the later edit wins, whichever arrives first. The server
-- never accepts an edit time in the future, so a wrong clock cannot win forever.
do $$
declare t text;
begin
  foreach t in array array['spaces', 'accounts', 'categories', 'people', 'obligations', 'recurring', 'transactions', 'budgets', 'goals', 'goal_entries'] loop
    execute format('alter table %I add column edited_at timestamptz not null default now()', t);
    execute format('update %I set edited_at = updated_at', t);
  end loop;
end;
$$;
