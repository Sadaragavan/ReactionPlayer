import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine } from '../../src/lib/sync/engine';
import { FakeAdapter } from '../helpers/fake-adapter';
import type { ProviderCapabilities } from '../../src/lib/contracts/media';

describe('SyncEngine', () => {
	let clock: number;
	let engine: SyncEngine;
	let source: FakeAdapter;
	let reaction: FakeAdapter;

	function setup(capabilities: Partial<ProviderCapabilities> = {}) {
		source = new FakeAdapter('source');
		reaction = new FakeAdapter('reaction', capabilities);
		engine.addVideo({ id: 'source', adapter: source, offsetMs: 0, baseRate: 1 });
		engine.addVideo({ id: 'reaction', adapter: reaction, offsetMs: 30_000, baseRate: 1 });
	}

	beforeEach(() => {
		clock = 0;
		engine = new SyncEngine({ now: () => clock });
		setup();
	});

	describe('master clock', () => {
		it('makes the first registered video the master', () => {
			expect(engine.getMasterId()).toBe('source');
		});

		it('never corrects the master itself', () => {
			source.time = 100;
			reaction.time = 0;
			engine.controlLoop();
			expect(source.seekLog).toHaveLength(0);
			expect(source.rateLog).toHaveLength(0);
		});

		it('targets followers using the documented offset convention', () => {
			source.time = 10;
			reaction.time = 0; // should be at 40
			engine.controlLoop();
			expect(reaction.seekLog.at(-1)).toBeCloseTo(40);
		});

		it('preserves relative alignment when the master changes', () => {
			engine.setMaster('reaction');
			expect(engine.getOffset('reaction')).toBe(0);
			expect(engine.getOffset('source')).toBe(-30_000);

			reaction.time = 40;
			source.time = 0;
			engine.controlLoop();
			// Source should now target 40 - 30 = 10.
			expect(source.seekLog.at(-1)).toBeCloseTo(10);
		});

		it('restores the new master to its base rate rather than a leftover nudge', () => {
			reaction.rate = 0.95;
			engine.setMaster('reaction');
			expect(reaction.rate).toBe(1);
		});
	});

	describe('drift correction', () => {
		it('leaves a follower alone inside the tolerance', () => {
			source.time = 100;
			reaction.time = 130.01;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
			expect(reaction.rate).toBe(1);
		});

		it('nudges rate for small drift instead of seeking', () => {
			source.time = 100;
			reaction.time = 130.1; // 100ms ahead
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
			expect(reaction.rate).toBeLessThan(1);
		});

		it('hard seeks for large drift', () => {
			source.time = 100;
			reaction.time = 132; // 2s ahead
			engine.controlLoop();
			expect(reaction.seekLog.at(-1)).toBeCloseTo(130);
		});

		it('does not seek repeatedly inside the cooldown', () => {
			source.time = 100;
			reaction.time = 132;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(1);

			clock = 100; // only 100ms later
			reaction.time = 132;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(1);

			clock = 1000; // past the 750ms cooldown
			reaction.time = 132;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(2);
		});

		it('does not correct a buffering follower', () => {
			source.time = 100;
			reaction.time = 0;
			reaction.buffering = true;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
			expect(reaction.rateLog).toHaveLength(0);
		});

		it('converges immediately after an explicit offset change', () => {
			source.time = 100;
			reaction.time = 130;
			engine.setOffset('reaction', 31_000);
			expect(reaction.seekLog.at(-1)).toBeCloseTo(131);
		});
	});

	describe('capability respect', () => {
		it('does not seek a provider that cannot seek', () => {
			engine.destroy();
			engine = new SyncEngine({ now: () => clock });
			setup({ canSeek: false });
			source.time = 100;
			reaction.time = 0;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
		});

		it('does not set rate on a provider that cannot change rate', () => {
			engine.destroy();
			engine = new SyncEngine({ now: () => clock });
			setup({ canSetRate: false });
			source.time = 100;
			reaction.time = 130.1;
			engine.controlLoop();
			expect(reaction.rateLog).toHaveLength(0);
		});

		it('skips a provider that cannot report time', () => {
			engine.destroy();
			engine = new SyncEngine({ now: () => clock });
			setup({ canReportTime: false });
			source.time = 100;
			reaction.time = 0;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
		});
	});

	describe('linked and unlinked modes', () => {
		it('does not correct followers when unlinked', () => {
			engine.setLinked(false);
			source.time = 100;
			reaction.time = 0;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
		});

		it('restores every base rate when unlinking', () => {
			source.time = 100;
			reaction.time = 130.1;
			engine.controlLoop();
			expect(reaction.rate).toBeLessThan(1);
			engine.setLinked(false);
			expect(reaction.rate).toBe(1);
		});

		it('re-syncs when linking again', () => {
			engine.setLinked(false);
			source.time = 100;
			reaction.time = 0;
			engine.setLinked(true);
			expect(reaction.seekLog.at(-1)).toBeCloseTo(130);
		});

		it('seeks only the targeted video when unlinked', () => {
			engine.setLinked(false);
			engine.seek(50, 'reaction');
			expect(reaction.time).toBe(50);
			expect(source.seekLog).toHaveLength(0);
		});
	});

	describe('transport and failure handling', () => {
		it('plays all videos when linked', async () => {
			await engine.play();
			expect(source.playCalls).toBe(1);
			expect(reaction.playCalls).toBe(1);
			expect(engine.getState().isPlaying).toBe(true);
		});

		it('reports autoplay rejection honestly and pauses the group', async () => {
			reaction.rejectPlay = true;
			await engine.play();
			const state = engine.getState();
			expect(state.isPlaying).toBe(false);
			expect(state.blockingReason?.kind).toBe('autoplay-rejected');
			expect(source.paused).toBe(true);
		});

		it('pauses the group when a follower stalls, so content is not missed', () => {
			source.paused = false;
			reaction.setBuffering(true);
			expect(source.paused).toBe(true);
			expect(engine.getState().blockingReason?.kind).toBe('buffering');
		});

		it('clears the buffering notice when the follower recovers', () => {
			reaction.setBuffering(true);
			reaction.setBuffering(false);
			expect(engine.getState().blockingReason).toBeNull();
		});

		it('pauses the group when the master ends', () => {
			source.paused = false;
			reaction.paused = false;
			source.setEnded(true);
			expect(reaction.paused).toBe(true);
			expect(engine.getState().isPlaying).toBe(false);
		});

		it('surfaces a media error with a readable message', () => {
			reaction.emit('error');
			const reason = engine.getState().blockingReason;
			expect(reason?.kind).toBe('error');
			if (reason?.kind === 'error') expect(reason.message).toMatch(/could not be played/i);
		});

		it('refuses an out-of-range seek rather than clamping to zero', () => {
			engine.seek(-10);
			expect(source.seekLog).toHaveLength(0);
			engine.seek(10_000);
			expect(source.seekLog).toHaveLength(0);
		});

		it('propagates a rate change to all videos when linked', () => {
			engine.setRate(1.5);
			expect(source.rate).toBe(1.5);
			expect(reaction.rate).toBe(1.5);
		});
	});

	describe('audio independence', () => {
		it('keeps the audio source separate from the clock master', () => {
			engine.setMaster('source');
			engine.setAudioSource('reaction');
			expect(engine.getMasterId()).toBe('source');
			expect(engine.getAudioSourceId()).toBe('reaction');
			expect(reaction.muted).toBe(false);
			expect(source.muted).toBe(true);
		});

		it('changes audio source without moving the clock master', () => {
			engine.setAudioSource('reaction');
			engine.setAudioSource('source');
			expect(engine.getMasterId()).toBe('source');
			expect(source.muted).toBe(false);
			expect(reaction.muted).toBe(true);
		});

		it('supports independent volume per video', () => {
			engine.setVolume('source', 0.4);
			engine.setVolume('reaction', 0.9);
			expect(source.volume).toBeCloseTo(0.4);
			expect(reaction.volume).toBeCloseTo(0.9);
		});
	});

	describe('tap to align', () => {
		it('derives the offset from current positions', () => {
			source.time = 12;
			reaction.time = 42;
			const offset = engine.alignToCurrentPositions('reaction');
			expect(offset).toBe(30_000);
			expect(engine.getOffset('reaction')).toBe(30_000);
		});

		it('refuses to align the master against itself', () => {
			expect(engine.alignToCurrentPositions('source')).toBeNull();
		});
	});

	describe('more than two videos', () => {
		it('corrects every follower without a hardcoded maximum', () => {
			const third = new FakeAdapter('third');
			const fourth = new FakeAdapter('fourth');
			engine.addVideo({ id: 'third', adapter: third, offsetMs: 5_000, baseRate: 1 });
			engine.addVideo({ id: 'fourth', adapter: fourth, offsetMs: -5_000, baseRate: 1 });

			source.time = 100;
			third.time = 0;
			fourth.time = 0;
			engine.controlLoop();

			expect(reaction.seekLog.at(-1)).toBeCloseTo(130);
			expect(third.seekLog.at(-1)).toBeCloseTo(105);
			expect(fourth.seekLog.at(-1)).toBeCloseTo(95);
		});

		it('promotes a new master when the master is removed', () => {
			engine.removeVideo('source');
			expect(engine.getMasterId()).toBe('reaction');
			expect(engine.getOffset('reaction')).toBe(0);
		});
	});

	describe('frame observation fallback', () => {
		it('records whether observations were frame-accurate', () => {
			source.advance(0.04, false);
			engine.controlLoop();
			const diagnostic = engine.getState().followers.find((f) => f.id === 'reaction');
			expect(diagnostic?.frameAccurate).toBe(false);
		});

		it('uses observed frame timing for frame stepping when available', () => {
			reaction.frameDurationMs = 41.7;
			reaction.time = 100;
			engine.frameStep(1, 'reaction');
			expect(reaction.time).toBeCloseTo(100.0417, 4);
		});

		it('falls back to assumed timing when frame duration is unknown', () => {
			reaction.time = 100;
			engine.frameStep(1, 'reaction');
			expect(reaction.time).toBeGreaterThan(100);
			expect(reaction.time).toBeLessThan(100.05);
		});
	});

	describe('lifecycle', () => {
		it('stops correcting after destroy', () => {
			engine.destroy();
			source.time = 100;
			reaction.time = 0;
			engine.controlLoop();
			expect(reaction.seekLog).toHaveLength(0);
		});
	});
});
