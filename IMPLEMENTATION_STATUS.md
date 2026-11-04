# Implementation Status

**Brief version:** 1.0.0 · **Policy version:** `0.0.1-dev` · **Last updated:** 2026-11-04

Legend: ✅ implemented and verified · 🟡 implemented, not fully verified · ⬜ not started
(schema/interface may exist) · 🚫 deliberately deferred by scope

---

## v0.0 — Foundation and vertical slice

**Exit gate:** an authenticated user can create a correctly isolated pass and run a basic
local two-video synchronization proof.

### Gate status: ✅ MET (with one testing gap, stated below)

Verified end-to-end against a running server: account creation → session cookie →
fingerprint registration → server-issued pass → reuse → idempotent retry → quota
enforcement under concurrency → cross-user isolation → consent → private sync profile.
Browser-side playback is exercised by written Playwright specs that run in CI but could
not execute in this sandbox (no Playwright CDN access).

### Quality gates

| Gate | Result |
| --- | --- |
| `npm run check` (svelte-check, strict) | ✅ 0 errors, 0 warnings |
| `npx eslint .` | ✅ 0 errors, 0 warnings |
| Unit tests | ✅ 134 / 134 |
| Database integration tests (real PostgreSQL 18) | ✅ 37 / 37 |
| HTTP end-to-end verification | ✅ 39 / 39 |
| `npm run build` (adapter-node) | ✅ succeeds |
| Playwright browser specs | 🟡 written + wired to CI; **not executed here** |

### Accounts and identity

| Item | Status |
| --- | --- |
| Account required from first usable build; no guest-first architecture | ✅ |
| `AuthProvider` contract with Supabase + local-dev implementations | ✅ |
| Local-dev provider: scrypt, hashed opaque tokens, httpOnly cookies, server-side revocation | ✅ |
| Dev provider refuses to activate in production | ✅ |
| Dev schema kept outside `supabase/migrations/` | ✅ |
| Supabase SSR provider (`getUser()` verification, not `getSession()`) | 🟡 written; no real project to test against |
| Explicit "unconfigured" state instead of silent fallback | ✅ |
| `/auth/callback` code exchange with shared open-redirect guard | ✅ guard verified over HTTP; 🟡 exchange needs a real project |
| `/me` stable account entry point | ✅ |
| Email confirmation / OAuth / MFA enrolment | ⬜ requires real Supabase project |

### Passes and entitlements

| Item | Status |
| --- | --- |
| 6 base passes per **rolling** 24 h (not calendar day) | ✅ tested |
| 2 bonus passes for 4 distinct eligible tagging contributions, once per window | ✅ tested |
| Pass valid 24 h; reload / resume / rewatch free | ✅ tested |
| Reuse unexpired pass for the same pair | ✅ tested |
| Idempotent retry by request id (8 concurrent → 1 pass) | ✅ tested |
| Atomic allocation (20 concurrent distinct pairs → exactly 6 issued, 14 denied) | ✅ tested |
| Same new pair concurrently → 1 issued, 9 reused | ✅ tested |
| `next_available_at` returned on exhaustion (HTTP 429) | ✅ tested |
| Expiry boundary at 23.99 h vs 24.01 h | ✅ tested |
| Per-user isolation; cross-account allocation refused | ✅ tested |
| Client cannot INSERT passes (RLS) | ✅ tested |
| Client cannot call `grant_tagging_bonus()` | ✅ tested — **real bug found and fixed** |
| Pro unlimited, `capacity_class='pro'`; reverts when grant expires | ✅ tested |
| Suspended account denied | ✅ tested |
| Video limit 2 for free; design supports 4+ for Pro | ✅ |
| Offline pass tolerance | ⬜ specified in brief, not implemented |

### Media and synchronization

| Item | Status |
| --- | --- |
| `MediaAdapter` interface + explicit capability model | ✅ |
| HTML5 local-file adapter | ✅ |
| `requestVideoFrameCallback` + 100 ms timer fallback | ✅ unit-tested |
| Single master clock; only followers corrected | ✅ tested |
| Offset sign convention (positive = ahead), milliseconds in domain | ✅ tested |
| Master switching with offset re-normalization (incl. 3+ videos) | ✅ tested |
| Drift correction: tolerance / hard seek / rate nudge / cooldown | ✅ tested |
| Buffering pauses group; autoplay rejection surfaced honestly | ✅ tested |
| Out-of-range seek rejected, not clamped | ✅ tested |
| Independent audio source selection | ✅ tested |
| Tap-to-align, offset nudge, approximate frame step | ✅ |
| Linked / unlinked timelines | ✅ |
| Layouts: side-by-side, PiP, source-only, reaction-only | ✅ |
| Layout switch does not remount video elements | 🟡 implemented; Playwright assertion in CI |
| Taint-safe canvas capture; clipboard degradation | ✅ logic; 🟡 needs real cross-origin check |
| Sampled fingerprinting (≤192 KiB of a 4 GiB file) + worker | ✅ tested |
| Direct-URL input UI, YouTube / Vimeo adapters | ⬜ interface ready, not built |
| Grid / custom layouts, presets studio, frame-sampling alignment | ⬜ |
| Piecewise timeline maps | 🚫 schema reserved (`sync_profiles.map`) |

### Local persistence and resume

