-- Step 2: accounts, agents, immutable versions and a publish pointer.
--
-- An agent version is one AgentConfig JSON document (apps/agent/src/agent_builder/config.py).
-- Versions are append-only. "Publish" and "rollback" are the same act: move
-- agents.published_version_id. The worker reads the published version with the secret key via
-- public.published_agent(); the web app uses the logged-in user and RLS.

create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 200),
  created_at  timestamptz not null default now()
);

create table if not exists public.account_members (
  account_id  uuid not null references public.accounts (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (account_id, user_id)
);
create index if not exists account_members_user on public.account_members (user_id);

create table if not exists public.agents (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts (id) on delete cascade,
  name                  text not null check (length(name) between 1 and 200),
  published_version_id  uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists agents_account on public.agents (account_id);

create table if not exists public.agent_versions (
  id          uuid primary key default gen_random_uuid(),
  agent_id    uuid not null references public.agents (id) on delete cascade,
  version     integer not null check (version > 0),
  config      jsonb not null check (jsonb_typeof(config) = 'object'),
  note        text not null default '' check (length(note) <= 500),
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (agent_id, version),
  unique (id, agent_id)
);

-- A pointer can only name a version of the same agent.
alter table public.agents drop constraint if exists agents_published_fk;
alter table public.agents
  add constraint agents_published_fk
  foreign key (published_version_id, id)
  references public.agent_versions (id, agent_id);

create table if not exists public.publish_log (
  id          bigint generated always as identity primary key,
  agent_id    uuid not null references public.agents (id) on delete cascade,
  version_id  uuid not null references public.agent_versions (id) on delete cascade,
  action      text not null check (action in ('publish', 'rollback')),
  by_user     uuid references auth.users (id) on delete set null,
  at          timestamptz not null default now()
);
create index if not exists publish_log_agent on public.publish_log (agent_id, at desc);

-- Versions never change after they are written.
create or replace function public.forbid_version_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'agent versions are immutable';
end;
$$;
drop trigger if exists agent_versions_immutable on public.agent_versions;
create trigger agent_versions_immutable before update on public.agent_versions
  for each row execute function public.forbid_version_change();

-- Membership helpers. security definer so the policies below do not recurse into
-- account_members' own RLS. The caller's id comes from auth.uid(), never from an argument.
create or replace function public.has_role(p_account uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.account_members m
    where m.account_id = p_account and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;
revoke all on function public.has_role(uuid, text[]) from public, anon;
grant execute on function public.has_role(uuid, text[]) to authenticated;

alter table public.accounts        enable row level security;
alter table public.account_members enable row level security;
alter table public.agents          enable row level security;
alter table public.agent_versions  enable row level security;
alter table public.publish_log     enable row level security;

create policy accounts_read on public.accounts for select to authenticated
  using (public.has_role(id, array['owner', 'editor', 'viewer']));
create policy accounts_rename on public.accounts for update to authenticated
  using (public.has_role(id, array['owner'])) with check (public.has_role(id, array['owner']));

create policy members_read on public.account_members for select to authenticated
  using (user_id = (select auth.uid()) or public.has_role(account_id, array['owner']));

create policy agents_read on public.agents for select to authenticated
  using (public.has_role(account_id, array['owner', 'editor', 'viewer']));
create policy agents_create on public.agents for insert to authenticated
  with check (public.has_role(account_id, array['owner', 'editor']));
create policy agents_update on public.agents for update to authenticated
  using (public.has_role(account_id, array['owner', 'editor']))
  with check (public.has_role(account_id, array['owner', 'editor']));

create policy versions_read on public.agent_versions for select to authenticated
  using (exists (
    select 1 from public.agents a
    where a.id = agent_id and public.has_role(a.account_id, array['owner', 'editor', 'viewer'])
  ));

create policy publish_log_read on public.publish_log for select to authenticated
  using (exists (
    select 1 from public.agents a
    where a.id = agent_id and public.has_role(a.account_id, array['owner', 'editor', 'viewer'])
  ));

-- Writes to versions and the log go through these functions only (no insert policy exists).
-- security invoker would need insert policies, so they are security definer and check the role.

create or replace function public.save_agent_version(
  p_agent uuid, p_config jsonb, p_note text default ''
) returns public.agent_versions
language plpgsql security definer set search_path = '' as $$
declare
  acct uuid;
  row_ public.agent_versions;
begin
  select account_id into acct from public.agents where id = p_agent for update;
  if acct is null or not public.has_role(acct, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.agent_versions (agent_id, version, config, note, created_by)
  values (
    p_agent,
    coalesce((select max(version) from public.agent_versions where agent_id = p_agent), 0) + 1,
    p_config,
    coalesce(p_note, ''),
    (select auth.uid())
  )
  returning * into row_;
  update public.agents set updated_at = now() where id = p_agent;
  return row_;
end;
$$;

create or replace function public.publish_agent_version(p_agent uuid, p_version uuid)
returns public.agents
language plpgsql security definer set search_path = '' as $$
declare
  acct uuid;
  current_ uuid;
  newer boolean;
  row_ public.agents;
begin
  select account_id, published_version_id into acct, current_
    from public.agents where id = p_agent for update;
  if acct is null or not public.has_role(acct, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.agent_versions where id = p_version and agent_id = p_agent) then
    raise exception 'version does not belong to this agent' using errcode = '22023';
  end if;
  select coalesce(
    (select v.version > (select c.version from public.agent_versions c where c.id = current_)
       from public.agent_versions v where v.id = p_version),
    true) into newer;
  update public.agents
    set published_version_id = p_version, updated_at = now()
    where id = p_agent returning * into row_;
  insert into public.publish_log (agent_id, version_id, action, by_user)
  values (p_agent, p_version, case when newer then 'publish' else 'rollback' end,
          (select auth.uid()));
  return row_;
end;
$$;

-- A signed-in user creates their first account and becomes its owner.
create or replace function public.create_account(p_name text) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  row_ public.accounts;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  insert into public.accounts (name) values (p_name) returning * into row_;
  insert into public.account_members (account_id, user_id, role) values (row_.id, uid, 'owner');
  return row_;
end;
$$;

-- What the worker runs: the published version of an agent. Secret key only.
create or replace function public.published_agent(p_agent uuid)
returns table (agent_id uuid, account_id uuid, version_id uuid, version integer, config jsonb)
language sql stable security definer set search_path = '' as $$
  select a.id, a.account_id, v.id, v.version, v.config
  from public.agents a
  join public.agent_versions v on v.id = a.published_version_id and v.agent_id = a.id
  where a.id = p_agent;
$$;

revoke all on function public.save_agent_version(uuid, jsonb, text) from public, anon;
revoke all on function public.publish_agent_version(uuid, uuid) from public, anon;
revoke all on function public.create_account(text) from public, anon;
revoke all on function public.published_agent(uuid) from public, anon, authenticated;
revoke all on function public.forbid_version_change() from public, anon, authenticated;
grant execute on function public.save_agent_version(uuid, jsonb, text) to authenticated;
grant execute on function public.publish_agent_version(uuid, uuid) to authenticated;
grant execute on function public.create_account(text) to authenticated;
grant execute on function public.published_agent(uuid) to service_role;

-- Editors rename agents directly; the publish pointer moves only through
-- publish_agent_version() so every change lands in publish_log.
revoke insert, update, delete on public.agents from anon, authenticated;
grant insert (account_id, name) on public.agents to authenticated;
grant update (name) on public.agents to authenticated;
revoke insert, update, delete on public.agent_versions, public.publish_log,
  public.account_members, public.accounts from anon, authenticated;
grant update (name) on public.accounts to authenticated;
revoke all on public.agents, public.agent_versions, public.publish_log, public.account_members,
  public.accounts from anon;
