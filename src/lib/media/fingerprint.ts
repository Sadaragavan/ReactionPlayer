/**
 * Sampled media fingerprinting (PROJECT_BRIEF.md §7).
 *
 * Runs in a Web Worker so a multi-gigabyte file never blocks the UI thread. Only three
 * small chunks are read (first/middle/last) plus size — never the whole file for large
 * media.
 *
 * A sampled fingerprint is a useful IDENTIFIER, not proof of content correctness. Two
 * different files can theoretically collide; a matching fingerprint does not verify a
 * catalog claim.
 *
 * This is media/file fingerprinting. There is NO device fingerprinting anywhere in this
 * project.
 */

import type { MediaFingerprint, FingerprintSample } from '../contracts/media';
import { fingerprintPolicy } from '../config/policy';

export interface FingerprintRequest {
	readonly file: File;
}

/**
 * Compute the sample descriptors. Exported for unit testing without a Worker.
 */
export function planSamples(sizeBytes: number): FingerprintSample[] {
	const chunk = fingerprintPolicy.chunkBytes;

	// Small files: hash the whole thing, which is both cheap and exhaustive.
	if (sizeBytes <= fingerprintPolicy.fullHashCeilingBytes) {
		return [{ position: 'first', offsetBytes: 0, lengthBytes: sizeBytes }];
	}

	const middleOffset = Math.max(0, Math.floor(sizeBytes / 2) - Math.floor(chunk / 2));
	const lastOffset = Math.max(0, sizeBytes - chunk);

	const samples: FingerprintSample[] = [
		{ position: 'first', offsetBytes: 0, lengthBytes: Math.min(chunk, sizeBytes) },
		{
			position: 'middle',
			offsetBytes: middleOffset,
			lengthBytes: Math.min(chunk, sizeBytes - middleOffset)
		},
		{
			position: 'last',
			offsetBytes: lastOffset,
			lengthBytes: Math.min(chunk, sizeBytes - lastOffset)
		}
	];

	// De-duplicate overlapping samples so a small-but-above-threshold file does not hash
	// the same bytes three times and produce a misleading descriptor list.
	const seen = new Set<string>();
	return samples.filter((s) => {
		const key = `${s.offsetBytes}:${s.lengthBytes}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return s.lengthBytes > 0;
	});
}

/**
 * Core hashing routine, usable in a Worker or directly in tests.
 * `readChunk` is injected so the algorithm can be tested without File/Blob APIs.
 */
export async function computeFingerprint(
	sizeBytes: number,
	readChunk: (offset: number, length: number) => Promise<ArrayBuffer>,
	nowMs: number = Date.now()
): Promise<MediaFingerprint> {
	const samples = planSamples(sizeBytes);
	const exhaustive = sizeBytes <= fingerprintPolicy.fullHashCeilingBytes;

	const hash = createHasher();
	// Domain-separated header including the scheme version, so a future scheme change
	// cannot produce a digest that collides with the current one.
	hash.update(new TextEncoder().encode(`reactionplayer-fingerprint-v${fingerprintPolicy.schemeVersion}\n`));
	hash.update(new TextEncoder().encode(`size:${sizeBytes}\n`));

	for (const sample of samples) {
		const buffer = await readChunk(sample.offsetBytes, sample.lengthBytes);
		hash.update(new TextEncoder().encode(`${sample.position}:${sample.offsetBytes}:${sample.lengthBytes}\n`));
		hash.update(new Uint8Array(buffer));
	}

	return {
		schemeVersion: fingerprintPolicy.schemeVersion,
		digest: await hash.digestHex(),
		sizeBytes,
		samples,
		computedAtMs: nowMs,
		exhaustive
	};
}

/** SHA-256 via WebCrypto, available in Workers and modern browsers. */
function createHasher() {
	const parts: Uint8Array[] = [];
	return {
		update(bytes: Uint8Array): void {
			parts.push(bytes);
		},
		async digestHex(): Promise<string> {
			const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
			const joined = new Uint8Array(total);
			let offset = 0;
			for (const part of parts) {
				joined.set(part, offset);
				offset += part.byteLength;
			}
			const digest = await crypto.subtle.digest('SHA-256', joined);
			return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
		}
	};
}

/** Compute a fingerprint for a File using sliced reads (no full-file buffering). */
export async function fingerprintFile(file: File): Promise<MediaFingerprint> {
	return computeFingerprint(file.size, async (offset, length) => {
		return await file.slice(offset, offset + length).arrayBuffer();
	});
}
