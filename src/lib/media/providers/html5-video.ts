/**
 * Native HTML5 video adapter (PROJECT_BRIEF.md §3).
 *
 * Used for local files and authorized direct media URLs. Normal playback goes straight
 * through the video element — NOT through Canvas — because Canvas re-rendering costs
 * performance and provides no synchronization benefit.
 *
 * Canvas is used only for permitted snapshots/thumbnails, and capture failures (tainted
 * cross-origin canvas) degrade gracefully rather than throwing.
 */

import type { MediaAdapter, MediaEventKind, MediaTimeObservation } from '../provider';
import type { ProviderCapabilities } from '../../contracts/media';
import { LOCAL_FILE_CAPABILITIES, DIRECT_URL_CAPABILITIES } from '../../contracts/media';
import { syncPolicy } from '../../config/policy';

type RVFCVideo = HTMLVideoElement & {
	requestVideoFrameCallback?: (
		callback: (now: number, metadata: { mediaTime: number; presentationTime: number }) => void
	) => number;
	cancelVideoFrameCallback?: (handle: number) => void;
};

export class Html5VideoAdapter implements MediaAdapter {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;

	private element: RVFCVideo | null = null;
	private objectUrl: string | null = null;
	private readonly listeners = new Map<MediaEventKind, Set<() => void>>();
	private readonly boundHandlers = new Map<MediaEventKind, () => void>();
	private waiting = false;
	private lastFrameMediaTime: number | null = null;
	private observedFrameDurationMs: number | null = null;
	private disposed = false;
	/** Set while the engine itself is seeking, so feedback loops can be suppressed. */
	private engineInitiatedSeek = false;

	constructor(id: string, kind: 'local-file' | 'direct-url' = 'local-file') {
		this.id = id;
		this.capabilities = kind === 'local-file' ? LOCAL_FILE_CAPABILITIES : DIRECT_URL_CAPABILITIES;
	}

	async attach(target: HTMLVideoElement): Promise<void> {
		if (this.element === target) return;
		this.detach();
		this.element = target as RVFCVideo;
		this.bindEvents();
	}

	detach(): void {
		for (const [event, handler] of this.boundHandlers) {
			this.element?.removeEventListener(event, handler);
		}
		this.boundHandlers.clear();
		this.element = null;
	}

	private bindEvents(): void {
		const el = this.element;
		if (!el) return;
		const events: MediaEventKind[] = [
			'play',
			'pause',
			'seeking',
			'seeked',
			'waiting',
			'playing',
			'ended',
			'ratechange',
			'durationchange',
			'error',
			'timeupdate'
		];
		for (const event of events) {
			const handler = () => {
				if (event === 'waiting') this.waiting = true;
				if (event === 'playing' || event === 'seeked') this.waiting = false;
				if (event === 'seeked') this.engineInitiatedSeek = false;
				this.emit(event);
			};
			this.boundHandlers.set(event, handler);
			el.addEventListener(event, handler);
		}
	}

	private emit(event: MediaEventKind): void {
		for (const handler of this.listeners.get(event) ?? []) handler();
	}

	on(event: MediaEventKind, handler: () => void): () => void {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(handler);
		return () => this.listeners.get(event)?.delete(handler);
	}

	/** Load a local File, creating a runtime object URL owned by this adapter. */
	loadFile(file: File): string {
		this.revokeObjectUrl();
		this.objectUrl = URL.createObjectURL(file);
		if (this.element) {
			this.element.src = this.objectUrl;
			this.element.load();
		}
		return this.objectUrl;
	}

	/** Load an authorized URL exactly as supplied — no parameter stripping (§3). */
	loadUrl(url: string): void {
		this.revokeObjectUrl();
		if (this.element) {
			this.element.src = url;
			this.element.load();
		}
	}

	get src(): string | null {
		return this.element?.src ?? null;
	}

	async play(): Promise<void> {
		if (!this.element) return;
		// Autoplay rejection is surfaced to the caller rather than swallowed, so the UI can
		// explain that a user gesture is required (§3).
		await this.element.play();
	}

	pause(): void {
		this.element?.pause();
	}

	seek(seconds: number): void {
		if (!this.element || !Number.isFinite(seconds)) return;
		this.engineInitiatedSeek = true;
		try {
			this.element.currentTime = seconds;
		} catch {
			// Invalid seek range (e.g. before metadata). The engine retries on the next tick.
			this.engineInitiatedSeek = false;
		}
	}

