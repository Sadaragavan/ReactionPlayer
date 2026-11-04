/**
 * Player controller: owns media adapters and the sync engine, and bridges them to the
 * session store.
 *
 * Kept separate from components so playback logic is testable and so video elements are
 * never remounted when layout or linked state changes (PROJECT_BRIEF.md §15).
 */

import { SvelteMap } from 'svelte/reactivity';
import { SyncEngine, type EngineState } from '$lib/sync/engine';
import { Html5VideoAdapter } from '$lib/media/providers/html5-video';
import { sessionStore } from './session-store.svelte';
import { toastStore } from './toast-store.svelte';
import type { SessionVideo } from '$lib/contracts/session';
import { syncPolicy } from '$lib/config/policy';

export class PlayerController {
	engine: SyncEngine;
	state = $state<EngineState>({
		masterId: null,
		isLinked: true,
		isPlaying: false,
		followers: [],
		blockingReason: null
	});
	/** Mirrors media time for the scrubbers without forcing a full engine publish. */
	masterTimeSeconds = $state(0);
	masterDurationSeconds = $state<number | null>(null);
	videoTimes = $state<Record<string, number>>({});

	private adapters = new SvelteMap<string, Html5VideoAdapter>();
	private elements = new SvelteMap<string, HTMLVideoElement>();
	private timeTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.engine = new SyncEngine({
			onStateChange: (state) => {
				this.state = state;
			}
		});
	}

	/** Register a rendered <video> element for a session video. */
	async registerElement(video: SessionVideo, element: HTMLVideoElement): Promise<void> {
		if (this.elements.get(video.id) === element && this.adapters.has(video.id)) return;

		this.unregister(video.id);
		this.elements.set(video.id, element);

		const adapter = new Html5VideoAdapter(
			video.id,
			video.media.provider === 'direct-url' ? 'direct-url' : 'local-file'
		);
		this.adapters.set(video.id, adapter);
		await adapter.attach(element);

		if (video.media.playbackUrl) {
			if (video.media.provider === 'local-file') {
				element.src = video.media.playbackUrl;
			} else if (video.media.sourceUrl) {
				adapter.loadUrl(video.media.sourceUrl);
			}
			element.load();
		}

		adapter.setVolume(video.volume);
		adapter.setMuted(video.muted);

		this.engine.addVideo({
			id: video.id,
			adapter,
			offsetMs: video.offsetMs,
			baseRate: video.playbackRate
		});

		// Restore the saved position once metadata is available.
		const onLoaded = () => {
			const duration = adapter.getDurationSeconds();
			sessionStore.updateVideo(video.id, { durationSeconds: duration });
			if (video.currentTimeSeconds > 0) {
				const target = Math.min(
					video.currentTimeSeconds,
					Math.max(0, (duration ?? video.currentTimeSeconds) - 0.1)
				);
				adapter.seek(target);
			}
		};
		if (element.readyState >= 1) onLoaded();
		else element.addEventListener('loadedmetadata', onLoaded, { once: true });

		this.ensureTimePolling();
	}

	unregister(id: string): void {
		this.engine.removeVideo(id);
		this.adapters.get(id)?.dispose();
		this.adapters.delete(id);
		this.elements.delete(id);
	}

	getAdapter(id: string): Html5VideoAdapter | undefined {
		return this.adapters.get(id);
	}

	getElement(id: string): HTMLVideoElement | undefined {
		return this.elements.get(id);
	}

	/** Load a runtime File into an already-registered element. */
	loadFile(id: string, file: File): string | null {
		const adapter = this.adapters.get(id);
		const element = this.elements.get(id);
		if (!adapter || !element) return null;
		const url = adapter.loadFile(file);
		return url;
	}

	/**
	 * Poll media time for the UI. The engine's own control loop is driven by rVFC
	 * observations; this timer only updates displayed positions and persists progress.
	 */
	private ensureTimePolling(): void {
		if (this.timeTimer) return;
		this.timeTimer = setInterval(() => {
			this.masterTimeSeconds = this.engine.getMasterTimeSeconds();
			this.masterDurationSeconds = this.engine.getMasterDurationSeconds();
			const times: Record<string, number> = {};
			for (const [id, adapter] of this.adapters) {
				times[id] = adapter.getTimeSeconds();
			}
			this.videoTimes = times;
		}, 200);
	}

	/** Copy engine-owned values back into the session before saving. */
	syncToStore(): void {
		for (const [id, adapter] of this.adapters) {
			const video = sessionStore.current.videos.find((v) => v.id === id);
			if (!video) continue;
			sessionStore.updateVideo(id, {
				currentTimeSeconds: adapter.getTimeSeconds(),
				durationSeconds: adapter.getDurationSeconds(),
				offsetMs: this.engine.getOffset(id),
				volume: this.elements.get(id)?.volume ?? video.volume,
				muted: this.elements.get(id)?.muted ?? video.muted
			});
		}
		const masterId = this.engine.getMasterId();
		if (masterId && masterId !== sessionStore.current.masterVideoId) {
			sessionStore.current.masterVideoId = masterId;
		}
		sessionStore.current.isLinked = this.engine.isLinked();
	}

	async togglePlay(): Promise<void> {
		await this.engine.togglePlay();
		const reason = this.state.blockingReason;
		if (reason?.kind === 'autoplay-rejected') {
			toastStore.show(reason.message, { kind: 'warning' });
		}
	}

	setLinked(linked: boolean): void {
		this.engine.setLinked(linked);
		sessionStore.setLinked(linked);
	}

	setMaster(id: string): void {
		this.engine.setMaster(id);
		const offsets = new SvelteMap(
			sessionStore.current.videos.map((v) => [v.id, this.engine.getOffset(v.id)])
		);
		sessionStore.setMaster(id, offsets);
	}

	setAudioSource(id: string): void {
		this.engine.setAudioSource(id);
		sessionStore.setAudioSource(id);
		for (const video of sessionStore.current.videos) {
			sessionStore.updateVideo(video.id, { muted: video.id !== id });
		}
	}

	setOffset(id: string, offsetMs: number): void {
		this.engine.setOffset(id, offsetMs);
		sessionStore.updateVideo(id, { offsetMs: this.engine.getOffset(id) });
	}

	nudgeOffset(id: string, deltaMs: number): void {
		this.engine.nudgeOffset(id, deltaMs);
		sessionStore.updateVideo(id, { offsetMs: this.engine.getOffset(id) });
	}

	alignToCurrent(id: string): void {
		const offset = this.engine.alignToCurrentPositions(id);
		if (offset === null) {
			toastStore.show('Choose the master video first, then align the other one.', {
				kind: 'info'
			});
			return;
		}
		sessionStore.updateVideo(id, { offsetMs: offset });
		toastStore.show(`Aligned. Offset set to ${(offset / 1000).toFixed(2)}s.`, { kind: 'success' });
	}

	/**
	 * Copy the current frame to the clipboard where permitted.
	 * Degrades gracefully for cross-origin/tainted canvases (brief §3).
	 */
	async copyFrame(id: string): Promise<void> {
		const adapter = this.adapters.get(id);
		if (!adapter) return;
		const canvas = await adapter.captureFrame();
		if (!canvas) {
			toastStore.show(
				'This frame cannot be captured. Cross-origin video blocks canvas access.',
				{ kind: 'warning' }
			);
			return;
		}
		try {
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, 'image/png')
			);
			if (!blob) throw new Error('Encoding failed');
			if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
				throw new Error('Clipboard images unsupported');
			}
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			toastStore.show('Frame copied to clipboard.', { kind: 'success' });
		} catch {
			toastStore.show(
				'Your browser blocked writing an image to the clipboard. The frame was captured but could not be copied.',
				{ kind: 'warning' }
			);
		}
	}

	async save(): Promise<boolean> {
		this.syncToStore();
		return await sessionStore.save();
	}

	destroy(): void {
		if (this.timeTimer) {
			clearInterval(this.timeTimer);
			this.timeTimer = null;
		}
		for (const id of [...this.adapters.keys()]) this.unregister(id);
		this.engine.destroy();
	}
}

export { syncPolicy };
