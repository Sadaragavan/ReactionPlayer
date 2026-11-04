/**
 * Consent service (PROJECT_BRIEF.md §5).
 *
 * Granular, versioned, timestamped, revocable. Revocation appends an event rather than
 * deleting history, so the record of what was agreed remains auditable — while the
 * *derived* current state immediately reflects the withdrawal.
 *
 * Optional purposes are never required for playback or pass allocation.
 */

import { asUser } from '../db/client';
import { AppError } from '../../contracts/errors';
import { POLICY_VERSION } from '../../config/policy';

export interface ConsentPurpose {
	readonly key: string;
	readonly title: string;
	readonly explanation: string;
	readonly requiredForService: boolean;
	readonly displayOrder: number;
}

export interface ConsentState {
	readonly purpose: string;
	readonly granted: boolean;
	readonly policyVersion: string;
	readonly recordedAt: string;
}

export async function listPurposes(): Promise<ConsentPurpose[]> {
	const { asService } = await import('../db/client');
	const rows = await asService(async (tx) => {
		return await tx<{
			key: string;
			title: string;
			explanation: string;
			required_for_service: boolean;
			display_order: number;
		}[]>`
			select key, title, explanation, required_for_service, display_order
			from public.consent_purposes order by display_order
		`;
	});
	return rows.map((r) => ({
		key: r.key,
		title: r.title,
		explanation: r.explanation,
		requiredForService: r.required_for_service,
		displayOrder: r.display_order
	}));
}

export async function getConsentState(userId: string): Promise<ConsentState[]> {
	const rows = await asUser(userId, async (tx) => {
		return await tx<{
			purpose: string;
			granted: boolean;
			policy_version: string;
			recorded_at: Date;
		}[]>`
			select purpose, granted, policy_version, recorded_at
			from public.consent_current where user_id = ${userId}
		`;
	});
	return rows.map((r) => ({
		purpose: r.purpose,
		granted: r.granted,
		policyVersion: r.policy_version,
		recordedAt: r.recorded_at.toISOString()
	}));
}

export async function recordConsent(
	userId: string,
	purpose: string,
	granted: boolean,
	source = 'settings'
): Promise<ConsentState> {
	const { asService } = await import('../db/client');
	const valid = await asService(async (tx) => {
		const rows = await tx<{ key: string }[]>`
			select key from public.consent_purposes where key = ${purpose}
		`;
		return rows.length > 0;
	});
	if (!valid) throw new AppError('invalid_input', 'Unknown consent purpose.');

	const rows = await asUser(userId, async (tx) => {
		return await tx<{ recorded_at: Date }[]>`
			insert into public.consent_events (user_id, purpose, granted, policy_version, source)
			values (${userId}, ${purpose}, ${granted}, ${POLICY_VERSION}, ${source})
			returning recorded_at
		`;
	});

	// Withdrawing personalization consent stops future collection. Existing rows are
	// removed so the withdrawal has real effect rather than being cosmetic (§5).
	if (!granted && purpose === 'watch_history') {
		await asUser(userId, async (tx) => {
			await tx`delete from public.watch_activity where owner_id = ${userId}`;
		});
	}
	if (!granted && purpose === 'public_nickname') {
		// Returning to anonymous display must be immediate (§6).
		await asUser(userId, async (tx) => {
			await tx`
				update public.profiles
				set nickname = null, nickname_normalized = null, nickname_confirmed_public_at = null
				where id = ${userId}
			`;
		});
	}

	return {
		purpose,
		granted,
		policyVersion: POLICY_VERSION,
		recordedAt: rows[0]!.recorded_at.toISOString()
	};
}

export async function hasConsent(userId: string, purpose: string): Promise<boolean> {
	const state = await getConsentState(userId);
	return state.find((s) => s.purpose === purpose)?.granted ?? false;
}
