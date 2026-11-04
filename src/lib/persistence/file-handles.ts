/**
 * Durable local-file references via the File System Access API (PROJECT_BRIEF.md §4).
 *
 * HONEST CAPABILITY STORY:
 *   - Chromium-based browsers can persist a FileSystemFileHandle in IndexedDB and
 *     re-request permission on a later visit. Restoration is then a permission prompt,
 *     not a silent read.
 *   - Safari and Firefox do not expose showOpenFilePicker. There, a saved session stores
 *     a reselection hint and the user must pick the file again.
 *
 * We therefore NEVER promise automatic restoration on every browser. The resume flow
 * always has a reselection fallback, and a fingerprint check confirms the re-picked file
 * is plausibly the same media.
 *
 * Blob URLs are never persisted; they die with the document.
 */

import { getDb, type StoredFileHandle } from './db';

/** Minimal structural typing so this module compiles without DOM FS Access lib types. */
export interface FileSystemFileHandleLike {
	readonly kind: 'file';
	readonly name: string;
	getFile(): Promise<File>;
	queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
	requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
}

export function supportsFileHandles(): boolean {
	return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

export type RestoreOutcome =
	| { readonly status: 'restored'; readonly file: File; readonly handleId: string }
	| { readonly status: 'permission-denied'; readonly reason: string }
	| { readonly status: 'needs-reselect'; readonly reason: string; readonly hint: StoredFileHandle | null }
	| { readonly status: 'unsupported'; readonly reason: string; readonly hint: StoredFileHandle | null };

/** Persist a handle obtained from a picker. Returns null when unsupported. */
export async function storeFileHandle(
	handle: FileSystemFileHandleLike,
	file: File,
	fingerprintDigest: string | null
): Promise<string | null> {
	if (!supportsFileHandles()) return null;
	const id = crypto.randomUUID();
	const record: StoredFileHandle = {
		id,
		handle,
		fileName: file.name,
		sizeBytes: file.size,
		lastModifiedMs: file.lastModified,
		fingerprintDigest,
		storedAtMs: Date.now()
	};
	try {
		const db = await getDb();
		await db.put('fileHandles', record);
		return id;
	} catch (error) {
		// Storing a handle can fail (quota, private mode). Degrade to reselection.
		console.warn('[file-handles] could not persist handle:', error);
		return null;
	}
}

export async function getStoredHandle(id: string): Promise<StoredFileHandle | null> {
	try {
		const db = await getDb();
		return (await db.get('fileHandles', id)) ?? null;
	} catch {
		return null;
	}
}

/**
 * Attempt to restore a file from a stored handle.
 *
 * MUST be called from a user gesture: requestPermission() requires transient activation.
 * The caller (resume button) satisfies that.
 */
export async function restoreFile(handleId: string): Promise<RestoreOutcome> {
	if (!supportsFileHandles()) {
		const hint = await getStoredHandle(handleId);
		return {
			status: 'unsupported',
			reason: 'This browser cannot reopen files automatically. Choose the file again to continue.',
			hint
		};
	}

	const stored = await getStoredHandle(handleId);
	if (!stored) {
		return {
			status: 'needs-reselect',
			reason: 'The saved file reference is no longer available. Choose the file again.',
			hint: null
		};
	}

	const handle = stored.handle as FileSystemFileHandleLike;

	try {
		// Query first: a granted permission needs no prompt.
		const current = (await handle.queryPermission?.({ mode: 'read' })) ?? 'prompt';
		if (current !== 'granted') {
			const requested = (await handle.requestPermission?.({ mode: 'read' })) ?? 'denied';
			if (requested !== 'granted') {
				return {
					status: 'permission-denied',
					reason: 'Permission to read this file was not granted. Choose the file again to continue.'
				};
			}
		}

		const file = await handle.getFile();
		return { status: 'restored', file, handleId };
	} catch (error) {
		// The file may have been moved, renamed or deleted since the handle was stored.
		return {
			status: 'needs-reselect',
			reason:
				error instanceof Error && error.name === 'NotFoundError'
					? 'The original file has moved or been deleted. Choose it again to continue.'
					: 'The saved file could not be opened. Choose it again to continue.',
			hint: stored
		};
	}
}

/** Open a file picker, returning both the File and a persistable handle where supported. */
export async function pickVideoFile(): Promise<{
	file: File;
	handle: FileSystemFileHandleLike | null;
} | null> {
	if (supportsFileHandles()) {
		try {
			const picker = (
				window as unknown as {
					showOpenFilePicker: (options: unknown) => Promise<FileSystemFileHandleLike[]>;
				}
			).showOpenFilePicker;
			const [handle] = await picker({
				multiple: false,
				types: [
					{
						description: 'Video files',
						accept: {
							'video/*': ['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi', '.ts']
						}
					}
				]
			});
			if (!handle) return null;
			const file = await handle.getFile();
			return { file, handle };
		} catch (error) {
			// AbortError means the user cancelled — not an error worth reporting.
			if (error instanceof Error && error.name === 'AbortError') return null;
			// Fall through to the input-based path on any other picker failure.
		}
	}

	return await pickViaInput();
}

/** Fallback picker using a hidden <input type="file">. No durable handle is available. */
function pickViaInput(): Promise<{ file: File; handle: null } | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'video/*';
		input.style.display = 'none';
		document.body.appendChild(input);

		let settled = false;
		const finish = (value: { file: File; handle: null } | null) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(value);
		};

		input.addEventListener('change', () => {
			const file = input.files?.[0];
			finish(file ? { file, handle: null } : null);
		});
		// Cancel detection: modern browsers fire `cancel`; older ones do not, so the
		// promise may remain pending until the next interaction. That is acceptable —
		// no state is mutated until a file is actually chosen.
		input.addEventListener('cancel', () => finish(null));
		input.click();
	});
}

/**
 * Validate a re-selected file against the stored hint.
 *
 * Size and name are cheap signals. A fingerprint match is stronger but still not proof
 * of content correctness (§7). A mismatch produces a warning the user can override,
 * because legitimate re-encodes and renames happen.
 */
export function assessReselectedFile(
	file: File,
	hint: { fileName: string; sizeBytes: number | null; fingerprintDigest: string | null },
	computedDigest: string | null
): { matches: boolean; warning: string | null } {
	if (computedDigest && hint.fingerprintDigest && computedDigest === hint.fingerprintDigest) {
		return { matches: true, warning: null };
	}
	if (hint.sizeBytes !== null && file.size === hint.sizeBytes) {
		return {
			matches: true,
			warning: null
		};
	}
	if (file.name === hint.fileName) {
		return {
			matches: true,
			warning: 'The file name matches but the size differs. It may be a different encode.'
		};
	}
	return {
		matches: false,
		warning: `"${file.name}" does not look like the saved file "${hint.fileName}". You can continue anyway, but synchronization may be wrong.`
	};
}

export async function deleteFileHandle(id: string): Promise<void> {
	try {
		const db = await getDb();
		await db.delete('fileHandles', id);
	} catch {
		// Best effort.
	}
}
