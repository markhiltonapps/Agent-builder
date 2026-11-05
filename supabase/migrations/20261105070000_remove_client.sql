-- Remove a client: its workspace and everything in it (agents, calls, numbers' records, links).
-- Only the client's owner can do it, and a person always keeps at least one client to work in.
create or replace function public.delete_client(p_account uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  others integer;
begin
  if not private.has_role(p_account, array['owner']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select count(*) into others from public.account_members m
    where m.user_id = (select auth.uid()) and m.account_id <> p_account;
  if others = 0 then
    raise exception 'keep at least one client' using errcode = '22023';
  end if;
  delete from public.accounts where id = p_account;
end;
$$;
revoke all on function public.delete_client(uuid) from public, anon;
grant execute on function public.delete_client(uuid) to authenticated;
