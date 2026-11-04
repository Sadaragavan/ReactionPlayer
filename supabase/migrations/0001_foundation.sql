-- ============================================================================
-- 0001_foundation.sql
-- Schema versions, policy registry, and shared helpers.
--
-- Assumes the Supabase `auth` schema exists (auth.users, auth.uid()).
-- All timestamps are timestamptz stored/compared in UTC (PROJECT_BRIEF.md §17).
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Schema-version registry. Every versioned data contract records its version so
-- projections can be rebuilt and migrations are auditable.
-- ---------------------------------------------------------------------------
create table if not exists public.schema_contracts (
  contract_name text primary key,
  version       integer not null check (version > 0),
  description   text not null default '',
  updated_at    timestamptz not null default now()
);

insert into public.schema_contracts (contract_name, version, description) values
  ('media',   1, 'Physical/logical/version media identity layers'),
  ('session', 1, 'Client session shape persisted to IndexedDB'),
  ('policy',  1, 'Provisional policy configuration'),
  ('tagging', 1, 'Tag claim lifecycle and evidence')
on conflict (contract_name) do nothing;

-- ---------------------------------------------------------------------------
-- Policy versions. The database copy is authoritative at runtime; the TypeScript
-- module supplies the seed. Provisional values are NOT validated production policy.
-- ---------------------------------------------------------------------------
create table if not exists public.policy_versions (
  version       text primary key,
  payload       jsonb not null,
  status        text not null default 'draft'
                check (status in ('draft','shadow','active','superseded')),
  -- 'shadow' supports policy simulation without affecting live decisions (§10).
  activated_at  timestamptz,
  created_at    timestamptz not null default now(),
  notes         text not null default ''
);

comment on table public.policy_versions is
  'Versioned policy configuration. Provisional thresholds live here, not in scattered code.';

-- ---------------------------------------------------------------------------
-- Feature flags / kill switches (§10). Independent switches so a single program
-- can be disabled without a deploy. Randomized drops ship DISABLED pending legal review.
-- ---------------------------------------------------------------------------
create table if not exists public.feature_flags (
  key           text primary key,
  enabled       boolean not null default false,
  description   text not null default '',
  -- Requires documented jurisdiction-specific legal review before enabling (§13, §19).
  requires_legal_review boolean not null default false,
  legal_review_completed_at timestamptz,
  updated_at    timestamptz not null default now(),
  constraint legal_review_gate check (
    not (enabled and requires_legal_review and legal_review_completed_at is null)
  )
);

insert into public.feature_flags (key, enabled, description, requires_legal_review) values
  ('surprise_drops', false, 'Unannounced 3-day Pro gifts (§13). OFF until legal review.', true),
  ('stripe_billing', false, 'Paid subscriptions (§18 v1.0).', true),
  ('shared_sync_profiles', false, 'Community-verified sync offsets (§18 v1.0).', false),
  ('public_leaderboards', false, 'Anonymous-by-default contributor boards (§12).', true),
  ('automated_restrictions', false, 'Automated punitive trust actions. OFF in alpha (§18 v0.1).', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Updated-at trigger helper.
-- ---------------------------------------------------------------------------
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit hash chain (§10). Tamper-EVIDENT, not tamper-proof: a privileged actor can
-- rewrite the chain. This detects accidental/unauthorized mutation, and is paired with
-- access control and off-site log shipping. Do not overstate this guarantee.
-- ---------------------------------------------------------------------------
create or replace function public.audit_chain_hash(
  p_prev_hash text,
  p_payload   jsonb
) returns text language sql immutable as $$
  select encode(digest(coalesce(p_prev_hash,'genesis') || p_payload::text, 'sha256'), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- Retention helper (§5): "append-only" must not mean personal data is kept forever.
-- Returns the cutoff for a retention class. Actual purge jobs are scheduled operations.
-- ---------------------------------------------------------------------------
create table if not exists public.retention_classes (
  key            text primary key,
  retain_days    integer not null check (retain_days > 0),
  rationale      text not null,
  contains_personal_data boolean not null default true
);

insert into public.retention_classes (key, retain_days, rationale) values
  ('security_audit', 365, 'Privileged-action accountability; minimized payloads.'),
  ('operational_log', 90, 'Service debugging; no media content.'),
  ('pass_ledger', 400, 'Quota dispute resolution and billing reconciliation.'),
  ('watch_activity', 730, 'Optional personalization; only with explicit consent.'),
  ('exposure_log', 90, 'Notification frequency caps.')
on conflict (key) do nothing;
