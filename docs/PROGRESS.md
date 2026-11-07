# Reaction Player — build notes (read this first after any restart)

Run from the project root: `npm run dev`, `npm run check` (svelte-check), `npm run build`, `npm run build:single`.
`README.md` covers usage, plans and payment; `docs/ARCHITECTURE.md` covers how the pieces fit.

Stack: Svelte 5 runes · Vite 8 · Tailwind 4 (`@theme` tokens in `src/app.css`) · `@lucide/svelte` · Archivo variable font.
Hash router (`#/`, `#/session`, `#/presets`, `#/sessions`, `#/settings/<appearance|preferences|profile|subscription>`).
The root font size is 14 px, so Tailwind spacing utilities scale by 0.875; explicit `px` values and border widths do not.

## Status: complete

- [x] Home, New session, Session (player), Load session, Presets and alignment studio, Settings (four tabs)
- [x] Sync engine, including videos of unequal length
- [x] Free and Pro tiers, Stripe Payment Link seam, cloud sync seam (both with working local fallbacks)
- [x] Browser verification (see the log below)
- [x] Production build, single-file build, hosted live preview, README, architecture doc, UI element inventory, source zip

## Design rules (decided, so do not re-debate)

- True `#000` everywhere, hairline borders (`border-line`, `border-line-strong`), square-ish corners, **no blur anywhere**.
- Yellow `#FFD400` (`text-accent`, `bg-accent`) only marks live or selected things: the source layer, the playhead, the linked
  state, one primary button.
- Reaction layers are white or grey, with a dashed outline when selected. The source layer has a yellow outline and is
  **always painted on top** (`paintOrder` in `engine/layouts.ts`).
- Archivo only. Page titles use `.title-wide` (width 125, weight 800). Numbers use `.num` (tabular). Sentence case, no all
  caps, no eyebrows.
- Icon-only HUD buttons use `IconButton` (its label is both the tooltip and the aria-label). Tooltips: `use:tip={{text,kbd,side}}`.
- No shadows except floating surfaces (`.float` menus and dialogs, and toasts).

## What exists

- `lib/types.ts` `Session`, `SessionVideo`, `Alignment`, `LayerTransform` (`x y w h` in 0..1, `crop`, `opacity`, `fit`, `aspect`),
  `Preset`, `AppSettings`, `PlaybackPrefs`, `MenuEntry`, and the `BillingAdapter` and `CloudSyncAdapter` contracts.
- `lib/constants.ts` `TIER_LIMITS`, `PRICING`, `DEFAULT_SETTINGS`, `SHORTCUTS` (with a `{step}` placeholder the dialog fills in),
  `ASPECT_OPTIONS`, `CANVAS_ASPECTS`, `MIN_LAYER_SIZE`, `SNAP_DISTANCE`, `PLAYBACK_RATES`, `OFFSET_STEPS`, `HARD_SEEK_THRESHOLD_S`.
- Stores (singletons): `session`, `settings`, `presets`, `router`, `ui`, plus `persistence.ts` for LocalStorage and IndexedDB.
  - `session`: `current`, `saved`, `lastId`, `selectedId`, `master`, `canContinue`, `lastSession`; `create`, `open`, `resume`, `save`,
    `close`, `duplicate`, `remove`, `rename`, `exportJSON`, `syncAll`, `updateVideo`, `setVolume`, `toggleMute`, `setRate`, `setOffset`,
    `nudgeOffset`, `setMaster`, `relink`, `select`, `setLayer`, `resetLayer`, `applyLayout`, `applyPreset`, `setLocked`, `setTheater`,
    `setCanvasAspect`, `recordTimes`.
  - `settings`: `settings`, `profile`, `tier`, `isPro`, `limits`, `playback`, `wallpaper`; `patchPlayback`, `setTier`, `setPlan`,
    `setWallpaper`, `updateProfile`, `resetSettings`.
  - `presets`: `builtIn`, `custom`, `all`, `forCount(n)`, `canAddCustom`, `save`, `rename`, `remove`.
  - `ui`: `toast(msg, kind, action?)`, `openMenu(x, y, entries)`, `newSessionOpen`, `shortcutsOpen`, `dormant`.
  - `router`: `go('home' | { name: 'settings', tab })`, `hrefFor(route)`.
- Engine: `playback.svelte.ts` (the `playback` singleton: clock, transport, drift correction, frame stepping, copy frame,
  thumbnails), `timeline.ts` (pure timeline and drift maths), `track.ts` (one `<video>` plus frame-rate measurement),
  `layouts.ts`, `capture.ts`, `media.ts`, `probe.ts`, `aspect.ts`, `demo.ts`, `sessionFactory.ts`, `importConfig.ts`.
