-- Website embed: let a published agent take calls from a web page.
--
-- Anyone on the internet can start a paid call once an agent is embedded, so every agent has an
-- off switch (default off), a list of websites allowed to show it, and a daily cap on calls.
-- Owners and editors change the settings through set_embed_settings(); the web app and builder
-- API check and count starts through embed_begin() (secret key only).

alter table public.agents
  add column if not exists embed_enabled boolean not null default false,
  add column if not exists embed_origins text[] not null default '{}',
  add column if not exists embed_daily_limit integer not null default 50
    check (embed_daily_limit between 1 and 2000);

-- A call from a visitor on a website is its own kind, so reports can tell it from a test call.
alter table public.calls drop constraint if exists calls_source_check;
alter table public.calls
  add constraint calls_source_check check (source in ('browser', 'phone', 'test', 'web'));

-- One row per embedded call started; used only to enforce the daily cap.
create table if not exists public.embed_sessions (
  id          bigint generated always as identity primary key,
  agent_id    uuid not null references public.agents (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists embed_sessions_agent_time on public.embed_sessions (agent_id, created_at desc);
alter table public.embed_sessions enable row level security;
revoke all on public.embed_sessions from anon, authenticated;

create or replace function public.set_embed_settings(
  p_agent uuid, p_enabled boolean, p_origins text[], p_limit integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  acct uuid;
  o text;
begin
  select account_id into acct from public.agents where id = p_agent;
  if acct is null or not private.has_role(acct, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  p_origins := coalesce(p_origins, '{}');
  if cardinality(p_origins) > 20 then
    raise exception 'at most 20 websites' using errcode = '22023';
  end if;
  foreach o in array p_origins loop
    -- https://example.com, https://*.example.com, optional port; http only for localhost.
    if o !~ '^https?://(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
       or (o like 'http://%' and o !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$') then
      raise exception 'not a website address: %', o using errcode = '22023';
    end if;
  end loop;
  if p_enabled and cardinality(p_origins) = 0 then
    raise exception 'add at least one website first' using errcode = '22023';
  end if;
  update public.agents
    set embed_enabled = p_enabled,
        embed_origins = p_origins,
        embed_daily_limit = greatest(1, least(coalesce(p_limit, 50), 2000)),
        updated_at = now()
    where id = p_agent;
end;
$$;

-- Counts one embedded call against the daily cap. Returns 'ok', 'disabled', 'unpublished' or
-- 'limit'. Called with the secret key only.
create or replace function public.embed_begin(p_agent uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  n integer;
begin
  select * into a from public.agents where id = p_agent;
  if not found or not a.embed_enabled then return 'disabled'; end if;
  if a.published_version_id is null then return 'unpublished'; end if;
  delete from public.embed_sessions where created_at < now() - interval '7 days';
  select count(*) into n from public.embed_sessions
    where agent_id = p_agent and created_at > now() - interval '24 hours';
  if n >= a.embed_daily_limit then return 'limit'; end if;
  insert into public.embed_sessions (agent_id) values (p_agent);
  return 'ok';
end;
$$;

revoke all on function public.set_embed_settings(uuid, boolean, text[], integer) from public, anon;
grant execute on function public.set_embed_settings(uuid, boolean, text[], integer) to authenticated;
revoke all on function public.embed_begin(uuid) from public, anon, authenticated;
grant execute on function public.embed_begin(uuid) to service_role;

-- The dashboard's "customer calls only" filter now means phone plus website calls.
create or replace function public.dashboard_stats(
  p_days integer default 30,
  p_phone_only boolean default false,
  p_tz text default 'UTC'
) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with params as (
    select
      greatest(1, least(coalesce(p_days, 30), 365)) as days,
      coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_tz limit 1), 'UTC') as tz
  ),
  bounds as (
    select days, tz,
      ((now() at time zone tz)::date - (days - 1)) as first_day,
      (now() at time zone tz)::date as last_day
    from params
  ),
  c as (
    select
      calls.agent_id,
      calls.duration_s,
      calls.goal_reached,
      calls.transferred,
      (calls.started_at at time zone b.tz)::date as day,
      exists (
        select 1 from jsonb_array_elements(calls.tool_calls) t
        where t ->> 'tool' = 'take_message' and t ->> 'ok' = 'true'
      ) as took_message,
      exists (
        select 1 from jsonb_array_elements(calls.tool_calls) t
        where t ->> 'tool' = 'send_booking_link' and t ->> 'ok' = 'true'
      ) as sent_link
    from public.calls calls, bounds b
    where (calls.started_at at time zone b.tz)::date between b.first_day and b.last_day
      and (not p_phone_only or calls.source in ('phone', 'web'))
  )
  select jsonb_build_object(
    'days', (select days from bounds),
    'tz', (select tz from bounds),
    'totals', (
      select jsonb_build_object(
        'calls', count(*),
        'successful', count(*) filter (where goal_reached),
        'transferred', count(*) filter (where transferred),
        'messages', count(*) filter (where took_message),
        'links', count(*) filter (where sent_link),
        'total_seconds', coalesce(sum(duration_s), 0),
        'avg_seconds', coalesce(avg(duration_s), 0)
      ) from c
    ),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'calls', n) order by d), '[]'::jsonb)
      from (
        select g::date as d, (select count(*) from c where c.day = g::date) as n
        from bounds b, generate_series(b.first_day, b.last_day, interval '1 day') g
      ) s
    ),
    'agents', (
      select coalesce(jsonb_agg(row order by (row ->> 'calls')::int desc, row ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'agent_id', c.agent_id,
          'name', coalesce(a.name, 'Deleted agent'),
          'calls', count(*),
          'successful', count(*) filter (where c.goal_reached),
          'transferred', count(*) filter (where c.transferred),
          'avg_seconds', avg(c.duration_s)
        ) as row
        from c left join public.agents a on a.id = c.agent_id
        group by c.agent_id, a.name
      ) per_agent
    )
  );
$$;
