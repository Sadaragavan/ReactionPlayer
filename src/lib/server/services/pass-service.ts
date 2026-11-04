/**
 * Pass service (PROJECT_BRIEF.md §7).
 *
 * Thin, validated wrapper over the SQL function that does the real work. All quota logic
 * lives in Postgres so it is atomic under concurrency; this layer only validates input,
 * binds the caller's identity, and shapes a client-safe response.
 *
 * The client never computes or grants entitlement.
 */

import { asUser, isUuid } from '../db/client';
import { AppError } from '../../contracts/errors';
import { canonicalPairKey, meteringKeyFor, type PairIdentity } from '../../contracts/media';
import { passPolicy } from '../../config/policy';

export interface PassIssueResponse {
	readonly outcome: 'issued' | 'reused' | 'expired' | 'denied';
	readonly passId: string | null;
	readonly expiresAt: string | null;
	readonly tier: 'free' | 'pro';
	readonly capacityClass: 'base' | 'bonus' | 'pro' | 'grant' | null;
	readonly usage: {
		readonly baseUsed: number;
		readonly baseCapacity: number;
		readonly bonusUsed: number;
		readonly bonusCapacity: number;
	};
	readonly nextAvailableAt: string | null;
	readonly reason: string | null;
	/** Videos allowed in a session for this tier. */
	readonly videoLimit: number;
}

interface PassRow {
	outcome: string;
	pass_id: string | null;
	pair_key: string | null;
	issued_at: Date | string | null;
	expires_at: Date | string | null;
	tier: string;
	capacity_class: string | null;
	base_used: number;
	base_capacity: number;
	bonus_used: number;
	bonus_capacity: number;
	next_available_at: Date | string | null;
	reason: string | null;
}

function toIso(value: Date | string | null): string | null {
	if (!value) return null;
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function shape(row: PassRow): PassIssueResponse {
	const tier = row.tier === 'pro' ? 'pro' : 'free';
	return {
		outcome: row.outcome as PassIssueResponse['outcome'],
		passId: row.pass_id,
		expiresAt: toIso(row.expires_at),
		tier,
		capacityClass: (row.capacity_class ?? null) as PassIssueResponse['capacityClass'],
		usage: {
			baseUsed: row.base_used,
			baseCapacity: row.base_capacity,
			bonusUsed: row.bonus_used,
			bonusCapacity: row.bonus_capacity
		},
		nextAvailableAt: toIso(row.next_available_at),
		reason: row.reason,
		videoLimit: tier === 'pro' ? passPolicy.proTierVideoLimit : passPolicy.freeTierVideoLimit
	};
}

/**
 * Build the canonical metering key from client-supplied identity descriptors.
 *
 * The client supplies identity, not authorization. A client could lie about identity to
 * reuse a pass for different content — that is an accepted limitation of any client-side
 * identification scheme and is why sampled fingerprints are treated as identifiers, not
 * proof (brief §7). Quota itself remains server-enforced.
 */
export function buildPairKey(input: {
	reaction: { logicalId?: string | null; confidence?: string | null; physicalKey?: string | null };
	source: { logicalId?: string | null; confidence?: string | null; physicalKey?: string | null };
}): { pairKey: string; layer: 'logical' | 'physical' } {
	const reaction = meteringKeyFor(
		input.reaction.logicalId
			? {
					layer: 'logical',
					id: input.reaction.logicalId,
					catalogSourceId: null,
					reactionReleaseId: null,
					title: '',
					seasonNumber: null,
					episodeNumber: null,
					confidence: (input.reaction.confidence ?? 'strong') as 'exact' | 'strong'
				}
			: null,
		input.reaction.physicalKey
			? {
					layer: 'physical',
					id: '',
					provider: 'local-file',
					providerContentId: input.reaction.physicalKey,
					fingerprint: null,
					fileName: null,
					sizeBytes: null,
					durationMs: null
				}
			: null
	);

	const source = meteringKeyFor(
		input.source.logicalId
			? {
					layer: 'logical',
					id: input.source.logicalId,
					catalogSourceId: null,
					reactionReleaseId: null,
					title: '',
					seasonNumber: null,
					episodeNumber: null,
					confidence: (input.source.confidence ?? 'strong') as 'exact' | 'strong'
				}
			: null,
		input.source.physicalKey
			? {
					layer: 'physical',
					id: '',
					provider: 'local-file',
					providerContentId: input.source.physicalKey,
					fingerprint: null,
					fileName: null,
					sizeBytes: null,
					durationMs: null
				}
			: null
	);

	if (!reaction || !source) {
		throw new AppError(
			'invalid_input',
			'Both videos need an identity before a session can start. Add two files or wait for identification to finish.'
		);
	}

	const pair: PairIdentity = {
		reactionKey: reaction.key,
		sourceKey: source.key,
		reactionKeyLayer: reaction.layer,
		sourceKeyLayer: source.layer
	};

	return {
		pairKey: canonicalPairKey(pair),
		// Record the weaker layer: if either side fell back to physical, the pair is
		// physical for auditing purposes.
		layer: reaction.layer === 'logical' && source.layer === 'logical' ? 'logical' : 'physical'
	};
}

export async function issueOrReusePass(
	userId: string,
	pairKey: string,
	requestId: string,
	identityLayer: 'logical' | 'physical'
): Promise<PassIssueResponse> {
	if (!pairKey || pairKey.length > 512) {
		throw new AppError('invalid_input', 'Invalid session pair.');
	}
	if (!isUuid(requestId)) {
		throw new AppError('invalid_input', 'A valid request id is required.');
	}

	const rows = await asUser(userId, async (tx) => {
		return await tx<PassRow[]>`
			select * from public.issue_session_pass(
				${userId}::uuid, ${pairKey}, ${requestId}::uuid, ${identityLayer}
			)
		`;
	});

	const row = rows[0];
	if (!row) throw new AppError('internal', 'The pass service returned no result.');

	const shaped = shape(row);
	if (shaped.outcome === 'denied' && shaped.reason === 'quota_exhausted') {
		// 429 with an actionable time, not a vague failure.
		throw new AppError('quota_exhausted', 'You have used all your session passes for now.', {
			nextAvailableAt: shaped.nextAvailableAt,
			usage: shaped.usage
		});
	}
	return shaped;
}

export async function getPassStatus(userId: string): Promise<PassIssueResponse> {
	const rows = await asUser(userId, async (tx) => {
		return await tx<PassRow[]>`select * from public.pass_status(${userId}::uuid)`;
	});
	const row = rows[0];
	if (!row) throw new AppError('internal', 'The pass service returned no status.');
	return shape(row);
}

/**
 * Verify a pass is currently valid for a pair. Used when resuming a saved session so a
 * stale client cannot resume on an expired authorization.
 */
export async function verifyPass(
	userId: string,
	passId: string,
	pairKey: string
): Promise<{ valid: boolean; expiresAt: string | null }> {
	if (!isUuid(passId)) return { valid: false, expiresAt: null };
	const rows = await asUser(userId, async (tx) => {
		return await tx<{ expires_at: Date }[]>`
			select expires_at from public.session_passes
			where id = ${passId} and user_id = ${userId} and pair_key = ${pairKey} and expires_at > now()
		`;
	});
	const row = rows[0];
	return { valid: Boolean(row), expiresAt: row ? toIso(row.expires_at) : null };
}
