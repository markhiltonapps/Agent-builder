-- Bookings made with the demonstration hotel (apps/agent/src/agent_builder/adapters/hotel_demo.py), kept so
-- a caller can ring back and ask about their reservation. Not real bookings. For the secret key only.
create table if not exists public.demo_reservations (
  scope         text not null,
  confirmation  text not null,
  data          jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (scope, confirmation)
);
alter table public.demo_reservations enable row level security;
revoke all on public.demo_reservations from anon, authenticated;
