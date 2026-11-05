-- An embedded agent no longer needs a website list. An empty list means any website may show it;
-- the daily call cap still protects the bill.
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
    if o !~ '^https?://(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
       or (o like 'http://%' and o !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$') then
      raise exception 'not a website address: %', o using errcode = '22023';
    end if;
  end loop;
  -- An empty list is allowed: it means any website may show the agent. The daily cap still applies.
  update public.agents
    set embed_enabled = p_enabled,
        embed_origins = p_origins,
        embed_daily_limit = greatest(1, least(coalesce(p_limit, 50), 2000)),
        updated_at = now()
    where id = p_agent;
end;
$$;
