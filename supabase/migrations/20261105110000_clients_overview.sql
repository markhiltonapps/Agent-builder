-- One row per client the signed-in person belongs to, for the "All clients" table: its agents (live out of
-- all), customer calls and phone minutes over the last p_days, and when its last customer call was.
-- Customer calls are phone and website calls; the builder's own test calls are left out, as in Usage.
-- security invoker: the person's own access rules decide which clients and calls they can count.
create or replace function public.clients_overview(p_days integer default 30)
returns table (account_id uuid, calls bigint, voice_seconds numeric, last_call timestamptz, agents_total bigint, agents_live bigint)
language sql stable security invoker set search_path = '' as $$
  select a.id,
         coalesce(c.calls, 0),
         coalesce(c.secs, 0),
         l.last_call,
         coalesce(g.total, 0),
         coalesce(g.live, 0)
    from public.accounts a
    left join (
      select x.account_id,
             count(*) as calls,
             sum(x.duration_s) filter (where x.channel = 'voice') as secs
        from public.calls x
       where x.source in ('phone', 'web')
         and x.started_at >= now() - make_interval(days => greatest(least(coalesce(p_days, 30), 365), 1))
       group by x.account_id
    ) c on c.account_id = a.id
    left join (
      select y.account_id, max(y.started_at) as last_call
        from public.calls y where y.source in ('phone', 'web') group by y.account_id
    ) l on l.account_id = a.id
    left join (
      select z.account_id, count(*) as total, count(z.published_version_id) as live
        from public.agents z group by z.account_id
    ) g on g.account_id = a.id
   order by a.name;
$$;
revoke all on function public.clients_overview(integer) from public, anon;
grant execute on function public.clients_overview(integer) to authenticated;
