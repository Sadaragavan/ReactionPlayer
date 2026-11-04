/**
 * Auth contracts.
 *
 * `SessionUser` is produced ONLY by server-side verification of a session credential.
 * It is never constructed from client-supplied claims, and `tier` is resolved from
 * server-side entitlement grants — never from a client flag (PROJECT_BRIEF.md §19).
 */

export type AccountTier = 'free' | 'pro';

export type StaffRole = 'support' | 'moderator' | 'admin' | 'owner';

export interface SessionUser {
	readonly id: string;
	/** Private. Never rendered in a public projection. */
	readonly email: string | null;
	readonly emailVerified: boolean;
	/** Null => anonymous in every public surface. */
	readonly nickname: string | null;
	readonly staffRoles: readonly StaffRole[];
	/**
	 * Supabase AAL. Privileged operations require 'aal2' (MFA) — see requireStaff().
	 * 'unknown' for the local dev provider, which cannot assert MFA.
	 */
	readonly assuranceLevel: 'aal1' | 'aal2' | 'unknown';
}

export interface AuthResult {
	readonly user: SessionUser | null;
	readonly error: AuthError | null;
}

export interface AuthError {
	readonly code: string;
	readonly message: string;
	/** Field-level hint for form rendering, when applicable. */
	readonly field?: string;
}

/**
 * Auth provider boundary. Two implementations exist:
 *   - SupabaseAuthProvider (production; Supabase Auth + SSR cookies)
 *   - LocalDevAuthProvider (development only; real server-side sessions, scrypt hashes)
 *
 * Both return the same verified shape, so no downstream code branches on provider.
 */
export interface AuthProvider {
	readonly kind: 'supabase' | 'local-dev';
	getUser(): Promise<SessionUser | null>;
	signInWithPassword(email: string, password: string): Promise<AuthResult>;
	signUpWithPassword(email: string, password: string): Promise<AuthResult>;
	signOut(): Promise<void>;
}

export function isStaff(user: SessionUser | null, roles: readonly StaffRole[]): boolean {
	if (!user) return false;
	return user.staffRoles.some((r) => roles.includes(r));
}
