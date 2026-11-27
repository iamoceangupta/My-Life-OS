-- =====================================================================
-- My Life OS — Supabase schema for cloud sync
-- Run once in: Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS).
-- =====================================================================

-- 1) One generic table for every app store (tx, tasks, notes, meta, ...)
create table if not exists public.records (
  user_id            uuid        not null default auth.uid()
                                 references auth.users(id) on delete cascade,
  store              text        not null,
  id                 text        not null,
  data               jsonb       not null,
  updated_at         bigint      not null,             -- record.updatedAt (ms since epoch, client clock)
  deleted            boolean     not null default false, -- tombstone
  server_updated_at  timestamptz not null default now(), -- server clock, used as the pull cursor
  primary key (user_id, store, id)
);

-- Pull query: "rows for me changed after <cursor>", ordered by server time
create index if not exists records_user_server_updated_idx
  on public.records (user_id, server_updated_at);

-- 2) Trigger: stamp server_updated_at on every insert/update, and enforce
--    last-write-wins on the server too: an update carrying an OLDER
--    updated_at than the stored row is silently skipped. This stops a device
--    that was offline from overwriting a newer edit made elsewhere.
--    (The client detects the skipped rows and pulls the newer version.)
create or replace function public.records_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;               -- keep the newer row that is already stored
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

-- 3) Row Level Security: each signed-in user sees and changes only their rows
alter table public.records enable row level security;
alter table public.records force row level security;

drop policy if exists "records_select_own" on public.records;
drop policy if exists "records_insert_own" on public.records;
drop policy if exists "records_update_own" on public.records;
drop policy if exists "records_delete_own" on public.records;

create policy "records_select_own" on public.records
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "records_insert_own" on public.records
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "records_update_own" on public.records
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "records_delete_own" on public.records
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- No public access: the anon role gets nothing; only signed-in users
revoke all on public.records from anon;
revoke all on public.records from public;
grant select, insert, update, delete on public.records to authenticated;

-- ---------------------------------------------------------------------
-- Optional housekeeping (run manually now and then): remove tombstones
-- older than 90 days. Every device that synced in the last 90 days has
-- already applied them.
--
--   delete from public.records
--   where deleted and server_updated_at < now() - interval '90 days';
-- ---------------------------------------------------------------------
