import { describe, it, expect } from 'vitest';
import {
	targetSecondsFor,
	driftMs,
	clampSeekSeconds,
	computeCorrection,
	nudgeRate,
	renormalizeOffsets,
	clampOffsetMs,
	offsetFromAlignment,
	frameStepSeconds,
	offsetMsToSeconds
} from '../../src/lib/sync/math';
import { syncPolicy, restrictionRenewalDays } from '../../src/lib/config/policy';
import { canonicalPairKey, meteringKeyFor } from '../../src/lib/contracts/media';
import { toPersistableSession, type Session } from '../../src/lib/contracts/session';

describe('offset sign convention', () => {
	it('converts milliseconds to seconds at the domain boundary', () => {
		expect(offsetMsToSeconds(30_000)).toBe(30);
		expect(offsetMsToSeconds(-1500)).toBe(-1.5);
	});

	it('treats a positive offset as the follower running ahead', () => {
		// Reaction has a 30s intro; at source t=0 the reaction should be at t=30.
		expect(targetSecondsFor(0, 30_000)).toBe(30);
		expect(targetSecondsFor(10, 30_000)).toBe(40);
	});

	it('treats a negative offset as the follower running behind', () => {
		expect(targetSecondsFor(60, -5_000)).toBe(55);
	});

	it('computes drift with a documented sign', () => {
		// Ahead of target => positive drift => must slow down.
		expect(driftMs(10.5, 10)).toBeCloseTo(500);
		expect(driftMs(9.5, 10)).toBeCloseTo(-500);
	});

	it('derives an offset from a tap-to-align gesture', () => {
		// Master at 12s, follower at 42s on the same content moment => +30000ms.
		expect(offsetFromAlignment(12, 42)).toBe(30_000);
		expect(offsetFromAlignment(42, 12)).toBe(-30_000);
	});
});

describe('seek clamping', () => {
	it('rejects a negative target instead of silently seeking to zero', () => {
		expect(clampSeekSeconds(-5, 100)).toBeNull();
	});

	it('rejects a target beyond the media duration', () => {
		expect(clampSeekSeconds(150, 100)).toBeNull();
	});

	it('backs off from the exact end so playback does not immediately end', () => {
		const result = clampSeekSeconds(100, 100);
		expect(result).not.toBeNull();
		expect(result!).toBeLessThan(100);
		expect(result!).toBeGreaterThan(99.9);
	});

	it('passes through a target when duration is unknown, without inventing a bound', () => {
		expect(clampSeekSeconds(50, null)).toBe(50);
		expect(clampSeekSeconds(50, 0)).toBe(50);
	});

	it('rejects non-finite input', () => {
		expect(clampSeekSeconds(Number.NaN, 100)).toBeNull();
		expect(clampSeekSeconds(Number.POSITIVE_INFINITY, 100)).toBeNull();
	});

	it('clamps a zero-duration media safely', () => {
		expect(clampSeekSeconds(0, 0.01)).toBe(0);
	});
});

