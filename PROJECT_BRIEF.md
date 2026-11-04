# PROJECT HANDOFF: Synchronized Reaction-Video Application

> **Document status:** Authoritative product planning handoff.
> **Brief version:** 1.0.0 (imported verbatim from the planning conversation on 2026-11-04).
> **Companion document:** [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md) records what has actually been built and verified.
>
> **Change control:** This document is the product source of truth. Implementation must not silently
> diverge from it. When a decision changes, update this file, bump the brief version, and record the
> change in `docs/adr/`. Provisional numbers live in `src/lib/config/policy.ts`, not scattered in code.

## Instructions for the implementation assistant

You are an expert Frontend Architect and full-stack engineer specializing in high-performance web media applications.

We have completed product planning. Help me implement the actual project incrementally, with a strong foundation for future SaaS features.

This document is the authoritative planning handoff.

Important:
- Do not restart product discovery or ask me to repeat decisions recorded here.
- Distinguish committed product requirements from configurable implementation defaults.
- Numerical thresholds described as provisional must be configurable, not scattered through application code.
- Do not build a static UI mockup and describe it as a complete application.
- Do not claim production readiness without appropriate tests, security controls, and documented limitations.
- Implement working vertical slices rather than attempting every future feature at once.
- Keep this document and an implementation-status document updated as development progresses.
- No application code has been created in the planning conversation.

---

## 1. Product and business context

This is my own product idea, not a client project. I intend to monetize it.

The primary use case:
1. A viewer supplies a full-length reaction video.
2. The viewer separately supplies or accesses the original source video.
3. The application synchronizes their playback.

Target reactors typically:
- Publish their reaction separately from the source.
- Display a timer corresponding to the source timeline.
- Do not repeatedly pause the source during the reaction.

Therefore:
- The MVP uses one synchronization offset per reaction/source-version pair.
- Piecewise timeline maps are not an MVP requirement.
- The data model should remain extensible if more complicated synchronization is needed later.

The application DOES NOT provide, host, redistribute, or bypass access controls for reaction or source videos.

Possible user-provided media:
- Local files.
- Authorized direct media URLs.
- YouTube or Vimeo embeds where permitted.
- Eventually, videos playing on their original websites through a browser extension.

Examples of external platforms include Patreon-linked creator sites, YouTube, Streamable, Dropbox, Google Drive, Crunchyroll, Netflix, and Prime Video.

Support is capability-dependent. Do not promise that arbitrary links from these platforms can play inside our application.

Core monetization:
- Free: two videos per session, normally one source plus one reaction.
- Pro: more than two videos, unlimited new session passes, and additional convenience/power features.
- Design for four simultaneous videos initially without hardcoding the entire architecture around that maximum.
- Do not advertise “4K streaming” as a paid service we deliver: we do not host streams.

---

## 2. Technology and architectural direction

Preferred stack:
- SvelteKit.
- Svelte 5.
- TypeScript.
- Tailwind CSS.
- Lucide icons.
- Supabase Auth and PostgreSQL, with row-level security.
- IndexedDB, preferably through `idb`, for local persistence.
- Stripe for paid subscriptions and billing, introduced in the monetization phase.

Use:
- Svelte 5 runes for appropriate client state.
- Modular components and domain services.
- Server-authoritative entitlements, quota allocation, rewards, and moderation.
- Database migrations, automated tests, CI, environment documentation, and structured errors.

Deployment:
- Choose a SvelteKit adapter appropriate for the actual backend deployment.
- Do not use a static-only architecture unless all trusted server operations are implemented in a separate backend, such as Supabase Edge Functions.
- Stripe webhooks, reward allocation, administrative operations, and quota enforcement must never rely solely on client code.

Architecture should separate:
1. Media/provider adapters.
2. Synchronization engine.
3. Session state and persistence.
4. Identity and catalog matching.
5. Pass/quota service.
6. Contributions and verification.
7. Trust and moderation.
8. Entitlements and billing.
9. Notifications and promotions.
10. Recommendation/discovery services.

Prepare interfaces and versioned data contracts for future features without building every future subsystem immediately.

---

## 3. Media capabilities and synchronization

### Local files and authorized direct URLs

Use native HTML5 video playback.

Use `requestVideoFrameCallback` where available for frame observation and synchronization feedback, with an appropriate fallback.

Important limitations:
- `requestVideoFrameCallback` does not guarantee zero-lag or universally frame-perfect synchronization.
- Do not render normal playback through Canvas unnecessarily.
- Canvas is for permitted snapshots, thumbnails, and later alignment tools.
- Cross-origin media may play successfully while Canvas capture is unavailable because of CORS.
- Clipboard/frame capture must fail gracefully when unsupported or restricted.

Synchronization requirements:
- A documented master clock.
- Explicit offset sign convention.
- Play, pause, seek, and rate coordination.
- Small playback-rate nudges for minor drift.
- Hard seeks only when appropriate.
- Handling for buffering, ended media, invalid seek ranges, autoplay rejection, and feedback loops.
- Independent audio volume/mute settings.
- Separate the synchronization clock from audio-source/mixing decisions.
- Record relevant settings and positions for resume.

