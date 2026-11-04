-- ============================================================================
-- 0006_operations.sql
-- Decisions, appeals, remedies, audit log, notifications (PROJECT_BRIEF.md §10, §16).
--
-- Every consequential judgment is recorded and correctable. Audit is tamper-EVIDENT
-- and access-controlled, with retention limits — not "kept forever".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Decisions (§10). Correctable via supersession, never silently edited away.
-- ---------------------------------------------------------------------------
create table if not exists public.decisions (
  id             uuid primary key default gen_random_uuid(),
  subject_user_id uuid references public.profiles(id) on delete cascade,
  subject_type   text not null default 'user'
                 check (subject_type in ('user','tag_claim','nickname','appeal','session_pass','incident')),
  subject_id     uuid,
  outcome        text not null,
  reason_code    text not null,
  evidence_snapshot jsonb not null default '{}'::jsonb,
  policy_version text not null,
  actor_user_id  uuid references public.profiles(id),
  -- True when taken by an automated policy rather than a human.
  automated      boolean not null default false,
  superseded_by  uuid references public.decisions(id),
  created_at     timestamptz not null default now()
);

create index if not exists decisions_subject_idx on public.decisions (subject_user_id, created_at desc);

alter table public.decisions enable row level security;

-- Users must be able to see decisions that affect them, with an appeal path (§9, §10).
drop policy if exists decisions_subject_read on public.decisions;
create policy decisions_subject_read on public.decisions
  for select to authenticated using (
    subject_user_id = auth.uid()
    or public.has_staff_role(auth.uid(), array['support','moderator','admin','owner'])
  );

-- ---------------------------------------------------------------------------
-- Appeals (§10). Structured and evidence-based; alpha response target 48h.
-- ---------------------------------------------------------------------------
create table if not exists public.appeals (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid not null references public.decisions(id) on delete cascade,
  appellant_id   uuid not null references public.profiles(id) on delete cascade,
  statement      text not null,
  evidence_refs  jsonb not null default '[]'::jsonb,
  state          text not null default 'open'
                 check (state in ('open','under_review','upheld','overturned','partially_overturned','withdrawn')),
  response_target_at timestamptz not null,
  opened_at      timestamptz not null default now(),
  resolved_at    timestamptz,
  -- Staff may not judge their own appeal (§10); enforced at write time server-side.
  resolved_by    uuid references public.profiles(id),
  resolution_note text,
  constraint no_self_resolution check (resolved_by is null or resolved_by <> appellant_id)
);

alter table public.appeals enable row level security;

drop policy if exists appeals_participant_read on public.appeals;
create policy appeals_participant_read on public.appeals
  for select to authenticated using (
    appellant_id = auth.uid()
    or public.has_staff_role(auth.uid(), array['support','moderator','admin','owner'])
  );

drop policy if exists appeals_appellant_insert on public.appeals;
create policy appeals_appellant_insert on public.appeals
  for insert to authenticated with check (appellant_id = auth.uid() and state = 'open');

-- ---------------------------------------------------------------------------
-- Remedies / compensation (§10). Restore first, modest goodwill second.
-- Good-faith rewards are not clawed back for our own mistakes.
-- ---------------------------------------------------------------------------
create table if not exists public.remedies (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid references public.decisions(id),
  appeal_id      uuid references public.appeals(id),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in (
                   'restore_passes','restore_credit','restore_trust','goodwill_pro_days',
                   'goodwill_passes','billing_credit','lift_restriction','end_probation'
                 )),
  amount         numeric(12,4),
  -- Idempotency: replaying a reversal must not double-compensate (§17).
  idempotency_key text not null,
  state          text not null default 'pending'
                 check (state in ('pending','applied','failed','cancelled')),
  applied_at     timestamptz,
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

alter table public.remedies enable row level security;

drop policy if exists remedies_self_read on public.remedies;
create policy remedies_self_read on public.remedies
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Audit log (§10, §19). Hash-chained for tamper EVIDENCE. A privileged actor could
-- rewrite the chain; this is paired with access control, retention and (in production)
-- off-site shipping. Payloads are minimized: no media, no filenames, no tokens.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id            bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id),
  actor_role    text,
  action        text not null,
  subject_type  text,
  subject_id    uuid,
  -- Minimized, non-sensitive detail only.
  detail        jsonb not null default '{}'::jsonb,
  retention_class text not null default 'security_audit'
                  references public.retention_classes(key),
  occurred_at   timestamptz not null default now(),
  prev_hash     text,
  entry_hash    text not null
);

create index if not exists audit_log_actor_time on public.audit_log (actor_user_id, occurred_at desc);
create index if not exists audit_log_retention on public.audit_log (retention_class, occurred_at);

