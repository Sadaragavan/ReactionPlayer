/**
 * Local session persistence (PROJECT_BRIEF.md §4).
 *
 * Available to every tier. Stores configuration only — never media bytes, never blob URLs.
 */

import { getDb } from './db';
import {
	SESSION_SCHEMA_VERSION,
	toPersistableSession,
	type PersistedSession,
	type Session
} from '../contracts/session';

export interface SessionSummary {
	readonly id: string;
	readonly name: string;
	readonly savedAtMs: number;
	readonly updatedAtMs: number;
	readonly videoCount: number;
	readonly progressFraction: number;
	readonly videoTitles: readonly string[];
	/** True when at least one video needs manual reselection on this browser. */
	readonly requiresReselect: boolean;
}

export async function saveSession(session: Session): Promise<void> {
	const db = await getDb();
	const record: PersistedSession = {
		schemaVersion: SESSION_SCHEMA_VERSION,
		session: toPersistableSession({ ...session, updatedAtMs: Date.now() }),
		savedAtMs: Date.now()
	};
	await db.put('sessions', record);
}

export async function loadSession(id: string): Promise<Session | null> {
	const db = await getDb();
	const record = await db.get('sessions', id);
	if (!record) return null;
	return migrateSession(record);
}

export async function listSessions(): Promise<SessionSummary[]> {
	const db = await getDb();
	const records = await db.getAll('sessions');
	const summaries: SessionSummary[] = [];

	for (const record of records) {
		const session = migrateSession(record);
		if (!session) continue;
		const master = session.videos.find((v) => v.id === session.masterVideoId) ?? session.videos[0];
		const progress =
			master && master.durationSeconds && master.durationSeconds > 0
				? Math.min(1, Math.max(0, master.currentTimeSeconds / master.durationSeconds))
				: 0;
		summaries.push({
			id: session.id,
			name: session.name,
			savedAtMs: record.savedAtMs,
			updatedAtMs: session.updatedAtMs,
			videoCount: session.videos.length,
			progressFraction: progress,
			videoTitles: session.videos.map((v) => v.title),
			requiresReselect: session.videos.some((v) => v.media.provider === 'local-file')
		});
	}

	return summaries.sort((a, b) => b.savedAtMs - a.savedAtMs);
}

export async function deleteSession(id: string): Promise<void> {
	const db = await getDb();
	await db.delete('sessions', id);
}

export async function duplicateSession(id: string, newName?: string): Promise<Session | null> {
	const existing = await loadSession(id);
	if (!existing) return null;
	const copy: Session = {
		...existing,
		id: crypto.randomUUID(),
		name: newName ?? `${existing.name} (copy)`,
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		lastModifiedMs: Date.now(),
		// A duplicated session is a new session; it must not inherit the old authorization.
		passId: null
	};
	await saveSession(copy);
	return copy;
}

/** Most recently saved session, for the Continue action. */
export async function getResumableSession(): Promise<SessionSummary | null> {
	const sessions = await listSessions();
	return sessions[0] ?? null;
}

/**
 * Schema migration hook.
 *
 * v1 is the first version. Unknown/future versions are rejected rather than silently
 * misread, and older versions get an explicit upgrade path when introduced.
 */
function migrateSession(record: PersistedSession): Session | null {
	if (record.schemaVersion === SESSION_SCHEMA_VERSION) {
		// Defensive: strip any playbackUrl that a previous build might have written.
		return toPersistableSession(record.session);
	}
	if (record.schemaVersion > SESSION_SCHEMA_VERSION) {
		console.warn(
			`[persistence] session ${record.session.id} was saved by a newer version; not loading it.`
		);
		return null;
	}
	console.warn(`[persistence] no migration path from schema ${record.schemaVersion}; skipping.`);
	return null;
}

/** Export a session configuration as JSON. Contains no media and no signed URLs. */
export function exportSessionConfig(session: Session): string {
	return JSON.stringify(
		{
			schemaVersion: SESSION_SCHEMA_VERSION,
			exportedAt: new Date().toISOString(),
			session: toPersistableSession(session)
		},
		null,
		2
	);
}
