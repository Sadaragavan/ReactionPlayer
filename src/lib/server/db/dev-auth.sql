-- ============================================================================
-- dev-auth.sql — LOCAL DEVELOPMENT AUTH ONLY. NOT A SUPABASE MIGRATION.
--
-- Applied by `npm run db:setup:dev` when ALLOW_DEV_AUTH=true and no Supabase project is
-- configured. This exists so the full vertical slice (auth -> pass -> playback -> resume)
-- can be developed and tested without cloud credentials.
--
-- It is deliberately NOT in supabase/migrations/, so it can never be applied to a
-- Supabase project by the normal migration path. The production auth provider is
-- Supabase Auth; this schema is unused there.
--
-- Passwords use scrypt with a per-user random salt. Sessions are opaque random tokens
-- stored server-side and delivered in an httpOnly cookie. No password or token is ever
-- readable by client JavaScript or by the `authenticated` database role.
-- ============================================================================

create schema if not exists dev_auth;

create table if not exists dev_auth.credentials (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  password_hash text not null,
  salt          text not null,
  -- Parameters recorded so the work factor can be raised without invalidating hashes.
  kdf           text not null default 'scrypt',
  kdf_params    jsonb not null default '{"N":16384,"r":8,"p":1,"keylen":64}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists dev_auth.sessions (
  -- Store only a hash of the token: a database leak does not yield usable sessions.
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index if not exists dev_auth_sessions_user on dev_auth.sessions (user_id);
create index if not exists dev_auth_sessions_expiry on dev_auth.sessions (expires_at);

-- No grants to `authenticated` or `anon`: credential and session material is reachable
-- only by the trusted server role. RLS is enabled as defence in depth.
alter table dev_auth.credentials enable row level security;
alter table dev_auth.sessions enable row level security;

revoke all on schema dev_auth from public, anon, authenticated;
revoke all on all tables in schema dev_auth from public, anon, authenticated;
grant usage on schema dev_auth to service_role;
grant all on all tables in schema dev_auth to service_role;

-- The development provider creates accounts by inserting into auth.users directly.
-- In production this NEVER happens: Supabase Auth owns user creation through its API,
-- and the application only reads the resulting identity. This grant is dev-only, which
-- is why it lives here rather than in supabase/migrations/.
grant select, insert, update, delete on auth.users to service_role;

-- The signup trigger inserts into public.profiles; it is SECURITY DEFINER so it runs as
-- its owner, but service_role also needs explicit table privileges for profile reads.
grant select, insert, update on public.profiles to service_role;
