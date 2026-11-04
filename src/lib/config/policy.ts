/**
 * CENTRAL POLICY CONFIGURATION — single source of truth for provisional numbers.
 *
 * PROJECT_BRIEF.md §Instructions: "Numerical thresholds described as provisional must be
 * configurable, not scattered through application code."
 *
 * Every value here is a *planning default*, NOT a validated production policy and NOT legal
 * advice. Values marked `provisional` require calibration against real data before public
 * launch. The authoritative copy at runtime is the `policy_versions` database row; this module
 * supplies the seed/default and the typed shape.
 *
 * Units are encoded in property names wherever ambiguity is possible:
 *   ...Ms      milliseconds
 *   ...Seconds seconds (browser media API domain)
 *   ...Hours / ...Days  wall-clock durations
 *   ...Bps     bits per second
 *
 * Do not import this module into SQL. Migrations read the seeded JSON from `policy_versions`
 * so server-side enforcement and client-side display can never silently disagree.
 */

export const POLICY_VERSION = '0.0.1-dev' as const;

/** Free-tier session pass metering (brief §7). */
export const passPolicy = {
	/** New passes granted per rolling window for free accounts. */
	basePassesPerWindow: 6,
	/** Rolling window length. Not a calendar day — a true rolling window. */
	windowHours: 24,
	/** A pass authorizes its pair for this long from issuance. */
	passLifetimeHours: 24,
	/** Maximum video elements in one session on the free tier. */
	freeTierVideoLimit: 2,
	/**
	 * Design target for simultaneous videos. The architecture must not hardcode this as a
	 * ceiling; it is the initial Pro entitlement value.
	 */
	proTierVideoLimit: 4,
	/** Provisional: cached authorization tolerance when the server is briefly unreachable. */
	offlineGraceMinutes: 30
} as const;

/** Tagging bonus (brief §8). */
export const taggingBonusPolicy = {
	/** Distinct eligible contributions needed to unlock the bonus. */
	requiredContributions: 4,
	/** Extra passes granted for the current reward window. */
	bonusPasses: 2,
	/** At most one bonus per rolling window. */
	bonusWindowHours: 24
} as const;

/**
 * Synchronization engine tuning (brief §3).
 *
 * These are drift-control tolerances, not guarantees. `requestVideoFrameCallback` does not
 * provide frame-perfect or zero-lag synchronization; see docs/SYNC.md.
 */
export const syncPolicy = {
	/** Drift below this is left alone (avoids visible micro-corrections). */
	driftToleranceMs: 40,
	/** Drift above this triggers a hard seek instead of a rate nudge. */
	hardSeekThresholdMs: 350,
	/** Maximum playback-rate deviation applied as a drift nudge. */
	maxRateNudge: 0.06,
	/** Proportional gain mapping drift to rate nudge. */
	nudgeGainPerSecond: 0.08,
	/** Minimum interval between corrective hard seeks for one video. */
	seekCooldownMs: 750,
	/** How often the control loop runs when rVFC is unavailable. */
	fallbackPollIntervalMs: 100,
	/** Seek step while playing. */
	seekStepSeconds: 5,
	/** Assumed frame duration for approximate frame stepping when unknown. */
	assumedFrameDurationMs: 1000 / 30,
	/** Clamp for user-entered offsets. */
	maxOffsetMs: 60 * 60 * 1000,
	/** Provisional: a follower this far outside its range is treated as ended/stalled. */
	stallTimeoutMs: 10_000
} as const;

/** Media fingerprinting (brief §7). Sampled hashing only — never full-file on the UI thread. */
export const fingerprintPolicy = {
	/** Bytes sampled at each of first/middle/last positions. */
	chunkBytes: 64 * 1024,
	/** Number of sample positions. */
	samplePositions: ['first', 'middle', 'last'] as const,
	/** Fingerprint contract version; bump when the sampling scheme changes. */
	schemeVersion: 1,
	/** Files above this size are still sampled, never fully hashed. */
	fullHashCeilingBytes: 8 * 1024 * 1024
} as const;

/** HUD / interface behaviour (brief §15). */
export const uiPolicy = {
	hudAutoHideMs: 2500,
	navDockWidthPx: 256,
	toastDurationMs: 4000,
	toastImportantDurationMs: 5000,
	maxStackedToasts: 3,
	maxConcurrentModals: 1
} as const;

