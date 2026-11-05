-- Reliability, phase 1. Three things move out of a server's memory and into the database, so that
-- any copy of the builder API can carry on where another left off:
--   chat_sessions  open website chats (state after every message; idle chats are finished by whichever copy sweeps first)
--   finish_jobs    the work after a call or chat ends (summary, save, Votel), retried until it lands
--   rate_buckets   per-visitor limits that hold across copies
-- All three are for the project's secret key only: RLS is on, there are no policies, and nothing is
-- granted to the publishable key or to signed-in users.

-- ---------------------------------------------------------------------------------------------
-- Open website chats
-- ---------------------------------------------------------------------------------------------
create table if not exists public.chat_sessions (
  id          text primary key,
  agent_id    uuid not null,
  data        jsonb not null,
  ended       boolean not null default false,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now()
);
create index if not exists chat_sessions_open on public.chat_sessions (last_at) where not ended;
alter table public.chat_sessions enable row level security;
revoke all on public.chat_sessions from anon, authenticated;

-- Marks one chat finished, once. Returns its saved state, or null if it was already finished or never existed.
create or replace function public.end_chat(p_id text) returns jsonb
language sql security definer set search_path = '' as $$
  update public.chat_sessions set ended = true
   where id = p_id and not ended
  returning data;
$$;

-- Claims chats nobody has written to for p_idle_s seconds, so one copy finishes each of them.
create or replace function public.claim_idle_chats(p_idle_s integer, p_limit integer default 20)
returns table (id text, agent_id uuid, data jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_sessions s where s.ended and s.last_at < now() - interval '1 day';
  return query
    update public.chat_sessions c set ended = true
     where c.id in (
       select s.id from public.chat_sessions s
        where not s.ended and s.last_at < now() - make_interval(secs => greatest(p_idle_s, 1))
        order by s.last_at
        limit greatest(least(p_limit, 100), 1)
        for update skip locked)
    returning c.id, c.agent_id, c.data;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Work after a call or chat ends
-- ---------------------------------------------------------------------------------------------
create table if not exists public.finish_jobs (
  id           uuid primary key default gen_random_uuid(),
  dedupe_key   text not null unique,
  agent_id     uuid not null,
  account_id   uuid,
  version_id   uuid,
  version      integer,
  config       jsonb not null,
  record       jsonb not null,
  state        text not null default 'pending' check (state in ('pending', 'done', 'failed')),
  attempts     integer not null default 0,
  run_after    timestamptz not null default now(),
  lease_until  timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);
create index if not exists finish_jobs_due on public.finish_jobs (run_after) where state = 'pending';
alter table public.finish_jobs enable row level security;
revoke all on public.finish_jobs from anon, authenticated;

-- Hands out due jobs, each to one caller, with a lease so a crashed caller's jobs come back.
create or replace function public.claim_finish_jobs(p_limit integer default 5, p_lease_s integer default 300)
returns setof public.finish_jobs
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.finish_jobs where state = 'done' and done_at < now() - interval '3 days';
  delete from public.finish_jobs where state = 'failed' and created_at < now() - interval '30 days';
  return query
    update public.finish_jobs j
       set lease_until = now() + make_interval(secs => greatest(p_lease_s, 10))
     where j.id in (
       select s.id from public.finish_jobs s
        where s.state = 'pending' and s.run_after <= now()
          and (s.lease_until is null or s.lease_until < now())
        order by s.run_after
        limit greatest(least(p_limit, 50), 1)
        for update skip locked)
    returning j.*;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Limits that hold across copies
-- ---------------------------------------------------------------------------------------------
create table if not exists public.rate_buckets (
  key         text not null,
  bucket      bigint not null,
  n           integer not null default 0,
  created_at  timestamptz not null default now(),
  primary key (key, bucket)
);
alter table public.rate_buckets enable row level security;
revoke all on public.rate_buckets from anon, authenticated;

-- Counts one hit and says whether it is within p_limit hits per p_window_s seconds (fixed windows).
create or replace function public.rate_hit(p_key text, p_limit integer, p_window_s integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  w integer := greatest(least(coalesce(p_window_s, 60), 86400), 1);
  b bigint := floor(extract(epoch from now()) / w);
  total integer;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 then return false; end if;
  insert into public.rate_buckets as r (key, bucket, n) values (p_key || ':' || w, b, 1)
    on conflict (key, bucket) do update set n = r.n + 1
    returning n into total;
  if random() < 0.02 then
    delete from public.rate_buckets where created_at < now() - interval '1 day';
  end if;
  return total <= greatest(least(coalesce(p_limit, 1), 100000), 1);
end;
$$;

revoke all on function public.end_chat(text) from public, anon, authenticated;
revoke all on function public.claim_idle_chats(integer, integer) from public, anon, authenticated;
revoke all on function public.claim_finish_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.end_chat(text) to service_role;
grant execute on function public.claim_idle_chats(integer, integer) to service_role;
grant execute on function public.claim_finish_jobs(integer, integer) to service_role;
grant execute on function public.rate_hit(text, integer, integer) to service_role;
