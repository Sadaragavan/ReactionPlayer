-- ============================================================================
-- 0002_accounts.sql
-- Profiles, granular consent, entitlements, staff roles.
--
-- Anonymous-by-default is enforced structurally: public display reads a projection
-- that cannot expose account ids or emails (PROJECT_BRIEF.md §6).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Profiles. One row per auth user. NO email-derived public username.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  -- Null nickname => "Anonymous contributor" in every public projection.
  nickname      text,
  nickname_normalized text,
  nickname_changed_at timestamptz,
  -- Versioned acknowledgement of public-display guidelines (§6).
  nickname_guidelines_version text,
  nickname_confirmed_public_at timestamptz,
  -- Moderation may force a rename; reason and appeal path are disclosed (§6).
  nickname_moderation_state text not null default 'none'
    check (nickname_moderation_state in ('none','pending_review','removed','forced_rename')),
  nickname_moderation_reason text,
  account_state text not null default 'active'
    check (account_state in ('active','suspended','deleted')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint nickname_requires_confirmation check (
    nickname is null or nickname_confirmed_public_at is not null
  ),
  constraint nickname_length check (
    nickname is null or (char_length(nickname) between 3 and 24)
  )
);

-- Case-insensitive uniqueness on the normalized form (§6).
create unique index if not exists profiles_nickname_normalized_key
  on public.profiles (nickname_normalized) where nickname_normalized is not null;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

alter table public.profiles enable row level security;

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- No INSERT policy for authenticated: profiles are created by the signup trigger.
-- No public SELECT policy: public access is only via the projection view below.

-- ---------------------------------------------------------------------------
-- Auto-provision profile on signup. SECURITY DEFINER because the new user has no
-- session yet. Never copies email or provider name into a public field (§6, §22).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Granular, versioned, revocable consent (§5).
-- Append-only event log: current state is the latest event per (user, purpose).
-- Operational account data is NOT a consent purpose — it is the service contract.
-- ---------------------------------------------------------------------------
create table if not exists public.consent_purposes (
  key          text primary key,
  title        text not null,
  explanation  text not null,
  required_for_service boolean not null default false,
  display_order integer not null default 0
);

insert into public.consent_purposes (key, title, explanation, required_for_service, display_order) values
  ('watch_history', 'Watch history and personalization',
   'Remember what you watched so we can recommend more from the same reactor or series. Optional: declining does not limit playback or passes.',
   false, 10),
  ('community_contributions', 'Community contributions',
   'Share the tags and sync offsets you submit so other viewers can benefit. Your contributions stay anonymous unless you choose a public nickname.',
   false, 20),
  ('product_analytics', 'Product analytics',
   'Aggregate usage measurements that help us fix problems and prioritize features. Never includes your media, filenames, or video content.',
   false, 30),
  ('public_nickname', 'Public nickname display',
   'Show a nickname you choose on public leaderboards and badges. You can return to anonymous display at any time.',
   false, 40)
on conflict (key) do nothing;

create table if not exists public.consent_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  purpose        text not null references public.consent_purposes(key),
  granted        boolean not null,
  policy_version text not null,
  -- Server time is authoritative; client clocks are never trusted for consent ordering.
  recorded_at    timestamptz not null default now(),
  source         text not null default 'settings'
);

create index if not exists consent_events_user_purpose_time
  on public.consent_events (user_id, purpose, recorded_at desc);

alter table public.consent_events enable row level security;

drop policy if exists consent_self_read on public.consent_events;
create policy consent_self_read on public.consent_events
  for select to authenticated using (user_id = auth.uid());

drop policy if exists consent_self_write on public.consent_events;
create policy consent_self_write on public.consent_events
  for insert to authenticated with check (user_id = auth.uid());

-- Append-only: no UPDATE/DELETE policies. Revocation is a new event with granted=false.

-- Current consent state, derived from the event log.
create or replace view public.consent_current as
select distinct on (user_id, purpose)
  user_id, purpose, granted, policy_version, recorded_at
from public.consent_events
order by user_id, purpose, recorded_at desc;

-- Views must not bypass RLS of the invoking user.
alter view public.consent_current set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- Minimal activity counters for reward eligibility (§5, §11).
-- Deliberately SEPARATE from watch history: a user who declines personalization can
-- still earn a trial. These are aggregate counters, not a viewing log.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_counters (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  -- UTC date bucket; no titles, no media identity, no filenames.
  bucket_date    date not null,
  distinct_viewing_items integer not null default 0 check (distinct_viewing_items >= 0),
  contribution_units numeric(10,4) not null default 0 check (contribution_units >= 0),
  updated_at     timestamptz not null default now(),
  primary key (user_id, bucket_date)
);

