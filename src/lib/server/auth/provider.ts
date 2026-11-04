/**
 * Auth provider selection and request-scoped identity.
 *
 * Two providers, one contract:
 *   - `supabase`   : Supabase Auth via @supabase/ssr cookie sessions (production)
 *   - `local-dev`  : server-side sessions in dev_auth (development only, explicit opt-in)
 *
 * The provider is chosen from configuration, never from a client-supplied value.
 * `locals.user` is only ever set from a verified session lookup.
 */

import type { Cookies } from '@sveltejs/kit';
import type postgres from 'postgres';
import { createServerClient } from '@supabase/ssr';
import { createHash, randomBytes } from 'node:crypto';
import type { SessionUser, StaffRole, AuthResult } from '../../contracts/auth';
import { AppError } from '../../contracts/errors';
import { getServerConfig } from '../env';
import { asService } from '../db/client';
import { hashPassword, verifyPassword, normalizeEmail, validateEmail, validatePassword } from './password';

export const DEV_SESSION_COOKIE = 'rp_dev_session';
const DEV_SESSION_DAYS = 7;

/** Load the verified user for a request, or null. Never throws for "not signed in". */
export async function resolveUser(cookies: Cookies): Promise<SessionUser | null> {
	const config = getServerConfig();
	if (config.authMode === 'supabase') return resolveSupabaseUser(cookies);
	if (config.authMode === 'local-dev') return resolveDevUser(cookies);
	return null;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function supabaseClient(cookies: Cookies) {
	const config = getServerConfig();
	if (!config.supabaseUrl || !config.supabaseAnonKey) {
		throw new AppError('internal', 'Supabase is not configured.');
	}
	return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
		cookies: {
			getAll: () => cookies.getAll(),
			setAll: (toSet) => {
				for (const { name, value, options } of toSet) {
					cookies.set(name, value, { ...options, path: '/' });
				}
			}
		}
	});
}

