/**
 * GET  /api/sync-profiles?pairKey=... — the caller's private offset for a pair
 * POST /api/sync-profiles           — save a private offset
 *
 * MVP: ONE offset per reaction/source-version pair (brief §1). The `map` column reserves
 * room for future piecewise maps without a breaking change.
 *
 * Personal offsets are stored as `private` / `unverified`. They are useful immediately but
 * are clearly labelled and never affect shared data until verified (brief §8).
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { AppError, jsonError } from '$lib/contracts/errors';
import { asUser } from '$lib/server/db/client';
import { clampOffsetMs } from '$lib/sync/math';

export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to load sync profiles.');
		const userId = locals.user.id;
		const pairKey = url.searchParams.get('pairKey');
		if (!pairKey || pairKey.length > 512) {
			throw new AppError('invalid_input', 'A valid pairKey is required.');
		}

		const rows = await asUser(userId, async (tx) => {
			return await tx<{
				id: string;
				offset_ms: number;
				verification_state: string;
				updated_at: Date;
			}[]>`
				select id, offset_ms, verification_state, updated_at
				from public.sync_profiles
				where owner_id = ${userId} and pair_key = ${pairKey}
				order by updated_at desc limit 1
			`;
		});

		const row = rows[0];
		return json(
			{
				profile: row
					? {
							id: row.id,
							offsetMs: row.offset_ms,
							verificationState: row.verification_state,
							updatedAt: row.updated_at.toISOString()
						}
					: null
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return jsonError(error);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.user) throw new AppError('unauthenticated', 'Sign in to save sync profiles.');
		const userId = locals.user.id;

		const body = (await request.json()) as { pairKey?: string; offsetMs?: number };
		if (!body.pairKey || body.pairKey.length > 512) {
			throw new AppError('invalid_input', 'A valid pairKey is required.');
		}
		if (typeof body.offsetMs !== 'number' || !Number.isFinite(body.offsetMs)) {
			throw new AppError('invalid_input', 'A numeric offsetMs is required.');
		}
		const offsetMs = clampOffsetMs(body.offsetMs);

		const pairKey = body.pairKey;
		const rows = await asUser(userId, async (tx) => {
			const existing = await tx<{ id: string }[]>`
				select id from public.sync_profiles
				where owner_id = ${userId} and pair_key = ${pairKey}
				order by updated_at desc limit 1
			`;
			if (existing[0]) {
				return await tx<{ id: string }[]>`
					update public.sync_profiles
					set offset_ms = ${offsetMs}, verification_state = 'unverified', visibility = 'private'
					where id = ${existing[0].id}
					returning id
				`;
			}
			return await tx<{ id: string }[]>`
				insert into public.sync_profiles (owner_id, pair_key, offset_ms, visibility, verification_state)
				values (${userId}, ${pairKey}, ${offsetMs}, 'private', 'unverified')
				returning id
			`;
		});

		return json(
			{ id: rows[0]!.id, offsetMs, verificationState: 'unverified' },
			{ headers: { 'cache-control': 'no-store' } }
		);
	} catch (error) {
		return jsonError(error);
	}
};
