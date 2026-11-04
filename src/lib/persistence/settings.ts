/**
 * App settings persistence (PROJECT_BRIEF.md §4, §15).
 *
 * Wallpaper is stored as a URL reference or a File System Access handle id — never as
 * base64 image bytes in IndexedDB, which would bloat storage.
 *
 * The "hardware acceleration" preference is deliberately absent as a fake toggle:
 * JavaScript cannot force browser hardware acceleration. See docs/LIMITATIONS.md.
 */

import { getDb, type StoredSettings } from './db';
import { syncPolicy } from '../config/policy';

export const DEFAULT_SETTINGS: StoredSettings = {
	key: 'app',
	wallpaper: { kind: 'none', url: null, handleId: null },
	syncToleranceMs: syncPolicy.driftToleranceMs,
	masterAudioPreference: 'reaction',
	reduceMotion: false,
	updatedAtMs: 0
};

export async function loadSettings(): Promise<StoredSettings> {
	try {
		const db = await getDb();
		const stored = await db.get('settings', 'app');
		return stored ? { ...DEFAULT_SETTINGS, ...stored } : { ...DEFAULT_SETTINGS };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: Omit<StoredSettings, 'key' | 'updatedAtMs'>): Promise<void> {
	const db = await getDb();
	await db.put('settings', { ...settings, key: 'app', updatedAtMs: Date.now() });
}

const ALLOWED_WALLPAPER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_WALLPAPER_BYTES = 12 * 1024 * 1024;

/** Validate a wallpaper upload (brief §15: PNG/JPG/WebP/GIF). */
export function validateWallpaperFile(file: File): { ok: true } | { ok: false; message: string } {
	if (!ALLOWED_WALLPAPER_TYPES.includes(file.type)) {
		return { ok: false, message: 'Use a PNG, JPG, WebP or GIF image.' };
	}
	if (file.size > MAX_WALLPAPER_BYTES) {
		return { ok: false, message: 'Use an image under 12 MB.' };
	}
	return { ok: true };
}

/**
 * Validate a wallpaper URL.
 *
 * Only https (and blob/data for locally chosen images) are accepted. The URL is used
 * client-side as an image source; it is never fetched server-side, so there is no SSRF
 * surface here (brief §19).
 */
export function validateWallpaperUrl(url: string): { ok: true } | { ok: false; message: string } {
	const trimmed = url.trim();
	if (!trimmed) return { ok: false, message: 'Enter an image URL.' };
	try {
		const parsed = new URL(trimmed);
		if (!['https:', 'blob:', 'data:'].includes(parsed.protocol)) {
			return { ok: false, message: 'Use an https image URL.' };
		}
		if (parsed.protocol === 'data:' && !/^data:image\/(png|jpeg|webp|gif);/.test(trimmed)) {
			return { ok: false, message: 'Use a PNG, JPG, WebP or GIF image.' };
		}
		return { ok: true };
	} catch {
		return { ok: false, message: 'That is not a valid URL.' };
	}
}
