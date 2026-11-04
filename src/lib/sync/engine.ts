/**
 * Synchronization engine (PROJECT_BRIEF.md §3).
 *
 * MASTER CLOCK
 * ------------
 * One video is the master. Its `currentTime` (seconds) is the session timeline. Every
 * other video is a follower whose target position is:
 *
 *     targetSeconds = masterSeconds + follower.offsetMs / 1000
 *
 * A POSITIVE offset means the follower runs AHEAD of the master timeline. Example: a
 * reaction with a 30-second intro before the feature begins has offsetMs = +30000 relative
 * to a source master, so at source t=0 the reaction should be at t=30.
 *
 * The master is never rate-nudged or seeked by the engine; only followers are corrected.
 * This guarantees a single source of truth and prevents mutual chasing.
 *
 * AUDIO IS SEPARATE
 * -----------------
 * The master clock and the audio source are independent decisions. Making the source the
 * clock master does not force the source to be audible; `audioSourceId` is set separately.
 *
 * FEEDBACK LOOP PREVENTION
 * ------------------------
 *  - Only followers are corrected, never the master.
 *  - Rate writes are skipped when unchanged (adapter-level).
 *  - Hard seeks have a per-follower cooldown.
 *  - Engine-initiated seeks are tracked so the resulting `seeked` event does not trigger
 *    another correction.
 *  - No correction while a follower is buffering.
 *
 * HONEST LIMITATIONS
 * ------------------
 * requestVideoFrameCallback improves observation granularity but does not guarantee
 * frame-perfect or zero-lag sync. Drift correction is perceptual, not sample-exact.
 */

import type { MediaAdapter } from '../media/provider';
import { syncPolicy } from '../config/policy';
import {
	computeCorrection,
	targetSecondsFor,
	clampSeekSeconds,
	renormalizeOffsets,
	clampOffsetMs,
	offsetFromAlignment,
	type CorrectionAction
} from './math';

export interface EngineVideo {
	readonly id: string;
	readonly adapter: MediaAdapter;
	offsetMs: number;
	/** The user's chosen rate. Transient nudges are applied around this, never persisted. */
	baseRate: number;
}

export interface EngineState {
	readonly masterId: string | null;
	readonly isLinked: boolean;
	readonly isPlaying: boolean;
	/** Per-follower diagnostics for the HUD and for tests. */
	readonly followers: readonly FollowerDiagnostic[];
	readonly blockingReason: BlockingReason | null;
}

export interface FollowerDiagnostic {
	readonly id: string;
	readonly driftMs: number;
	readonly lastAction: CorrectionAction['kind'];
	readonly isBuffering: boolean;
	readonly frameAccurate: boolean;
}

export type BlockingReason =
	| { kind: 'autoplay-rejected'; message: string }
	| { kind: 'buffering'; videoId: string }
	| { kind: 'all-ended' }
	| { kind: 'error'; videoId: string; message: string };

export interface EngineOptions {
	readonly onStateChange?: (state: EngineState) => void;
	/** Injected for deterministic tests. */
	readonly now?: () => number;
	readonly policy?: typeof syncPolicy;
}

export class SyncEngine {
	private videos = new Map<string, EngineVideo>();
	private masterId: string | null = null;
	private audioSourceId: string | null = null;
	private linked = true;
	private playing = false;
	private blockingReason: BlockingReason | null = null;

	private readonly unobservers = new Map<string, () => void>();
	private readonly eventUnsubscribers = new Map<string, Array<() => void>>();
	private readonly lastSeekAtMs = new Map<string, number>();
	private readonly diagnostics = new Map<string, FollowerDiagnostic>();
	private readonly lastActions = new Map<string, CorrectionAction['kind']>();
	private readonly frameAccurate = new Map<string, boolean>();

	private readonly now: () => number;
	private readonly policy: typeof syncPolicy;
	private readonly onStateChange: ((state: EngineState) => void) | undefined;
	private destroyed = false;

	constructor(options: EngineOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.policy = options.policy ?? syncPolicy;
		this.onStateChange = options.onStateChange;
	}

	// -------------------------------------------------------------------------
	// Registration
	// -------------------------------------------------------------------------

