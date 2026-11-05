-- Stop sign-up emails to addresses that are not invited, BEFORE Supabase sends them.
--
-- Supabase sends the confirmation email as part of sign-up, so checking the invite list afterwards
-- (create_account) is too late: every sign-up for an address that cannot receive mail bounced, and
-- enough bounces get email sending restricted for the whole project. This function is the "Before
-- User Created" auth hook: it runs before the user exists and before any email is sent, and
-- refuses anything not on public.signup_allowlist.
--
-- Turn it on in the dashboard: Authentication, Auth Hooks, Before User Created, choose
-- "Postgres function", schema public, function hook_before_user_created.
--
-- Rules:
--  * the address must be on the allowlist (case does not matter; a "+tag" on an allowlisted address
--    is allowed, so the owner can test with markallenhilton+test1@gmail.com);
--  * addresses that can never receive mail are refused even if someone adds them to the allowlist:
--    example.com / .org / .net, localhost, tokbird.com, and the reserved .test .invalid .example
--    .localhost endings.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  addr text := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
  dom text;
  base text;
begin
  if addr !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:].]{2,}$' then
    return jsonb_build_object('error', jsonb_build_object('message', 'That email address cannot be used.', 'http_code', 400));
  end if;
  dom := split_part(addr, '@', 2);
  if dom in ('example.com', 'example.org', 'example.net', 'localhost', 'tokbird.com')
     or dom ~ '\.(test|invalid|example|localhost)$' then
    return jsonb_build_object('error', jsonb_build_object('message', 'That email address cannot be used.', 'http_code', 400));
  end if;
  base := regexp_replace(split_part(addr, '@', 1), '\+.*$', '') || '@' || dom;
  if exists (
    select 1 from public.signup_allowlist a
    where lower(a.email) = addr or lower(a.email) = base
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object('message', 'Sign-up is by invitation.', 'http_code', 403));
end;
$$;

-- Only Supabase's auth service may run it; nobody can call it through the API.
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
