-- Hardening after the first advisor run.

-- has_role is only an RLS helper. Keep it out of the exposed API schema (PostgREST serves
-- public only) so it is not callable as /rest/v1/rpc/has_role. Policies follow the function.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.has_role(uuid, text[]) set schema private;
revoke all on function private.has_role(uuid, text[]) from public, anon;
grant execute on function private.has_role(uuid, text[]) to authenticated;

-- live_calls holds call transcripts and is for the worker's secret key only. RLS already
-- denies everything; also remove the table grants so a policy added later cannot open it.
revoke all on public.live_calls from anon, authenticated;
revoke all on function public.touch_live_calls() from public, anon, authenticated;
