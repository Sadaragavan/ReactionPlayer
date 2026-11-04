/**
 * POST /api/passes  — issue or reuse a session pass (server-authoritative)
 * GET  /api/passes  — current usage snapshot
 *
 * The client supplies identity, never authorization. Quota is enforced in Postgres.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { AppError, jsonError } from '$lib/contracts/errors';
import { buildPairKey, issueOrReusePass, getPassStatus } from '$lib/server/services/pass-service';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/services/rate-limit';
import { isUuid } from '$lib/server/db/client';

interface IssueBody {
	requestId?: string;
	reaction?: { logicalId?: string | null; confidence?: string | null; physicalKey?: string | null };
	source?: { logicalId?: string | null; confidence?: string | null; physicalKey?: string | null };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to start a session.');
		enforceRateLimit(`pass:${locals.user.id}`, RATE_LIMITS.passIssue);

		let body: IssueBody;
		try {
			body = (await request.json()) as IssueBody;
		} catch {
			throw new AppError('invalid_input', 'Send a JSON body.');
		}

		if (!body.requestId || !isUuid(body.requestId)) {
			throw new AppError('invalid_input', 'A valid requestId is required for idempotent issuance.');
		}
		if (!body.reaction || !body.source) {
			throw new AppError('invalid_input', 'Both a reaction and a source identity are required.');
		}

		// Bound the identity strings so a malicious client cannot inflate the pair key.
		for (const side of [body.reaction, body.source]) {
			if (side.physicalKey && side.physicalKey.length > 256) {
				throw new AppError('invalid_input', 'Media identity is too long.');
			}
			if (side.logicalId && !isUuid(side.logicalId)) {
				throw new AppError('invalid_input', 'Malformed logical identity.');
			}
		}

		const { pairKey, layer } = buildPairKey({ reaction: body.reaction, source: body.source });
		const result = await issueOrReusePass(locals.user.id, pairKey, body.requestId, layer);

		return json(result, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return jsonError(error);
	}
};

export const GET: RequestHandler = async ({ locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to view pass usage.');
		const status = await getPassStatus(locals.user.id);
		return json(status, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return jsonError(error);
	}
};
