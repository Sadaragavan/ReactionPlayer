# Changelog

Notable changes to Reaction Player. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the version matches `package.json`.

## [Unreleased]

## [0.1.0] - 2026-11-07

First version in this repository.

### Added

- Player: a black canvas with a reaction layer and a source layer that can each be moved and resized, with the source
  always painted on top. Layouts, crop, opacity, aspect lock, theater mode and fullscreen.
- Sync engine: one master clock, drift correction on every frame, a hard seek only for large drift, a per-video offset
  with a stepper, frame stepping, and timelines for videos of unequal length.
- Pages: Home, New session, Session, Load session, Presets with the frame-sampling alignment studio, and Settings
  (Appearance, Preferences, Profile, Subscription).
- Free and Pro tiers: 2 or 4 videos, up to 1080p or 4K, 3 or unlimited custom presets, cloud sync, and the last eight
  captures per video in the studio.
- A Stripe Payment Link seam (`billing.ts`) and a cloud sync adapter (`cloud.ts`), each with a working local fallback.
- A single-file build (`npm run build:single`), the README, `docs/ARCHITECTURE.md` and `docs/PROGRESS.md`.

### Known gaps

- See "Open questions and known gaps" in `docs/PROGRESS.md`.
