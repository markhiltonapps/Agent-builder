-- A client's own Votel connection: the API key made inside the client's Votel sub-account, kept encrypted
-- (apps/agent/src/agent_builder/secret_box.py). Only the servers read it, with the project's secret key.
create table if not exists public.client_votel_keys (
  account_id          uuid primary key references public.accounts (id) on delete cascade,
  encrypted_key       text not null,
  votel_account_name  text not null default '',
  votel_account_id    text not null default '',
  updated_at          timestamptz not null default now()
);
alter table public.client_votel_keys enable row level security;
revoke all on public.client_votel_keys from anon, authenticated;
