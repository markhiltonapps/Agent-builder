-- Numbers for the client dashboard: one function, one round trip.
--
-- security invoker: the caller's own row-level security on public.calls and public.agents
-- applies, so a person only ever counts calls from workspaces they belong to. Days are cut in
-- the viewer's time zone (an unknown zone falls back to UTC) so "today" matches their clock.

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
      and (not p_phone_only or calls.source = 'phone')
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

revoke all on function public.dashboard_stats(integer, boolean, text) from public, anon;
grant execute on function public.dashboard_stats(integer, boolean, text) to authenticated;
