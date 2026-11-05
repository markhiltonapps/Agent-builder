-- Link a client (workspace) to its contact in Votel. The contact carries the tag
-- agent-builder-client there; this column remembers which contact is this client's, so the two
-- stay matched even when someone renames either side. One contact can belong to one client.

alter table public.accounts add column if not exists votel_contact_id text;
create unique index if not exists accounts_votel_contact_uniq on public.accounts (votel_contact_id)
  where votel_contact_id is not null;

-- Only the client's owner can link or unlink it. Pass null to unlink.
create or replace function public.link_client_votel(p_account uuid, p_contact text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_account, array['owner']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_contact is not null and p_contact !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'not a Votel contact id' using errcode = '22023';
  end if;
  update public.accounts set votel_contact_id = lower(p_contact) where id = p_account;
end;
$$;
revoke all on function public.link_client_votel(uuid, text) from public, anon;
grant execute on function public.link_client_votel(uuid, text) to authenticated;