- Utilities: `geometry.ts`, `format.ts`, `file.ts` (`saveBlob` and `saveJSON`, which use the viewer's `downloads` capability when
  sandboxed and a normal download otherwise; `pickFiles`, `downscaleToDataURL`, `copyCanvasToClipboard`), `fullscreen.ts`.
- UI kit `components/ui/`: Button, IconButton, Modal, ContextMenu, MenuPanel, Segmented, Slider, NumberField, Switch, Toasts, ProBadge,
  EmptyState, LayoutPreview, ShortcutsDialog. Actions: `tip`, `dropzone`, `portal`, `focusTrap`, `clickOutside`, `layerGesture`.
- Demo clips: `src/assets/demo/source.webm` (flashes at 2.0 s and 8.0 s) and `reaction.webm` (3.5 s and 9.5 s), so the reaction
  needs `offsetMs = +1500` to line up. `scripts/make-demo-clips.sh` regenerates them.

## Behaviour worth remembering

- **Unequal lengths.** The linked timeline is the union of all footage. A video outside its own footage waits on its first or last
  frame, a virtual clock carries the timeline while the master has none, playback ends when every video has ended, a single
  frame step follows the video on screen, and `audioFollowsFootage` (default on) lends the master's sound to the first video that
  has footage.
- **Lane heights** come from one number. `LANE_H` in `components/session/metrics.ts` is exposed as `--lane` on the transport, and
  the master lane, the per-video lanes and the stage inset all read it, so the dock and the canvas cannot drift apart.
- **The plan table in Settings → Subscription must say what the code enforces.** Enforced today: 2 or 4 videos, up to 1080p or 4K,
  cloud sync, 3 or unlimited custom presets, and the last eight captures per video in the studio (Pro). Onion skin, wipe and crop are free.
- **The shortcut list** is `SHORTCUTS` in `constants.ts` and must match the `switch` in `pages/Session.svelte`.
- **Local files** are never persisted, only their names. A relink prompt appears on exactly the layers that need it.
- **Tailwind only scans `src/` and `index.html`** (`source(none)` and two `@source` lines at the top of `src/app.css`). Do not remove
  them: with automatic detection the docs and old builds leak class names into the stylesheet.

## Verification log

- `npm run check`: 0 errors, 0 warnings.
- Headless Chromium (Playwright) against the production build (the engine-level length suite on the dev server; the smoke,
  transport, session and length suites repeated on the single-file build), with generated clips of 6, 8 and 20 s at 24 and 30 fps:
  smoke and sync; transport (frame steps, link and unlink, offset capture); session HUD, menus, theater and shortcuts; every page,
  including wallpaper upload and link; a 390 px phone layout; menus and flows (preset apply, Presets to new session, Quit and Reopen);
  a sandbox simulation (blocked storage, throwing file picker, rejecting clipboard, refused fullscreen); unequal lengths through the
  engine (54 checks) and through the real screens (13 checks). All passing, no console errors.
- The final single-file build was opened in the artifact viewer: Home renders, the demo starts, both layers show with the 1.5 s offset.
  The viewer logs two harmless notices (autoplay and screen wake lock are not allowed in the frame).
- **Not verified:** a real Stripe checkout or webhook, a real cloud backend, File System Access handle persistence across restarts,
  the clipboard and fullscreen inside a sandboxed viewer, Safari and Firefox, real touch hardware, and screen readers.

## Open questions and known gaps

- **Home navigation.** The dock has no Home item and the wordmark is not a link. From Load session and Presets the only way back to
  Home is Quit then Reopen; from Settings there is also the "See Home" button on Appearance; the player has its own Home button.
  Left as is: it is a design decision (there is a comment on it in the UI inventory doc).
- The Layers panel on a phone leaves the canvas about 94 px wide; it wants a bottom sheet.
- The phone dock shows icons without visible labels, and the phone transport drops frame steps, speed and volume.
- "Try the demo" shows no loading state while the clips decode.
- No HLS or DASH, no real payment verification, no real cloud backend (both have adapters ready: `billing.ts`, `cloud.ts`).

## Conventions

- Pages that sit beside the dock wrap their content in `<PageShell>`; the title is `<h1 class="title-wide text-[28px] md:text-[34px]">`.
- Free users: `settings.limits.maxCustomPresets` is 3 and `advancedSampler` is false. Gate with `<ProBadge />` and a button to
  `router.go({ name: 'settings', tab: 'subscription' })`.
- Never blur. Never shadow except on floating surfaces. No all caps, no eyebrows, no "·"-joined meta strings (use icons and separate spans).
- Write long files in small pieces (outline first, then sections); one long response once hit the output limit.
