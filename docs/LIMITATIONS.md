# Known limitations

This document exists so capability claims stay honest. Nothing here is a hidden defect;
each item is a deliberate, documented boundary.

## Synchronization

- **Not frame-perfect, not zero-lag.** Drift correction is perceptual. `requestVideoFrameCallback`
  improves observation granularity but guarantees neither.
- **No universal exact frame step.** HTML5 media exposes no such API. Steps use observed or
  assumed frame timing and are labelled approximate in the UI.
- **One offset per pair.** Piecewise timeline maps are not implemented. The schema reserves
  `sync_profiles.map` for a future version.
- **rVFC availability varies.** Where absent, a 100 ms timer is used and precision is lower.
  The engine records which path was used.

## Media and providers

- **Only local files are wired in v0.0.** The `MediaAdapter` interface and capability model
  exist, and `DIRECT_URL_CAPABILITIES` is defined, but the direct-URL input UI and the
  YouTube/Vimeo adapters are not built yet.
- **DRM platforms cannot be embedded.** Netflix, Prime Video, Crunchyroll and similar
  cannot be played inside this app. Nothing here bypasses DRM, paywalls, download
  restrictions or platform authentication.
- **A share page is not a media URL.** Patreon, Dropbox and Google Drive links are not
  rewritten or unwrapped. Authorization parameters are never stripped.
- **Canvas capture can be blocked.** Cross-origin media may play fine while frame capture
  fails due to a tainted canvas. This degrades to a clear message, not an error.
- **Clipboard image writes can be blocked** by browser support or permission.
- **Audio-track selection is unavailable** for local HTML5 video and is not offered in the
  context menu.

## Local file restoration

- **File System Access is Chromium-only** at time of writing. Safari and Firefox fall back
  to explicit reselection. Automatic restoration is never promised for every browser.
- **Permission must be re-requested** and requires a user gesture. The Resume button
  supplies it.
- **Handles break** if a file is moved, renamed or deleted. The flow detects this and
  offers reselection with a hint.
- **Blob URLs are never persisted.** They die with the document.
- **A fingerprint match is not proof.** Sampled hashing reads ~192 KiB of a multi-gigabyte
  file. It is a useful identifier, not verification of content correctness. A re-selected
  file that differs produces a warning the user may override, because legitimate
  re-encodes happen.
- **IndexedDB can be unavailable** (private browsing, quota). Saving fails with a clear
  message rather than silently losing data.

## Security and infrastructure

- **Rate limiting is single-process, in-memory.** It does not coordinate across replicas.
  Before horizontal scaling, replace the store with Redis or a Postgres counter. The
  interface is deliberately swappable.
- **The audit hash chain is tamper-evident, not tamper-proof.** A privileged actor could
  rewrite it. It is paired with access control and retention limits, and should be shipped
  off-site in production.
- **Offline pass tolerance is specified but not implemented.** No cached signed
  authorization is issued yet. A modified client cannot be made perfectly tamper-proof in
  any case.
- **Client-supplied identity can be lied about.** A user could present a different
  fingerprint to reuse a pass. Quota itself remains server-enforced; this is an accepted
  limitation of client-side media identification, and why fingerprints are never treated
  as proof.
- **No distributed lock beyond Postgres.** Pass atomicity relies on a per-user advisory
  transaction lock, which is correct for a single database.

## Not implemented in v0.0

These are scoped to later milestones in the brief, not defects:

- Stripe billing, subscriptions, webhooks (feature-flagged off)
- Trials, leaderboards, badges, surprise drops (drops flag off pending legal review)
- Tagging UI, verification workflow, trust automation (schema present, automation flag off)
- Master Controller UI, appeals UI, remedies UI (schema + authorization present)
- Notification inbox UI, campaigns, exposure capping (schema + toast store present)
- Queue/discovery, reactor directory UI, recommendations
- Grid and custom layouts, presets studio, frame-sampling alignment
- Cloud session sync (Pro), browser extension
- Data export and account deletion endpoints (consent revocation *is* implemented)

## Legal

This repository contains no legal advice. Terms of service, privacy policy, billing terms
and promotional rules require jurisdiction-specific counsel review before launch. No
hosting does not eliminate copyright, privacy, security or consumer-protection exposure.
Randomized promotions and paid auto-renewal are feature-flagged off until reviewed.
