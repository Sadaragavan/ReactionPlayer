# Security

This describes controls that are **implemented and verified**, and explicitly separates
them from what is planned. It is not a legal document and makes no compliance claim.

## Implemented and verified

### Authorization is server-side only

- `locals.user` is populated exclusively from a verified session lookup in
  `hooks.server.ts`. No client-supplied header, cookie payload or body field is trusted as
  an identity.
- Supabase uses `auth.getUser()`, which validates the JWT with the auth server.
  `getSession()` alone is deliberately **not** used for authorization.
- Tier comes from `effective_tier()`, derived from entitlement grant intervals. There is no
  client-writable Pro flag.
- The pass API delegates all quota logic to Postgres. There is no client-side allowance.

### Row-level security

Every user-scoped table has RLS enabled. Application queries run as `authenticated`, a
non-superuser role without `BYPASSRLS`, with the JWT subject set per transaction. A test
asserts RLS is enabled on every application table, and isolation tests confirm one user
cannot read another's profile, passes or sync profiles.

Clients have **no INSERT policy** on `session_passes`. A test asserts a direct forged
insert is rejected.

### Function privileges (a real bug found and fixed)

Supabase grants `EXECUTE` on new public functions to `authenticated` via
`ALTER DEFAULT PRIVILEGES`. `REVOKE ... FROM public` does **not** remove that explicit
grant. Trusted-only functions therefore revoke from `authenticated` and `anon` by name:

```sql
revoke all on function public.grant_tagging_bonus(uuid, integer)
  from public, authenticated, anon;
grant execute on function public.grant_tagging_bonus(uuid, integer) to service_role;
```

Without this, a client could mint its own bonus passes. The same applies to
`append_audit()`. Both are covered by regression tests.

`issue_session_pass()` is `SECURITY DEFINER` but hard-asserts `p_user_id = auth.uid()`, so
it cannot allocate for another account despite running with elevated privileges.

### Concurrency and idempotency

Pass allocation takes a per-user advisory transaction lock
(`pg_advisory_xact_lock(hashtextextended(user_id, 0))`), serializing allocation so two
requests cannot both observe "5 used" and both insert. A unique index on
`(user_id, request_id)` makes retries idempotent. Verified with 20 concurrent requests
against a quota of 6: exactly 6 issued.

### Secrets

- No service-role key or Stripe secret is reachable from the browser. Only
  `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` are public, which is safe by design
  because RLS protects data.
- Server-only code lives under `$lib/server/` and uses `$env/dynamic/private`; SvelteKit
  fails the build if it is imported from client code.
- `.env` is gitignored. `.env.example` contains placeholders only.

### Input validation and injection

- All SQL uses parameterized queries via `postgres`. The only `unsafe()` calls are fixed
  DDL strings and `SET LOCAL ROLE` with a compile-time constant role name.
- User ids are UUID-validated before being bound into a session setting.
- Pair keys, digests, filenames and offsets are length/format validated at the API edge.
- Every endpoint accepting a post-auth destination uses one shared `safeRelativePath()`
  guard, so the check cannot drift between routes. It rejects absolute URLs,
  protocol-relative paths, backslash variants (which browsers normalize to `//`), control
  characters and surrounding whitespace. Unit tests cover each variant, and the HTTP
  verifier asserts the live `/auth/callback` and `/me` behaviour.
- Wallpaper URLs accept only `https:`, `blob:` and image `data:` URLs. They are used as
  client-side image sources and are **never fetched server-side**, so there is no SSRF
  surface. No arbitrary server-side URL fetching exists.
- Nicknames and campaign bodies are stored and rendered as plain text. No HTML rendering
  path exists for user-supplied strings.

### Errors

`toStructuredError()` maps unknown exceptions to a generic message. Database and driver
messages — which can contain schema or credential fragments — are never returned to the
client. A unit test asserts a leaky error string is redacted.

### Headers and CSP

`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: SAMEORIGIN`, a restrictive `Permissions-Policy`, and HSTS in production.
CSP is configured in `svelte.config.js` with `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, and `frame-src` limited to the app plus YouTube/Vimeo for future
adapters.

### Rate limiting

Token buckets on sign-in, sign-up, pass issuance, consent writes and fingerprint
registration. **Single-process and in-memory** — see limitations below.

Capacity can be scaled by `RATE_LIMIT_MULTIPLIER` for automated testing. This is a
configuration knob, **not a bypass header**: it applies to all callers equally, defaults to
`1`, and `configureRateLimits()` forces it back to `1` whenever `NODE_ENV=production`,
regardless of the configured value. Unit tests assert the production guard and that
non-finite or sub-unit multipliers are ignored.

### Staff authorization

`requireStaff()` enforces: server-side role checks, mandatory MFA (`aal2`), least privilege
per action, no judging your own claims/appeals/benefits, and a second approver (or an
explicitly recorded solo-operator exception) for high-risk actions. The development auth
provider reports `unknown` assurance and therefore **fails closed** for all privileged
actions. Every privileged action is auditable via `auditPrivilegedAction()`.

The first Owner is bootstrapped by an out-of-band CLI script, never a public client flow.

### Privacy

- Anonymous by default. No email-derived username, no automatically public social name.
- `public_display_name()` is the only public projection and returns either a confirmed
  nickname or "Anonymous contributor". It exposes no account id or email.
- Consent is granular, versioned, timestamped and revocable. Revoking watch history deletes
  existing history rows, so the withdrawal has real effect.
- Reward eligibility uses separate aggregate counters containing no titles or media
  identity, so declining personalization does not block earning a trial.
- Fingerprints and filenames are owner-only under RLS.
- Retention classes are defined with explicit rationale; "append-only" is not treated as
  "keep personal data forever".

## Known limitations (documented, not hidden)

| Limitation | Impact | Mitigation / plan |
| --- | --- | --- |
| Rate limiting is per-process | Does not coordinate across replicas | Swap the store for Redis or a Postgres counter before scaling; interface is isolated |
| Audit chain is tamper-evident, not tamper-proof | A privileged actor could rewrite it | Access control + retention; ship logs off-site in production |
| Client-supplied media identity can be falsified | A user could reuse a pass for different content | Quota stays server-enforced; fingerprints are identifiers, not proof |
| No offline pass tolerance yet | Brief offline use is not supported | Specified in the brief; not implemented |
| No account deletion / export endpoint yet | Privacy tooling incomplete | Consent revocation works; export/delete are next-milestone work |
| Backups, monitoring, incident response | Not configured in this repo | Deployment-time responsibility; must be set up before launch |
| Supabase Auth transport not exercised here | Real project needed | RLS verified against real Postgres with identical roles/claims |

## Legal

No Terms of Service can make an operator "absolutely blameless". Counsel-reviewed terms,
privacy policy, billing terms and promotional rules are required before launch, along with
an appropriate legal entity. Randomized promotions (`surprise_drops`) and paid billing
(`stripe_billing`) are feature-flagged **off**, and a database constraint prevents enabling
a legally-gated flag without a recorded review timestamp. Nothing here is legal advice.
