/**
 * Media identity contracts (PROJECT_BRIEF.md §7).
 *
 * THREE SEPARATE LAYERS — conflating them causes incorrect pass metering:
 *
 *  1. Physical identity  — this exact byte stream / file / provider asset.
 *  2. Logical identity   — the content itself ("this episode"), independent of cut or encode.
 *  3. Version identity   — a specific cut/edition of the logical content (theatrical, TV,
 *                          regional, remaster). Offsets are ALWAYS version-specific.
 *
 * Pass pair identity uses reaction identity + LOGICAL source identity when confidently known,
 * falling back to physical identity otherwise. Switching between legitimate versions of the
 * same logical source must not burn another pass.
 *
 * A sampled fingerprint is a useful identifier, NOT proof of content correctness.
 * No device fingerprinting anywhere in this codebase.
 */

export const MEDIA_CONTRACT_VERSION = 1 as const;

export type MediaProviderKind =
	| 'local-file'
	| 'direct-url'
	| 'youtube'
	| 'vimeo'
	| 'extension-bridge';

/** How confidently a logical match is established. Never treat 'tentative' as verified. */
export type MatchConfidence = 'exact' | 'strong' | 'tentative' | 'unresolved';

/** Physical layer: identifies bytes, not meaning. */
export interface PhysicalMediaIdentity {
	readonly layer: 'physical';
	/** Stable internal id (uuid). */
	readonly id: string;
	readonly provider: MediaProviderKind;
	/**
	 * Provider-stable content id where one exists (e.g. YouTube video id).
	 * For local files this is the sampled fingerprint digest.
	 */
	readonly providerContentId: string | null;
	/** Sampled fingerprint, if computed. */
	readonly fingerprint: MediaFingerprint | null;
	/** Original filename — PRIVATE. Never expose in public projections. */
	readonly fileName: string | null;
	readonly sizeBytes: number | null;
	readonly durationMs: number | null;
}

/** Logical layer: the content, independent of encode/cut. */
export interface LogicalMediaIdentity {
	readonly layer: 'logical';
	readonly id: string;
	readonly catalogSourceId: string | null;
	readonly reactionReleaseId: string | null;
	readonly title: string;
	readonly seasonNumber: number | null;
	readonly episodeNumber: number | null;
	readonly confidence: MatchConfidence;
}

/** Version layer: a specific cut. Sync offsets attach here. */
export interface SourceVersionIdentity {
	readonly layer: 'version';
	readonly id: string;
	readonly logicalId: string;
	/** e.g. 'theatrical', 'extended', 'tv-broadcast', 'remaster-2019'. */
	readonly versionLabel: string;
	readonly runtimeMs: number | null;
	readonly confidence: MatchConfidence;
}

/**
 * Sampled fingerprint result. Produced in a Web Worker (never the UI thread).
 * Scheme is versioned so a future change does not silently invalidate existing ids.
 */
export interface MediaFingerprint {
	readonly schemeVersion: number;
	/** Hex digest of the sampled chunks + size + normalized metadata. */
	readonly digest: string;
	readonly sizeBytes: number;
	/** Chunk descriptors, for explainability/debugging. Contains no media content. */
	readonly samples: readonly FingerprintSample[];
	readonly computedAtMs: number;
	/** True when the file was small enough to hash in full. */
	readonly exhaustive: boolean;
}

export interface FingerprintSample {
	readonly position: 'first' | 'middle' | 'last';
	readonly offsetBytes: number;
	readonly lengthBytes: number;
}

/**
 * A media reference as stored in a session.
 *
 * CRITICAL: `playbackUrl` is RUNTIME ONLY. Blob URLs die with the document; signed URLs
 * expire. Neither is a durable identifier and neither may be persisted as a catalog identity.
 * Durable restoration uses `fileHandleId` (File System Access) or explicit reselection.
 */
