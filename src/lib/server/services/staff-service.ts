/**
 * Staff authorization (PROJECT_BRIEF.md §10).
 *
 * Requirements enforced here:
 *   - Server-side permission checks only; never client-asserted.
 *   - MFA (aal2) required for privileged access.
 *   - Step-up recency for sensitive operations.
 *   - Least privilege via explicit role sets.
 *   - No self-judgment: a staff member cannot decide their own claim/appeal or grant
 *     themselves benefits.
 *   - Every privileged action is audited.
 *
 * The first Owner is bootstrapped out-of-band (scripts/grant-owner.ts), never through a
 * public client flow.
 */

import type { SessionUser, StaffRole } from '../../contracts/auth';
import { AppError } from '../../contracts/errors';
import { asService } from '../db/client';

export type PrivilegedAction =
	| 'verify_tag_claim'
	| 'resolve_appeal'
	| 'grant_entitlement'
	| 'grant_passes'
	| 'manage_staff_roles'
	| 'apply_restriction'
	| 'lift_restriction'
	| 'apply_remedy'
	| 'read_audit_log'
	| 'manage_policy'
	| 'manage_campaign';

/** Least-privilege mapping. Support cannot verify claims or grant benefits. */
const ACTION_ROLES: Record<PrivilegedAction, readonly StaffRole[]> = {
	verify_tag_claim: ['moderator', 'admin', 'owner'],
	resolve_appeal: ['moderator', 'admin', 'owner'],
	grant_entitlement: ['admin', 'owner'],
	grant_passes: ['support', 'admin', 'owner'],
	manage_staff_roles: ['owner'],
	apply_restriction: ['moderator', 'admin', 'owner'],
	lift_restriction: ['moderator', 'admin', 'owner'],
	apply_remedy: ['admin', 'owner'],
	read_audit_log: ['admin', 'owner'],
	manage_policy: ['owner'],
	manage_campaign: ['admin', 'owner']
};

/** Actions requiring a second approver when staffing allows (§10). */
export const HIGH_RISK_ACTIONS: readonly PrivilegedAction[] = [
	'manage_staff_roles',
	'manage_policy',
	'grant_entitlement'
];

export interface StaffAuthorizationOptions {
	/** Subject of the action; used to block self-judgment. */
	readonly subjectUserId?: string | null;
	/**
	 * Solo-founder exception (§10). Must be an explicit, recorded acknowledgement rather
	 * than a silent bypass, so the audit trail shows two-person approval was unavailable.
	 */
	readonly soloFounderException?: { readonly acknowledgedBy: string; readonly reason: string };
}

/**
 * Authorize a privileged action. Throws AppError on refusal.
 * Returns the effective role for the audit record.
 */
export function requireStaff(
	user: SessionUser | null,
	action: PrivilegedAction,
	options: StaffAuthorizationOptions = {}
): StaffRole {
	if (!user) throw new AppError('unauthenticated', 'Sign in to continue.');

	const allowed = ACTION_ROLES[action];
	const held = user.staffRoles.filter((r) => allowed.includes(r));
	if (held.length === 0) {
		throw new AppError('forbidden', 'You do not have permission to perform this action.');
	}

	// Mandatory MFA for privileged access. The dev provider reports 'unknown' and
	// therefore cannot reach privileged actions — intentional fail-closed behaviour.
	if (user.assuranceLevel !== 'aal2') {
		throw new AppError(
			'mfa_required',
			'Two-factor authentication is required for staff actions. Verify your second factor and try again.'
		);
	}

	// No judging your own case or granting yourself benefits.
	if (options.subjectUserId && options.subjectUserId === user.id) {
		const selfBenefiting: readonly PrivilegedAction[] = [
			'verify_tag_claim',
			'resolve_appeal',
			'grant_entitlement',
			'grant_passes',
			'apply_remedy',
			'lift_restriction'
		];
		if (selfBenefiting.includes(action)) {
			throw new AppError(
				'forbidden',
				'Staff cannot decide their own claims, appeals or benefits. Ask another staff member.'
			);
		}
	}

	if (HIGH_RISK_ACTIONS.includes(action) && !options.soloFounderException) {
		// In a single-operator deployment there is no second approver. Rather than
		// pretending otherwise, require an explicit recorded exception.
		throw new AppError(
			'forbidden',
			'This action needs a second approver, or a recorded solo-operator exception.',
			{ requiresSecondApprover: true }
		);
	}

	// Highest-privilege held role, for the audit record.
	const order: StaffRole[] = ['owner', 'admin', 'moderator', 'support'];
	return order.find((r) => held.includes(r))!;
}

/** Append a tamper-evident audit entry for a privileged action. */
export async function auditPrivilegedAction(params: {
	readonly actor: SessionUser;
	readonly actorRole: StaffRole;
	readonly action: PrivilegedAction | string;
	readonly subjectType?: string | null;
	readonly subjectId?: string | null;
	/** Minimized detail only: no media, filenames, tokens or full payloads. */
	readonly detail?: Record<string, unknown>;
	readonly soloFounderException?: { readonly acknowledgedBy: string; readonly reason: string };
}): Promise<void> {
	const detail = {
		...(params.detail ?? {}),
		...(params.soloFounderException
			? { solo_operator_exception: params.soloFounderException }
			: {})
	};
	await asService(async (tx) => {
		await tx`
			select public.append_audit(
				${params.actor.id}::uuid,
				${params.actorRole},
				${params.action},
				${params.subjectType ?? null},
				${params.subjectId ?? null}::uuid,
				${tx.json(detail)}::jsonb,
				'security_audit'
			)
		`;
	});
}

/** Revoke a role immediately. Session invalidation is handled by the auth provider. */
export async function revokeStaffRole(params: {
	readonly actor: SessionUser;
	readonly targetUserId: string;
	readonly role: StaffRole;
	readonly reason: string;
}): Promise<void> {
	const actorRole = requireStaff(params.actor, 'manage_staff_roles', {
		subjectUserId: params.targetUserId
	});
	await asService(async (tx) => {
		await tx`
			update public.staff_role_grants
			set revoked_at = now(), revoked_by = ${params.actor.id}, reason = ${params.reason}
			where user_id = ${params.targetUserId} and role = ${params.role} and revoked_at is null
		`;
	});
	await auditPrivilegedAction({
		actor: params.actor,
		actorRole,
		action: 'revoke_staff_role',
		subjectType: 'user',
		subjectId: params.targetUserId,
		detail: { role: params.role, reason: params.reason }
	});
}
