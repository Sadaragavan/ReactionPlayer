-- ============================================================================
-- 0005_contributions.sql
-- Tag claims, evidence, trust events, reward credit (PROJECT_BRIEF.md §8, §9).
--
-- Core principles encoded here:
--   * A task is a reaction/source PAIR, not a rendered video element.
--   * Duplicate submissions cannot farm credit (unique per user+task).
--   * Pending evidence is structurally distinct from verified fact.
--   * Trust is derived from reversible events, never a mutable score column.
--   * Reward credit is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tagging tasks. One per reaction/source pair.
-- ---------------------------------------------------------------------------
create table if not exists public.tagging_tasks (
  id                  uuid primary key default gen_random_uuid(),
  reaction_release_id uuid references public.reaction_releases(id) on delete cascade,
  source_version_id   uuid references public.source_versions(id) on delete cascade,
  pair_key            text not null,
  -- Canary/reference tasks must never contaminate real catalog data (§8).
  is_reference_check  boolean not null default false,
  reference_truth     jsonb,
  created_at          timestamptz not null default now(),
  unique (pair_key)
);

alter table public.tagging_tasks enable row level security;

drop policy if exists tagging_tasks_read on public.tagging_tasks;
create policy tagging_tasks_read on public.tagging_tasks
  for select to authenticated using (
    -- Reference checks are hidden so their ground truth cannot be mined.
    is_reference_check = false or public.has_staff_role(auth.uid(), array['moderator','admin','owner'])
  );