export interface MediaReference {
	readonly provider: MediaProviderKind;
	readonly physicalId: string | null;
	/** Durable handle key in IndexedDB, when the browser supports File System Access. */
	readonly fileHandleId: string | null;
	/** For direct URLs: the authorized URL the user supplied. Treated as private. */
	readonly sourceUrl: string | null;
	/** Runtime-only object URL. MUST NOT be persisted. */
	readonly playbackUrl: string | null;
	/** Reselect hint shown to the user; not an identity. */
	readonly reselectHint: ReselectHint | null;
}

export interface ReselectHint {
	readonly fileName: string;
	readonly sizeBytes: number | null;
	readonly lastModifiedMs: number | null;
	readonly fingerprintDigest: string | null;
}

/** Explicit provider capabilities (brief §3). Never assume; always query. */
export interface ProviderCapabilities {
	readonly canPlayPause: boolean;
	readonly canSeek: boolean;
	readonly canSetRate: boolean;
	readonly canReportTime: boolean;
	readonly canCaptureFrame: boolean;
	readonly canSelectAudioTrack: boolean;
	readonly canReportBuffered: boolean;
	/** Honest expected precision, used to set UI expectations. */
	readonly expectedPrecision: 'frame-approximate' | 'sub-second' | 'coarse' | 'unknown';
	/** Why a capability is unavailable, for accurate user-facing messaging. */
	readonly limitations: readonly string[];
}

export const LOCAL_FILE_CAPABILITIES: ProviderCapabilities = {
	canPlayPause: true,
	canSeek: true,
	canSetRate: true,
	canReportTime: true,
	// Frame capture depends on origin; local files are same-origin blobs so this is true,
	// but the adapter still verifies at runtime rather than trusting this flag.
	canCaptureFrame: true,
	canSelectAudioTrack: false,
	canReportBuffered: true,
	expectedPrecision: 'frame-approximate',
	limitations: [
		'Exact frame stepping is not exposed by HTML5 media; steps use estimated frame timing.',
		'Synchronization is drift-corrected, not guaranteed frame-perfect.'
	]
};

export const DIRECT_URL_CAPABILITIES: ProviderCapabilities = {
	canPlayPause: true,
	canSeek: true,
	canSetRate: true,
	canReportTime: true,
	// Cross-origin media may play fine while Canvas capture is tainted/blocked.
	canCaptureFrame: false,
	canSelectAudioTrack: false,
	canReportBuffered: true,
	expectedPrecision: 'frame-approximate',
	limitations: [
		'Cross-origin media may play but block Canvas frame capture (CORS).',
		'Seeking requires server support for byte ranges.',
		'A share page URL is not a media URL; authorization parameters are preserved as supplied.'
	]
};

/** Pair identity used for pass metering (brief §7). */
export interface PairIdentity {
	readonly reactionKey: string;
	readonly sourceKey: string;
	/** Which layer produced each key — recorded so decisions are auditable. */
	readonly reactionKeyLayer: 'logical' | 'physical';
	readonly sourceKeyLayer: 'logical' | 'physical';
}

/**
 * Derive the metering key for one side of a pair.
 * Prefer logical identity when confidently known; otherwise fall back to physical.
 */
export function meteringKeyFor(
	logical: LogicalMediaIdentity | null,
	physical: PhysicalMediaIdentity | null
): { key: string; layer: 'logical' | 'physical' } | null {
	if (logical && (logical.confidence === 'exact' || logical.confidence === 'strong')) {
		return { key: `logical:${logical.id}`, layer: 'logical' };
	}
	if (physical) {
		const stable = physical.providerContentId ?? physical.fingerprint?.digest;
		if (stable) return { key: `physical:${physical.provider}:${stable}`, layer: 'physical' };
	}
	return null;
}

/**
 * Canonical, order-independent pair key.
 * Reaction and source are sorted so (A,B) and (B,A) do not produce two different passes.
 */
export function canonicalPairKey(pair: PairIdentity): string {
	const [a, b] = [pair.reactionKey, pair.sourceKey].sort();
	return `${a}|${b}`;
}