	addVideo(video: EngineVideo): void {
		if (this.destroyed) return;
		this.videos.set(video.id, video);
		this.lastSeekAtMs.set(video.id, -Infinity);
		this.lastActions.set(video.id, 'none');

		this.unobservers.get(video.id)?.();
		const unobserve = video.adapter.observe((observation) => {
			this.frameAccurate.set(video.id, observation.frameAccurate);
			if (video.id === this.masterId) {
				// The master advanced: correct every follower against it.
				this.controlLoop();
				this.publish();
			}
		});
		this.unobservers.set(video.id, unobserve);

		const unsubscribers: Array<() => void> = [];
		unsubscribers.push(
			video.adapter.on('waiting', () => {
				if (this.linked && video.id !== this.masterId) {
					// A stalled follower would drift silently. Pause the group so the user
					// does not miss content, and surface why (§3).
					this.pauseAll();
					this.blockingReason = { kind: 'buffering', videoId: video.id };
					this.publish();
				}
			}),
			video.adapter.on('playing', () => {
				if (this.blockingReason?.kind === 'buffering' && this.blockingReason.videoId === video.id) {
					this.blockingReason = null;
					this.publish();
				}
			}),
			video.adapter.on('ended', () => {
				if (video.id === this.masterId) {
					this.pauseAll();
					if (this.allEnded()) this.blockingReason = { kind: 'all-ended' };
					this.publish();
				}
			}),
			video.adapter.on('error', () => {
				this.blockingReason = {
					kind: 'error',
					videoId: video.id,
					message: 'This video could not be played. Check the file or URL and try again.'
				};
				this.publish();
			}),
			video.adapter.on('seeked', () => {
				// A user seek on the master re-targets followers immediately.
				if (this.linked && video.id === this.masterId) this.controlLoop(true);
			}),
			video.adapter.on('durationchange', () => this.publish())
		);
		this.eventUnsubscribers.set(video.id, unsubscribers);

		if (!this.masterId) this.masterId = video.id;
		if (!this.audioSourceId) this.audioSourceId = video.id;
		this.publish();
	}

	removeVideo(id: string): void {
		this.unobservers.get(id)?.();
		this.unobservers.delete(id);
		for (const off of this.eventUnsubscribers.get(id) ?? []) off();
		this.eventUnsubscribers.delete(id);
		this.videos.delete(id);
		this.diagnostics.delete(id);
		this.lastSeekAtMs.delete(id);
		if (this.masterId === id) {
			const next = [...this.videos.keys()][0] ?? null;
			if (next) this.setMaster(next);
			else this.masterId = null;
		}
		if (this.audioSourceId === id) this.audioSourceId = [...this.videos.keys()][0] ?? null;
		this.publish();
	}

	// -------------------------------------------------------------------------
	// Master clock and audio (independent decisions)
	// -------------------------------------------------------------------------

	setMaster(id: string): void {
		if (!this.videos.has(id) || this.masterId === id) return;
		// Re-normalize offsets so relative alignment survives the master change.
		const offsets = renormalizeOffsets(
			[...this.videos.values()].map((v) => ({ id: v.id, offsetMs: v.offsetMs })),
			id
		);
		for (const [videoId, offset] of offsets) {
			const video = this.videos.get(videoId);
			if (video) video.offsetMs = offset;
		}
		this.masterId = id;
		// The new master must run at its base rate, not a leftover nudge.
		const master = this.videos.get(id);
		if (master) master.adapter.setRate(master.baseRate);
		if (this.linked) this.controlLoop(true);
		this.publish();
	}

	getMasterId(): string | null {
		return this.masterId;
	}

	/** Audio source is deliberately independent of the clock master (§3). */
	setAudioSource(id: string): void {
		if (!this.videos.has(id)) return;
		this.audioSourceId = id;
		for (const video of this.videos.values()) {
			video.adapter.setMuted(video.id !== id);
		}
		this.publish();
	}

	getAudioSourceId(): string | null {
		return this.audioSourceId;
	}

	// -------------------------------------------------------------------------
	// Linking
	// -------------------------------------------------------------------------

	setLinked(linked: boolean): void {
		this.linked = linked;
		if (linked) {
			this.controlLoop(true);
		} else {
			// Unlinked: every video returns to its own base rate and plays independently.
			for (const video of this.videos.values()) video.adapter.setRate(video.baseRate);
		}
		this.publish();
	}

