-- ============================================================================
-- 0003_session_passes.sql
-- Server-authoritative session pass metering (PROJECT_BRIEF.md §7, §8).
--
-- Guarantees implemented here:
--   * Atomic under concurrency  -> per-user advisory transaction lock
--   * Idempotent                -> unique (user_id, request_id)
--   * Reuse before allocate     -> unexpired pass for the same pair is returned
--   * Rolling window            -> true rolling 24h, not a calendar day
--   * Understandable next time  -> oldest in-window issuance + window length
--   * Bonus capacity            -> raises capacity; never revokes issued passes
--
-- The client never computes entitlement. It calls issue_session_pass() and renders
-- the result. A modified client cannot mint a pass it did not receive.
-- ============================================================================

create table if not exists public.session_passes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  -- Canonical, order-independent pair key (see contracts/media.ts canonicalPairKey).
  pair_key    text not null,
  -- Which identity layer produced the key; recorded so metering is auditable and
  -- a later logical match can be explained.
  identity_layer text not null default 'physical'
                 check (identity_layer in ('logical','physical')),
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- 'base' counts against base capacity, 'bonus' against bonus capacity,
  -- 'pro' is unmetered, 'grant' is staff compensation and never counts against quota.
  capacity_class text not null default 'base'
                 check (capacity_class in ('base','bonus','pro','grant')),
  -- Idempotency key supplied by the caller (uuid). Retries return the original pass.
  request_id  uuid not null,
  policy_version text not null,
  constraint pass_interval_valid check (expires_at > issued_at)
);

-- Idempotency: the same request never allocates twice.
create unique index if not exists session_passes_request_key
  on public.session_passes (user_id, request_id);

-- Supports "find an unexpired pass for this pair" and rolling-window counts.
create index if not exists session_passes_user_pair_expiry
  on public.session_passes (user_id, pair_key, expires_at desc);

create index if not exists session_passes_user_issued
  on public.session_passes (user_id, issued_at desc);

alter table public.session_passes enable row level security;

drop policy if exists passes_self_read on public.session_passes;
create policy passes_self_read on public.session_passes
  for select to authenticated using (user_id = auth.uid());

-- NO client INSERT/UPDATE/DELETE policy. Issuance happens only through the
-- SECURITY DEFINER function below, which enforces quota.

-- ---------------------------------------------------------------------------
-- Tagging bonus grants (§8). One per rolling window.
-- ---------------------------------------------------------------------------
create table if not exists public.tag_bonus_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  granted_at    timestamptz not null default now(),
  window_ends_at timestamptz not null,
  contributions_counted integer not null,
  passes_granted integer not null,
  policy_version text not null
);

create index if not exists tag_bonus_grants_user_time
  on public.tag_bonus_grants (user_id, granted_at desc);

alter table public.tag_bonus_grants enable row level security;