-- ---------------------------------------------------------------------------
-- Tag claims with the lifecycle from §8.
-- ---------------------------------------------------------------------------
create table if not exists public.tag_claims (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tagging_tasks(id) on delete cascade,
  -- Null owner means a reference/canary claim authored by the system.
  submitted_by  uuid references public.profiles(id) on delete cascade,
  state         text not null default 'draft'
                check (state in ('draft','submitted','pending','verified','disputed','rejected','superseded')),
  claim         jsonb not null,
  claim_schema_version integer not null default 1,
  -- Correction chain: a superseded claim points at its replacement (§8, §10).
  superseded_by uuid references public.tag_claims(id),
  policy_version text not null default '0.0.1-dev',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists tag_claims_touch on public.tag_claims;
create trigger tag_claims_touch before update on public.tag_claims
  for each row execute function public.tg_touch_updated_at();

-- One live claim per user per task: prevents duplicate-submission farming (§8).
create unique index if not exists tag_claims_one_live_per_user_task
  on public.tag_claims (task_id, submitted_by)
  where state not in ('superseded','rejected') and submitted_by is not null;

create index if not exists tag_claims_state_idx on public.tag_claims (state, created_at desc);

alter table public.tag_claims enable row level security;

drop policy if exists tag_claims_owner_select on public.tag_claims;
create policy tag_claims_owner_select on public.tag_claims
  for select to authenticated using (
    submitted_by = auth.uid()
    or public.has_staff_role(auth.uid(), array['moderator','admin','owner'])
  );

drop policy if exists tag_claims_owner_insert on public.tag_claims;
create policy tag_claims_owner_insert on public.tag_claims
  for insert to authenticated with check (
    submitted_by = auth.uid() and state in ('draft','submitted')
  );

drop policy if exists tag_claims_owner_update on public.tag_claims;
create policy tag_claims_owner_update on public.tag_claims
  for update to authenticated using (submitted_by = auth.uid() and state in ('draft','submitted'))
  with check (submitted_by = auth.uid() and state in ('draft','submitted'));

-- Verification transitions are staff-only and happen server-side.

-- ---------------------------------------------------------------------------
-- Evidence. Layered and explicitly weighted by class; crowd agreement is NOT proof (§8).
-- ---------------------------------------------------------------------------
create table if not exists public.tag_evidence (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.tag_claims(id) on delete cascade,
  evidence_class text not null check (evidence_class in (
                    'catalog_selection','provider_metadata','creator_attestation',
                    'independent_corroboration','human_review','plausibility','reference_check'
                  )),
  -- Runtime/metadata agreement is a WEAK signal: cuts and encodes vary (§8).
  strength      text not null check (strength in ('weak','moderate','strong')),
  payload       jsonb not null default '{}'::jsonb,
  recorded_by   uuid references public.profiles(id),
  recorded_at   timestamptz not null default now()
);

alter table public.tag_evidence enable row level security;

drop policy if exists tag_evidence_staff_read on public.tag_evidence;
create policy tag_evidence_staff_read on public.tag_evidence
  for select to authenticated using (
    public.has_staff_role(auth.uid(), array['moderator','admin','owner'])
    or exists (select 1 from public.tag_claims c where c.id = claim_id and c.submitted_by = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Confirmations / votes. One per user per task; independently resolved (§8).
-- ---------------------------------------------------------------------------
create table if not exists public.sync_confirmations (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tagging_tasks(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  verdict     text not null check (verdict in ('confirms','disagrees','uncertain')),
  -- Resolution is independent of the crowd; null until independently checked.
  resolved_correct boolean,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (task_id, user_id)
);

alter table public.sync_confirmations enable row level security;

drop policy if exists sync_confirmations_owner_select on public.sync_confirmations;
create policy sync_confirmations_owner_select on public.sync_confirmations
  for select to authenticated using (user_id = auth.uid());
create policy sync_confirmations_owner_insert on public.sync_confirmations
  for insert to authenticated with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Trust events (§9). Append-only and reversible: trust is DERIVED, so an incorrect
-- decision can be undone by a compensating event rather than editing history.
-- Trust is never granted for paying, staff status, volume, or account age.
-- ---------------------------------------------------------------------------
create table if not exists public.trust_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  delta         numeric(6,2) not null,
  reason_code   text not null,
  -- Compensating event for a reversal (§10 reversal cascade).
  reverses_event_id uuid references public.trust_events(id),
  decision_id   uuid,
  policy_version text not null default '0.0.1-dev',
  -- Penalties caused BY a restriction must be excluded from renewal maths (§9).
  caused_by_restriction boolean not null default false,
  occurred_at   timestamptz not null default now()
);

create index if not exists trust_events_user_time on public.trust_events (user_id, occurred_at desc);

alter table public.trust_events enable row level security;

drop policy if exists trust_events_self_read on public.trust_events;
create policy trust_events_self_read on public.trust_events
  for select to authenticated using (user_id = auth.uid());

create or replace function public.derived_trust(p_user_id uuid)
returns numeric language sql stable security invoker set search_path = public as $$
  select greatest(0, least(100,
    -- Baseline 50: a new account is neither trusted nor distrusted.
    50 + coalesce((select sum(delta) from public.trust_events where user_id = p_user_id), 0)
  ));
$$;

-- ---------------------------------------------------------------------------
-- Reward credit ledger (§8). Idempotent per (user, task, kind).
-- Credit is released only when verification requirements are met; reduced standing
-- raises the bar but must never make a promised bonus secretly impossible (§9).
-- ---------------------------------------------------------------------------
create table if not exists public.contribution_credit (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  task_id       uuid not null references public.tagging_tasks(id) on delete cascade,
  kind          text not null check (kind in ('substantive_tag','confirmation','resolved_vote','correction')),
  state         text not null default 'pending'
                check (state in ('pending','credited','released','revoked')),
  contribution_units numeric(10,4) not null default 0,
  -- Activity period the credit belongs to; NOT the leaderboard settlement lag (§11).
  activity_period_start date not null default (now() at time zone 'utc')::date,
  credited_at   timestamptz not null default now(),
  released_at   timestamptz,
  revoked_at    timestamptz,
  revoke_reason text,
  policy_version text not null default '0.0.1-dev',
  unique (user_id, task_id, kind)
);

alter table public.contribution_credit enable row level security;

drop policy if exists contribution_credit_self_read on public.contribution_credit;
create policy contribution_credit_self_read on public.contribution_credit
  for select to authenticated using (user_id = auth.uid());

-- Count of DISTINCT released contributions in the current bonus window (§8).
create or replace function public.eligible_bonus_contributions(p_user_id uuid)
returns integer language sql stable security invoker set search_path = public as $$
  select count(distinct task_id)::int
  from public.contribution_credit
  where user_id = p_user_id
    and state = 'released'
    and released_at > now() - make_interval(hours =>
      coalesce(((public.active_policy() -> 'taggingBonus') ->> 'bonusWindowHours')::int, 24));
$$;

-- ---------------------------------------------------------------------------
-- Restrictions and probation (§9). Every restriction has a review date AND expiry.
-- Renewal requires fresh evidence; three consecutive renewals force human review.
-- ---------------------------------------------------------------------------
create table if not exists public.account_restrictions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in (
                   'reduced_influence','reward_hold','playback_restricted','access_suspended'
                 )),
  reason_code    text not null,
  evidence_ref   text,
  started_at     timestamptz not null default now(),
  review_at      timestamptz not null,
  expires_at     timestamptz not null,
  consecutive_renewals integer not null default 0,
  human_review_required boolean not null default false,
  policy_version text not null default '0.0.1-dev',
  decision_id    uuid,
  lifted_at      timestamptz,
  lifted_reason  text,
  constraint restriction_window_valid check (expires_at > started_at)
);

create index if not exists restrictions_user_active
  on public.account_restrictions (user_id, expires_at) where lifted_at is null;

alter table public.account_restrictions enable row level security;

-- Service-affecting restrictions MUST be accurately visible to the user (§9).
drop policy if exists restrictions_self_read on public.account_restrictions;
create policy restrictions_self_read on public.account_restrictions
  for select to authenticated using (user_id = auth.uid());

create table if not exists public.account_probation (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  started_at    timestamptz not null default now(),
  ends_at       timestamptz not null,
  reason_code   text not null,
  -- Probation pauses contributor rewards but NOT normal service access (§9).
  contributor_rewards_paused boolean not null default true,
  ended_at      timestamptz,
  end_reason    text,
  policy_version text not null default '0.0.1-dev'
);

alter table public.account_probation enable row level security;

drop policy if exists probation_self_read on public.account_probation;
create policy probation_self_read on public.account_probation
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Protection after our error (§9). Winning an appeal must not cause punishment.
-- ---------------------------------------------------------------------------
create table if not exists public.automated_penalty_protections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  reason_code   text not null,
  decision_id   uuid,
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz not null,
  created_at    timestamptz not null default now()
);

alter table public.automated_penalty_protections enable row level security;

drop policy if exists protections_self_read on public.automated_penalty_protections;
create policy protections_self_read on public.automated_penalty_protections
  for select to authenticated using (user_id = auth.uid());