	/** True when the most recent seek was engine-initiated (feedback-loop suppression). */
	get isEngineSeeking(): boolean {
		return this.engineInitiatedSeek;
	}

	setRate(rate: number): void {
		if (!this.element || !this.capabilities.canSetRate) return;
		if (!Number.isFinite(rate) || rate <= 0) return;
		// Avoid redundant writes: assigning an identical rate still fires ratechange in
		// some browsers, which would feed back into the control loop.
		if (Math.abs(this.element.playbackRate - rate) < 0.001) return;
		this.element.playbackRate = rate;
	}

	setVolume(volume: number): void {
		if (!this.element) return;
		this.element.volume = Math.min(1, Math.max(0, volume));
	}

	setMuted(muted: boolean): void {
		if (this.element) this.element.muted = muted;
	}

	getTimeSeconds(): number {
		return this.element?.currentTime ?? 0;
	}

	getDurationSeconds(): number | null {
		const duration = this.element?.duration;
		if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return null;
		return duration;
	}

	isPaused(): boolean {
		return this.element?.paused ?? true;
	}

	isBuffering(): boolean {
		if (!this.element) return false;
		// HAVE_CURRENT_DATA (2) or lower means not enough data to advance.
		return this.waiting || this.element.readyState < 3;
	}

	isEnded(): boolean {
		return this.element?.ended ?? false;
	}

	getRate(): number {
		return this.element?.playbackRate ?? 1;
	}

	get frameDurationMs(): number | null {
		return this.observedFrameDurationMs;
	}

	observe(callback: (observation: MediaTimeObservation) => void): () => void {
		const el = this.element;
		if (!el) return () => {};

		let cancelled = false;
		let rvfcHandle: number | null = null;
		let timer: ReturnType<typeof setInterval> | null = null;

		const emitObservation = (
			mediaTimeSeconds: number,
			presentationTimeMs: number,
			frameAccurate: boolean
		) => {
			let frameDurationMs: number | null = null;
			if (this.lastFrameMediaTime !== null) {
				const delta = (mediaTimeSeconds - this.lastFrameMediaTime) * 1000;
				// Only accept plausible forward deltas as frame timing; seeks and stalls
				// produce large or negative jumps that would corrupt frame-step estimates.
				if (delta > 1 && delta < 250) {
					frameDurationMs = delta;
					// Smooth the estimate to reduce jitter.
					this.observedFrameDurationMs =
						this.observedFrameDurationMs === null
							? delta
							: this.observedFrameDurationMs * 0.8 + delta * 0.2;
				}
			}
			this.lastFrameMediaTime = mediaTimeSeconds;
			callback({
				mediaTimeSeconds,
				presentationTimeMs,
				frameDurationMs,
				frameAccurate
			});
		};

		if (typeof el.requestVideoFrameCallback === 'function') {
			const tick = (now: number, metadata: { mediaTime: number }) => {
				if (cancelled || this.disposed) return;
				emitObservation(metadata.mediaTime, now, true);
				rvfcHandle = el.requestVideoFrameCallback!(tick);
			};
			rvfcHandle = el.requestVideoFrameCallback(tick);
		} else {
			// Fallback: rVFC is unavailable (e.g. Safari/Firefox at time of writing).
			// Precision is lower; the engine's tolerances account for this.
			timer = setInterval(() => {
				if (cancelled || this.disposed) return;
				emitObservation(el.currentTime, performance.now(), false);
			}, syncPolicy.fallbackPollIntervalMs);
		}

		return () => {
			cancelled = true;
			if (rvfcHandle !== null && typeof el.cancelVideoFrameCallback === 'function') {
				el.cancelVideoFrameCallback(rvfcHandle);
			}
			if (timer !== null) clearInterval(timer);
		};
	}

	async captureFrame(): Promise<HTMLCanvasElement | null> {
		const el = this.element;
		if (!el || el.readyState < 2 || el.videoWidth === 0) return null;
		try {
			const canvas = document.createElement('canvas');
			canvas.width = el.videoWidth;
			canvas.height = el.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
			// Reading a pixel forces the taint check. Cross-origin media without CORS
			// plays fine but throws here — that is expected and handled, not an error (§3).
			ctx.getImageData(0, 0, 1, 1);
			return canvas;
		} catch {
			return null;
		}
	}

	private revokeObjectUrl(): void {
		if (this.objectUrl) {
			URL.revokeObjectURL(this.objectUrl);
			this.objectUrl = null;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.detach();
		this.revokeObjectUrl();
		this.listeners.clear();
	}
}