drop policy if exists tag_bonus_self_read on public.tag_bonus_grants;
create policy tag_bonus_self_read on public.tag_bonus_grants
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Result shape. Explicit outcome instead of an exception for the normal "quota
-- exhausted" case, so the API can return a structured, understandable response.
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.pass_issue_result as (
    outcome           text,
    pass_id           uuid,
    pair_key          text,
    issued_at         timestamptz,
    expires_at        timestamptz,
    tier              text,
    capacity_class    text,
    base_used         integer,
    base_capacity     integer,
    bonus_used        integer,
    bonus_capacity    integer,
    next_available_at timestamptz,
    reason            text
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Metering snapshot: what the UI renders. Read-only, RLS-respecting.
-- ---------------------------------------------------------------------------
create or replace function public.pass_status(p_user_id uuid)
returns public.pass_issue_result
language plpgsql stable security invoker set search_path = public as $$
declare
  v_cfg          jsonb;
  v_window       interval;
  v_base_cap     integer;
  v_bonus_cap    integer;
  v_base_used    integer;
  v_bonus_used   integer;
  v_tier         text;
  v_window_start timestamptz;
  v_next         timestamptz;
begin
  if p_user_id is distinct from auth.uid() then
    raise exception 'pass_status: caller may only read their own status';
  end if;

  v_cfg := public.active_policy() -> 'pass';
  v_window := make_interval(hours => coalesce((v_cfg ->> 'windowHours')::int, 24));
  v_base_cap := coalesce((v_cfg ->> 'basePassesPerWindow')::int, 6);
  v_window_start := now() - v_window;
  v_tier := public.effective_tier(p_user_id);

  select count(*) into v_base_used
  from public.session_passes
  where user_id = p_user_id and capacity_class = 'base' and issued_at > v_window_start;

  select count(*) into v_bonus_used
  from public.session_passes
  where user_id = p_user_id and capacity_class = 'bonus' and issued_at > v_window_start;

  v_bonus_cap := public.active_bonus_capacity(p_user_id);

  -- Next availability: when the oldest in-window base pass leaves the window.
  select min(issued_at) + v_window into v_next
  from public.session_passes
  where user_id = p_user_id and capacity_class = 'base' and issued_at > v_window_start;

  return row(
    'status', null, null, null, null, v_tier, null,
    v_base_used, v_base_cap, v_bonus_used, v_bonus_cap,
    case when v_base_used >= v_base_cap then v_next else null end,
    null
  )::public.pass_issue_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Active policy payload. Falls back to the seeded dev policy so a fresh database
-- is usable, but production must activate a reviewed policy row.
-- ---------------------------------------------------------------------------
create or replace function public.active_policy()
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(
    (select payload from public.policy_versions where status = 'active'
      order by activated_at desc nulls last limit 1),
    (select payload from public.policy_versions order by created_at desc limit 1),
    '{}'::jsonb
  );
$$;

-- ---------------------------------------------------------------------------
-- Bonus capacity currently available (§8).
--
-- Capacity is granted for a reward window. IMPORTANT: an already-issued pass keeps
-- its own expires_at even after the bonus window closes (§8) — capacity and pass
-- lifetime are deliberately independent.
-- ---------------------------------------------------------------------------
create or replace function public.active_bonus_capacity(p_user_id uuid)
returns integer language sql stable security invoker set search_path = public as $$
  select coalesce((
    select g.passes_granted from public.tag_bonus_grants g
    where g.user_id = p_user_id and g.window_ends_at > now()
    order by g.granted_at desc limit 1
  ), 0);
$$;

-- ---------------------------------------------------------------------------
-- ISSUE OR REUSE A PASS.
--
-- SECURITY DEFINER (needs to insert where clients have no INSERT policy) but it
-- HARD-ASSERTS p_user_id = auth.uid(), so it cannot be used to allocate passes for
-- another account even though it runs with elevated privileges.
--
-- Concurrency: pg_advisory_xact_lock serializes allocation per user for the duration
-- of the transaction. Two simultaneous requests therefore cannot both observe
-- "5 used" and both insert a 6th-and-7th pass. The lock is transaction-scoped and
-- released automatically on commit/rollback.
-- ---------------------------------------------------------------------------
create or replace function public.issue_session_pass(
  p_user_id      uuid,
  p_pair_key     text,
  p_request_id   uuid,
  p_identity_layer text default 'physical'
)
returns public.pass_issue_result
language plpgsql security definer set search_path = public as $$
declare
  v_cfg            jsonb;
  v_policy_version text;
  v_window         interval;
  v_lifetime       interval;
  v_base_cap       integer;
  v_bonus_cap      integer;
  v_base_used      integer;
  v_bonus_used     integer;
  v_tier           text;
  v_state          text;
  v_existing       public.session_passes;
  v_new_id         uuid;
  v_now            timestamptz;
  v_window_start   timestamptz;
  v_class          text;
  v_next           timestamptz;
begin
  -- Authorization: never allocate for someone else.
  if p_user_id is distinct from auth.uid() then
    raise exception 'issue_session_pass: caller may only allocate for themselves'
      using errcode = '42501';
  end if;

  if p_pair_key is null or length(trim(p_pair_key)) = 0 then
    raise exception 'issue_session_pass: pair_key is required' using errcode = '22023';
  end if;
  if length(p_pair_key) > 512 then
    raise exception 'issue_session_pass: pair_key too long' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'issue_session_pass: request_id is required' using errcode = '22023';
  end if;

  -- Serialize per-user allocation. hashtextextended gives a well-distributed 64-bit key.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_now := now();

  -- (1) IDEMPOTENCY: a retried request returns its original result, even if that pass
  -- has since expired. The caller learns the true state rather than being charged twice.
  select * into v_existing from public.session_passes
  where user_id = p_user_id and request_id = p_request_id;

  if found then
    v_cfg := public.active_policy() -> 'pass';
    v_window := make_interval(hours => coalesce((v_cfg ->> 'windowHours')::int, 24));
    v_base_cap := coalesce((v_cfg ->> 'basePassesPerWindow')::int, 6);
    v_bonus_cap := public.active_bonus_capacity(p_user_id);
    select count(*) into v_base_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'base' and issued_at > v_now - v_window;
    select count(*) into v_bonus_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'bonus' and issued_at > v_now - v_window;

    return row(
      case when v_existing.expires_at > v_now then 'reused' else 'expired' end,
      v_existing.id, v_existing.pair_key, v_existing.issued_at, v_existing.expires_at,
      public.effective_tier(p_user_id), v_existing.capacity_class,
      v_base_used, v_base_cap, v_bonus_used, v_bonus_cap, null,
      case when v_existing.expires_at > v_now then 'idempotent_retry' else 'pass_expired' end
    )::public.pass_issue_result;
  end if;

  select account_state into v_state from public.profiles where id = p_user_id;
  if v_state is null then
    raise exception 'issue_session_pass: profile not found' using errcode = 'P0002';
  end if;
  if v_state <> 'active' then
    return row('denied', null, p_pair_key, null, null, public.effective_tier(p_user_id),
      null, 0, 0, 0, 0, null, 'account_not_active')::public.pass_issue_result;
  end if;

  v_tier := public.effective_tier(p_user_id);

  -- (2) REUSE BEFORE ALLOCATE: reloading, resuming or rewatching the same pair inside
  -- its 24h lifetime is free and must not consume another pass (§7).
  select * into v_existing from public.session_passes
  where user_id = p_user_id and pair_key = p_pair_key and expires_at > v_now
  order by expires_at desc limit 1;

  if found then
    v_cfg := public.active_policy() -> 'pass';
    v_window := make_interval(hours => coalesce((v_cfg ->> 'windowHours')::int, 24));
    v_base_cap := coalesce((v_cfg ->> 'basePassesPerWindow')::int, 6);
    v_bonus_cap := public.active_bonus_capacity(p_user_id);
    select count(*) into v_base_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'base' and issued_at > v_now - v_window;
    select count(*) into v_bonus_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'bonus' and issued_at > v_now - v_window;

    return row('reused', v_existing.id, v_existing.pair_key, v_existing.issued_at,
      v_existing.expires_at, v_tier, v_existing.capacity_class,
      v_base_used, v_base_cap, v_bonus_used, v_bonus_cap, null, 'existing_pass'
    )::public.pass_issue_result;
  end if;

  -- (3) ALLOCATE.
  select version into v_policy_version from public.policy_versions
    order by (status = 'active') desc, created_at desc limit 1;
  v_policy_version := coalesce(v_policy_version, '0.0.1-dev');

  v_cfg := public.active_policy() -> 'pass';
  v_window := make_interval(hours => coalesce((v_cfg ->> 'windowHours')::int, 24));
  v_lifetime := make_interval(hours => coalesce((v_cfg ->> 'passLifetimeHours')::int, 24));
  v_base_cap := coalesce((v_cfg ->> 'basePassesPerWindow')::int, 6);
  v_window_start := v_now - v_window;

  if v_tier = 'pro' then
    -- Pro is unmetered but still recorded, so resume/reuse and auditing work identically.
    v_class := 'pro';
    v_base_used := 0;
    v_bonus_used := 0;
    v_bonus_cap := 0;
  else
    v_bonus_cap := public.active_bonus_capacity(p_user_id);

    select count(*) into v_base_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'base' and issued_at > v_window_start;
    select count(*) into v_bonus_used from public.session_passes
      where user_id = p_user_id and capacity_class = 'bonus' and issued_at > v_window_start;

    if v_base_used < v_base_cap then
      v_class := 'base';
    elsif v_bonus_used < v_bonus_cap then
      v_class := 'bonus';
    else
      -- Quota exhausted. Return the earliest moment capacity frees up, computed from
      -- the oldest in-window issuance in the class that would be consumed next.
      select min(issued_at) + v_window into v_next from public.session_passes
        where user_id = p_user_id and capacity_class = 'base' and issued_at > v_window_start;

      return row('denied', null, p_pair_key, null, null, v_tier, null,
        v_base_used, v_base_cap, v_bonus_used, v_bonus_cap, v_next, 'quota_exhausted'
      )::public.pass_issue_result;
    end if;
  end if;

  insert into public.session_passes
    (user_id, pair_key, identity_layer, issued_at, expires_at, capacity_class, request_id, policy_version)
  values
    (p_user_id, p_pair_key, p_identity_layer, v_now, v_now + v_lifetime, v_class, p_request_id, v_policy_version)
  returning id into v_new_id;

  return row('issued', v_new_id, p_pair_key, v_now, v_now + v_lifetime, v_tier, v_class,
    v_base_used + case when v_class = 'base' then 1 else 0 end, v_base_cap,
    v_bonus_used + case when v_class = 'bonus' then 1 else 0 end, v_bonus_cap,
    null, null)::public.pass_issue_result;
end;
$$;

revoke all on function public.issue_session_pass(uuid, text, uuid, text) from public;
grant execute on function public.issue_session_pass(uuid, text, uuid, text) to authenticated;

revoke all on function public.pass_status(uuid) from public;
grant execute on function public.pass_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grant the tagging bonus once eligibility is met (§8). Idempotent per window.
-- Called by trusted server code after verification, never directly by the client.
-- ---------------------------------------------------------------------------
create or replace function public.grant_tagging_bonus(
  p_user_id uuid,
  p_eligible_contributions integer
)
returns public.tag_bonus_grants
language plpgsql security definer set search_path = public as $$
declare
  v_cfg      jsonb;
  v_required integer;
  v_passes   integer;
  v_hours    integer;
  v_existing public.tag_bonus_grants;
  v_row      public.tag_bonus_grants;
  v_now      timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1));
  v_now := now();

  v_cfg := public.active_policy() -> 'taggingBonus';
  v_required := coalesce((v_cfg ->> 'requiredContributions')::int, 4);
  v_passes := coalesce((v_cfg ->> 'bonusPasses')::int, 2);
  v_hours := coalesce((v_cfg ->> 'bonusWindowHours')::int, 24);

  -- One bonus per rolling window.
  select * into v_existing from public.tag_bonus_grants
  where user_id = p_user_id and window_ends_at > v_now
  order by granted_at desc limit 1;
  if found then
    return v_existing;
  end if;

  if p_eligible_contributions < v_required then
    return null;
  end if;

  insert into public.tag_bonus_grants
    (user_id, granted_at, window_ends_at, contributions_counted, passes_granted, policy_version)
  values
    (p_user_id, v_now, v_now + make_interval(hours => v_hours), p_eligible_contributions, v_passes,
     coalesce((select version from public.policy_versions order by created_at desc limit 1), '0.0.1-dev'))
  returning * into v_row;

  return v_row;
end;
$$;

-- SECURITY: Supabase grants EXECUTE on new public functions to `authenticated` via
-- ALTER DEFAULT PRIVILEGES. `revoke ... from public` does NOT remove that explicit grant,
-- so trusted-only functions must revoke from `authenticated` and `anon` by name.
-- Without this, a client could call grant_tagging_bonus() and mint its own bonus passes.
-- (Verified by tests/integration/passes.test.ts "does not grant the bonus to a client directly".)
revoke all on function public.grant_tagging_bonus(uuid, integer) from public, authenticated, anon;
grant execute on function public.grant_tagging_bonus(uuid, integer) to service_role;