alter table public.audit_log enable row level security;

-- Staff read only; no client writes. Retention purge runs as a trusted job.
drop policy if exists audit_log_staff_read on public.audit_log;
create policy audit_log_staff_read on public.audit_log
  for select to authenticated using (
    public.has_staff_role(auth.uid(), array['admin','owner'])
  );

create or replace function public.append_audit(
  p_actor uuid,
  p_actor_role text,
  p_action text,
  p_subject_type text,
  p_subject_id uuid,
  p_detail jsonb,
  p_retention_class text default 'security_audit'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_prev text;
  v_hash text;
  v_id   bigint;
  v_payload jsonb;
begin
  -- Serialize chain appends so the hash chain has a single well-defined order.
  perform pg_advisory_xact_lock(hashtextextended('audit_log_chain', 0));

  select entry_hash into v_prev from public.audit_log order by id desc limit 1;

  v_payload := jsonb_build_object(
    'actor', p_actor, 'actor_role', p_actor_role, 'action', p_action,
    'subject_type', p_subject_type, 'subject_id', p_subject_id, 'detail', p_detail
  );
  v_hash := public.audit_chain_hash(v_prev, v_payload);

  insert into public.audit_log
    (actor_user_id, actor_role, action, subject_type, subject_id, detail, retention_class, prev_hash, entry_hash)
  values
    (p_actor, p_actor_role, p_action, p_subject_type, p_subject_id, p_detail, p_retention_class, v_prev, v_hash)
  returning id into v_id;

  return v_id;
end;
$$;

-- Trusted-only: revoke the implicit default grant to authenticated/anon as well as public,
-- otherwise a client could forge audit entries. See note in 0003_session_passes.sql.
revoke all on function public.append_audit(uuid, text, text, text, uuid, jsonb, text)
  from public, authenticated, anon;
grant execute on function public.append_audit(uuid, text, text, text, uuid, jsonb, text) to service_role;

-- Verify the chain. Returns the first broken link, or null when intact.
create or replace function public.verify_audit_chain()
returns bigint language plpgsql stable security invoker set search_path = public as $$
declare
  r record;
  v_prev text := null;
  v_expected text;
  v_payload jsonb;
begin
  for r in select * from public.audit_log order by id asc loop
    v_payload := jsonb_build_object(
      'actor', r.actor_user_id, 'actor_role', r.actor_role, 'action', r.action,
      'subject_type', r.subject_type, 'subject_id', r.subject_id, 'detail', r.detail
    );
    v_expected := public.audit_chain_hash(v_prev, v_payload);
    if v_expected <> r.entry_hash or coalesce(r.prev_hash,'') <> coalesce(v_prev,'') then
      return r.id;
    end if;
    v_prev := r.entry_hash;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Notifications (§16). Transactional and promotional are structurally separated so
-- marketing caps can never suppress an essential billing/security/appeal notice.
-- ---------------------------------------------------------------------------
create table if not exists public.inbox_items (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  category      text not null check (category in ('transactional','promotional')),
  kind          text not null,
  title         text not null,
  -- Plain text only. Rendered without HTML so campaigns cannot inject markup (§19).
  body          text not null default '',
  action_url    text,
  dedupe_key    text,
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  dismissed_at  timestamptz,
  snoozed_until timestamptz
);

create unique index if not exists inbox_dedupe_key
  on public.inbox_items (user_id, dedupe_key) where dedupe_key is not null;

create index if not exists inbox_user_time on public.inbox_items (user_id, created_at desc);

alter table public.inbox_items enable row level security;

drop policy if exists inbox_owner_select on public.inbox_items;
create policy inbox_owner_select on public.inbox_items
  for select to authenticated using (user_id = auth.uid());
create policy inbox_owner_update on public.inbox_items
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Exposure records (§16). Used for frequency caps and, with consent, analytics.
-- NEVER used to deny the early trial because a user saw an upgrade prompt (§11, §22).
-- Client-observed: not tamper-proof, and not treated as a security signal.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_exposures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  campaign_key text not null,
  surface      text not null check (surface in ('modal','toast','banner','inline','hud','inbox')),
  interruptive boolean not null default false,
  occurred_at  timestamptz not null default now()
);

create index if not exists exposures_user_time
  on public.notification_exposures (user_id, occurred_at desc);

alter table public.notification_exposures enable row level security;

drop policy if exists exposures_owner_select on public.notification_exposures;
create policy exposures_owner_select on public.notification_exposures
  for select to authenticated using (user_id = auth.uid());
create policy exposures_owner_insert on public.notification_exposures
  for insert to authenticated with check (user_id = auth.uid());
