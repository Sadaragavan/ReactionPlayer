/**
 * Session state contracts (PROJECT_BRIEF.md §4).
 *
 * UNIT CONVENTIONS — enforced by property naming, never mixed silently:
 *   - Browser media APIs use SECONDS  -> `currentTimeSeconds`, `durationSeconds`
 *   - Domain offsets use MILLISECONDS -> `offsetMs`
 *   - Layout coordinates use NORMALIZED FRACTIONS of the stage (0..1), resolution independent
 *   - Crop uses NORMALIZED FRACTIONS of the source frame (0..1), inset from each edge
 *
 * Persisted shape is versioned. `SESSION_SCHEMA_VERSION` must be bumped with a migration
 * whenever the persisted shape changes incompatibly.
 */

import type { MediaReference, MatchConfidence } from './media';

export const SESSION_SCHEMA_VERSION = 1 as const;

export type VideoRole = 'source' | 'reaction';
export type LayoutType = 'split' | 'grid' | 'pip' | 'custom';

export interface SessionVideo {
	readonly id: string;
	readonly role: VideoRole;
	/** Replaceable on resume: the re-picked file may have a different name. */
	title: string;
	/** Runtime playback URL is attached here on load/resume; never persisted. */
	media: MediaReference;

	// --- Runtime playback state (seconds: browser media domain) ---
	currentTimeSeconds: number;
	durationSeconds: number | null;

	// --- Independent audio (never coupled to the sync clock) ---
	volume: number;
	muted: boolean;

	// --- Rate: base rate chosen by the user. The sync engine may apply a transient
	// nudge around this value; the nudge is NOT persisted as the user's base rate. ---
	playbackRate: number;

	/**
	 * Offset sign convention (fully documented in docs/SYNC.md):
	 *
	 *   targetTimeForThisVideo = masterClockSeconds + offsetMs / 1000
	 *
	 * A POSITIVE offset means this video runs AHEAD of the master timeline. A reaction with
	 * a 30-second intro before the feature starts has offsetMs = +30000 when the source is
	 * master. The master video's own offsetMs is always normalized to 0.
	 *
	 * Generalizes to N videos; changing master re-normalizes all offsets so the relative
	 * alignment is preserved.
	 */
	offsetMs: number;

	// --- Identity (optional until resolved) ---
	readonly logicalId: string | null;
	readonly sourceVersionId: string | null;
	readonly identityConfidence: MatchConfidence;
}

/** Normalized stage coordinates. Origin top-left. All values are fractions of the stage. */
export interface ViewportCoordinates {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Inset fractions of the source frame: 0 = no crop, 0.1 = trim 10% from that edge. */
	crop: { top: number; right: number; bottom: number; left: number };
	opacity: number;
	/** Stacking order for pip/custom layouts. */
	z: number;
}

export interface SessionAlignment {
	layoutType: LayoutType;
	/** Locked layouts (from presets/saved sessions) must not be draggable/resizable. */
	locked: boolean;
	/** Keyed by viewport (video) id. */
	coordinates: Record<string, ViewportCoordinates>;
}

export interface Session {
	readonly id: string;
	readonly schemaVersion: number;
	name: string;
	/** Client-side epoch ms; server timestamps are authoritative for anything metered. */
	lastModifiedMs: number;
	updatedAtMs: number;
	createdAtMs: number;
	videos: SessionVideo[];
	alignment: SessionAlignment;
	isLinked: boolean;
	isTheaterMode: boolean;
	/** Which video drives the master clock. */
	masterVideoId: string | null;
	/** Which video supplies audible audio by default; independent of the master clock. */
	audioSourceVideoId: string | null;
	/** Server-issued pass authorizing this pair, when metering applies. */
	passId: string | null;
}

export function defaultCoordinates(index: number): ViewportCoordinates {
	return {
		x: index === 0 ? 0 : 0.5,
		y: 0,
		width: 0.5,
		height: 1,
		crop: { top: 0, right: 0, bottom: 0, left: 0 },
		opacity: 1,
		z: index
	};
}

export function pipCoordinates(index: number): ViewportCoordinates {
	if (index === 0) {
		return {
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			crop: { top: 0, right: 0, bottom: 0, left: 0 },
			opacity: 1,
			z: 0
		};
	}
	return {
		x: 0.72,
		y: 0.68,
		width: 0.26,
		height: 0.26,
		crop: { top: 0, right: 0, bottom: 0, left: 0 },
		opacity: 1,
		z: 1
	};
}

/** Clamp helper for normalized coordinate values. */
export function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Persisted session record. Deliberately excludes runtime-only fields:
 * blob URLs are stripped because they are not durable references.
 */
export interface PersistedSession {
	readonly schemaVersion: number;
	readonly session: Session;
	readonly savedAtMs: number;
}

/** Remove non-durable runtime values before writing to IndexedDB. */
export function toPersistableSession(session: Session): Session {
	return {
		...session,
		videos: session.videos.map((v) => ({
			...v,
			media: {
				...v.media,
				// Blob/object URLs are document-scoped and must never be persisted.
				playbackUrl: null
			}
		}))
	};
}