Document time units:
- Browser media APIs use seconds.
- Domain offsets should use milliseconds.
- Avoid mixing these silently.

Frame stepping:
- HTML5 media does not expose a universal exact frame-step API.
- Use known or estimated frame timing and describe its limitations honestly.

### Provider adapters

Each provider should expose explicit capabilities, for example:
- Can play/pause.
- Can seek.
- Can change rate.
- Can report time.
- Can capture a frame.
- Expected synchronization precision.

YouTube/Vimeo:
- Use official embed/player APIs.
- Do not assume access to their internal video elements or Canvas frames.

Other hosted links:
- A share-page URL is not necessarily a media URL.
- Do not blindly rewrite or strip authorization parameters.
- Keep stable media identity separate from temporary playback URLs.

DRM platforms:
- Our normal web player cannot arbitrarily embed Netflix, Prime, or Crunchyroll streams.
- Never bypass DRM, paywalls, download restrictions, or platform authentication.
- No promise of Canvas sampling for DRM content.

### Future browser extension

A later extension may coordinate playback across the original provider tabs/windows.

It should:
- Control permitted playback operations on the original page.
- Avoid capturing or redistributing protected video.
- Use site-specific adapters and capability detection.
- Treat Document Picture-in-Picture as optional, browser-dependent functionality.
- Undergo legal, platform-policy, and extension-store review.

A small early feasibility investigation is sensible, but the full extension is not MVP scope.

---

## 4. Core client/session state

Maintain a `sessionStore` or equivalent modular state layer.

Do not expose shared mutable per-user state through server-side module globals.

Preserve the following conceptual state:

### currentSession
- id
- name
- lastModified
- updatedAt
- videos[]
- alignment
- isLinked
- isTheaterMode

Each video includes:
- id
- role: source or reaction
- media reference
- runtime playback URL where applicable
- title
- currentTime
- duration
- volume
- muted
- playbackRate
- offsetMs
- logical source/reaction identity where available
- provider/source-version information

Alignment:
- layoutType: split | grid | pip | custom
- locked
- coordinates keyed by viewport ID
- x, y, width, height, crop, opacity

Define coordinate and crop units explicitly.

### Other state
- savedSessions
- presets, including previews where available
- appSettings:
  - wallpaper: image or GIF, with URL/local reference
  - sync preferences
  - audio preferences
  - hardware-acceleration preference where meaningful
  - user tier derived from authoritative entitlements

Important persistence requirements:
- Blob URLs are temporary and must not be treated as durable file references.
- Store File System Access handles in IndexedDB where supported.
- Re-request permissions when needed.
- Provide a file-reselection fallback.
- Do not promise exact automatic file restoration on every browser.
- Do not persist private signed URLs as public catalog identifiers.
- Full cross-device session synchronization is a Pro feature.
- Local session storage remains available to free users.

---

## 5. Accounts and data foundation from the first build

Accounts are required from the earliest usable build. No guest trial is planned initially.

The reason:
- Build identity, consent, catalog relationships, and useful data from day one.
- Later recommendations should not begin with an entirely empty database.

However:
- Early collection reduces cold-start problems; it cannot guarantee enough data for every future feature.
- Collect useful, structured data, not everything indiscriminately.

Separate:
1. Operational account/service data.
2. Optional watch history and personalization.
3. Optional community contributions.
4. Optional product analytics.
5. Optional public nickname display.

Consent must be:
- Granular.
- Versioned.
- Recorded with timestamps.
- Revocable.
- Supported by clear explanations.

Provide:
- Privacy controls.
- Data export.
- Account deletion.
- Appropriate deletion/anonymization and retention workflows.

Do not treat optional recommendation history as mandatory merely because the user needs an account.

If reward eligibility needs minimal activity counters, explain their separate purpose. Do not silently collect full viewing history from someone who declined personalization.

Operational/audit logging must also respect data minimization and retention. “Append-only” must not mean personal data is retained forever regardless of legal obligations.

---

## 6. Anonymous by default; nickname only by explicit choice

Every account is anonymous to other users by default.

Default public display:
- “Anonymous contributor.”
- No email-derived username.
- No automatically public social-login name.
- No public profile containing watch history, sessions, files, or queue items.

A user may explicitly choose a nickname for public leaderboard/badge display.

Anonymous users:
- Can contribute.
- Can rank.
- Can earn rewards.
- See their own position marked privately as “You.”
- Are not penalized for declining a public nickname.

Public anonymous rows must not expose:
- Internal account IDs.
- Email addresses.
- Stable public identifiers that unnecessarily connect anonymous appearances.
- Private session or viewing information.

Do not claim that anonymous display prevents every possible inference from public ranks/scores.

### Nickname setup flow

1. Show safety guidelines before confirmation.
2. Let the user choose a nickname.
3. Show a public preview.
4. Require explicit confirmation that it will be public.

Guidelines include:
- Avoid real names, email addresses, contact details, and identifying handles.
- Do not impersonate staff, reactors, or brands.
- No hateful, harassing, deceptive, or otherwise prohibited names.
- No links.
- Explain that names may be moderated.
- Explain that the user can return to anonymous display.

Planning defaults:
- 3–24 characters.
- Case-insensitive uniqueness.
- Unicode normalization plus confusable-name screening.
- Reserved names and impersonation checks.
- One nickname change per 30 days.
- Immediate return to anonymous display at any time.

