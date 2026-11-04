/**
 * GET  /api/consents — purposes plus the caller's current state
 * POST /api/consents — record a grant or revocation (append-only, versioned)
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { AppError, jsonError } from '$lib/contracts/errors';
import { listPurposes, getConsentState, recordConsent } from '$lib/server/services/consent-service';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/services/rate-limit';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to manage privacy settings.');
		const [purposes, state] = await Promise.all([
			listPurposes(),
			getConsentState(locals.user.id)
		]);
		return json({ purposes, state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return jsonError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to manage privacy settings.');
		enforceRateLimit(`consent:${locals.user.id}`, RATE_LIMITS.consentWrite);

		const body = (await request.json()) as { purpose?: string; granted?: boolean };
		if (typeof body.purpose !== 'string' || typeof body.granted !== 'boolean') {
			throw new AppError('invalid_input', 'Provide a purpose and a boolean granted value.');
		}

		const state = await recordConsent(locals.user.id, body.purpose, body.granted);
		return json({ state }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		return jsonError(error);
	}
};
