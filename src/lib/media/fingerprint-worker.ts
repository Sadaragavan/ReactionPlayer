/**
 * Fingerprint Web Worker entry point.
 *
 * Keeping this off the main thread is a hard requirement (PROJECT_BRIEF.md §7): hashing
 * even sampled chunks of a large file must never block playback or input.
 */

import { fingerprintFile } from './fingerprint';
import type { MediaFingerprint } from '../contracts/media';

export interface WorkerRequest {
	readonly id: string;
	readonly file: File;
}

export type WorkerResponse =
	| { readonly id: string; readonly ok: true; readonly fingerprint: MediaFingerprint }
	| { readonly id: string; readonly ok: false; readonly error: string };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const { id, file } = event.data;
	try {
		const fingerprint = await fingerprintFile(file);
		const response: WorkerResponse = { id, ok: true, fingerprint };
		self.postMessage(response);
	} catch (error) {
		const response: WorkerResponse = {
			id,
			ok: false,
			// Do not echo the filename back through error text; it is private (§17).
			error: error instanceof Error ? error.message : 'Could not read this file.'
		};
		self.postMessage(response);
	}
};
