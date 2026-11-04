-- ============================================================================
-- 0004_media_catalog.sql
-- Media identity layers, catalog, sync profiles, local session references.
--
-- Separates physical / logical / version identity (PROJECT_BRIEF.md §7).
-- Private data (filenames, fingerprints, signed URLs) is never publicly readable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Logical catalog sources ("the episode"), independent of cut or encode.
-- ---------------------------------------------------------------------------
create table if not exists public.catalog_sources (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  kind          text not null default 'episode'
                check (kind in ('film','episode','short','special','other')),
  series_title  text,
  season_number integer,
  episode_number integer,
  -- External catalog references (TMDB/AniList/etc). Commercial-use licensing must be
  -- verified before enabling any provider import (§14).
  external_refs jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists catalog_sources_series_idx
  on public.catalog_sources (series_title, season_number, episode_number);

alter table public.catalog_sources enable row level security;

drop policy if exists catalog_sources_read on public.catalog_sources;
create policy catalog_sources_read on public.catalog_sources
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Source versions / cuts. Runtime varies legitimately by region/edit; a runtime
-- mismatch is a WEAK signal, never automatic proof a user is wrong (§8).
-- ---------------------------------------------------------------------------
create table if not exists public.source_versions (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references public.catalog_sources(id) on delete cascade,
  version_label text not null default 'standard',
  runtime_ms    bigint,
  notes         text not null default '',
  created_at    timestamptz not null default now(),
  unique (source_id, version_label)
);

alter table public.source_versions enable row level security;

drop policy if exists source_versions_read on public.source_versions;
create policy source_versions_read on public.source_versions
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Reactors and their releases.
-- ---------------------------------------------------------------------------
create table if not exists public.reactors (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  -- Verified creator attestations are a distinct, stronger evidence class (§8).
  verified_at   timestamptz,
  verified_by   uuid references public.profiles(id),
  channel_refs  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

alter table public.reactors enable row level security;

drop policy if exists reactors_read on public.reactors;
create policy reactors_read on public.reactors
  for select to authenticated using (true);

create table if not exists public.reaction_releases (
  id            uuid primary key default gen_random_uuid(),
  reactor_id    uuid not null references public.reactors(id) on delete cascade,
  title         text not null,
  provider      text not null,
  -- Stable provider content id. NOT a signed/expiring URL (§7).
  provider_content_id text,
  -- Outbound link to the authorized provider. Discovery is a round trip, not a
  -- dead end of links (§14).
  provider_url  text,
  released_at   timestamptz,
  created_at    timestamptz not null default now()
);

create unique index if not exists reaction_releases_provider_content_key
  on public.reaction_releases (provider, provider_content_id)
  where provider_content_id is not null;

alter table public.reaction_releases enable row level security;

drop policy if exists reaction_releases_read on public.reaction_releases;
create policy reaction_releases_read on public.reaction_releases
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Media fingerprints. PRIVATE: a fingerprint plus filename can identify what a
-- specific person owns. Owner-only read; never in a public projection (§17).
-- A sampled fingerprint is an identifier, not proof of content correctness (§7).
-- ---------------------------------------------------------------------------
create table if not exists public.media_fingerprints (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.profiles(id) on delete cascade,
  scheme_version integer not null,
  digest         text not null,
  provider       text not null,
  size_bytes     bigint,
  duration_ms    bigint,
  -- Private: original filename, used only for the owner's reselection hint.
  file_name      text,
  exhaustive     boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (owner_id, scheme_version, digest, provider)
);

alter table public.media_fingerprints enable row level security;

drop policy if exists fingerprints_owner_all on public.media_fingerprints;
create policy fingerprints_owner_select on public.media_fingerprints
  for select to authenticated using (owner_id = auth.uid());
create policy fingerprints_owner_insert on public.media_fingerprints
  for insert to authenticated with check (owner_id = auth.uid());
create policy fingerprints_owner_delete on public.media_fingerprints
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Sync profiles. ONE offset per reaction/source-VERSION pair for MVP (§1).
-- `map` jsonb reserves room for a future piecewise timeline map without a breaking
-- migration; MVP writes a single offset and leaves map null.
-- ---------------------------------------------------------------------------
create table if not exists public.sync_profiles (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  reaction_release_id uuid references public.reaction_releases(id) on delete cascade,
  source_version_id  uuid references public.source_versions(id) on delete cascade,
  -- Fallback identity when catalog matching is unresolved.
  pair_key           text,
  offset_ms          integer not null,
  -- Reserved for future piecewise maps. NULL in MVP.
  map                jsonb,
  map_schema_version integer not null default 1,
  -- Personal offsets are useful while unverified, but must be clearly labelled and
  -- must not affect shared data until verified (§8).
  visibility         text not null default 'private'
                     check (visibility in ('private','shared')),
  verification_state text not null default 'unverified'
                     check (verification_state in ('unverified','pending','verified','rejected')),
  confidence         text not null default 'tentative'
                     check (confidence in ('exact','strong','tentative','unresolved')),
  policy_version     text not null default '0.0.1-dev',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sync_profile_needs_identity check (
    pair_key is not null or (reaction_release_id is not null and source_version_id is not null)
  ),
  constraint shared_requires_verified check (
    visibility <> 'shared' or verification_state = 'verified'
  )
);

drop trigger if exists sync_profiles_touch on public.sync_profiles;
create trigger sync_profiles_touch before update on public.sync_profiles
  for each row execute function public.tg_touch_updated_at();

create index if not exists sync_profiles_owner_pair
  on public.sync_profiles (owner_id, pair_key);

alter table public.sync_profiles enable row level security;

drop policy if exists sync_profiles_owner_select on public.sync_profiles;
create policy sync_profiles_owner_select on public.sync_profiles
  for select to authenticated using (owner_id = auth.uid() or visibility = 'shared');
create policy sync_profiles_owner_insert on public.sync_profiles
  for insert to authenticated with check (owner_id = auth.uid() and visibility = 'private');
create policy sync_profiles_owner_update on public.sync_profiles
  for update to authenticated using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and visibility = 'private');
create policy sync_profiles_owner_delete on public.sync_profiles
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Cloud session references (Pro cross-device sync, §4). Local sessions stay in
-- IndexedDB for all tiers; this table stores only configuration, never media.
-- ---------------------------------------------------------------------------
create table if not exists public.cloud_sessions (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references public.profiles(id) on delete cascade,
  schema_version integer not null,
  name           text not null default 'Untitled session',
  -- Configuration only: never media bytes, never blob URLs, never signed URLs (§4).
  payload        jsonb not null,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

drop trigger if exists cloud_sessions_touch on public.cloud_sessions;
create trigger cloud_sessions_touch before update on public.cloud_sessions
  for each row execute function public.tg_touch_updated_at();

alter table public.cloud_sessions enable row level security;

drop policy if exists cloud_sessions_owner_all on public.cloud_sessions;
create policy cloud_sessions_owner_select on public.cloud_sessions
  for select to authenticated using (owner_id = auth.uid());
create policy cloud_sessions_owner_delete on public.cloud_sessions
  for delete to authenticated using (owner_id = auth.uid());
-- Writes are gated server-side on the Pro entitlement, not by RLS alone.

-- ---------------------------------------------------------------------------
-- Queue / watchlist: the PRIMARY recommendation action (§14).
-- ---------------------------------------------------------------------------
create table if not exists public.queue_items (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references public.profiles(id) on delete cascade,
  reaction_release_id uuid references public.reaction_releases(id) on delete cascade,
  source_id           uuid references public.catalog_sources(id) on delete cascade,
  state               text not null default 'saved'
                      check (state in ('saved','acquired','watched','dismissed')),
  -- Opt-in alerts only; never implied by saving (§14).
  notify_on_availability boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists queue_items_touch on public.queue_items;
create trigger queue_items_touch before update on public.queue_items
  for each row execute function public.tg_touch_updated_at();

alter table public.queue_items enable row level security;

drop policy if exists queue_owner_select on public.queue_items;
create policy queue_owner_select on public.queue_items
  for select to authenticated using (owner_id = auth.uid());
create policy queue_owner_write on public.queue_items
  for insert to authenticated with check (owner_id = auth.uid());
create policy queue_owner_update on public.queue_items
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy queue_owner_delete on public.queue_items
  for delete to authenticated using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Optional watch activity (§5). Only written when watch_history consent is granted.
-- Distinct from activity_counters, which exist for reward eligibility with a
-- separately explained purpose.
-- ---------------------------------------------------------------------------
create table if not exists public.watch_activity (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  source_id     uuid references public.catalog_sources(id) on delete set null,
  reaction_release_id uuid references public.reaction_releases(id) on delete set null,
  engaged_seconds integer not null default 0,
  engaged_fraction numeric(5,4),
  occurred_at   timestamptz not null default now()
);

create index if not exists watch_activity_owner_time
  on public.watch_activity (owner_id, occurred_at desc);

alter table public.watch_activity enable row level security;

drop policy if exists watch_activity_owner_select on public.watch_activity;
create policy watch_activity_owner_select on public.watch_activity
  for select to authenticated using (owner_id = auth.uid());
create policy watch_activity_owner_delete on public.watch_activity
  for delete to authenticated using (owner_id = auth.uid());

-- Writes require consent; enforced in the definer function so it cannot be bypassed
-- by a direct INSERT with a forged owner.
create or replace function public.record_watch_activity(
  p_owner_id uuid,
  p_source_id uuid,
  p_reaction_release_id uuid,
  p_engaged_seconds integer,
  p_engaged_fraction numeric
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_consented boolean;
  v_id uuid;
begin
  if p_owner_id is distinct from auth.uid() then
    raise exception 'record_watch_activity: owner mismatch' using errcode = '42501';
  end if;

  select granted into v_consented from public.consent_current
  where user_id = p_owner_id and purpose = 'watch_history';

  -- No consent => no history row. Aggregate eligibility counters are separate (§5).
  if not coalesce(v_consented, false) then
    return null;
  end if;

  insert into public.watch_activity
    (owner_id, source_id, reaction_release_id, engaged_seconds, engaged_fraction)
  values (p_owner_id, p_source_id, p_reaction_release_id, p_engaged_seconds, p_engaged_fraction)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_watch_activity(uuid, uuid, uuid, integer, numeric) from public;
grant execute on function public.record_watch_activity(uuid, uuid, uuid, integer, numeric) to authenticated;
