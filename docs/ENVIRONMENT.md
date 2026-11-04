# Environment and setup

No production credentials are invented or committed. Copy `.env.example` to `.env`.

## Option A — Local development (no cloud account needed)

This runs the **real** stack: a real PostgreSQL 18 cluster, the same migrations, the same
row-level security and the same atomic pass logic used against Supabase. Only the identity
provider differs.

```bash
npm install --legacy-peer-deps
npm run db:setup:dev          # starts Postgres in .devdb/, migrates, seeds policy
```

The script prints the values to put in `.env`:

```dotenv
DATABASE_URL=postgres://rp_dev:rp_dev@127.0.0.1:55432/reactionplayer
ALLOW_DEV_AUTH=true
NODE_ENV=development
# Optional: lets you re-run the verification suite without tripping the sign-up limit.
RATE_LIMIT_MULTIPLIER=100
```

Then, in a second terminal:

```bash
npm run dev
```

Open the app, create an account, and the full vertical slice works: two local videos →
server-authorized pass → align/sync → save → resume.

> `--legacy-peer-deps` works around an npm arborist bug resolving Vitest's optional peer
> set. The lockfile is still honoured by `npm ci`.

### What the development auth provider is and is not

- **Is:** a real server-side account system. scrypt-hashed passwords with per-user salts,
  opaque random session tokens stored as SHA-256 hashes, httpOnly cookies, server-side
  session lookup. Passes and entitlements are still enforced by Postgres.
- **Is not:** a fake "logged in" flag, and not a guest mode. An account is still required.
- **Never available in production.** `getServerConfig()` refuses to select it when
  `NODE_ENV=production`, even if `ALLOW_DEV_AUTH=true` is mistakenly set.
- Its schema lives in `src/lib/server/db/dev-auth.sql`, deliberately **outside**
  `supabase/migrations/`, so the normal migration path can never apply it to Supabase.
- It cannot assert MFA, so `requireStaff()` fails closed for every privileged action.

## Option B — Supabase (production path)

1. Create a Supabase project.
2. Project Settings → Database → Connection string (URI). Use the **pooler** string for
   multi-instance deployments.
3. Project Settings → API → copy the project URL and anon key.

```dotenv
DATABASE_URL=postgresql://postgres.<ref>:<password>@<host>:6543/postgres
PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>   # SERVER ONLY
ALLOW_DEV_AUTH=false
ORIGIN=https://your-domain.example
NODE_ENV=production
```

Apply migrations:

```bash
npm run db:migrate
```

The runner detects a Supabase host and skips the local `auth` shim, because Supabase
already provides `auth.users` and `auth.uid()`.

Then build and run:

```bash
npm run build
npm start        # adapter-node server, honours PORT and ORIGIN
```

### Supabase Auth settings to configure

- Enable Email provider. Decide whether to require email confirmation.
- Set the Site URL and redirect allow-list to your deployed origin.
- Enrol MFA for any account that will hold a staff role — privileged actions require
  `aal2` and will refuse otherwise.

### Bootstrapping the first Owner

There is deliberately **no public client flow** that creates staff:

```bash
DATABASE_URL=... npm run grant:owner -- you@example.com
```

The account must already exist. The grant is audited. The account still needs MFA enrolled
before it can perform privileged actions.

## Variable reference

| Variable | Required | Exposure | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | server | Postgres connection string. Never sent to the browser. |
| `PUBLIC_SUPABASE_URL` | production | public | Safe in the browser; RLS protects data. |
| `PUBLIC_SUPABASE_ANON_KEY` | production | public | Safe in the browser; RLS protects data. |
| `SUPABASE_SERVICE_ROLE_KEY` | privileged ops | **server secret** | Bypasses RLS. Never prefix with `PUBLIC_`. |
| `ALLOW_DEV_AUTH` | dev only | server | Refused when `NODE_ENV=production`. |
| `DEV_DB_PORT` | no | server | Default `55432`. |
| `RATE_LIMIT_MULTIPLIER` | no | server | Scales rate-limit capacity for automated runs. Default `1`. **Refused when `NODE_ENV=production`.** |
| `ORIGIN` | production | server | Absolute origin, for CSRF/redirect correctness. |
| `NODE_ENV` | yes | server | `production` disables development affordances. |

Stripe variables exist as commented placeholders in `.env.example`. Billing is
feature-flagged off and not implemented in v0.0.

## Unconfigured state

If no provider is configured, the app does **not** silently fall back to a guest mode.
It renders an explicit setup notice on the home and sign-in pages explaining what an
operator must do, and the pass API returns `401`. This is intentional: a misconfigured
deployment should be obvious, not quietly permissive.

## Sandbox / proxied preview notes

The dev server binds `0.0.0.0` and allows the `.e2b.app` preview host. Browser-facing code
uses only relative URLs, so it works behind the proxy without pointing at `localhost`.