	isLinked(): boolean {
		return this.linked;
	}

	// -------------------------------------------------------------------------
	// Offsets
	// -------------------------------------------------------------------------

	setOffset(id: string, offsetMs: number): void {
		const video = this.videos.get(id);
		if (!video) return;
		video.offsetMs = clampOffsetMs(offsetMs, this.policy);
		if (this.linked && id !== this.masterId) this.controlLoop(true);
		this.publish();
	}

	nudgeOffset(id: string, deltaMs: number): void {
		const video = this.videos.get(id);
		if (!video) return;
		this.setOffset(id, video.offsetMs + deltaMs);
	}

	/**
	 * "Tap to align": the user has positioned both videos on the same content moment.
	 * Derives the offset from the current positions.
	 */
	alignToCurrentPositions(followerId: string): number | null {
		const follower = this.videos.get(followerId);
		const master = this.masterId ? this.videos.get(this.masterId) : null;
		if (!follower || !master || followerId === this.masterId) return null;
		const offset = offsetFromAlignment(
			master.adapter.getTimeSeconds(),
			follower.adapter.getTimeSeconds()
		);
		this.setOffset(followerId, offset);
		return offset;
	}

	getOffset(id: string): number {
		return this.videos.get(id)?.offsetMs ?? 0;
	}

	// -------------------------------------------------------------------------
	// Transport
	// -------------------------------------------------------------------------

	async play(): Promise<void> {
		this.blockingReason = null;
		const targets = this.linked ? [...this.videos.values()] : [...this.videos.values()];
		if (this.linked) this.controlLoop(true);

		const results = await Promise.allSettled(targets.map((v) => v.adapter.play()));
		const rejected = results.find((r) => r.status === 'rejected');
		if (rejected && rejected.status === 'rejected') {
			// Autoplay policy rejected playback. Report honestly rather than pretending to
			// play; the UI asks for a user gesture (§3).
			this.playing = false;
			this.blockingReason = {
				kind: 'autoplay-rejected',
				message: 'Your browser blocked automatic playback. Press play to start.'
			};
			for (const video of targets) video.adapter.pause();
			this.publish();
			return;
		}
		this.playing = true;
		this.publish();
	}

	pause(): void {
		this.pauseAll();
		this.publish();
	}

	private pauseAll(): void {
		for (const video of this.videos.values()) video.adapter.pause();
		this.playing = false;
	}

	async togglePlay(): Promise<void> {
		if (this.playing) this.pause();
		else await this.play();
	}

	/** Seek the master timeline (linked) or one video (unlinked). */
	seek(seconds: number, videoId?: string): void {
		if (this.linked && !videoId) {
			const master = this.masterId ? this.videos.get(this.masterId) : null;
			if (!master) return;
			const clamped = clampSeekSeconds(seconds, master.adapter.getDurationSeconds());
			if (clamped === null) return;
			master.adapter.seek(clamped);
			this.controlLoop(true);
		} else {
			const target = this.videos.get(videoId ?? this.masterId ?? '');
			if (!target) return;
			const clamped = clampSeekSeconds(seconds, target.adapter.getDurationSeconds());
			if (clamped === null) return;
			target.adapter.seek(clamped);
		}
		this.publish();
	}

	seekBy(deltaSeconds: number, videoId?: string): void {
		const target = this.videos.get(videoId ?? this.masterId ?? '');
		if (!target) return;
		this.seek(target.adapter.getTimeSeconds() + deltaSeconds, videoId);
	}

	/**
	 * Approximate frame step. HTML5 has no universal exact frame-step API, so this uses
	 * observed or assumed frame timing. Callers must label it approximate (§3).
	 */
	frameStep(direction: 1 | -1, videoId?: string): void {
		const target = this.videos.get(videoId ?? this.masterId ?? '');
		if (!target) return;
		const adapter = target.adapter as MediaAdapter & { frameDurationMs?: number | null };
		const observed = adapter.frameDurationMs ?? null;
		const duration = observed && observed > 0 ? observed : this.policy.assumedFrameDurationMs;
		this.seek(target.adapter.getTimeSeconds() + (direction * duration) / 1000, videoId);
	}