comment on table public.activity_counters is
  'Aggregate eligibility counters. Purpose is separate from personalization: no titles or media identity, so declining watch history does not block trial eligibility.';

alter table public.activity_counters enable row level security;

drop policy if exists activity_self_read on public.activity_counters;
create policy activity_self_read on public.activity_counters
  for select to authenticated using (user_id = auth.uid());

-- Writes only via server-side definer functions; no client INSERT policy.

-- ---------------------------------------------------------------------------
-- Entitlements (§7, §11, §12, §13). Server-authoritative; never client-controlled.
-- A grant is an interval. Tier is derived from active grants, not a mutable flag.
-- ---------------------------------------------------------------------------
create table if not exists public.entitlement_grants (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  tier         text not null check (tier in ('free','pro')),
  source       text not null check (source in (
                 'subscription','earned_trial','card_trial','leaderboard_reward',
                 'surprise_drop','compensation','staff_grant','manual'
               )),
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,
  -- Idempotency for webhooks/award jobs (§17).
  external_ref text,
  -- Gifts/compensation must NOT consume the one formal trial (§11).
  consumes_formal_trial boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   uuid references public.profiles(id),
  revoked_at   timestamptz,
  revoke_reason text,
  constraint grant_interval_valid check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists entitlement_grants_external_ref_key
  on public.entitlement_grants (source, external_ref) where external_ref is not null;

create index if not exists entitlement_grants_user_active
  on public.entitlement_grants (user_id, starts_at, ends_at) where revoked_at is null;

alter table public.entitlement_grants enable row level security;

drop policy if exists entitlements_self_read on public.entitlement_grants;
create policy entitlements_self_read on public.entitlement_grants
  for select to authenticated using (user_id = auth.uid());

-- No client write policy: all grants are issued by trusted server code.

-- Effective tier right now. SECURITY INVOKER so RLS still applies.
create or replace function public.effective_tier(p_user_id uuid)
returns text language sql stable security invoker set search_path = public as $$
  select case when exists (
    select 1 from public.entitlement_grants
    where user_id = p_user_id
      and tier = 'pro'
      and revoked_at is null
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
  ) then 'pro' else 'free' end;
$$;

-- ---------------------------------------------------------------------------
-- Formal trial history (§11). One formal trial per account. Gifts never write here.
-- ---------------------------------------------------------------------------
create table if not exists public.trial_claims (
  id           uuid primary key default gen_random_uuid(),
  -- UNIQUE on user_id enforces "one formal trial" atomically at the database level.
  user_id      uuid not null unique references public.profiles(id) on delete cascade,
  path         text not null check (path in ('earned_no_card','early_card')),
  grant_id     uuid not null references public.entitlement_grants(id),
  claimed_at   timestamptz not null default now(),
  -- A no-card trial must never produce a charge. No payment reference is stored here.
  requires_payment_method boolean not null
);

alter table public.trial_claims enable row level security;

drop policy if exists trials_self_read on public.trial_claims;
create policy trials_self_read on public.trial_claims
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Staff roles (§10). Staff are normal users with additional grants.
-- No trust boost, excluded from competitive rewards, cannot judge own cases.
-- ---------------------------------------------------------------------------
create table if not exists public.staff_role_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('support','moderator','admin','owner')),
  granted_at  timestamptz not null default now(),
  granted_by  uuid references public.profiles(id),
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles(id),
  reason      text not null default ''
);

-- At most one active grant per (user, role).
create unique index if not exists staff_role_active_unique
  on public.staff_role_grants (user_id, role) where revoked_at is null;

alter table public.staff_role_grants enable row level security;

drop policy if exists staff_roles_self_read on public.staff_role_grants;
create policy staff_roles_self_read on public.staff_role_grants
  for select to authenticated using (user_id = auth.uid());

-- Role management is server-side only (never a public client flow).

create or replace function public.has_staff_role(p_user_id uuid, p_roles text[])
returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from public.staff_role_grants
    where user_id = p_user_id and role = any(p_roles) and revoked_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- Public display projection (§6). The ONLY shape exposed publicly.
-- Deliberately omits: account id, email, nickname history, watch data.
-- Note: anonymous rows have no stable public identifier, so they cannot be linked
-- across appearances. This does not prevent inference from ranks/scores (§6).
-- ---------------------------------------------------------------------------
create or replace function public.public_display_name(p_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nickname from public.profiles
      where id = p_user_id
        and nickname is not null
        and nickname_moderation_state in ('none','pending_review')),
    'Anonymous contributor'
  );
$$;

revoke all on function public.public_display_name(uuid) from public;
grant execute on function public.public_display_name(uuid) to authenticated, anon;
