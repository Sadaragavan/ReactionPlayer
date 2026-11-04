/**
 * Pure synchronization math (PROJECT_BRIEF.md §3).
 *
 * Kept free of DOM/media dependencies so it is exhaustively unit-testable.
 *
 * UNIT BOUNDARY: this module accepts seconds where it talks about media time (matching the
 * browser API domain) and milliseconds where it talks about domain offsets/drift. Every
 * parameter name states its unit. No implicit conversions.
 *
 * OFFSET SIGN CONVENTION:
 *   targetSeconds = masterSeconds + offsetMs / 1000
 * Positive offset => this video is AHEAD of the master timeline.
 */

import { syncPolicy } from '../config/policy';

export type SyncPolicyValues = typeof syncPolicy;

/** Convert a domain offset (ms) to the media domain (seconds). */
export function offsetMsToSeconds(offsetMs: number): number {
	return offsetMs / 1000;
}

/** Target position for a follower given the master clock. */
export function targetSecondsFor(masterSeconds: number, offsetMs: number): number {
	return masterSeconds + offsetMsToSeconds(offsetMs);
}

/**
 * Drift of a follower relative to where it should be.
 * POSITIVE drift => the follower is AHEAD (too far along) and must be slowed/pulled back.
 * NEGATIVE drift => the follower is BEHIND and must be sped up.
 */
export function driftMs(actualSeconds: number, targetSeconds: number): number {
	return (actualSeconds - targetSeconds) * 1000;
}

/**
 * Clamp a seek target into the seekable range of the media.
 * Returns null when the target lies entirely outside the media (e.g. the reaction has not
 * reached the feature yet, or the source has already ended). Callers must treat null as
 * "do not seek", never as "seek to 0".
 */
export function clampSeekSeconds(
	targetSeconds: number,
	durationSeconds: number | null,
	options: { readonly endEpsilonSeconds?: number } = {}
): number | null {
	if (!Number.isFinite(targetSeconds)) return null;
	if (targetSeconds < 0) return null;
	if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		// Unknown duration (live/unloaded): allow the raw target, the element will reject
		// invalid seeks itself. Do not invent a bound.
		return targetSeconds;
	}
	// Seeking exactly to duration triggers `ended` in most browsers; back off slightly.
	const epsilon = options.endEpsilonSeconds ?? 0.05;
	const ceiling = Math.max(0, durationSeconds - epsilon);
	if (targetSeconds > durationSeconds) return null;
	return Math.min(targetSeconds, ceiling);
}

export type CorrectionAction =
	| { readonly kind: 'none' }
	| { readonly kind: 'rate'; readonly rate: number }
	| { readonly kind: 'seek'; readonly targetSeconds: number };

export interface CorrectionInput {
	readonly actualSeconds: number;
	readonly targetSeconds: number;
	readonly durationSeconds: number | null;
	/** The user's chosen base rate; nudges are applied around it. */
	readonly baseRate: number;
	/** Whether this follower is currently buffering (no correction while stalled). */
	readonly isBuffering: boolean;
	/** Epoch ms of the last hard seek applied to this follower. */
	readonly lastSeekAtMs: number;
	readonly nowMs: number;
	readonly policy?: SyncPolicyValues;
}

/**
 * Decide how to correct drift.
 *
 * Strategy (brief §3: "small playback-rate nudges for minor drift, hard seeks only when
 * appropriate"):
 *   - buffering                        -> none (never fight a stalled decoder)
 *   - |drift| <= tolerance             -> restore base rate
 *   - |drift| >= hardSeekThreshold     -> hard seek, subject to cooldown
 *   - otherwise                        -> proportional rate nudge, clamped
 *
 * The cooldown prevents seek storms and feedback loops when a seek itself produces
 * a transient drift reading.
 */
