-- Record what happened when a call was sent to Votel, so it is visible and never sent twice.
alter table public.calls
  add column if not exists votel_contact_id text,
  add column if not exists votel_synced_at  timestamptz,
  add column if not exists votel_error      text;
