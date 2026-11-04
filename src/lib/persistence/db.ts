/**
 * IndexedDB persistence via `idb` (PROJECT_BRIEF.md §4).
 *
 * Stores:
 *   sessions    — persisted session configuration (no blob URLs, no media bytes)
 *   fileHandles — File System Access handles for durable local-file restoration
 *   settings    — app settings including wallpaper reference
 *
 * Local session storage is available to ALL tiers. Cross-device cloud sync is Pro and is
 * a separate server-side concern.
 *
 * Media bytes are never stored here. A handle is a permission-bearing reference, not a copy.
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { PersistedSession } from '../contracts/session';

export const DB_NAME = 'reactionplayer';
export const DB_VERSION = 1;

export interface StoredFileHandle {
	readonly id: string;
	/** FileSystemFileHandle is structured-cloneable in supporting browsers. */
	readonly handle: unknown;
	readonly fileName: string;
	readonly sizeBytes: number | null;
	readonly lastModifiedMs: number | null;
	readonly fingerprintDigest: string | null;
	readonly storedAtMs: number;
}

export interface StoredSettings {
	readonly key: 'app';
	wallpaper: { kind: 'url' | 'local' | 'none'; url: string | null; handleId: string | null };
	syncToleranceMs: number;
	masterAudioPreference: 'source' | 'reaction' | 'last-used';
	reduceMotion: boolean;
	updatedAtMs: number;
}

interface ReactionPlayerDb {
	sessions: { key: string; value: PersistedSession };
	fileHandles: { key: string; value: StoredFileHandle };
	settings: { key: string; value: StoredSettings };
}

let dbPromise: Promise<IDBPDatabase<ReactionPlayerDb>> | null = null;

export function getDb(): Promise<IDBPDatabase<ReactionPlayerDb>> {
	if (dbPromise) return dbPromise;
	dbPromise = openDB<ReactionPlayerDb>(DB_NAME, DB_VERSION, {
		upgrade(db) {
			if (!db.objectStoreNames.contains('sessions')) {
				const store = db.createObjectStore('sessions', { keyPath: 'session.id' });
				store.createIndex('savedAtMs', 'savedAtMs');
			}
			if (!db.objectStoreNames.contains('fileHandles')) {
				db.createObjectStore('fileHandles', { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains('settings')) {
				db.createObjectStore('settings', { keyPath: 'key' });
			}
		},
		blocked() {
			console.warn('[persistence] IndexedDB upgrade blocked by another open tab.');
		},
		blocking() {
			console.warn('[persistence] This tab is blocking an IndexedDB upgrade.');
		}
	});
	return dbPromise;
}

export async function closeDb(): Promise<void> {
	if (dbPromise) {
		const db = await dbPromise;
		db.close();
		dbPromise = null;
	}
}

/** True when IndexedDB is usable (private browsing can block it). */
export async function isPersistenceAvailable(): Promise<boolean> {
	try {
		const db = await getDb();
		return Boolean(db);
	} catch {
		return false;
	}
}
