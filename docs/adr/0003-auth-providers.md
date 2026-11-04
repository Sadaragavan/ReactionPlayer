# ADR 0003 — Two auth providers behind one contract

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

The brief requires accounts from the earliest usable build and names Supabase Auth. No
Supabase credentials exist in this environment, and none may be invented. At the same time,
the v0.0 exit gate demands a *working* authenticated slice, not a mock.

A client-side "pretend logged in" flag was rejected outright: it would violate the
server-authoritative requirement and produce a demo rather than an application.

## Decision

Define an `AuthProvider` contract with two implementations, selected by server
configuration:

| Provider | When | Identity |
| --- | --- | --- |
| `supabase` | `PUBLIC_SUPABASE_URL` + anon key present | Supabase Auth, SSR cookies, `getUser()` verification |
| `local-dev` | `DATABASE_URL` + `ALLOW_DEV_AUTH=true` **and** not production | Real server-side accounts in `dev_auth` |
| `unconfigured` | neither | Explicit setup notice; API returns 401 |

Both return the same verified `SessionUser`. No downstream code branches on provider.

## What the development provider actually is

- scrypt password hashing (N=16384, r=8, p=1, 64-byte key) with a per-user 16-byte salt;
  constant-time verification; parameters stored so the work factor can be raised.
- Opaque 32-byte random session tokens, stored **only as SHA-256 hashes**, delivered in an
  httpOnly `SameSite=Lax` cookie, revoked server-side on sign-out.
- Credential and session tables are unreachable by `authenticated` and `anon`.
- Passes, entitlements, consent and RLS are **unchanged** — the same Postgres enforcement
  applies.

## Guardrails

- Refuses to activate when `NODE_ENV=production`, even if `ALLOW_DEV_AUTH=true` is set.
- Its schema lives in `src/lib/server/db/dev-auth.sql`, **outside** `supabase/migrations/`,
  so the normal migration path can never apply it to a Supabase project.
- It reports `assuranceLevel: 'unknown'`, so `requireStaff()` fails closed for every
  privileged action. Staff features cannot be exercised through it.
- The UI displays a persistent "Local development mode" notice on home and sign-in.

## Consequences

- This is **not** a guest mode. An account is still required, satisfying the brief's
  "no guest-first architecture" constraint.
- Email confirmation is auto-marked in dev because there is no mail transport. This never
  happens in the Supabase path.
- The Supabase provider is written but **not exercised against a real project** in this
  environment. That gap is recorded in `IMPLEMENTATION_STATUS.md` and `docs/TESTING.md`
  rather than implied to be verified.

## Alternatives considered

- **Supabase-only, app unusable without credentials:** honest but fails the exit gate; no
  way to verify the slice.
- **Client-side mock auth:** rejected — violates server-authoritative entitlements.
- **Supabase CLI local stack:** requires Docker, unavailable here; `embedded-postgres`
  provides the same real-Postgres guarantees without a container runtime.
