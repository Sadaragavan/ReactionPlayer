# ADR 0001 — Framework and library versions

- **Status:** Accepted
- **Date:** 2026-11-04
- **Context:** v0.0 foundation

## Decision

Pin a coherent, stable set rather than the newest majors:

| Package | Version | Note |
| --- | --- | --- |
| SvelteKit | 2.70.x | Stable major |
| Svelte | 5.57.x | Runes mode enabled globally |
| Vite | 7.3.x | |
| `@sveltejs/vite-plugin-svelte` | 6.2.x | Matches Vite 7 |
| TypeScript | 5.9.x | |
| `@sveltejs/adapter-node` | 5.5.x | Trusted server runtime |
| Tailwind CSS | 4.3.x | Via `@tailwindcss/vite` |
| `@lucide/svelte` | 1.68.x | |
| Vitest | 4.1.x | |
| `idb` | 8.x | |
| `postgres` | 3.4.x | |
| `@supabase/ssr` / `supabase-js` | 0.12.x / 2.118.x | |

## Rationale

SvelteKit 3 and TypeScript 7 are available. Kit 3 introduces breaking changes that touch
every file in this project: `$lib` → `#lib`, mandatory explicit module extensions, a
TypeScript 6 minimum, Vite 8, and moved hook/remote-function types. `svelte-check` does not
yet accept TypeScript 7.

For a foundation whose exit gate is *verified working functionality*, adopting four
simultaneous major upgrades adds risk without product benefit. Kit 2.70 is current within
its major and supports Svelte 5 runes fully.

## Consequences

- The ESLint rule `svelte/no-navigation-without-resolve` is disabled; it targets Kit 3's
  `resolve()` API. Plain internal paths are correct on Kit 2 with no base path.
- Upgrading to Kit 3 is a scoped, deliberate task: rename the alias, add module extensions,
  bump TypeScript/Vite/plugin, re-enable the rule, re-run the full suite.
- No application code depends on the adapter, so hosting changes remain a one-line change.

## Alternatives considered

- **Kit 3 + TS 6 + Vite 8:** newest, but four coordinated majors on a greenfield codebase
  with no existing test coverage to catch regressions. Revisit after v0.1.
- **Static adapter + Supabase Edge Functions:** rejected by the brief; trusted operations
  would need a second backend, doubling the surface for no v0.0 benefit.
