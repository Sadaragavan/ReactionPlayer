# Testing

## Running

```bash
npm test                              # unit + integration (171 tests)
npx vitest run --project unit         # pure logic, no database
npx vitest run --project integration  # real PostgreSQL cluster
npm run check                         # svelte-check, strict TypeScript
npx eslint .                          # lint
npm run build                         # production build

# Against a running dev server:
node --experimental-strip-types scripts/verify-slice.ts   # 39 HTTP checks

npx playwright install chromium     # one-time browser download
npm run test:e2e                    # browser tests
```

## Layers

### 1. Unit (`tests/unit/`, 134 tests, no I/O)

Pure logic with injected clocks and fake adapters.

| File | Covers |
| --- | --- |
| `sync-math.test.ts` | offset sign convention, unit conversion, seek clamping, drift strategy, cooldown, rate clamping, master re-normalization (incl. 3+ videos), tap-to-align, frame stepping, pair identity, blob-URL stripping, restriction renewal formula |
| `sync-engine.test.ts` | master never corrected, capability respect, linked/unlinked, autoplay rejection, buffering pause/resume, ended handling, seek-range rejection, audio independence, N-video correction, rVFC fallback, lifecycle |
| `services.test.ts` | sampled fingerprinting (4 GiB file reads ≤192 KiB), reselection assessment, wallpaper validation, rate limiting, staff authorization (MFA, least privilege, self-judgment, two-person approval), structured error redaction, credential validation incl. **no dot/alias stripping**; rate-limit production guard (scaling refused when `NODE_ENV=production`, invalid multipliers ignored) |

### 2. Integration (`tests/integration/`, 37 tests, real PostgreSQL)

`tests/helpers/database.ts` starts a **real PostgreSQL 18 cluster** via `embedded-postgres`
and applies the actual migrations. Nothing at the database boundary is mocked.

Connections use `set local role authenticated` with a per-transaction JWT subject — the
same mechanism as production — so **RLS is genuinely exercised**, not bypassed by a
superuser.

| File | Covers |
| --- | --- |
| `migrations.test.ts` | all migrations apply; re-running is a no-op; signup trigger; anonymous-by-default display; RLS enabled on every user table; legally-gated flags cannot be enabled without recorded review; **full recursive policy drift guard** (every field of `policy.ts` vs `active_policy()`, including array contents and extra/missing keys); cross-user profile isolation |
| `passes.test.ts` | issuance and 24 h lifetime; reuse; reload/resume/rewatch free; idempotent retry; **8 concurrent identical requests → 1 pass**; **20 concurrent distinct pairs → exactly 6 issued, 14 denied**; **10 concurrent same-new-pair → 1 issued, 9 reused**; rolling (not calendar) window; exact expiry boundary; cross-user isolation; forged INSERT blocked by RLS; cross-account allocation refused; Pro unmetered; expired Pro reverts; suspended account denied; bonus at 4 contributions; **bonus granted exactly once under concurrency**; client cannot call the bonus function; issued passes survive bonus-window close |

Two real bugs were found and fixed by these tests:

1. **Privilege escalation.** Supabase's `ALTER DEFAULT PRIVILEGES` grants `EXECUTE` on new
   public functions to `authenticated`. `REVOKE ... FROM public` does not remove that
   explicit grant, so a client could call `grant_tagging_bonus()` and mint its own bonus
   passes. Fixed by revoking from `authenticated` and `anon` by name; the regression test
   asserts the call is now refused.
2. **Boundary arithmetic.** `make_interval(hours => ...)` requires an integer and rejected
   fractional hours in expiry-boundary tests; switched to interval multiplication.

### 3. HTTP verification (`scripts/verify-slice.ts`, 39 checks)

Runs against a live dev server and exercises the real network boundary: cookies, CSRF,
JSON contracts, status codes. Signup → session cookie → fingerprint registration → pass
issuance → reuse → idempotency → 12-way concurrency → quota exhaustion with a
next-availability time → cross-user isolation → consent grant/revoke → private sync
profile isolation → absence of any client bonus-granting route → open-redirect safety on `/auth/callback` and `/me`.

### 4. Browser (`tests/e2e/`, Playwright)

Test media is **generated inside the browser** with `canvas.captureStream` +
`MediaRecorder`, so there are no binary fixtures, no ffmpeg dependency and no network
access to sample videos. Each clip renders a visible frame counter, making drift observable
in traces.

Covers the full slice (signup → two files → pass → linked playback advances both videos →
align → offset nudge → layout switch **without remounting** → linked/unlinked timelines →
save → resume with reselection), plus access control, security headers, reduced motion and
accessible names on icon-only controls.

### Repeatability and rate limits

Automated runs create many accounts from one IP, which correctly trips the sign-up rate
limit after four attempts. Rather than adding a bypass header (a real attack surface), set
`RATE_LIMIT_MULTIPLIER=100` in `.env` for local/CI runs. The scaling is **refused when
`NODE_ENV=production`**, and unit tests assert that guard.

The verifier also inspects SvelteKit's devalue payload: form actions return HTTP 200 even on
failure, so a naive status check would report success while nothing worked. That weakness
was found and fixed during implementation.

## What could not be executed in this sandbox

**Playwright browsers were not run here.** The sandbox's network allowlist does not include
the Playwright CDN, so `playwright install` cannot download Chromium. The specs are written
and wired into CI (`.github/workflows/ci.yml`, `browser` job), which does have access.

Everything else on this page **was executed and passes**: 171 unit/integration tests,
39 HTTP checks, `svelte-check` (0 errors), ESLint (0 errors) and a production build.

## Tests requiring real credentials or manual verification

| Area | Why | Status |
| --- | --- | --- |
| Supabase Auth (email confirmation, OAuth, MFA enrolment) | Needs a real Supabase project | Not run. Provider code is written; the local-dev provider exercises the same downstream contract. |
| Supabase-hosted RLS over PostgREST | Needs a real project | RLS is verified against real Postgres with the same roles and claims; the REST transport is not. |
| YouTube / Vimeo adapters | Needs provider APIs and real videos | Not built in v0.0. |
| File System Access permission prompt | Needs headed Chromium and a real gesture | Logic is unit-tested; the prompt path needs manual verification. CI exercises the reselection fallback deterministically. |
| rVFC frame accuracy on real hardware | Needs real displays/decoders | Needs manual verification per browser/GPU. |
| Cross-origin CORS canvas taint | Needs a real cross-origin host | Adapter logic returns `null` on taint; needs a manual check. |
| Stripe webhooks | Needs Stripe keys | Not implemented in v0.0. |

## CI

`.github/workflows/ci.yml` runs two jobs:

- **verify** — install, sync types, typecheck, unit tests, database integration tests,
  production build.
- **browser** — install Chromium, start the dev database and app, run the HTTP verification
  script, run Playwright, upload traces/video on failure.

Neither job needs cloud credentials.