describe('drift correction strategy', () => {
	const base = {
		durationSeconds: 600,
		baseRate: 1,
		isBuffering: false,
		lastSeekAtMs: -Infinity,
		nowMs: 10_000
	};

	it('restores base rate inside the tolerance deadband', () => {
		const action = computeCorrection({
			...base,
			actualSeconds: 100.01,
			targetSeconds: 100,
			baseRate: 1.5
		});
		expect(action).toEqual({ kind: 'rate', rate: 1.5 });
	});

	it('applies a small rate nudge for minor drift', () => {
		const action = computeCorrection({ ...base, actualSeconds: 100.1, targetSeconds: 100 });
		expect(action.kind).toBe('rate');
		if (action.kind === 'rate') {
			// Ahead => slower than base.
			expect(action.rate).toBeLessThan(1);
			expect(action.rate).toBeGreaterThan(1 - syncPolicy.maxRateNudge - 1e-9);
		}
	});

	it('speeds up a follower that is behind', () => {
		const action = computeCorrection({ ...base, actualSeconds: 99.9, targetSeconds: 100 });
		expect(action.kind).toBe('rate');
		if (action.kind === 'rate') expect(action.rate).toBeGreaterThan(1);
	});

	it('hard seeks for large drift', () => {
		const action = computeCorrection({ ...base, actualSeconds: 105, targetSeconds: 100 });
		expect(action).toEqual({ kind: 'seek', targetSeconds: 100 });
	});

	it('never corrects while buffering', () => {
		const action = computeCorrection({
			...base,
			isBuffering: true,
			actualSeconds: 200,
			targetSeconds: 100
		});
		expect(action).toEqual({ kind: 'none' });
	});

	it('suppresses seek storms with a cooldown, still nudging gently', () => {
		const action = computeCorrection({
			...base,
			actualSeconds: 105,
			targetSeconds: 100,
			lastSeekAtMs: 9_800,
			nowMs: 10_000
		});
		expect(action.kind).toBe('rate');
	});

	it('allows a seek once the cooldown has elapsed', () => {
		const action = computeCorrection({
			...base,
			actualSeconds: 105,
			targetSeconds: 100,
			lastSeekAtMs: 9_000,
			nowMs: 10_000
		});
		expect(action.kind).toBe('seek');
	});

	it('does not seek outside the follower range', () => {
		const action = computeCorrection({
			...base,
			durationSeconds: 50,
			actualSeconds: 10,
			targetSeconds: 100
		});
		expect(action).toEqual({ kind: 'none' });
	});

	it('ignores non-finite readings rather than acting on them', () => {
		expect(
			computeCorrection({ ...base, actualSeconds: Number.NaN, targetSeconds: 100 })
		).toEqual({ kind: 'none' });
	});

	it('clamps rate nudges to the configured maximum', () => {
		const rate = nudgeRate(60_000, 1);
		expect(rate).toBeGreaterThanOrEqual(1 - syncPolicy.maxRateNudge);
		const fast = nudgeRate(-60_000, 1);
		expect(fast).toBeLessThanOrEqual(1 + syncPolicy.maxRateNudge);
	});

	it('never produces a non-positive or absurd rate', () => {
		expect(nudgeRate(1e9, 0.25)).toBeGreaterThan(0);
		expect(nudgeRate(-1e9, 4)).toBeLessThanOrEqual(4);
	});
});

describe('master re-normalization', () => {
	it('preserves relative alignment when the master changes', () => {
		const videos = [
			{ id: 'source', offsetMs: 0 },
			{ id: 'reaction', offsetMs: 30_000 }
		];
		const result = renormalizeOffsets(videos, 'reaction');
		expect(result.get('reaction')).toBe(0);
		expect(result.get('source')).toBe(-30_000);

		// Relative difference is unchanged: reaction is still 30s ahead of source.
		const before = videos[1]!.offsetMs - videos[0]!.offsetMs;
		const after = result.get('reaction')! - result.get('source')!;
		expect(after).toBe(before);
	});

	it('handles a three-video session without hardcoding a maximum', () => {
		const videos = [
			{ id: 'a', offsetMs: 0 },
			{ id: 'b', offsetMs: 5_000 },
			{ id: 'c', offsetMs: -2_000 }
		];
		const result = renormalizeOffsets(videos, 'b');
		expect(result.get('a')).toBe(-5_000);
		expect(result.get('b')).toBe(0);
		expect(result.get('c')).toBe(-7_000);
	});

	it('is a no-op for an unknown master id', () => {
		const result = renormalizeOffsets([{ id: 'a', offsetMs: 1000 }], 'missing');
		expect(result.get('a')).toBe(1000);
	});
});

describe('offset clamping', () => {
	it('clamps to the configured range and rounds to whole milliseconds', () => {
		expect(clampOffsetMs(1e12)).toBe(syncPolicy.maxOffsetMs);
		expect(clampOffsetMs(-1e12)).toBe(-syncPolicy.maxOffsetMs);
		expect(clampOffsetMs(1234.6)).toBe(1235);
	});

	it('treats non-finite input as zero', () => {
		expect(clampOffsetMs(Number.NaN)).toBe(0);
	});
});

describe('approximate frame stepping', () => {
	it('uses observed frame timing when available', () => {
		expect(frameStepSeconds(1, 41.7)).toBeCloseTo(0.0417);
	});

	it('falls back to the assumed frame duration and stays approximate', () => {
		expect(frameStepSeconds(1, null)).toBeCloseTo(syncPolicy.assumedFrameDurationMs / 1000);
		expect(frameStepSeconds(-1, 0)).toBeCloseTo(-syncPolicy.assumedFrameDurationMs / 1000);
	});
});

