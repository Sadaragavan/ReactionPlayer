/**
 * Media provider adapter boundary (PROJECT_BRIEF.md §3).
 *
 * Every provider exposes explicit capabilities. The sync engine only uses operations the
 * adapter declares, so a provider that cannot change rate is simply excluded from rate
 * nudging rather than silently failing.
 *
 * Time is SECONDS throughout this interface, matching browser media APIs. Domain offsets
 * are MILLISECONDS and are converted at the boundary by the sync engine.
 */

import type { ProviderCapabilities } from '../contracts/media';

export interface MediaTimeObservation {
	/** Media position in seconds. */
	readonly mediaTimeSeconds: number;
	/** High-resolution timestamp when the frame was presented, if available. */
	readonly presentationTimeMs: number;
	/** Duration between presented frames, when the provider can report it. */
	readonly frameDurationMs: number | null;
	/** Whether this observation came from requestVideoFrameCallback. */
	readonly frameAccurate: boolean;
}

export type MediaEventKind =
	| 'play'
	| 'pause'
	| 'seeking'
	| 'seeked'
	| 'waiting'
	| 'playing'
	| 'ended'
	| 'ratechange'
	| 'durationchange'
	| 'error'
	| 'timeupdate';

export interface MediaAdapter {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;

	/** Attach to a rendered element/container. Idempotent. */
	attach(target: HTMLVideoElement): Promise<void>;
	detach(): void;

	play(): Promise<void>;
	pause(): void;
	seek(seconds: number): void;
	setRate(rate: number): void;
	setVolume(volume: number): void;
	setMuted(muted: boolean): void;

	getTimeSeconds(): number;
	getDurationSeconds(): number | null;
	isPaused(): boolean;
	isBuffering(): boolean;
	isEnded(): boolean;
	getRate(): number;

	/**
	 * Observe playback progress. Uses requestVideoFrameCallback where available and falls
	 * back to a timer otherwise. Returns an unsubscribe function.
	 *
	 * rVFC improves observation granularity; it does NOT guarantee frame-perfect or
	 * zero-lag synchronization.
	 */
	observe(callback: (observation: MediaTimeObservation) => void): () => void;

	on(event: MediaEventKind, handler: () => void): () => void;

	/**
	 * Capture the current frame to a canvas, where permitted.
	 * Returns null when unsupported or blocked (e.g. tainted cross-origin canvas).
	 * Never throws for a capability failure — callers degrade gracefully.
	 */
	captureFrame(): Promise<HTMLCanvasElement | null>;

	/** Best-effort cleanup of runtime resources (object URLs, listeners). */
	dispose(): void;
}

/** Capability probe results that can only be determined at runtime. */
export interface RuntimeCapabilities {
	readonly requestVideoFrameCallback: boolean;
	readonly clipboardWriteImage: boolean;
	readonly fileSystemAccess: boolean;
	readonly documentPictureInPicture: boolean;
	readonly elementPictureInPicture: boolean;
}

export function probeRuntimeCapabilities(): RuntimeCapabilities {
	if (typeof window === 'undefined') {
		return {
			requestVideoFrameCallback: false,
			clipboardWriteImage: false,
			fileSystemAccess: false,
			documentPictureInPicture: false,
			elementPictureInPicture: false
		};
	}
	const video = document.createElement('video');
	return {
		requestVideoFrameCallback: 'requestVideoFrameCallback' in video,
		clipboardWriteImage:
			typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined',
		fileSystemAccess: 'showOpenFilePicker' in window,
		documentPictureInPicture: 'documentPictureInPicture' in window,
		elementPictureInPicture: Boolean(document.pictureInPictureEnabled)
	};
}
