# ReactionPlayer

Watch a source video and a reaction to it, **synchronized**, on your own device.
The app never hosts, uploads, proxies or redistributes video — you supply your own files.

**Status: v0.0 vertical slice, working and verified.** Not production-ready. See
[`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) for exactly what is done, what is
not, and what could not be tested here.

---

## Quick start (no cloud account required)

```bash
npm install --legacy-peer-deps
npm run db:setup:dev
```

The setup script starts a real PostgreSQL 18 cluster in `.devdb/`, applies every migration,
and prints the values for `.env`:

```dotenv
DATABASE_URL=postgres://rp_dev:rp_dev@127.0.0.1:55432/reactionplayer
ALLOW_DEV_AUTH=true
NODE_ENV=development
```

Then in a second terminal:

```bash
npm run dev
```

Open the app, create an account, add two local videos, and the full slice works:
server-authorized pass → align → synchronized playback → save → resume.

> `--legacy-peer-deps` works around an npm bug resolving Vitest's optional peer set.
> `npm ci` still honours the lockfile.

For Supabase deployment, see [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md).

## What works today

- **Accounts required.** Real server-side auth; no guest mode. Supabase Auth in production,
  a genuine scrypt/httpOnly-cookie provider for local development.
- **Server-authoritative passes.** 6 base passes per rolling 24 h plus 2 bonus passes for
  4 eligible tagging contributions. Atomic, idempotent, reuses unexpired passes, returns a
  next-availability time when exhausted. Free = 2 videos per session.
- **Two-video synchronization.** One master clock, per-pair millisecond offsets, drift
  correction with rate nudges and hard seeks, linked/unlinked control, master switching,
  tap-to-align, approximate frame stepping, independent audio selection.
- **Local persistence.** IndexedDB sessions, File System Access handles with permission
  re-prompting and explicit reselection fallback, duplicate, export.
- **Privacy.** Anonymous by default, opt-in nickname, granular revocable consent that
  actually deletes watch history when withdrawn.
- **Desktop-first UI.** Edge-docked ~256 px nav, full-bleed crisp wallpaper, auto-hiding
  edge HUD, side-by-side / PiP / source-only / reaction-only layouts, icon-only playback
  chrome with readable text for safety, billing and consent.

## What does not exist yet

Billing, trials, leaderboards, tagging UI, moderation UI, notifications UI, discovery,
grid/custom layouts, provider adapters (YouTube/Vimeo), cloud sync. Their **schemas and
interfaces** are in place; the features are deliberately not built. Full list in
[`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Verification

```bash
npm test              # 171 unit + integration tests
npm run check         # svelte-check — 0 errors, 0 warnings
npx eslint .          # 0 errors
npm run build         # production build

# Against a running dev server:
npm run verify:slice  # 39 end-to-end HTTP checks
```

Integration tests run against a **real PostgreSQL cluster** with row-level security
genuinely enforced — not mocks. They verify concurrency (20 simultaneous requests against
a quota of 6 issue exactly 6), idempotency, expiry boundaries, cross-user isolation and
that clients cannot mint their own bonus passes.

Browser tests are written and run in CI; Playwright's browser CDN is unreachable from this
sandbox, so they were not executed here. This is stated plainly in
[`docs/TESTING.md`](./docs/TESTING.md).

## Documentation

| Document | Contents |
| --- | --- |
| [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) | Authoritative product brief, versioned scope boundaries |
| [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) | What is implemented, verified, and outstanding |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Trusted boundary, module layout, extension seams |
| [`docs/SYNC.md`](./docs/SYNC.md) | Master clock, offset sign, drift strategy, precision limits |
| [`docs/ENVIRONMENT.md`](./docs/ENVIRONMENT.md) | Setup, variables, Supabase deployment |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Implemented controls and honest gaps |
| [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md) | Deliberate boundaries, not hidden defects |
| [`docs/TESTING.md`](./docs/TESTING.md) | Test layers, results, what needs credentials |
| [`docs/adr/`](./docs/adr) | Architecture decisions |

## Honest limitations

Synchronization is **not frame-perfect and not zero-lag**. Sampled fingerprints are
**identifiers, not proof of content**. Automatic file restoration is **not guaranteed in
every browser**. DRM platforms cannot be embedded. Rate limiting is currently
single-process. Legal terms require counsel review before launch; randomized promotions
and paid billing are feature-flagged off until then.
