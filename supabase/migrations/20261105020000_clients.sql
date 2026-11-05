-- Clients: each client is a workspace. Owners can switch between them and share a read-only
-- dashboard with a client through a secret link (numbers only: no transcripts, summaries or
-- phone numbers). The link is a long random token that can be switched off or replaced.

alter table public.accounts add column if not exists share_token text unique;

-- The numbers behind every dashboard. Definer: callers never reach it directly (no grants);
-- dashboard_stats() and client_dashboard() decide which accounts a caller may count.
create or replace function private.dashboard_calc(
  p_accounts uuid[], p_days integer, p_customers_only boolean, p_tz text
) returns jsonb
language sql stable security definer set search_path = '' as $$
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
        where t ->> 'tool' in ('take_message', 'request_appointment') and t ->> 'ok' = 'true'
      ) as took_message,
      exists (
        select 1 from jsonb_array_elements(calls.tool_calls) t
        where t ->> 'tool' = 'send_booking_link' and t ->> 'ok' = 'true'
      ) as sent_link
    from public.calls calls, bounds b
    where calls.account_id = any (p_accounts)
      and (calls.started_at at time zone b.tz)::date between b.first_day and b.last_day
      and (not p_customers_only or calls.source in ('phone', 'web'))
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
revoke all on function private.dashboard_calc(uuid[], integer, boolean, text) from public, anon, authenticated;

-- The signed-in dashboard: every client the person belongs to, or just one.
drop function if exists public.dashboard_stats(integer, boolean, text);
create or replace function public.dashboard_stats(
  p_days integer default 30,
  p_phone_only boolean default false,
  p_tz text default 'UTC',
  p_account uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  ids uuid[];
begin
  select coalesce(array_agg(m.account_id), '{}') into ids
  from public.account_members m
  where m.user_id = (select auth.uid()) and (p_account is null or m.account_id = p_account);
  return private.dashboard_calc(ids, p_days, p_phone_only, p_tz);
end;
$$;
revoke all on function public.dashboard_stats(integer, boolean, text, uuid) from public, anon;
grant execute on function public.dashboard_stats(integer, boolean, text, uuid) to authenticated;

-- The shared link: no sign-in, only a token. Returns null for an unknown or switched-off token.
create or replace function public.client_dashboard(
  p_token text, p_days integer default 30, p_tz text default 'UTC'
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a public.accounts;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into a from public.accounts where share_token = p_token;
  if not found then return null; end if;
  return jsonb_build_object(
    'client', a.name,
    'stats', private.dashboard_calc(array[a.id], p_days, false, p_tz)
  );
end;
$$;
revoke all on function public.client_dashboard(text, integer, text) from public;
grant execute on function public.client_dashboard(text, integer, text) to anon, authenticated;

-- Owners switch the link on or off, or replace it (which kills the old one).
create or replace function public.set_client_share(p_account uuid, p_enabled boolean, p_rotate boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  tok text;
begin
  if not private.has_role(p_account, array['owner']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not p_enabled then
    update public.accounts set share_token = null where id = p_account;
    return null;
  end if;
  select share_token into tok from public.accounts where id = p_account;
  if tok is null or p_rotate then
    tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    update public.accounts set share_token = tok where id = p_account;
  end if;
  return tok;
end;
$$;
revoke all on function public.set_client_share(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_client_share(uuid, boolean, boolean) to authenticated;
