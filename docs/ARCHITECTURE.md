# Architecture

This document describes what is actually implemented. For product intent, see
[`PROJECT_BRIEF.md`](../PROJECT_BRIEF.md). For current status, see
[`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md).

## Trusted backend boundary

The single most important architectural rule: **the client never grants itself anything.**

```
┌──────────────────────── Browser (untrusted) ────────────────────────┐
│  Svelte 5 runes stores      Sync engine        Media adapters       │
│  sessionStore               master clock       HTML5 video          │
│  player controller          drift control      fingerprint worker   │
│  IndexedDB (idb)            rVFC / fallback    FS Access handles    │
│                                                                     │
│  Holds NO authority. `tier` and pass usage are mirrors of           │
│  server-issued values, used only for display.                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS, httpOnly session cookie
┌──────────────────────────────▼──────────────────────────────────────┐
│                SvelteKit server (adapter-node) — TRUSTED            │
│  hooks.server.ts   verified identity -> event.locals.user           │
│  /api/passes       quota enforcement (delegates to SQL)             │
│  /api/consents     granular, versioned, revocable                   │
│  /api/identities   private fingerprint registration                 │
│  /api/sync-profiles private, unverified offsets                     │
│  services/         pass, consent, staff authorization, rate limit   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ per-transaction role + JWT subject
┌──────────────────────────────▼──────────────────────────────────────┐
│                     PostgreSQL (Supabase) — AUTHORITY               │
│  Row-level security on every user-scoped table                      │
│  issue_session_pass()  atomic, idempotent, advisory-locked          │
│  effective_tier()      derived from entitlement grant intervals     │
│  append_audit()        hash-chained, trusted-role only              │
└─────────────────────────────────────────────────────────────────────┘
```

### Why a Node adapter

Pass issuance, entitlement resolution, staff authorization and (later) Stripe webhooks
require a trusted runtime. `adapter-node` produces a standalone Node server. A static-only
build is deliberately not used. Swapping hosting targets is a one-line change in
`svelte.config.js`; no application code depends on the adapter.

## Database access: one path, real RLS

`src/lib/server/db/client.ts` exposes three helpers:

| Helper | Role | RLS | Use |
| --- | --- | --- | --- |
| `asUser(userId, fn)` | `authenticated` | **enforced** | all ordinary user operations |
| `asService(fn)` | `service_role` | bypassed | trusted-only work (audit, bonus grants) |
| `asAnon(fn)` | `anon` | enforced | public reference data |

Each call opens a transaction and issues:

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<user uuid>', true);
```

`authenticated` is not a superuser and has no `BYPASSRLS`, so every policy applies exactly
as it does through Supabase's REST API. `auth.uid()` reads that claim.

Consequences:

- **No service-role key is needed for ordinary user operations.**
- A bug in a query cannot silently read another user's rows — RLS still blocks it.
- `SET LOCAL` is transaction-scoped, so a pooled connection can never leak a previous
  request's identity into the next one.
- Privileged work must explicitly opt into `asService`, which is easy to audit.

This works identically against Supabase Postgres and a local cluster, which is what makes
the integration tests meaningful.

## Module layout

```
src/lib/
  config/policy.ts          ALL provisional numbers, versioned. Single source of truth.
  contracts/                Versioned data contracts shared by client and server
    media.ts                physical / logical / version identity layers
    session.ts              session shape, coordinate + crop units
    auth.ts                 verified SessionUser, AuthProvider boundary
    errors.ts               structured errors, client-safe serialization
  server/                   SERVER ONLY (SvelteKit enforces this)
    env.ts                  configuration + explicit auth-mode selection
    db/client.ts            RLS-scoped transactions
    db/dev-auth.sql         development-only auth schema (NOT a Supabase migration)
    auth/provider.ts        Supabase + local-dev providers, one contract
    auth/password.ts        scrypt hashing, email/password validation
    services/               pass, consent, staff authorization, rate limiting
  sync/
    math.ts                 pure offset/drift/clamp math (no DOM)
    engine.ts               master clock, drift control, transport, capabilities
  media/
    provider.ts             MediaAdapter interface + capability probing
    providers/html5-video.ts  native video, rVFC + fallback, safe canvas capture
    fingerprint*.ts         sampled hashing, worker + client
  persistence/
    db.ts                   IndexedDB via idb
    file-handles.ts         FS Access handles, permission + reselection fallback
    sessions.ts             local save/load/list/duplicate/export
    settings.ts             wallpaper, sync tolerance, audio preference
  state/
    session-store.svelte.ts runes session state
    player.svelte.ts        adapter/engine/store bridge
    toast-store.svelte.ts   capped notifications
  components/               NavDock, VideoStage, PlaybackHud, Toasts
```

## Synchronization

See [`SYNC.md`](./SYNC.md) for the master clock, offset sign convention, drift strategy and
honest precision limits.

## Identity layers

Three layers are kept strictly separate (`contracts/media.ts`):

1. **Physical** — this byte stream (sampled fingerprint or provider content id).
2. **Logical** — the content itself, independent of cut/encode.
3. **Version** — a specific cut; sync offsets attach here.

Pass metering prefers a *confident* logical identity and falls back to physical, so
switching between legitimate versions of the same source does not burn another pass.
The layer used is recorded on the pass for auditability.

## Configuration

Every provisional threshold lives in `src/lib/config/policy.ts` and is seeded into the
`policy_versions` table. **The database copy is authoritative at runtime**; the TypeScript
module supplies the typed shape and the seed. A test asserts the seeded values match, so
client display and server enforcement cannot silently disagree.

## Extensibility seams (prepared, not built)

| Future subsystem | Seam already present |
| --- | --- |
| Piecewise timeline maps | `sync_profiles.map` jsonb + `map_schema_version` |
| Provider adapters (YouTube/Vimeo) | `MediaAdapter` + explicit `ProviderCapabilities` |
| Billing | `entitlement_grants.source`, `stripe_billing` flag (off) |
| Trials | `trial_claims` with UNIQUE(user_id), `activity_counters` |
| Leaderboards | `contribution_credit`, `trust_events`, policy-versioned scoring |
| Moderation | `decisions`, `appeals`, `remedies`, `account_restrictions` |
| Notifications | `inbox_items`, `notification_exposures`, category separation |
| Discovery | `queue_items`, `reactors`, `reaction_releases`, `catalog_sources` |

These tables exist with RLS but have no UI in v0.0. That is deliberate: the brief warns
against building future admin machinery before proving playback.