Do not assume Unicode normalization alone solves every homoglyph issue.

Nickname moderation:
- Automated screening.
- Human review for ambiguous cases.
- Reporting.
- Disclosed removal/forced rename with a reason and appeal path.
- Versioned acknowledgement of nickname/public-display guidelines.

A nickname does not make tags, offsets, votes, or watch history publicly attributable.

---

## 7. Free session passes and fingerprinting

Free users receive:
- Six new session passes per rolling 24 hours.
- Two videos per session.

A pass covers a reaction/source pair for 24 hours from issuance.

Within that pass:
- Reloading is free.
- Resuming is free.
- Rewatching is free.
- Reopening the same pair must not consume another pass.

After expiration, starting that pair again may require a new pass.

Pro:
- Unlimited new passes.
- More than two videos per session.

Pass allocation must be:
- Server-authoritative.
- Atomic under concurrency.
- Idempotent.
- Able to return an understandable next-availability time.
- Able to reuse an existing unexpired pass before allocating a new one.

Brief offline tolerance may use cached signed authorization, but this is not DRM. A modified client cannot be made perfectly tamper-proof.

### Identity layers

Separate:
1. Physical media identity.
2. Logical content identity.
3. Source version/cut identity.

Planning default:
- Pair identity is the reaction identity plus the logical source identity when confidently known.
- Fall back to physical identity when logical matching is unresolved.
- Switching between legitimate versions of the same logical source should not unnecessarily burn another pass.
- Synchronization offsets remain version-specific.

Local fingerprints:
- Use efficient sampled hashing in a worker.
- First/middle/last chunks, file size, and consistently represented metadata are reasonable starting points.
- Do not hash entire multi-gigabyte files on the UI thread.
- Treat sampled fingerprints as useful identifiers, not proof of content correctness.

Provider media:
- Prefer stable provider content IDs.
- Separate identity from expiring URLs.
- Do not blindly remove query parameters that affect identity or authorization.

No device fingerprinting.

Media/file fingerprinting is allowed and is distinct from device fingerprinting.

---

## 8. Tagging bonus and verification

Product rule:
- Four distinct eligible tagging contributions unlock two additional free session passes for the current daily/24-hour reward window.
- One such bonus per rolling 24 hours.
- Normal free maximum: six base passes plus two bonus passes.

Planning identity model:
- A tagging task describes a reaction/source pair, not each rendered video element.
- Duplicate submissions or repeated confirmation of the same task by the same user must not farm credit.

Define reward-window timestamps and expiration precisely in implementation.
Do not invalidate an already-issued, unexpired pass just because bonus capacity later expires.

A tag claim can identify:
- Reactor.
- Reaction release/media.
- Source title.
- Season/episode or equivalent.
- Platform.
- Source version.
- Relevant synchronization information.

### Verification principles

A trust score or agreement with the crowd is not proof.

Use layered evidence:
- Structured catalog selections.
- Provider/channel metadata where official APIs permit it.
- Verified creator/release attestations.
- Independent corroboration.
- Human moderation.
- Plausibility checks.
- Audited reference examples.

Metadata/runtime checks are weak signals:
- Regional cuts, edits, intros, credits, and encodes vary.
- Do not automatically declare a user wrong solely because runtime differs.
- Playback heartbeats and client-provided measurements can be spoofed.
- A moderator cannot conclusively identify an unseen local file from a hash alone.

Suggested claim lifecycle:
- draft
- submitted
- pending/provisional
- verified
- disputed
- rejected
- superseded/corrected

Only sufficiently verified data should affect shared sync profiles and public recommendation relationships.

Pending personal tags can still be useful privately if clearly identified as unverified.

Alpha:
- Manual review and a small seeded reference dataset.
- Do not rely on nonexistent crowd consensus.

Later:
- Weighted independent corroboration.
- Dispute resolution.
- Random audits.
- Carefully isolated reference checks/canaries if justified.

If canaries are used:
- Their ground truth must be reliable.
- They must not contaminate real catalog data.
- Honest mistakes must not automatically be treated as malicious behavior.

One-tap confirmation can count toward the four-tag target when it is genuinely useful and independently checked.

Reward processing must be idempotent.

---

## 9. Trust, reduced influence, restrictions, and probation

Trust is behavioral reputation, not a declaration that a user is factually correct.

Derive trust from recorded events so incorrect decisions can be reversed.

Do not grant trust merely because someone:
- Pays.
- Has a staff role.
- Ranks highly by volume.
- Has an old account.

### Reduced standing

Users with credible abuse concerns should:
- Have less influence on shared tagging/voting.
- Face stronger independent verification before earning bonuses.
- Have a reachable recovery path.

The intended meaning is:
- LOWER influence.
- HIGHER verification/reward bar.

Illustrative, configurable defaults:
- Influence multiplier around 0.25.
- Verified-only release of bonus credit.
- More audit sampling.
- A recent independently checked accuracy requirement.

Do not present these exact draft numbers as validated production policy.

Do not:
- Show fake reward progress.
- Display “verified” when data is actually quarantined.
- Make earning a promised bonus secretly impossible.
- Let reduced influence itself cause a permanent trust spiral.

