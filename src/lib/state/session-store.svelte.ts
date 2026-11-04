/**
 * Session store (PROJECT_BRIEF.md §4) using Svelte 5 runes.
 *
 * This is CLIENT state. It holds no authority: `tier` and pass usage are mirrors of
 * server-issued values and are never used to grant access locally.
 *
 * Per-user state lives here, in the browser — never in server module globals.
 */

import type {
	Session,
	SessionVideo,
	LayoutType,
	ViewportCoordinates,
	VideoRole
} from '../contracts/session';
import { SESSION_SCHEMA_VERSION, defaultCoordinates, pipCoordinates } from '../contracts/session';
import type { MediaReference } from '../contracts/media';
import { saveSession } from '../persistence/sessions';
import { passPolicy } from '../config/policy';

export interface PassUsageView {
	readonly baseUsed: number;
	readonly baseCapacity: number;
	readonly bonusUsed: number;
	readonly bonusCapacity: number;
	readonly nextAvailableAt: string | null;
	readonly tier: 'free' | 'pro';
	readonly videoLimit: number;
}

const DEFAULT_USAGE: PassUsageView = {
	baseUsed: 0,
	baseCapacity: passPolicy.basePassesPerWindow,
	bonusUsed: 0,
	bonusCapacity: 0,
	nextAvailableAt: null,
	tier: 'free',
	videoLimit: passPolicy.freeTierVideoLimit
};

function createSessionId(): string {
	return crypto.randomUUID();
}

export function createEmptySession(name = 'Untitled session'): Session {
	const now = Date.now();
	return {
		id: createSessionId(),
		schemaVersion: SESSION_SCHEMA_VERSION,
		name,
		lastModifiedMs: now,
		updatedAtMs: now,
		createdAtMs: now,
		videos: [],
		alignment: { layoutType: 'split', locked: false, coordinates: {} },
		isLinked: true,
		isTheaterMode: false,
		masterVideoId: null,
		audioSourceVideoId: null,
		passId: null
	};
}

export function createSessionVideo(params: {
	role: VideoRole;
	title: string;
	media: MediaReference;
	index: number;
	layout: LayoutType;
}): SessionVideo {
	return {
		id: crypto.randomUUID(),
		role: params.role,
		title: params.title,
		media: params.media,
		currentTimeSeconds: 0,
		durationSeconds: null,
		volume: 1,
		muted: params.role === 'source',
		playbackRate: 1,
		offsetMs: 0,
		logicalId: null,
		sourceVersionId: null,
		identityConfidence: 'unresolved'
	};
}

class SessionStore {
	current = $state<Session>(createEmptySession());
	usage = $state<PassUsageView>(DEFAULT_USAGE);
	isSaving = $state(false);
	lastSavedAtMs = $state<number | null>(null);
	/** Non-fatal notices for the UI (e.g. permission or capability degradations). */
	notice = $state<string | null>(null);

	readonly videoLimit = $derived(this.usage.videoLimit);
	readonly canAddVideo = $derived(this.current.videos.length < this.videoLimit);
	readonly hasSource = $derived(this.current.videos.some((v) => v.role === 'source'));
	readonly hasReaction = $derived(this.current.videos.some((v) => v.role === 'reaction'));
	readonly isReadyToSync = $derived(this.current.videos.length >= 2 && this.current.passId !== null);

	addVideo(video: SessionVideo): boolean {
		if (this.current.videos.length >= this.videoLimit) {
			this.notice =
				this.usage.tier === 'pro'
					? `This session already has ${this.videoLimit} videos.`
					: `Free sessions support ${this.videoLimit} videos. Pro supports more.`;
			return false;
		}
		const index = this.current.videos.length;
		const coordinates =
			this.current.alignment.layoutType === 'pip' ? pipCoordinates(index) : defaultCoordinates(index);

		this.current.videos.push(video);
		this.current.alignment.coordinates[video.id] = coordinates;
		if (!this.current.masterVideoId) this.current.masterVideoId = video.id;
		if (!this.current.audioSourceVideoId) {
			this.current.audioSourceVideoId =
				this.current.videos.find((v) => v.role === 'reaction')?.id ?? video.id;
		}
		this.touch();
		return true;
	}

	removeVideo(id: string): void {
		this.current.videos = this.current.videos.filter((v) => v.id !== id);
		delete this.current.alignment.coordinates[id];
		if (this.current.masterVideoId === id) {
			this.current.masterVideoId = this.current.videos[0]?.id ?? null;
		}
		if (this.current.audioSourceVideoId === id) {
			this.current.audioSourceVideoId = this.current.videos[0]?.id ?? null;
		}
		this.touch();
	}

	updateVideo(id: string, patch: Partial<SessionVideo>): void {
		const video = this.current.videos.find((v) => v.id === id);
		if (!video) return;
		Object.assign(video, patch);
		this.touch();
	}

	setLayout(layout: LayoutType): void {
		this.current.alignment.layoutType = layout;
		this.current.alignment.coordinates = {};
		this.current.videos.forEach((video, index) => {
			this.current.alignment.coordinates[video.id] =
				layout === 'pip' ? pipCoordinates(index) : defaultCoordinates(index);
		});
		this.touch();
	}

	setCoordinates(id: string, coordinates: ViewportCoordinates): void {
		// Locked layouts must not be draggable/resizable (§15).
		if (this.current.alignment.locked) return;
		this.current.alignment.coordinates[id] = coordinates;
		this.touch();
	}

	setLayoutLocked(locked: boolean): void {
		this.current.alignment.locked = locked;
		this.touch();
	}

	setLinked(linked: boolean): void {
		this.current.isLinked = linked;
		this.touch();
	}

	setTheaterMode(theater: boolean): void {
		this.current.isTheaterMode = theater;
		this.touch();
	}

	setMaster(id: string, offsets: Map<string, number>): void {
		this.current.masterVideoId = id;
		for (const [videoId, offsetMs] of offsets) {
			const video = this.current.videos.find((v) => v.id === videoId);
			if (video) video.offsetMs = offsetMs;
		}
		this.touch();
	}

	setAudioSource(id: string): void {
		this.current.audioSourceVideoId = id;
		this.touch();
	}

	setName(name: string): void {
		this.current.name = name.trim() || 'Untitled session';
		this.touch();
	}

	applyPass(passId: string, usage: PassUsageView): void {
		this.current.passId = passId;
		this.usage = usage;
		this.touch();
	}

	setUsage(usage: PassUsageView): void {
		this.usage = usage;
	}

	/** Replace the whole session (resume/load). */
	replace(session: Session): void {
		this.current = session;
		this.notice = null;
	}

	reset(): void {
		this.current = createEmptySession();
		this.lastSavedAtMs = null;
		this.notice = null;
	}

	async save(): Promise<boolean> {
		this.isSaving = true;
		try {
			await saveSession(this.current);
			this.lastSavedAtMs = Date.now();
			return true;
		} catch (error) {
			this.notice =
				'Could not save this session locally. Your browser may be blocking storage (private browsing).';
			console.warn('[session-store] save failed:', error);
			return false;
		} finally {
			this.isSaving = false;
		}
	}

	private touch(): void {
		this.current.lastModifiedMs = Date.now();
	}
}

export const sessionStore = new SessionStore();
