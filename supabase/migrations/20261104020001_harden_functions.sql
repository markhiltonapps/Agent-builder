-- has_role moved to the private schema (previous migration); these two call it by name.
-- They stay security definer and check the caller's role themselves.

create or replace function public.save_agent_version(
  p_agent uuid, p_config jsonb, p_note text default ''
) returns public.agent_versions
language plpgsql security definer set search_path = '' as $$
declare
  acct uuid;
  row_ public.agent_versions;
begin
  select account_id into acct from public.agents where id = p_agent for update;
  if acct is null or not private.has_role(acct, array['owner', 'editor']) then
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
  if acct is null or not private.has_role(acct, array['owner', 'editor']) then
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

revoke all on function public.save_agent_version(uuid, jsonb, text) from public, anon;
revoke all on function public.publish_agent_version(uuid, uuid) from public, anon;
grant execute on function public.save_agent_version(uuid, jsonb, text) to authenticated;
grant execute on function public.publish_agent_version(uuid, uuid) to authenticated;