export function computeCorrection(input: CorrectionInput): CorrectionAction {
	const p = input.policy ?? syncPolicy;

	if (input.isBuffering) return { kind: 'none' };
	if (!Number.isFinite(input.actualSeconds) || !Number.isFinite(input.targetSeconds)) {
		return { kind: 'none' };
	}

	const d = driftMs(input.actualSeconds, input.targetSeconds);
	const magnitude = Math.abs(d);

	if (magnitude >= p.hardSeekThresholdMs) {
		const cooled = input.nowMs - input.lastSeekAtMs >= p.seekCooldownMs;
		if (!cooled) {
			// Still converge gently rather than doing nothing at all.
			return { kind: 'rate', rate: nudgeRate(d, input.baseRate, p) };
		}
		const clamped = clampSeekSeconds(input.targetSeconds, input.durationSeconds);
		if (clamped === null) return { kind: 'none' };
		return { kind: 'seek', targetSeconds: clamped };
	}

	if (magnitude <= p.driftToleranceMs) {
		return { kind: 'rate', rate: input.baseRate };
	}

	return { kind: 'rate', rate: nudgeRate(d, input.baseRate, p) };
}

/**
 * Proportional rate nudge.
 * Ahead (positive drift) => slow down below base rate. Behind => speed up.
 * Clamped to baseRate ± maxRateNudge and to a sane absolute range.
 */
export function nudgeRate(
	driftMilliseconds: number,
	baseRate: number,
	policy: SyncPolicyValues = syncPolicy
): number {
	const driftSeconds = driftMilliseconds / 1000;
	const adjustment = -driftSeconds * policy.nudgeGainPerSecond;
	const clampedAdjustment = Math.min(
		policy.maxRateNudge,
		Math.max(-policy.maxRateNudge, adjustment)
	);
	const rate = baseRate + clampedAdjustment;
	// Browsers commonly accept 0.0625..16; stay well inside and never reverse/stop.
	return Math.min(4, Math.max(0.25, rate));
}

/**
 * Re-normalize offsets when the master clock changes, preserving relative alignment.
 *
 * All offsets are expressed relative to the master. If the master switches from A to B,
 * subtract B's offset from every offset so B becomes 0 and relative differences survive.
 */
export function renormalizeOffsets(
	videos: readonly { readonly id: string; readonly offsetMs: number }[],
	newMasterId: string
): Map<string, number> {
	const newMaster = videos.find((v) => v.id === newMasterId);
	const shift = newMaster?.offsetMs ?? 0;
	const result = new Map<string, number>();
	for (const v of videos) {
		result.set(v.id, Math.round(v.offsetMs - shift));
	}
	return result;
}

/** Clamp a user-supplied offset to the configured range. */
export function clampOffsetMs(offsetMs: number, policy: SyncPolicyValues = syncPolicy): number {
	if (!Number.isFinite(offsetMs)) return 0;
	return Math.min(policy.maxOffsetMs, Math.max(-policy.maxOffsetMs, Math.round(offsetMs)));
}

/**
 * Derive an offset from a "tap to align" gesture: the user pauses both videos on the same
 * moment of content. Returns the offset that makes the follower's current position correct
 * for the master's current position.
 *
 *   offsetMs = (followerSeconds - masterSeconds) * 1000
 */
export function offsetFromAlignment(
	masterSeconds: number,
	followerSeconds: number
): number {
	return clampOffsetMs((followerSeconds - masterSeconds) * 1000);
}

/**
 * Approximate frame step. HTML5 media exposes no universal exact frame-step API, so this
 * uses known or estimated frame timing. The result is explicitly approximate.
 */
export function frameStepSeconds(
	direction: 1 | -1,
	observedFrameDurationMs: number | null,
	policy: SyncPolicyValues = syncPolicy
): number {
	const duration =
		observedFrameDurationMs && observedFrameDurationMs > 0
			? observedFrameDurationMs
			: policy.assumedFrameDurationMs;
	return (direction * duration) / 1000;
}