describe('pair identity for metering', () => {
	it('prefers a confident logical identity over physical', () => {
		const result = meteringKeyFor(
			{
				layer: 'logical',
				id: 'ep-1',
				catalogSourceId: null,
				reactionReleaseId: null,
				title: 'Episode 1',
				seasonNumber: 1,
				episodeNumber: 1,
				confidence: 'strong'
			},
			{
				layer: 'physical',
				id: 'p1',
				provider: 'local-file',
				providerContentId: 'abc123',
				fingerprint: null,
				fileName: 'file.mkv',
				sizeBytes: 100,
				durationMs: 1000
			}
		);
		expect(result).toEqual({ key: 'logical:ep-1', layer: 'logical' });
	});

	it('falls back to physical when the logical match is unresolved', () => {
		const result = meteringKeyFor(
			{
				layer: 'logical',
				id: 'ep-1',
				catalogSourceId: null,
				reactionReleaseId: null,
				title: '',
				seasonNumber: null,
				episodeNumber: null,
				confidence: 'tentative'
			},
			{
				layer: 'physical',
				id: 'p1',
				provider: 'local-file',
				providerContentId: 'abc123',
				fingerprint: null,
				fileName: null,
				sizeBytes: null,
				durationMs: null
			}
		);
		expect(result?.layer).toBe('physical');
	});

	it('produces an order-independent canonical pair key', () => {
		const a = canonicalPairKey({
			reactionKey: 'logical:r',
			sourceKey: 'logical:s',
			reactionKeyLayer: 'logical',
			sourceKeyLayer: 'logical'
		});
		const b = canonicalPairKey({
			reactionKey: 'logical:s',
			sourceKey: 'logical:r',
			reactionKeyLayer: 'logical',
			sourceKeyLayer: 'logical'
		});
		expect(a).toBe(b);
	});

	it('returns null when neither layer can identify the media', () => {
		expect(meteringKeyFor(null, null)).toBeNull();
	});
});

describe('session persistence safety', () => {
	it('strips runtime blob URLs so they are never persisted as durable references', () => {
		const session: Session = {
			id: 's1',
			schemaVersion: 1,
			name: 'Test',
			lastModifiedMs: 1,
			updatedAtMs: 1,
			createdAtMs: 1,
			isLinked: true,
			isTheaterMode: false,
			masterVideoId: 'v1',
			audioSourceVideoId: 'v1',
			passId: null,
			alignment: { layoutType: 'split', locked: false, coordinates: {} },
			videos: [
				{
					id: 'v1',
					role: 'source',
					title: 'Source',
					media: {
						provider: 'local-file',
						physicalId: null,
						fileHandleId: 'handle-1',
						sourceUrl: null,
						playbackUrl: 'blob:http://localhost/dead-beef',
						reselectHint: {
							fileName: 'source.mkv',
							sizeBytes: 100,
							lastModifiedMs: 1,
							fingerprintDigest: 'abc'
						}
					},
					currentTimeSeconds: 10,
					durationSeconds: 100,
					volume: 1,
					muted: false,
					playbackRate: 1,
					offsetMs: 0,
					logicalId: null,
					sourceVersionId: null,
					identityConfidence: 'unresolved'
				}
			]
		};

		const persisted = toPersistableSession(session);
		expect(persisted.videos[0]!.media.playbackUrl).toBeNull();
		// The durable handle and reselection hint survive.
		expect(persisted.videos[0]!.media.fileHandleId).toBe('handle-1');
		expect(persisted.videos[0]!.media.reselectHint?.fileName).toBe('source.mkv');
		// The original object is not mutated.
		expect(session.videos[0]!.media.playbackUrl).toBe('blob:http://localhost/dead-beef');
	});
});

describe('restriction renewal formula', () => {
	it('gives higher trust an earlier review', () => {
		expect(restrictionRenewalDays(100)).toBe(7);
		expect(restrictionRenewalDays(0)).toBe(30);
		expect(restrictionRenewalDays(50)).toBe(19);
	});

	it('is monotonic and stays inside the configured range', () => {
		let previous = 31;
		for (let trust = 0; trust <= 100; trust += 5) {
			const days = restrictionRenewalDays(trust);
			expect(days).toBeGreaterThanOrEqual(7);
			expect(days).toBeLessThanOrEqual(30);
			expect(days).toBeLessThanOrEqual(previous);
			previous = days;
		}
	});

	it('clamps out-of-range trust values', () => {
		expect(restrictionRenewalDays(-50)).toBe(30);
		expect(restrictionRenewalDays(500)).toBe(7);
	});
});