Influence restrictions may be less visible than service restrictions, subject to applicable law.

Anything affecting:
- Paid access.
- Playback access.
- Pass availability.
- Bonus eligibility or release conditions.
- Login/suspension.

must be accurately represented to the user.

Sensitive detection details do not need to be disclosed.

### Restriction duration and renewal

Renewals should range from 7 to 30 days according to behavioral trust.

Planning formula:
- T is trust from 0–100.
- renewalDays = 7 + round(23 × (1 − T/100))
- Higher trust means earlier review.
- Lower trust means a longer interval.

Exclude penalties caused by the restriction itself from this calculation.

Renewal requires fresh evidence.
No endless automatic renewal based only on the original suspicion.

Planning safeguards:
- Initial restriction: 14 days by default.
- After three consecutive renewals, require human review.
- Every restriction has a review date and expiration.
- Record policy version and decision evidence.

### Probation: 30 days

Probation is a monitoring/review period, not automatic punishment.

Use it when:
- A minor confirmed offense is forgiven.
- Reinstatement is appropriate but a specific unresolved concern remains.

It should not automatically follow a successful appeal proving the system was wrong.

During probation:
- Normal service access is restored unless separately restricted.
- Additional audits/review may occur.
- A new signal opens a case; it does not automatically establish guilt.
- Contributor leaderboard/reward eligibility is paused.
- Explain the review period without revealing detection thresholds.

After 30 clean days, it ends.

### Protected status after our error

If the system was wrong:
- Reverse the incorrect decision.
- Restore trust, credit, and eligibility.
- Default to 14 days of protection against the same automated penalty, with human review where needed.
- Do not punish someone for winning an appeal.

### Anti-abuse without device fingerprinting

Use proportionate signals such as:
- Verified accounts.
- Contribution patterns.
- Timing and coordination signals.
- Provider evidence.
- Minimal, appropriately retained security/network signals where justified.

Shared IPs, shared cards, and shared files are not proof of abuse.

Do not globally strip email dots or aliases across every provider.
Do not merge or punish accounts based on unsafe normalization assumptions.

---

## 10. Master Controller: administration, staff, appeals, remedies

Build a secure controller for operating the service.

It should eventually manage:
- Users and account standing.
- Staff roles.
- Tag claims and verification.
- Appeals and disputes.
- Trust events.
- Restrictions and probation.
- Pass grants.
- Compensation.
- Trials and membership grants.
- Leaderboard rewards.
- Surprise drops.
- Policy versions.
- Feature flags and kill switches.
- Notification campaigns.
- Incident remediation.

### Staff are users

Staff use normal user accounts with additional role grants.

Suggested roles:
- Support.
- Moderator.
- Admin.
- Owner.

Requirements:
- Server-side permission checks.
- Mandatory MFA for privileged access.
- Step-up authentication for sensitive operations.
- Least privilege.
- Logged role grants/revocations.
- Immediate privilege revocation and appropriate session invalidation.
- No staff trust boost.
- No ability to judge their own claims/appeals or grant themselves benefits.
- Staff excluded from competitive contributor rewards.
- Clear internal distinction between user identity and staff authority.

Public communications can use “Moderation team” without exposing staff personal identities.

Bootstrap the first Owner securely, not through a public client flow.

### Decisions and appeals

Every consequential judgment must record:
- Subject.
- Outcome.
- Reason code.
- Evidence reference/snapshot.
- Policy version.
- Actor.
- Timestamp.
- Superseded decision where relevant.

Judgments must be correctable.

Appeals should be:
- Accessible.
- Evidence-based.
- Structured.
- Resistant to manipulation without assuming eloquence equals dishonesty.
- Subject to realistic response targets.

Default alpha appeal target: 48 hours.

### Reversal cascade

Correcting a decision may need to:
- Correct the claim.
- Reverse trust/strike effects.
- Restore tag credit.
- Restore bonus eligibility or lost passes.
- Reevaluate affected votes/reference checks.
- Rebuild derived sync/catalog/recommendation data.
- Notify affected users.
- Create a regression/reference case.

A successful appeal is evidence for review, not automatically unquestionable ground truth for all future cases.

### Compensation policy defaults

- Restore what was wrongly removed.
- Add a modest goodwill benefit when appropriate.
- Do not claw back good-faith rewards merely because our system made a mistake.
- Confirmed fraud is handled separately.
- Mandatory contractual/statutory remedies are not merely discretionary goodwill.

Provide:
- Standard remedy types.
- Budgets and approval limits.
- Audit trail.
- Bulk incident remediation.
- Policy simulation/shadow mode.
- Independent kill switches.

Use two-person approval for high-risk actions when staffing allows.
For a solo founder, document a controlled exception process rather than pretending two-person approval exists.

Audit logs should be tamper-evident and access-controlled; do not claim a hash chain makes privileged tampering impossible.

---

## 11. Seven-day trial membership

One formal seven-day trial per eligible account/person, with reasonable anti-abuse controls.

No device fingerprinting.
Do not promise perfect “one human, one trial” enforcement without an identity-verification system.

There are two paths.

### A. Earned trial: no card

