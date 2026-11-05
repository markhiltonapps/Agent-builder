-- Chats and billing minutes.
--
-- A call is voice (minutes on the line) or chat (typed, so it has no minutes). The dashboard counts
-- both as conversations but only voice adds to talk time. client_usage() totals minutes per client
-- for billing, and client_usage_detail() lists the calls behind the totals.

alter table public.calls add column if not exists channel text not null default 'voice'
  check (channel in ('voice', 'chat'));

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
      calls.channel,
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
        'chats', count(*) filter (where channel = 'chat'),
        'successful', count(*) filter (where goal_reached),
        'transferred', count(*) filter (where transferred),
        'messages', count(*) filter (where took_message),
        'links', count(*) filter (where sent_link),
        'total_seconds', coalesce(sum(duration_s) filter (where channel = 'voice'), 0),
        'avg_seconds', coalesce(avg(duration_s) filter (where channel = 'voice'), 0)
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
          'avg_seconds', avg(c.duration_s) filter (where c.channel = 'voice')
        ) as row
        from c left join public.agents a on a.id = c.agent_id
        group by c.agent_id, a.name
      ) per_agent
    )
  );
$$;
revoke all on function private.dashboard_calc(uuid[], integer, boolean, text) from public, anon, authenticated;

-- Minutes per client for a date range, in the viewer's time zone. Only clients the person owns:
-- billing is the owner's business. "Billable" rounds every call up to a whole minute, the way
-- phone carriers and most agencies bill; "minutes" is the exact total.
create or replace function public.client_usage(
  p_from date, p_to date, p_tz text default 'UTC', p_customers_only boolean default true
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_tz limit 1), 'UTC');
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'choose a date range of up to a year' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(row order by row ->> 'name')
    from (
      select jsonb_build_object(
        'account_id', a.id,
        'name', a.name,
        'calls', count(c.id) filter (where c.channel = 'voice'),
        'seconds', coalesce(sum(c.duration_s) filter (where c.channel = 'voice'), 0),
        'billable_minutes', coalesce(sum(ceil(c.duration_s / 60.0)) filter (where c.channel = 'voice'), 0),
        'chats', count(c.id) filter (where c.channel = 'chat')
      ) as row
      from public.accounts a
      join public.account_members m on m.account_id = a.id and m.user_id = (select auth.uid()) and m.role = 'owner'
      left join public.calls c on c.account_id = a.id
        and (c.started_at at time zone tz)::date between p_from and p_to
        and (not p_customers_only or c.source in ('phone', 'web'))
      group by a.id, a.name
    ) per_client
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.client_usage(date, date, text, boolean) from public, anon;
grant execute on function public.client_usage(date, date, text, boolean) to authenticated;

-- The calls behind one client's total, oldest first (at most 5,000), for the billing export.
create or replace function public.client_usage_detail(
  p_account uuid, p_from date, p_to date, p_tz text default 'UTC', p_customers_only boolean default true
) returns table (started_at timestamptz, agent text, source text, channel text, duration_s numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  tz text := coalesce((select z.name from pg_catalog.pg_timezone_names z where z.name = p_tz limit 1), 'UTC');
begin
  if not private.has_role(p_account, array['owner']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'choose a date range of up to a year' using errcode = '22023';
  end if;
  return query
    select c.started_at, coalesce(ag.name, 'Deleted agent'), c.source, c.channel, c.duration_s
    from public.calls c
    left join public.agents ag on ag.id = c.agent_id
    where c.account_id = p_account
      and (c.started_at at time zone tz)::date between p_from and p_to
      and (not p_customers_only or c.source in ('phone', 'web'))
    order by c.started_at
    limit 5000;
end;
$$;
revoke all on function public.client_usage_detail(uuid, date, date, text, boolean) from public, anon;
grant execute on function public.client_usage_detail(uuid, date, date, text, boolean) to authenticated;
