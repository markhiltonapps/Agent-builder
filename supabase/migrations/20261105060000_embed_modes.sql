-- Website visitors can talk, chat, or both. Each agent has an off switch for each (both on by
-- default); the daily cap counts voice calls and chats together.

alter table public.agents
  add column if not exists embed_voice boolean not null default true,
  add column if not exists embed_chat boolean not null default true;

drop function if exists public.set_embed_settings(uuid, boolean, text[], integer);
create or replace function public.set_embed_settings(
  p_agent uuid, p_enabled boolean, p_origins text[], p_limit integer,
  p_voice boolean default true, p_chat boolean default true
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
  if p_enabled and not coalesce(p_voice, false) and not coalesce(p_chat, false) then
    raise exception 'choose talking, chatting or both' using errcode = '22023';
  end if;
  -- An empty list is allowed: it means any website may show the agent. The daily cap still applies.
  update public.agents
    set embed_enabled = p_enabled,
        embed_origins = p_origins,
        embed_daily_limit = greatest(1, least(coalesce(p_limit, 50), 2000)),
        embed_voice = coalesce(p_voice, true),
        embed_chat = coalesce(p_chat, true),
        updated_at = now()
    where id = p_agent;
end;
$$;
revoke all on function public.set_embed_settings(uuid, boolean, text[], integer, boolean, boolean) from public, anon;
grant execute on function public.set_embed_settings(uuid, boolean, text[], integer, boolean, boolean) to authenticated;

-- Counts one embedded call or chat against the daily cap. Returns 'ok', 'disabled' (including
-- that way of talking being switched off), 'unpublished' or 'limit'. Secret key only.
drop function if exists public.embed_begin(uuid);
create or replace function public.embed_begin(p_agent uuid, p_kind text default 'voice') returns text
language plpgsql security definer set search_path = '' as $$
declare
  a public.agents;
  n integer;
begin
  select * into a from public.agents where id = p_agent;
  if not found or not a.embed_enabled then return 'disabled'; end if;
  if (p_kind = 'chat' and not a.embed_chat) or (p_kind <> 'chat' and not a.embed_voice) then return 'disabled'; end if;
  if a.published_version_id is null then return 'unpublished'; end if;
  delete from public.embed_sessions where created_at < now() - interval '7 days';
  select count(*) into n from public.embed_sessions
    where agent_id = p_agent and created_at > now() - interval '24 hours';
  if n >= a.embed_daily_limit then return 'limit'; end if;
  insert into public.embed_sessions (agent_id) values (p_agent);
  return 'ok';
end;
$$;
revoke all on function public.embed_begin(uuid, text) from public, anon, authenticated;
grant execute on function public.embed_begin(uuid, text) to service_role;
