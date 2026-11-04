/**
 * Deterministic fake media adapter for engine tests.
 *
 * Simulates the parts of HTMLMediaElement the engine depends on, including buffering,
 * ended state, autoplay rejection and capability restrictions, without a browser.
 */

import type { MediaAdapter, MediaEventKind, MediaTimeObservation } from '../../src/lib/media/provider';
import type { ProviderCapabilities } from '../../src/lib/contracts/media';
import { LOCAL_FILE_CAPABILITIES } from '../../src/lib/contracts/media';

export class FakeAdapter implements MediaAdapter {
	readonly id: string;
	capabilities: ProviderCapabilities;

	time = 0;
	duration: number | null = 600;
	rate = 1;
	volume = 1;
	muted = false;
	paused = true;
	buffering = false;
	ended = false;
	frameDurationMs: number | null = null;

	/** Force play() to reject, simulating an autoplay policy block. */
	rejectPlay = false;
	/** Record every operation so tests can assert on engine behaviour. */
	readonly seekLog: number[] = [];
	readonly rateLog: number[] = [];
	playCalls = 0;
	pauseCalls = 0;
	captureResult: HTMLCanvasElement | null = null;

	private readonly handlers = new Map<MediaEventKind, Set<() => void>>();
	private observers: Array<(o: MediaTimeObservation) => void> = [];

	constructor(id: string, capabilities: Partial<ProviderCapabilities> = {}) {
		this.id = id;
		this.capabilities = { ...LOCAL_FILE_CAPABILITIES, ...capabilities };
	}

	async attach(): Promise<void> {}
	detach(): void {}

	async play(): Promise<void> {
		this.playCalls++;
		if (this.rejectPlay) {
			throw new DOMException('play() failed: user gesture required', 'NotAllowedError');
		}
		this.paused = false;
		this.emit('play');
	}

	pause(): void {
		this.pauseCalls++;
		this.paused = true;
		this.emit('pause');
	}

	seek(seconds: number): void {
		this.seekLog.push(seconds);
		this.time = seconds;
		this.emit('seeking');
		this.emit('seeked');
	}

	setRate(rate: number): void {
		if (!this.capabilities.canSetRate) return;
		if (Math.abs(this.rate - rate) < 0.001) return;
		this.rateLog.push(rate);
		this.rate = rate;
		this.emit('ratechange');
	}

	setVolume(volume: number): void {
		this.volume = volume;
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
	}

	getTimeSeconds(): number {
		return this.time;
	}

	getDurationSeconds(): number | null {
		return this.duration;
	}

	isPaused(): boolean {
		return this.paused;
	}

	isBuffering(): boolean {
		return this.buffering;
	}

	isEnded(): boolean {
		return this.ended;
	}

	getRate(): number {
		return this.rate;
	}

	observe(callback: (o: MediaTimeObservation) => void): () => void {
		this.observers.push(callback);
		return () => {
			this.observers = this.observers.filter((o) => o !== callback);
		};
	}

	on(event: MediaEventKind, handler: () => void): () => void {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		this.handlers.get(event)!.add(handler);
		return () => this.handlers.get(event)?.delete(handler);
	}

	async captureFrame(): Promise<HTMLCanvasElement | null> {
		return this.captureResult;
	}

	dispose(): void {
		this.handlers.clear();
		this.observers = [];
	}

	// --- Test controls ---

	emit(event: MediaEventKind): void {
		for (const handler of this.handlers.get(event) ?? []) handler();
	}

	/** Advance media time and notify observers, as a real element would. */
	advance(seconds: number, frameAccurate = true): void {
		this.time += seconds;
		for (const observer of this.observers) {
			observer({
				mediaTimeSeconds: this.time,
				presentationTimeMs: 0,
				frameDurationMs: this.frameDurationMs,
				frameAccurate
			});
		}
	}

	setBuffering(value: boolean): void {
		this.buffering = value;
		this.emit(value ? 'waiting' : 'playing');
	}

	setEnded(value: boolean): void {
		this.ended = value;
		if (value) this.emit('ended');
	}
}
