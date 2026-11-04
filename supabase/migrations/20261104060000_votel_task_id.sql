-- Remember which Votel card belongs to each agent, so the sync updates it directly instead of
-- searching for it. Written by the web app through this function (editors and owners only).
alter table public.agents add column if not exists votel_task_id text;

create or replace function public.set_votel_task_id(p_agent uuid, p_task text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  acct uuid;
begin
  select account_id into acct from public.agents where id = p_agent;
  if acct is null or not private.has_role(acct, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.agents set votel_task_id = nullif(p_task, '') where id = p_agent;
end;
$$;
revoke all on function public.set_votel_task_id(uuid, text) from public, anon;
grant execute on function public.set_votel_task_id(uuid, text) to authenticated;