/** Nickname rules (brief §6). */
export const nicknamePolicy = {
	minLength: 3,
	maxLength: 24,
	changeCooldownDays: 30,
	/** Unicode normalization form applied before comparison. */
	normalization: 'NFKC' as const,
	guidelinesVersion: '0.0.1-dev'
} as const;

/** Trust / restrictions (brief §9). Draft policy — explicitly not validated. */
export const trustPolicy = {
	/** Influence multiplier under reduced standing. */
	reducedInfluenceMultiplier: 0.25,
	initialRestrictionDays: 14,
	renewalMinDays: 7,
	renewalMaxDays: 30,
	/** renewalDays = min + round((max-min) * (1 - T/100)) */
	renewalRangeDays: 23,
	consecutiveRenewalsBeforeHumanReview: 3,
	probationDays: 30,
	protectedAfterOurErrorDays: 14,
	trustMin: 0,
	trustMax: 100,
	appealResponseTargetHours: 48
} as const;

/** Trial membership (brief §11). */
export const trialPolicy = {
	trialDays: 7,
	qualifyingWeeks: 4,
	weekDays: 7,
	/** Minimum distinct qualifying viewing items for a week to count at all. */
	minViewingItemsPerWeek: 6,
	/** Sliding scale: viewing items -> contribution units required. */
	weeklyContributionScale: [
		{ minViewingItems: 6, requiredContributionUnits: 4 },
		{ minViewingItems: 9, requiredContributionUnits: 3 },
		{ minViewingItems: 12, requiredContributionUnits: 2 }
	] as const,
	/** Provisional engagement definition: 10 minutes OR 25% of source. */
	engagementMinSeconds: 600,
	engagementMinFraction: 0.25,
	/** Provisional guardrail: distinct active days in a qualifying week. */
	minActiveDaysPerWeek: 3,
	contributionUnits: {
		acceptedSubstantiveTag: 2,
		usefulAcceptedConfirmation: 1,
		usefulIndependentlyResolvedVote: 0.25
	}
} as const;

/** Leaderboards (brief §12). */
export const leaderboardPolicy = {
	accuracyGateFraction: 0.85,
	accuracyGateMinResolvedClaims: 10,
	settlementLagDays: 14,
	monthlyRewardLadder: [
		{ maxRank: 1, proDays: 14 },
		{ maxRank: 3, proDays: 10 },
		{ maxRank: 10, proDays: 7 },
		{ maxRank: 25, proDays: 3 },
		{ maxRank: 50, bonusPasses: 3 }
	] as const
} as const;

/** Surprise drops (brief §13). Feature-flagged OFF pending legal review. */
export const surpriseDropPolicy = {
	enabled: false,
	proDays: 3,
	claimWindowDays: 14,
	perUserCooldownDays: 60,
	minAccountAgeDays: 7,
	requireVerifiedEmail: true
} as const;

/** Notification caps (brief §16). */
export const notificationPolicy = {
	promotionalModalCooldownHours: 72,
	maxInterruptivePromotionsPerWeek: 3,
	suppressPromotionsDuringPlayback: true
} as const;

export const policy = {
	version: POLICY_VERSION,
	pass: passPolicy,
	taggingBonus: taggingBonusPolicy,
	sync: syncPolicy,
	fingerprint: fingerprintPolicy,
	ui: uiPolicy,
	nickname: nicknamePolicy,
	trust: trustPolicy,
	trial: trialPolicy,
	leaderboard: leaderboardPolicy,
	surpriseDrop: surpriseDropPolicy,
	notification: notificationPolicy
} as const;

export type Policy = typeof policy;

/**
 * Renewal interval from trust score (brief §9).
 * Higher trust => earlier review. Clamped to the configured range.
 */
export function restrictionRenewalDays(trust: number): number {
	const t = Math.min(trustPolicy.trustMax, Math.max(trustPolicy.trustMin, trust));
	const days =
		trustPolicy.renewalMinDays +
		Math.round(trustPolicy.renewalRangeDays * (1 - t / trustPolicy.trustMax));
	return Math.min(trustPolicy.renewalMaxDays, Math.max(trustPolicy.renewalMinDays, days));
}
