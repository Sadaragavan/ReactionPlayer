/**
 * Rate limiting for sensitive endpoints (PROJECT_BRIEF.md §19).
 *
 * IMPORTANT LIMITATION: this is a single-process, in-memory token bucket. It is adequate
 * for a single Node instance and for development, but it does NOT coordinate across
 * replicas. Before horizontally scaling, replace the store with Redis or a Postgres
 * counter — the interface below is deliberately swappable.
 *
 * Documented rather than hidden so the limitation is not mistaken for production-grade
 * distributed protection.
 *
 * The bucket map is process infrastructure, not per-user application state, so it does not
 * violate the "no shared mutable per-user state in module globals" rule: nothing here is
 * read to make an authorization or entitlement decision.
 */

import { AppError } from '../../contracts/errors';

export interface RateLimitRule {
	readonly capacity: number;
	readonly refillPerSecond: number;
}

export const RATE_LIMITS = {
	signIn: { capacity: 8, refillPerSecond: 8 / 300 },
	signUp: { capacity: 4, refillPerSecond: 4 / 3600 },
	passIssue: { capacity: 30, refillPerSecond: 30 / 60 },
	consentWrite: { capacity: 20, refillPerSecond: 20 / 60 },
	fingerprintRegister: { capacity: 60, refillPerSecond: 60 / 60 }
} as const satisfies Record<string, RateLimitRule>;

interface Bucket {
	tokens: number;
	updatedAtMs: number;
}

/**
 * Development-only capacity scaling.
 *
 * Automated suites create many accounts from one IP and would otherwise exhaust the
 * sign-up bucket after four runs. Rather than adding a bypass header (a real attack
 * surface) or weakening the production defaults, capacity can be scaled explicitly by
 * configuration — and the scaling is REFUSED in production regardless of what is set.
 *
 * Defaults to 1, so an unconfigured deployment gets the real limits.
 */
let capacityMultiplier = 1;

export function configureRateLimits(options: {
	multiplier: number;
	isProduction: boolean;
}): void {
	if (options.isProduction || !Number.isFinite(options.multiplier)) {
		capacityMultiplier = 1;
		return;
	}
	capacityMultiplier = Math.min(1000, Math.max(1, Math.floor(options.multiplier)));
}

/** Scale both burst capacity and sustained refill so the shape of the limit is preserved. */
function scaled(rule: RateLimitRule): RateLimitRule {
	if (capacityMultiplier === 1) return rule;
	return {
		capacity: rule.capacity * capacityMultiplier,
		refillPerSecond: rule.refillPerSecond * capacityMultiplier
	};
}

const buckets = new Map<string, Bucket>();
let lastSweepMs = 0;

/** Remove long-idle buckets so the map cannot grow without bound. */
function sweep(nowMs: number): void {
	if (nowMs - lastSweepMs < 60_000) return;
	lastSweepMs = nowMs;
	for (const [key, bucket] of buckets) {
		if (nowMs - bucket.updatedAtMs > 3_600_000) buckets.delete(key);
	}
}

export interface RateLimitResult {
	readonly allowed: boolean;
	readonly retryAfterSeconds: number;
	readonly remaining: number;
}

export function checkRateLimit(
	key: string,
	rule: RateLimitRule,
	nowMs: number = Date.now()
): RateLimitResult {
	sweep(nowMs);
	const existing = buckets.get(key);
	let bucket: Bucket;

	if (!existing) {
		bucket = { tokens: rule.capacity, updatedAtMs: nowMs };
	} else {
		const elapsedSeconds = Math.max(0, (nowMs - existing.updatedAtMs) / 1000);
		bucket = {
			tokens: Math.min(rule.capacity, existing.tokens + elapsedSeconds * rule.refillPerSecond),
			updatedAtMs: nowMs
		};
	}

	if (bucket.tokens < 1) {
		const deficit = 1 - bucket.tokens;
		buckets.set(key, bucket);
		return {
			allowed: false,
			retryAfterSeconds: Math.ceil(deficit / rule.refillPerSecond),
			remaining: 0
		};
	}

	bucket.tokens -= 1;
	buckets.set(key, bucket);
	return {
		allowed: true,
		retryAfterSeconds: 0,
		remaining: Math.floor(bucket.tokens)
	};
}

/** Throw a structured 429 when the limit is exceeded. */
export function enforceRateLimit(key: string, rule: RateLimitRule): void {
	const result = checkRateLimit(key, scaled(rule));
	if (!result.allowed) {
		throw new AppError('rate_limited', 'Too many attempts. Please wait before trying again.', {
			retryAfterSeconds: result.retryAfterSeconds
		});
	}
}

/** Test-only reset. */
export function resetRateLimits(): void {
	buckets.clear();
	lastSweepMs = 0;
	capacityMultiplier = 1;
}