Available after approximately four qualifying weeks / at least 28 days.

No card required.
No automatic charge.
Trial expires after seven days unless the user separately subscribes.

Eligibility depends on viewing and contributions in EACH of four weeks.

Planning implementation:
- Trailing 28 days.
- Four seven-day blocks.
- Reevaluate qualification consistently using server timestamps.

Weekly sliding-scale default:

| Qualifying viewing items | Contribution units required |
|-------------------------|-----------------------------|
| Fewer than 6            | Week does not qualify        |
| 6–8                     | 4 CU                         |
| 9–11                    | 3 CU                         |
| 12+                     | 2 CU                         |

These values are provisional and should be calibrated.

Planning CU examples:
- Accepted substantive tag: 2 CU.
- Useful accepted confirmation: 1 CU.
- Useful independently resolved vote: 0.25 CU.

Qualifying viewing should represent actual engagement with distinct content, not every reload or both video elements in one session.

A proposed engagement starting point was:
- Ten minutes or 25% of the source.
- Meaningful advancing playback.

This is a calibration parameter, not proof against automation.

A proposed additional guardrail is activity across three days in a qualifying week; keep this configurable.

Pending contributions should appear as pending.
Accepted contributions should be credited to their relevant activity period.
Do not blindly apply the leaderboard’s 14-day settlement lag to every trial/activity credit.

Show clear progress toward the four-week requirement.

### B. Early trial: card required

Users may explicitly choose to start the trial before earning the no-card path.

Explain openly:
- “Earn a no-card trial after four qualifying weeks.”
- “Start earlier by adding a payment method.”

Use Stripe-hosted payment collection.
Do not store card numbers ourselves.

If this path converts to a paid subscription:
- Require explicit agreement.
- Display exact price and charge date.
- Send appropriate reminders.
- Provide straightforward cancellation.
- A saved card alone is not consent to charge.

The previous “unprompted visit to pricing” / 72-hour no-promotion gate was dropped.
Do not reintroduce it.

### Trial history and gifts

- A formal trial is available once.
- Planning default: previous paid subscribers are not eligible for a new-user trial.
- Gifts, compensation, and leaderboard membership rewards do NOT consume the one formal trial.
- Gifts must not accidentally disqualify someone from later earning their trial.
- Trials do not improve trust.
- Active restrictions/probation can affect promotional trial eligibility according to disclosed policy.

---

## 12. Public monthly and all-time contributor leaderboards

Two boards:
1. Monthly.
2. All-time.

Public identity:
- Anonymous by default.
- Optional explicitly chosen nickname.
- No public watch history or contribution attribution.

Anonymous users remain fully reward-eligible.

Rank quality contributions, not raw submission volume.

Scoring can account for:
- Independently accepted tags.
- Useful confirmations.
- Helpful verified corrections.
- Appeals identifying genuine system/catalog flaws.
- Novelty/usefulness.
- Diminishing returns and anti-farming caps.

Do not reward agreement with a mistaken majority as if it were objective correctness.

Planning defaults:
- Initial accuracy gate around 85% over at least ten resolved claims.
- Consider raising to 90% only after calibration.
- Provisional score updates.
- Approximately 14-day settlement for competitive monthly awards.
- Policy-versioned scoring.
- Documented tie-breaking.
- No active reward restriction or probation.
- Staff excluded from competitive awards.

Monthly reward ladder, configurable and budgeted:

| Rank  | Draft reward                         |
|-------|--------------------------------------|
| 1     | 14 days Pro                          |
| 2–3   | 10 days Pro                          |
| 4–10  | 7 days Pro                           |
| 11–25 | 3 days Pro                           |
| 26–50 | Bonus session passes                 |

The confirmed product intent is:
- Maximum monthly top reward: 14 days membership.
- Lowest reward tiers: bonus sessions.

Exact tier sizes and pass amounts are configurable.

Do not silently reduce an already-announced earned reward because a budget was exhausted.
Budget future award cycles appropriately.

All-time contributors also receive:
- Badges.
- Profile flair when publicly named.
- Early-access opportunities.
- Contributor feedback opportunities.
- Other non-manipulative incentives.

All-time rank must not automatically buy voting authority.
Trust comes from measured reliability, not leaderboard position alone.

For paying users, membership rewards must deliver real value through an explicit billing credit or correctly implemented extension.
Appending an internal entitlement does not automatically delay Stripe billing.

---

## 13. Unannounced three-day Pro surprise drops

This replaces the earlier proposal for random seven-day gifts restricted to top contributors.

Final product direction:
- Three days of Pro.
- Unannounced surprise gift.
- General registered-member pool.
- Not tied to purchasing, viewing, tagging, or leaderboard rank.
- No card.
- No automatic renewal.
- No charge afterward.

Free and paid members can benefit.

Planning defaults:
- Offer through inbox and a nonintrusive toast.
- Claim within 14 days.
- Three days start on claim.
- At most one per user per 60 days.
- Monthly budget cap.
- Audited random selection when not gifting everyone.
- Use cryptographically appropriate randomness, not `Math.random` for an auditable award process.
- Keep pool snapshots and award decisions private and auditable.

Email verification and a short account-age gate, such as seven days, were proposed anti-abuse defaults, not contribution requirements. Keep eligibility configurable and accurately described.

