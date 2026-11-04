-- Per-room conversation memory for calls in progress (see apps/agent/src/agent_builder/session_store.py).
-- Only the agent worker touches this table, with the project's secret key. RLS is on and there
-- are no policies, so the publishable key and logged-in users can never read call transcripts.
create table if not exists public.live_calls (
  room        text primary key,
  data        jsonb not null,
  ended       boolean not null default false,
  updated_at  timestamptz not null default now()
);

alter table public.live_calls enable row level security;

create or replace function public.touch_live_calls() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists live_calls_touch on public.live_calls;
create trigger live_calls_touch before insert or update on public.live_calls
  for each row execute function public.touch_live_calls();

create index if not exists live_calls_updated_at on public.live_calls (updated_at);
