-- One row per finished call. Only the voice worker writes (secret key); account members read.
-- Transcripts are personal data: keep the policies below to members of the owning account.
create table if not exists public.calls (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts (id) on delete cascade,
  agent_id            uuid not null references public.agents (id) on delete cascade,
  agent_version_id    uuid references public.agent_versions (id) on delete set null,
  agent_version       integer,
  room                text not null,
  source              text not null default 'browser' check (source in ('browser', 'phone', 'test')),
  caller_number       text,
  started_at          timestamptz not null,
  ended_at            timestamptz not null,
  duration_s          numeric not null check (duration_s >= 0),
  goal_reached        boolean not null default false,
  transferred         boolean not null default false,
  transfer_reason     text,
  recoveries          integer not null default 0,
  voice_model         jsonb,
  config_fingerprint  text,
  tool_calls          jsonb not null default '[]'::jsonb,
  transcript          jsonb not null default '[]'::jsonb,
  summary             text,
  created_at          timestamptz not null default now(),
  unique (room, started_at)
);
create index if not exists calls_account_started on public.calls (account_id, started_at desc);
create index if not exists calls_agent_started on public.calls (agent_id, started_at desc);

alter table public.calls enable row level security;
revoke all on public.calls from anon, authenticated;
grant select on public.calls to authenticated;

create policy calls_read on public.calls for select to authenticated
  using (private.has_role(account_id, array['owner', 'editor', 'viewer']));