Staff can be excluded as an integrity rule.
An active access suspension can block redemption.
Ordinary probation is not automatically a bar to this general goodwill gift; contributor rewards are a separate program.

Paying members:
- Receive equivalent value through an explicit Stripe billing credit or properly supported billing adjustment.
- Do not claim their billing was extended unless Stripe actually reflects it.

Legal caveat:
- A smaller prize, unannounced distribution, or account registration does NOT automatically eliminate lottery/sweepstakes/promotional-law issues.
- Do not repeat earlier suggestions that those changes guarantee legality.
- Obtain jurisdiction-appropriate review before activating randomized drops.
- Feature-flag this program off until ready.
- Deterministic merit rewards also need appropriate published rules.

---

## 14. Recommendations without hosting videos

Recommendations must not be designed as a dead-end list of Patreon links.

Build a round-trip discovery workflow:

Discover → Save → Visit authorized provider → Acquire/access media → Return → Sync/watch.

Mechanisms:
- Queue/watchlist as the primary recommendation action.
- Outbound provider links as a secondary action.
- Saved reactor/source/release identities.
- Return/drop zone for a downloaded file.
- Match returning media to queued items where confidence permits.
- Prefill metadata without treating that match as automatic verification.
- Apply appropriate saved/shared sync profiles.
- Opt-in release/sync-availability alerts.
- Creator “Watch synced” deep links.
- Public previews using permitted embeds.
- Later, local-library-aware recommendations with explicit permission.

Recommended progression:
1. More from this reactor.
2. Other reactors covering this source.
3. Continue this series.
4. Genre/franchise-based recommendations.
5. Collaborative filtering only when sufficient data exists.

Data foundation:
- Reactor directory.
- Structured source catalog.
- Reaction releases.
- Reactor/source relationships.
- Optional watch history.
- Queue intent.
- Version-specific sync profiles.

Catalog tools may use official APIs such as TMDB, AniList, or YouTube, but verify commercial-use licensing and current terms.

Patreon:
- Creators may use Patreon hosting, external hosts, or their own membership-connected websites.
- Patreon account linking does not automatically grant our app media access.
- Any future OAuth/membership integration requires current API/permission review.
- No scraping gated posts or bypassing creator restrictions.

Measure round trips and successful synced sessions, not just outbound clicks.
Tracking and personalization must respect consent.

---

## 15. Interface and visual requirements

Desktop-first, minimalist, high-performance.

Aesthetic:
- Edge-to-edge docking.
- Minimal wasted space.
- Dark/acrylic controls.
- Smooth GPU-friendly transitions.
- Icon-driven playback controls with tooltips.
- Accessible names and keyboard support.
- Respect reduced-motion preferences.

“No text labels” applies mainly to playback chrome.
Safety instructions, billing terms, errors, consent, and administration need readable text.

### Home `/`

- Full-bleed image/GIF wallpaper.
- Crisp rendering.
- No blur.
- No global darkening filter.
- `object-fit: cover` by default.
- Persistent left navigation dock, approximately 256px wide.

Navigation:
- Continue.
- New Session.
- Load Session.
- Presets.
- Settings.
- Exit/reset view.

Continue is disabled without a resumable session.
Exit means cleanly leave/reset session state; do not promise a normal browser tab can always close itself.

### Playback `/session`

MVP:
- Two videos.
- Split and PiP.
- Linked/unlinked playback.
- Offset calibration.
- Individual audio settings.
- Save/resume.

Later:
- Grid.
- More videos.
- Custom coordinates.

Loaded presets/saved locked layouts must disable accidental dragging/resizing.

HUD:
- Directly docked to top/bottom window borders.
- Auto-hide after approximately 2.5 seconds of pointer inactivity.
- Reveal on interaction.
- Do not hide while keyboard focus, scrubbing, menus, or active interaction requires visibility.
- No floating gap at the window edges.

Linked mode:
- One master timeline.

Unlinked mode:
- Separate timelines.
- Per-video controls for calibration.

Animate the transition so scrubbers visually consolidate/separate without remounting video elements or disrupting playback.

Theater mode:
- Fill the browser window’s viewport.
- Collapse surrounding chrome.
- Distinct from actual browser fullscreen.

Keyboard:
- Space: play/pause linked videos.
- L: toggle linked controls.
- T: theater.
- F: fullscreen.
- Left/right: five-second seeks while playing, frame-step approximation while paused.
- Do not intercept shortcuts in text inputs or incompatible dialogs.

Video context menu:
- Copy frame where allowed.
- Set master audio source.
- Adjust sync offset.
- Reset viewport alignment.
- Advanced speed/aspect options.
- Audio-track selection only when the actual provider supports it.

### Sessions `/sessions`

Eventually:
- Search and sort.
- Cards with title, time, video count, progress.
- Resume.
- Duplicate.
- Export config.
- Delete.
- Composite thumbnails where permitted.

Keep private media previews local unless explicitly authorized for remote storage.

### Presets `/presets`

Later-phase studio:
- Frame capture via Canvas where permitted.
- Overlay/onion skin.
- Wipe comparison.
- Coordinates and crop.
- Drag/numeric micro-adjustments.
- Save preset with composite preview.