| Item | Status |
| --- | --- |
| IndexedDB via `idb` (sessions, handles, settings) | ✅ |
| Save / list / resume / duplicate / export / delete | ✅ |
| File System Access handle storage | ✅ |
| Permission re-prompt on user gesture | 🟡 logic tested; prompt needs manual check |
| Explicit reselection fallback (Safari/Firefox, moved files) | ✅ assessment unit-tested |
| Reselected-file mismatch warns but allows override | ✅ tested |
| Blob URLs never persisted | ✅ tested |
| IndexedDB unavailable → clear failure, no silent data loss | ✅ |
| Cloud session sync (Pro) | 🚫 later milestone |

### Privacy and consent

| Item | Status |
| --- | --- |
| Anonymous by default; no email-derived public name | ✅ tested |
| Nickname only on explicit confirmed choice | ✅ |
| Granular, versioned, revocable consent | ✅ tested over HTTP |
| Withdrawing watch history **deletes** existing rows | ✅ |
| Withdrawing nickname clears it immediately | ✅ |
| Reward eligibility uses aggregate counters, no media identity | ✅ schema |
| Owner-only fingerprints and filenames (RLS) | ✅ tested |
| Retention classes with rationale | ✅ schema |
| Data export / account deletion endpoints | ⬜ next milestone |

### Staff and operations

| Item | Status |
| --- | --- |
| Server-side least-privilege role checks | ✅ tested |
| Mandatory MFA (`aal2`); dev provider fails closed | ✅ tested |
| Cannot judge own claims / appeals / benefits | ✅ tested |
| Second approver or recorded solo exception for high-risk actions | ✅ tested |
| Hash-chained audit log, trusted-role only | ✅ schema + service |
| Out-of-band Owner bootstrap CLI | ✅ |
| Master Controller UI, appeals UI, remedies UI | ⬜ schema + authorization present |

### UI

| Item | Status |
| --- | --- |
| Desktop-first, edge-docked ~256 px nav | ✅ |
| Full-bleed wallpaper, crisp, no blur/darkening | ✅ |
| Auto-hiding edge HUD (~2.5 s), not while focused/scrubbing | ✅ |
| Theater ≠ fullscreen | ✅ |
| Icon-only playback chrome; readable text for safety/billing/consent | ✅ |
| Keyboard: Space, L, T, F, ←/→; never intercepted in text inputs | ✅ |
| Reduced-motion + focus-visible + accessible names | ✅ asserted in CI spec |
| Notification inbox UI, campaigns, exposure capping | ⬜ toast store + schema present |

### Not started (later milestones, per brief scope boundaries)

Stripe billing 🚫 · trials 🚫 · leaderboards/badges 🚫 · surprise drops 🚫 (flag off pending
legal review) · tagging UI + verification workflow 🚫 · trust automation 🚫 · discovery /
queue / reactor directory 🚫 · recommendations 🚫 · browser extension 🚫

---

## Known gaps and risks

| Gap | Severity | Notes |
| --- | --- | --- |
| Playwright specs not executed in this sandbox | Medium | CDN blocked. CI job runs them. Browser playback correctness rests on unit-tested engine logic plus written specs until CI runs. |
| Supabase provider untested against a real project | Medium | RLS verified against real Postgres with identical roles/claims; the Auth transport is not. |
| Rate limiting is single-process, in-memory | Medium | Must move to Redis or Postgres before horizontal scaling. |
| No account export/deletion endpoint | Medium | Required before launch; consent revocation works. |
| Legal terms not drafted | High (launch blocker) | Billing and randomized promotions are flag-gated off; a DB constraint requires recorded review to enable them. |
| npm requires `--legacy-peer-deps` | Low | Documented in README and CI. |
| No production monitoring/backups configured | Medium | Deployment responsibility. |

## Real defects found and fixed during implementation

1. **Privilege escalation via default privileges.** Supabase's `ALTER DEFAULT PRIVILEGES`
   grants `EXECUTE` on new public functions to `authenticated`. `REVOKE ... FROM public`
   does not remove that explicit grant, so a client could call `grant_tagging_bonus()` and
   mint its own bonus passes. Fixed by revoking from `authenticated` and `anon` by name;
   regression test added. **This pattern must be applied to every future trusted-only
   function.**
2. **Dev provider could not create accounts.** `service_role` had `SELECT` but not `INSERT`
   on the dev `auth.users` shim. Caught by the HTTP verifier (39 checks went 5 → 33).
3. **Interval arithmetic.** `make_interval(hours => 23.99)` rejects fractional integers;
   switched to `n * interval '1 hour'` for expiry-boundary tests.
4. **Svelte 5 `bind:this` cannot take a function.** Video registration moved to a `use:`
   action.
5. **Verifier reported false success.** SvelteKit form actions return HTTP 200 with a
   devalue `failure` payload, so a status-only assertion passed while signup was actually
   rate-limited. The verifier now inspects the payload and prints an actionable message.
6. **Repeated test runs tripped the sign-up rate limit.** Added `RATE_LIMIT_MULTIPLIER`,
   refused in production, rather than a bypass header. Guard covered by unit tests.
7. **Inconsistent open-redirect guards.** `/signin` accepted backslash and control-character
   variants that `/auth/callback` rejected. Extracted one shared `safeRelativePath()` used by
   both, with unit tests for every variant.

## Next milestone (v0.1 alpha)

Recommended order, all still within the brief's scope boundaries:

1. Run the browser suite in CI and fix anything it exposes.
2. Account export + deletion endpoints.
3. Direct-URL media input (capability-gated), then YouTube adapter.
4. Tagging UI + contribution flow, so the bonus-pass path becomes reachable by users.
5. Grid/custom layouts and preset studio.
6. Replace in-memory rate limiting with a shared store.
7. Connect a real Supabase project and verify the Auth path end to end.
