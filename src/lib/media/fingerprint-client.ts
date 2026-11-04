/**
 * Main-thread client for the fingerprint worker.
 *
 * Falls back to computing on the main thread only if Worker construction fails, and says
 * so — the fallback is a degradation, not the normal path.
 */

import type { MediaFingerprint } from '../contracts/media';
import type { WorkerResponse } from './fingerprint-worker';
import { fingerprintFile } from './fingerprint';

let worker: Worker | null = null;
let workerFailed = false;
const pending = new Map<
	string,
	{ resolve: (f: MediaFingerprint) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker | null {
	if (workerFailed || typeof Worker === 'undefined') return null;
	if (worker) return worker;
	try {
		worker = new Worker(new URL('./fingerprint-worker.ts', import.meta.url), {
			type: 'module'
		});
		worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
			const entry = pending.get(event.data.id);
			if (!entry) return;
			pending.delete(event.data.id);
			if (event.data.ok) entry.resolve(event.data.fingerprint);
			else entry.reject(new Error(event.data.error));
		};
		worker.onerror = () => {
			// A worker failure must not leave callers hanging.
			workerFailed = true;
			for (const [, entry] of pending) {
				entry.reject(new Error('Fingerprint worker unavailable.'));
			}
			pending.clear();
			worker = null;
		};
		return worker;
	} catch {
		workerFailed = true;
		return null;
	}
}

export interface FingerprintOutcome {
	readonly fingerprint: MediaFingerprint;
	/** True when the worker was unavailable and hashing happened on the main thread. */
	readonly usedMainThreadFallback: boolean;
}

export async function requestFingerprint(file: File): Promise<FingerprintOutcome> {
	const w = getWorker();
	if (!w) {
		return { fingerprint: await fingerprintFile(file), usedMainThreadFallback: true };
	}

	const id = crypto.randomUUID();
	const fingerprint = await new Promise<MediaFingerprint>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		try {
			// File is structured-cloneable; the bytes are NOT copied here, only the handle.
			w.postMessage({ id, file });
		} catch (error) {
			pending.delete(id);
			reject(error instanceof Error ? error : new Error('Could not start fingerprinting.'));
		}
	}).catch(async () => {
		// Worker path failed: fall back rather than blocking the user.
		return await fingerprintFile(file);
	});

	return { fingerprint, usedMainThreadFallback: false };
}

export function disposeFingerprintWorker(): void {
	worker?.terminate();
	worker = null;
	pending.clear();
}