Not MVP scope.

### Settings `/settings`

- Account/privacy.
- Wallpaper upload or URL.
- PNG/JPG/WebP/GIF.
- Clarity/no-blur confirmation.
- Sync tolerance.
- Audio preferences.
- Meaningful playback preferences.
- Free/Pro comparison.
- Billing.
- Trial progress.
- Notification preferences.

Do not imply JavaScript can force browser hardware acceleration when it cannot.

Additional surfaces:
- Leaderboards.
- Queue/discovery.
- Notification inbox.
- Secure controller/admin area.

---

## 16. Toasts, popups, promotions, and notifications

Support:
- Toasts.
- Inline cards.
- Banners.
- Modals.
- Tooltips/coach marks.
- HUD notices.
- Persistent inbox items.

Separate:
1. Transactional/system messages.
2. Promotional messages.

Promotional defaults:
- No promotional modal during active playback.
- Prefer home, settings, sessions, and natural session boundaries.
- At most one promotional modal per 72 hours.
- At most three interruptive promotional exposures per week.
- Passive inline cards are not equivalent to modal interruptions.
- Respect dismissal and snooze.
- No Pro upsells to active Pro users.
- No fake countdowns, guilt copy, confusing cancellation, or hidden close buttons.

Transactional messages:
- Preserve important billing/security/appeal/reward notices in the inbox.
- Do not suppress essential notices behind marketing caps.
- Still deduplicate and avoid flooding.

UI defaults:
- One modal at a time.
- Maximum three stacked toasts.
- Ordinary toasts around 3–5 seconds.
- Important actions/results remain accessible afterward.
- Appropriate ARIA live regions.
- Focus trapping/restoration for modals.
- Escape handling.
- Reduced-motion support.
- Do not obscure media controls.

Use a notification service/store plus server-controlled, safely rendered campaigns.

Exposure logging:
- Used for caps and, with appropriate consent, analytics.
- Not used to deny the early trial because the user saw an upgrade prompt.
- Rendering is client-observed; do not pretend exposure logging is tamper-proof.

---

## 17. Data model families

Design migrations and relationships around these domains, introducing tables when needed:

Accounts:
- users/profiles
- consents
- staff role grants
- nickname moderation

Media/catalog:
- reactors
- catalog sources
- reaction releases
- media fingerprints
- source versions
- reactor/source relationships

Playback:
- session passes
- local/cloud session references
- sync profiles
- sync confirmations/votes
- optional watch/activity events
- queue items

Contributions:
- tag claims
- evidence
- votes
- trust events
- reward progress

Operations:
- decisions
- appeals/cases
- restrictions
- probation
- remedies
- policy versions
- incidents
- audit logs
- budgets

Membership:
- entitlement grants
- trial claims/history
- billing references
- contribution scores
- monthly/all-time leaderboard snapshots
- badges
- award cycles
- surprise drops/awards

Notifications:
- inbox
- campaigns
- dismissals/snoozes
- exposure records

Important:
- Use stable IDs and schema versions.
- Make issuance, award, billing webhook, and reversal workflows idempotent.
- Keep uncertain/pending evidence distinct from verified facts.
- Keep authoritative records distinct from rebuildable projections.
- Use UTC/server time consistently while displaying local times to users.
- Protect private URLs, local filenames, fingerprints, and viewing information.
- Public APIs must return deliberately restricted projections.

---

## 18. Rollout plan

### v0.0 — Foundation and technical proof

Private development:
- Repository, SvelteKit shell, TypeScript, styling, CI.
- Supabase Auth, migrations, RLS.
- Consent/privacy foundation.
- Entitlement and pass architecture.
- Media identity contracts.
- Minimal controller authorization/audit foundation.
- Structured catalog/tagging contracts.
- Sync-engine prototype in parallel.

Exit gate:
An authenticated user can create a correctly isolated pass and run a basic local two-video synchronization proof.

Do not spend the entire first phase building future admin machinery before proving playback.

### v0.1 — Private alpha

- Local files and authorized direct URLs.
- Two-video split/PiP.
- Manual/tap-to-align.
- Linked/unlinked controls.
- Drift correction.
- HUD, theater, shortcuts, context menu.
- Local save/resume with permission/reselection fallback.
- Six-pass metering and two-pass tagging bonus.
- Structured tagging.
- Human verification.
- Minimal controller, appeals, reversal, compensation.
- Anonymous/nickname flow.
- Toasts and inbox.
- Trial/activity/contribution scoring measured internally.

No unproven automated punitive system.

### v0.5 — Public beta

- YouTube/Vimeo adapters where supported.
- Queue and return/drop workflow.
- Reactor directory and release metadata.
- Public anonymous-by-default monthly leaderboard.
- Manually approved, budgeted contributor rewards.
- Nickname reports/moderation.
- Expanded session browser and settings.
- Capped promotions.
- Collect opt-in contributions for later shared sync.
- Carefully tested influence restrictions and policy shadow mode.

### v1.0 — Monetization

- Stripe subscriptions and webhooks.
- Free/Pro entitlements.
- More than two videos and grid.
- Pro cloud session sync.
- Shared sync profiles with confidence/version safeguards.
- Basic rule-based recommendations.
- Earned no-card trial.
- Early card-backed trial after billing/trial behavior is validated.
- Public all-time leaderboard and badges.

