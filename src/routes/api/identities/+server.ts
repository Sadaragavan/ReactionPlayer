/**
 * POST /api/identities — register a sampled media fingerprint for the caller.
 *
 * Private by design: filenames and fingerprints are owner-only under RLS. Registering a
 * fingerprint does NOT verify any catalog claim (brief §7, §8).
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { AppError, jsonError } from '$lib/contracts/errors';
import { asUser } from '$lib/server/db/client';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/services/rate-limit';
import { fingerprintPolicy } from '$lib/config/policy';

interface RegisterBody {
	digest?: string;
	provider?: string;
	sizeBytes?: number | null;
	durationMs?: number | null;
	fileName?: string | null;
	exhaustive?: boolean;
}

const ALLOWED_PROVIDERS = ['local-file', 'direct-url', 'youtube', 'vimeo'];

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to identify media.');
		// Capture the id: narrowing does not survive into the async callback below.
		const userId = locals.user.id;
		enforceRateLimit(`fingerprint:${locals.user.id}`, RATE_LIMITS.fingerprintRegister);

		const body = (await request.json()) as RegisterBody;

		if (!body.digest || !/^[0-9a-f]{64}$/.test(body.digest)) {
			throw new AppError('invalid_input', 'A valid fingerprint digest is required.');
		}
		if (!body.provider || !ALLOWED_PROVIDERS.includes(body.provider)) {
			throw new AppError('invalid_input', 'Unsupported media provider.');
		}
		if (body.fileName && body.fileName.length > 300) {
			throw new AppError('invalid_input', 'File name is too long.');
		}
		if (body.sizeBytes !== null && body.sizeBytes !== undefined) {
			if (!Number.isFinite(body.sizeBytes) || body.sizeBytes < 0) {
				throw new AppError('invalid_input', 'Invalid file size.');
			}
		}

		// Capture validated values: TypeScript narrowing does not persist into the
		// async callback, and the SQL driver rejects `undefined` parameters.
		const digest = body.digest;
		const provider = body.provider;
		const sizeBytes = body.sizeBytes ?? null;
		const durationMs = body.durationMs ?? null;
		const fileName = body.fileName ?? null;
		const exhaustive = body.exhaustive ?? false;

		const rows = await asUser(userId, async (tx) => {
			return await tx<{ id: string }[]>`
				insert into public.media_fingerprints
					(owner_id, scheme_version, digest, provider, size_bytes, duration_ms, file_name, exhaustive)
				values (
					${userId}, ${fingerprintPolicy.schemeVersion}, ${digest}, ${provider},
					${sizeBytes}, ${durationMs}, ${fileName}, ${exhaustive}
				)
				on conflict (owner_id, scheme_version, digest, provider)
				do update set duration_ms = coalesce(excluded.duration_ms, public.media_fingerprints.duration_ms)
				returning id
			`;
		});

		return json({ physicalId: rows[0]!.id }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return jsonError(error);
	}
};
