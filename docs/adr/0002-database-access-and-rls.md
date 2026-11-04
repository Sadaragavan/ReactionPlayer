# ADR 0002 — Direct Postgres with per-transaction role impersonation

- **Status:** Accepted
- **Date:** 2026-11-04

## Context

Pass allocation must be atomic under concurrency, idempotent, and reuse an unexpired pass.
Supabase's idiomatic client (`supabase-js` + PostgREST) cannot express multi-statement
transactions, and advisory locks need a transaction scope.

Two options:

1. `supabase-js` with the user's JWT for reads, plus a PL/pgSQL RPC for allocation.
2. A direct Postgres connection with per-transaction role/claim impersonation.

## Decision

**Option 2**, wrapped in `asUser` / `asService` / `asAnon` helpers.

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', $1, true);
-- ... queries, RPC calls, advisory locks ...
commit;
```

## Rationale

- **One code path** for Supabase and local development. Supabase exposes a standard
  Postgres connection string, so the identical SQL runs in both.
- **RLS is genuinely enforced.** `authenticated` is not a superuser and has no `BYPASSRLS`.
  This is not a convenience bypass — a query bug still cannot read another user's rows.
- **Testable without cloud credentials.** Integration tests start a real PostgreSQL 18
  cluster and exercise the same roles, claims, policies and locks as production. Mocking
  the database would have made the concurrency guarantee untestable.
- **Transactions and advisory locks** are available where allocation needs them.
- **No service-role key is needed** for ordinary user operations, reducing secret exposure.

## Consequences

- `DATABASE_URL` is a required server secret. It never reaches the browser.
- Privileged operations must explicitly use `asService`, which is easy to grep and audit.
- Connection pooling matters in production; use Supabase's pooler string for multi-instance
  deployments. The pool is module-scoped and stateless per request; identity is bound per
  transaction, so no per-user state leaks between requests.
- The `auth` schema shim in `scripts/migrate.ts` is applied **only** to non-Supabase
  clusters. On Supabase, `auth.users` and `auth.uid()` already exist and the shim is skipped.

## What this does not change

The trust boundary is identical to the PostgREST approach: the browser holds no authority,
and every metered decision is made in the database.