### v1.5 — Discovery and automation

- Automated contributor settlements/awards.
- Three-day surprise drops after legal review.
- Content-based discovery.
- Opt-in alerts.
- Reactor dashboard/partnership tools.
- Campaign controller.
- Possible Patreon integration after API review.

### v2.0 — Browser extension

- Original-site playback coordination.
- Cross-tab/window linking.
- Capability-based site adapters.
- Optional supported PiP functionality.
- Legal/platform/store review.

### v2.5+ — Advanced tools

- Frame-sampling alignment studio.
- Custom layouts.
- Audio correlation only where both recordings actually contain matching audio.
- Collaborative recommendations when data supports them.
- More sophisticated moderation automation when calibration supports it.

Versions are scope boundaries, not promised delivery dates.

---

## 19. Security and legal requirements

No Terms of Service can make the founder “absolutely blameless.”

Aim for maximum lawful protection through:
- Appropriate legal entity.
- Counsel-reviewed terms/privacy/billing/promotional rules.
- Accurate limitations and third-party dependency disclosures.
- Reasonable liability clauses where enforceable.
- Security practices.
- Data minimization.
- Appropriate insurance later.

No hosting does not eliminate all copyright, privacy, security, or consumer-protection exposure.

Implementation requirements:
- No Supabase service-role key in the browser.
- No Stripe secret in the browser.
- No client-controlled Pro status.
- No client-only admin authorization.
- No untrusted arbitrary server-side URL fetching without SSRF safeguards.
- Validate external URLs and uploads.
- Prevent unsafe campaign/nickname HTML rendering.
- Rate-limit sensitive endpoints.
- Verify Stripe webhook signatures.
- Handle duplicate and out-of-order webhooks.
- Plan backups, recovery, monitoring, and incident response.
- Keep privileged actions audited.

Random promotions and paid auto-renewal require jurisdiction-specific review before activation.

Do not make universal legal claims or represent this handoff as legal advice.

---

## 20. Required testing

Include tests appropriate to each phase.

High-priority examples:
- Pass issuance under concurrent requests.
- Existing-pass reuse.
- 24-hour expiration boundaries.
- Bonus issuance exactly once.
- Repeated tag submissions.
- User-to-user data isolation and RLS.
- Server-side staff permissions.
- Claim reversal and reward/trust restoration.
- Trial claimed only once.
- No-card trial never causing a charge.
- Gifts not consuming trial eligibility.
- Stripe webhook idempotency.
- Paid-user reward billing actually matching promised value.
- Public leaderboard anonymity.
- Nickname validation and return to anonymous.
- Notification caps and playback suppression.
- Offset math and seek clamping.
- Linked/unlinked playback state.
- Buffering/play rejection behavior.
- Missing rVFC/CORS/clipboard capability fallbacks.
- Local-file permission loss and reselection.
- Keyboard accessibility and reduced motion.

Use unit/integration tests and browser tests, such as Vitest and Playwright, where appropriate.

Clearly identify tests that require real provider credentials or manual media/device verification.

---

## 21. Provisional configuration, not blocking product questions

The following remain deployment/configuration choices:
- Product name and branding.
- Subscription price, currency, and billing intervals.
- Deployment provider.
- Actual Supabase/Stripe credentials.
- Commercial catalog API arrangements.
- Reward budgets.
- Exact leaderboard tier sizes.
- Final calibrated verification/CU/engagement thresholds.
- Launch jurisdictions and counsel-approved legal text.

Use documented safe development defaults and environment placeholders.
Do not invent production credentials or present provisional policies as legally approved.

---

## 22. Important superseded ideas: do not reintroduce

- No device fingerprinting.
- No guest-first architecture.
- No deferring all accounts/data collection until later versions.
- No universal card requirement for trials.
- No “must visit pricing unprompted” eligibility gate.
- No random seven-day top-contributor-only gift: replaced by general three-day surprise drops.
- No blocking a formal trial merely because the user previously received a gift.
- No automatically public usernames or social-login identities.
- No assumption that majority consensus equals truth.
- No silent degradation of paid access or fake reward progress.
- No assumption that a smaller/unannounced prize guarantees legal compliance.
- No promise of zero-lag, universal frame accuracy, universal media embedding, or absolute legal immunity.
- No full frame-alignment studio in the MVP.
- No requirement for piecewise offset maps in the MVP.

---

## 23. What to do next

Start implementation, not another broad planning exercise.

First:
1. Briefly identify the implementation assumptions and first milestone.
2. Propose the repository structure and trusted backend boundaries.
3. Establish the versioned project brief and implementation-status document.
4. Implement v0.0 incrementally, with the playback proof in parallel.
5. Progress toward a working vertical slice:

Authenticated user
→ supplies two local videos
→ obtains/reuses a server-authorized pass
→ aligns and synchronizes playback
→ saves locally
→ resumes with the correct file-permission/reselection behavior.

Build and verify actual functionality before expanding the feature surface.

Ask questions only when something genuinely blocks implementation or requires credentials, spending, or an irreversible product decision.
