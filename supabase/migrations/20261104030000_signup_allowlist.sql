-- Only invited people can create a workspace. Anyone can still create a Supabase auth user
-- (until "Allow new users to sign up" is switched off in the dashboard), but without an
-- allowlisted email they cannot create an account, so they can reach no agent data.
--
-- Add a person:  insert into public.signup_allowlist (email) values ('name@company.com');
create table if not exists public.signup_allowlist (
  email text primary key check (email = lower(email))
);
alter table public.signup_allowlist enable row level security;  -- no policies: secret key only
revoke all on public.signup_allowlist from anon, authenticated;

create or replace function public.create_account(p_name text) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  who text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  row_ public.accounts;
begin
  if uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.signup_allowlist where email = who) then
    raise exception 'this email is not invited' using errcode = '42501';
  end if;
  insert into public.accounts (name) values (p_name) returning * into row_;
  insert into public.account_members (account_id, user_id, role) values (row_.id, uid, 'owner');
  return row_;
end;
$$;
revoke all on function public.create_account(text) from public, anon;
grant execute on function public.create_account(text) to authenticated;
