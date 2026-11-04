# Synchronization

## Master clock

One video is the **master**. Its `currentTime` (seconds) defines the session timeline.
Every other video is a **follower**:

```
targetSeconds = masterSeconds + follower.offsetMs / 1000
```

The master is never rate-nudged or seeked by the engine. Only followers are corrected.
This gives a single source of truth and prevents two videos from chasing each other.

By default the **source** is the master (it is the timeline the reactor's on-screen timer
usually refers to). The master can be changed from the video context menu.

## Offset sign convention

> **A positive offset means the video runs AHEAD of the master timeline.**

Worked example — a reaction with a 30-second intro before the feature starts:

| | Master (source) | Follower (reaction) | offsetMs |
| --- | --- | --- | --- |
| Feature begins | 0 s | 30 s | **+30000** |
| Two minutes in | 120 s | 150 s | +30000 |

If the master switches to the reaction, offsets are re-normalized so relative alignment
survives: reaction becomes `0`, source becomes `-30000`. The 30-second relationship is
unchanged. This generalizes to N videos; nothing is hardcoded to two.

### Units

| Domain | Unit | Naming |
| --- | --- | --- |
| Browser media APIs | seconds | `currentTimeSeconds`, `durationSeconds` |
| Domain offsets and drift | milliseconds | `offsetMs`, `driftMs` |
| Layout coordinates | fraction of stage (0..1) | `x`, `y`, `width`, `height` |
| Crop | inset fraction of source frame (0..1) | `crop.top/right/bottom/left` |

Conversion happens only at the boundary (`offsetMsToSeconds`). Units are never mixed
silently; every parameter name states its unit.

## Drift correction

`computeCorrection()` in `src/lib/sync/math.ts` is a pure function, exhaustively unit-tested.

| Condition | Action |
| --- | --- |
| Follower is buffering | **none** — never fight a stalled decoder |
| Non-finite reading | **none** |
| \|drift\| ≥ `hardSeekThresholdMs` (350 ms) | **hard seek**, subject to cooldown |
| …but inside `seekCooldownMs` (750 ms) | rate nudge instead (avoids seek storms) |
| \|drift\| ≤ `driftToleranceMs` (40 ms) | restore base rate |
| otherwise | proportional **rate nudge** |

Rate nudge: `rate = baseRate − clamp(driftSeconds × nudgeGainPerSecond, ±maxRateNudge)`.
Ahead → slow down; behind → speed up. Clamped to ±0.06 around the user's base rate and to
an absolute range of 0.25–4.

All thresholds are in `src/lib/config/policy.ts`, not scattered through the engine.

## Feedback-loop prevention

1. Only followers are corrected; the master is never touched.
2. Rate writes are skipped when the value is unchanged (some browsers fire `ratechange`
   even for an identical assignment).
3. Hard seeks have a per-follower cooldown.
4. Engine-initiated seeks are tracked so the resulting `seeked` event does not trigger
   another correction.
5. No correction while buffering.
6. Provider capabilities are respected: a provider that cannot seek or change rate is
   simply excluded from that correction, rather than silently failing.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Autoplay rejected | `play()` rejection is surfaced; the group is paused and the UI says "Press play to start". Never pretends to be playing. |
| Follower stalls | The group pauses so the viewer does not miss content; a "Buffering…" notice appears and clears on recovery. |
| Master ends | All followers pause; an "all ended" state is reported. |
| Seek outside range | Rejected (`null`), **not** clamped to 0. A follower that has not reached the feature yet is left alone. |
| Seek to exact duration | Backed off by 50 ms so playback does not immediately end. |
| Media error | A readable message is surfaced for that video. |

## Frame observation

`requestVideoFrameCallback` is used where available; otherwise a 100 ms timer.

**rVFC improves observation granularity. It does not guarantee frame-perfect or zero-lag
synchronization.** The engine records whether each observation was frame-accurate and
exposes it in diagnostics.

Normal playback goes directly through the video element, never through Canvas. Canvas is
used only for permitted snapshots.

## Frame stepping

HTML5 media exposes **no universal exact frame-step API**. Stepping uses observed frame
timing when rVFC provides plausible deltas, otherwise an assumed 33.3 ms (30 fps). The UI
labels these controls "approximate". Observed deltas are only accepted between 1 ms and
250 ms so seeks and stalls cannot corrupt the estimate.

## Audio is independent

The clock master and the audio source are separate decisions. Making the source the clock
master does not force it to be audible. `setAudioSource()` mutes the others; per-video
volume and mute remain independently controllable.

## Canvas and clipboard limits

Cross-origin media may play perfectly while Canvas capture is blocked (tainted canvas).
`captureFrame()` forces a taint check with a 1×1 `getImageData` and returns `null` on
failure. Clipboard writes degrade to a clear message when `ClipboardItem` is unavailable
or permission is denied. Neither case throws.

## What this does not do

- No piecewise timeline maps (MVP uses one offset per pair; the schema reserves room).
- No audio-correlation auto-alignment.
- No claim of sample-exact or frame-exact sync.
- No Canvas re-rendering of normal playback.