	setRate(rate: number, videoId?: string): void {
		if (this.linked && !videoId) {
			for (const video of this.videos.values()) {
				video.baseRate = rate;
				video.adapter.setRate(rate);
			}
		} else {
			const target = this.videos.get(videoId ?? this.masterId ?? '');
			if (target) {
				target.baseRate = rate;
				target.adapter.setRate(rate);
			}
		}
		this.publish();
	}

	setVolume(id: string, volume: number): void {
		this.videos.get(id)?.adapter.setVolume(volume);
		this.publish();
	}

	setMuted(id: string, muted: boolean): void {
		this.videos.get(id)?.adapter.setMuted(muted);
		this.publish();
	}

	// -------------------------------------------------------------------------
	// Control loop
	// -------------------------------------------------------------------------

	/**
	 * Correct all followers against the master clock.
	 * `force` bypasses the tolerance deadband (used after explicit seeks/offset changes).
	 */
	controlLoop(force = false): void {
		if (!this.linked || this.destroyed) return;
		const master = this.masterId ? this.videos.get(this.masterId) : null;
		if (!master) return;

		const masterSeconds = master.adapter.getTimeSeconds();
		const nowMs = this.now();

		for (const video of this.videos.values()) {
			if (video.id === this.masterId) continue;
			if (!video.adapter.capabilities.canReportTime) continue;

			const target = targetSecondsFor(masterSeconds, video.offsetMs);
			const actual = video.adapter.getTimeSeconds();
			const buffering = video.adapter.isBuffering();

			let action: CorrectionAction = computeCorrection({
				actualSeconds: actual,
				targetSeconds: target,
				durationSeconds: video.adapter.getDurationSeconds(),
				baseRate: video.baseRate,
				isBuffering: buffering,
				lastSeekAtMs: this.lastSeekAtMs.get(video.id) ?? -Infinity,
				nowMs,
				policy: this.policy
			});

			if (force && action.kind === 'rate' && video.adapter.capabilities.canSeek) {
				// An explicit user action warrants immediate convergence.
				const clamped = clampSeekSeconds(target, video.adapter.getDurationSeconds());
				if (clamped !== null) action = { kind: 'seek', targetSeconds: clamped };
			}

			// Respect provider capabilities rather than assuming them.
			if (action.kind === 'seek' && !video.adapter.capabilities.canSeek) {
				action = { kind: 'none' };
			}
			if (action.kind === 'rate' && !video.adapter.capabilities.canSetRate) {
				action = { kind: 'none' };
			}

			if (action.kind === 'seek') {
				video.adapter.seek(action.targetSeconds);
				this.lastSeekAtMs.set(video.id, nowMs);
			} else if (action.kind === 'rate') {
				video.adapter.setRate(action.rate);
			}

			this.lastActions.set(video.id, action.kind);
			this.diagnostics.set(video.id, {
				id: video.id,
				driftMs: (actual - target) * 1000,
				lastAction: action.kind,
				isBuffering: buffering,
				frameAccurate: this.frameAccurate.get(video.id) ?? false
			});
		}
	}

	private allEnded(): boolean {
		if (this.videos.size === 0) return false;
		return [...this.videos.values()].every((v) => v.adapter.isEnded());
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	getState(): EngineState {
		return {
			masterId: this.masterId,
			isLinked: this.linked,
			isPlaying: this.playing,
			followers: [...this.diagnostics.values()],
			blockingReason: this.blockingReason
		};
	}

	getMasterTimeSeconds(): number {
		const master = this.masterId ? this.videos.get(this.masterId) : null;
		return master?.adapter.getTimeSeconds() ?? 0;
	}

	getMasterDurationSeconds(): number | null {
		const master = this.masterId ? this.videos.get(this.masterId) : null;
		return master?.adapter.getDurationSeconds() ?? null;
	}

	private publish(): void {
		this.onStateChange?.(this.getState());
	}

	destroy(): void {
		this.destroyed = true;
		for (const off of this.unobservers.values()) off();
		this.unobservers.clear();
		for (const list of this.eventUnsubscribers.values()) for (const off of list) off();
		this.eventUnsubscribers.clear();
		this.videos.clear();
		this.diagnostics.clear();
	}
}