async function resolveSupabaseUser(cookies: Cookies): Promise<SessionUser | null> {
	try {
		const client = supabaseClient(cookies);
		// getUser() validates the JWT with the auth server. getSession() alone would trust
		// unverified cookie contents, so it is deliberately not used for authorization.
		const { data, error } = await client.auth.getUser();
		if (error || !data.user) return null;

		const profile = await loadProfile(data.user.id);
		let assuranceLevel: SessionUser['assuranceLevel'] = 'unknown';
		try {
			const { data: aal } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
			assuranceLevel = aal?.currentLevel === 'aal2' ? 'aal2' : 'aal1';
		} catch {
			// MFA introspection unavailable; treat as not stepped up.
			assuranceLevel = 'aal1';
		}

		return {
			id: data.user.id,
			email: data.user.email ?? null,
			emailVerified: Boolean(data.user.email_confirmed_at),
			nickname: profile.nickname,
			staffRoles: profile.staffRoles,
			assuranceLevel
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Local development provider
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function resolveDevUser(cookies: Cookies): Promise<SessionUser | null> {
	const token = cookies.get(DEV_SESSION_COOKIE);
	if (!token) return null;
	const tokenHash = hashToken(token);

	try {
		const rows = await asService(async (tx) => {
			return await tx<{ user_id: string; email: string | null; email_confirmed_at: Date | null }[]>`
				select s.user_id, u.email, u.email_confirmed_at
				from dev_auth.sessions s
				join auth.users u on u.id = s.user_id
				where s.token_hash = ${tokenHash}
				  and s.revoked_at is null
				  and s.expires_at > now()
			`;
		});
		const row = rows[0];
		if (!row) return null;

		const profile = await loadProfile(row.user_id);
		return {
			id: row.user_id,
			email: row.email,
			emailVerified: Boolean(row.email_confirmed_at),
			nickname: profile.nickname,
			staffRoles: profile.staffRoles,
			// The dev provider cannot assert MFA, so privileged actions must refuse.
			assuranceLevel: 'unknown'
		};
	} catch {
		return null;
	}
}

async function issueDevSession(cookies: Cookies, userId: string): Promise<void> {
	const token = randomBytes(32).toString('base64url');
	const tokenHash = hashToken(token);
	await asService(async (tx) => {
		await tx`
			insert into dev_auth.sessions (token_hash, user_id, expires_at)
			values (${tokenHash}, ${userId}, now() + make_interval(days => ${DEV_SESSION_DAYS}))
		`;
	});
	cookies.set(DEV_SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: getServerConfig().isProduction,
		maxAge: DEV_SESSION_DAYS * 24 * 60 * 60
	});
}

// ---------------------------------------------------------------------------
// Shared profile loading
// ---------------------------------------------------------------------------

async function loadProfile(
	userId: string
): Promise<{ nickname: string | null; staffRoles: readonly StaffRole[] }> {
	const rows = await asService(async (tx) => {
		const profile = await tx<{ nickname: string | null; state: string }[]>`
			select nickname, nickname_moderation_state as state
			from public.profiles where id = ${userId}
		`;
		const roles = await tx<{ role: StaffRole }[]>`
			select role from public.staff_role_grants
			where user_id = ${userId} and revoked_at is null
		`;
		return { profile: profile[0], roles: roles.map((r) => r.role) };
	});

	const nicknameVisible =
		rows.profile?.nickname &&
		(rows.profile.state === 'none' || rows.profile.state === 'pending_review');

	return {
		nickname: nicknameVisible ? rows.profile!.nickname : null,
		staffRoles: rows.roles
	};
}

/** Effective tier, resolved from server-side grants. Never from client state. */
export async function resolveTier(userId: string | null): Promise<'free' | 'pro'> {
	if (!userId) return 'free';
	try {
		const rows = await asService(async (tx) => {
			return await tx<{ tier: string }[]>`select public.effective_tier(${userId}::uuid) as tier`;
		});
		return rows[0]?.tier === 'pro' ? 'pro' : 'free';
	} catch {
		// Fail closed: an unavailable entitlement service must not grant Pro.
		return 'free';
	}
}

// ---------------------------------------------------------------------------
// Sign in / up / out
// ---------------------------------------------------------------------------

export async function signIn(
	cookies: Cookies,
	emailRaw: string,
	password: string
): Promise<AuthResult> {
	const config = getServerConfig();
	const emailCheck = validateEmail(emailRaw);
	if (!emailCheck.ok) {
		return { user: null, error: { code: 'invalid_input', message: emailCheck.message, field: 'email' } };
	}
	const email = normalizeEmail(emailRaw);

	if (config.authMode === 'supabase') {
		const client = supabaseClient(cookies);
		const { error } = await client.auth.signInWithPassword({ email, password });
		if (error) {
			// Do not disclose whether the account exists.
			return {
				user: null,
				error: { code: 'unauthenticated', message: 'Email or password is incorrect.', field: 'password' }
			};
		}
		return { user: await resolveUser(cookies), error: null };
	}

	if (config.authMode === 'local-dev') {
		const rows = await asService(async (tx) => {
			return await tx<{ user_id: string; password_hash: string; salt: string; kdf_params: { N: number; r: number; p: number; keylen: number } }[]>`
				select c.user_id, c.password_hash, c.salt, c.kdf_params
				from dev_auth.credentials c
				join auth.users u on u.id = c.user_id
				where u.email = ${email}
			`;
		});
		const row = rows[0];
		const ok = row
			? await verifyPassword(password, row.password_hash, row.salt, row.kdf_params)
			: // Perform comparable work for unknown accounts to reduce timing disclosure.
				await verifyPassword(password, '00'.repeat(64), '00'.repeat(16));

		if (!row || !ok) {
			return {
				user: null,
				error: { code: 'unauthenticated', message: 'Email or password is incorrect.', field: 'password' }
			};
		}
		await issueDevSession(cookies, row.user_id);
		return { user: await resolveUser(cookies), error: null };
	}

	return {
		user: null,
		error: { code: 'internal', message: 'No authentication provider is configured. See docs/ENVIRONMENT.md.' }
	};
}

export async function signUp(
	cookies: Cookies,
	emailRaw: string,
	password: string
): Promise<AuthResult & { needsEmailConfirmation?: boolean }> {
	const config = getServerConfig();
	const emailCheck = validateEmail(emailRaw);
	if (!emailCheck.ok) {
		return { user: null, error: { code: 'invalid_input', message: emailCheck.message, field: 'email' } };
	}
	const passwordCheck = validatePassword(password);
	if (!passwordCheck.ok) {
		return { user: null, error: { code: 'invalid_input', message: passwordCheck.message, field: 'password' } };
	}
	const email = normalizeEmail(emailRaw);

	if (config.authMode === 'supabase') {
		const client = supabaseClient(cookies);
		const { data, error } = await client.auth.signUp({ email, password });
		if (error) {
			return { user: null, error: { code: 'conflict', message: 'Could not create that account. Try signing in instead.' } };
		}
		// No session means Supabase requires email confirmation.
		if (!data.session) {
			return { user: null, error: null, needsEmailConfirmation: true };
		}
		return { user: await resolveUser(cookies), error: null };
	}

	if (config.authMode === 'local-dev') {
		const existing = await asService(async (tx) => {
			return await tx<{ id: string }[]>`select id from auth.users where email = ${email}`;
		});
		if (existing.length > 0) {
			return {
				user: null,
				error: { code: 'conflict', message: 'An account with that email already exists. Sign in instead.', field: 'email' }
			};
		}

		const hashed = await hashPassword(password);
		const created = await asService(async (tx) => {
			// The dev cluster has no mail transport; mark verified so the slice is usable.
			// This is a DEVELOPMENT convenience and is never done in the Supabase path.
			const users = await tx<{ id: string }[]>`
				insert into auth.users (email, email_confirmed_at)
				values (${email}, now()) returning id
			`;
			const userId = users[0]!.id;
			await tx`
				insert into dev_auth.credentials (user_id, password_hash, salt, kdf_params)
				values (${userId}, ${hashed.hash}, ${hashed.salt}, ${tx.json(hashed.params as unknown as postgres.JSONValue)})
			`;
			return userId;
		});
		await issueDevSession(cookies, created);
		return { user: await resolveUser(cookies), error: null };
	}

	return {
		user: null,
		error: { code: 'internal', message: 'No authentication provider is configured. See docs/ENVIRONMENT.md.' }
	};
}

export async function signOut(cookies: Cookies): Promise<void> {
	const config = getServerConfig();
	if (config.authMode === 'supabase') {
		try {
			await supabaseClient(cookies).auth.signOut();
		} catch {
			// Cookie clearing below still ends the local session.
		}
		return;
	}
	const token = cookies.get(DEV_SESSION_COOKIE);
	if (token) {
		const tokenHash = hashToken(token);
		try {
			await asService(async (tx) => {
				await tx`update dev_auth.sessions set revoked_at = now() where token_hash = ${tokenHash}`;
			});
		} catch {
			// Best effort; the cookie is removed regardless.
		}
		cookies.delete(DEV_SESSION_COOKIE, { path: '/' });
	}
}

/**
 * Exchange an auth code from a confirmation / OAuth / magic-link redirect for a session.
 *
 * Only the Supabase provider issues such codes. The development provider signs users in
 * directly, so a code arriving there is meaningless and is rejected rather than ignored.
 */
export async function exchangeAuthCode(cookies: Cookies, code: string): Promise<AuthResult> {
	const config = getServerConfig();
	if (config.authMode !== 'supabase') {
		return {
			user: null,
			error: { code: 'invalid_input', message: 'This sign-in link is not valid for this server.' }
		};
	}
	try {
		const { error } = await supabaseClient(cookies).auth.exchangeCodeForSession(code);
		if (error) {
			return {
				user: null,
				error: { code: 'invalid_input', message: 'That sign-in link has expired or was already used.' }
			};
		}
		return { user: await resolveUser(cookies), error: null };
	} catch {
		return {
			user: null,
			error: { code: 'internal', message: 'Could not complete sign-in. Please try again.' }
		};
	}
}
