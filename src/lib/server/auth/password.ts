/**
 * Password hashing for the LOCAL DEVELOPMENT auth provider.
 *
 * Production uses Supabase Auth, which manages credentials entirely outside this app.
 * This module exists so the development slice has real credential handling rather than
 * a fake "logged in" flag.
 *
 * scrypt with a per-user 16-byte random salt and a 64-byte derived key. Verification is
 * constant-time. Parameters are stored alongside the hash so they can be raised later.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
	password: string | Buffer,
	salt: string | Buffer,
	keylen: number,
	options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export interface PasswordHash {
	readonly hash: string;
	readonly salt: string;
	readonly kdf: 'scrypt';
	readonly params: typeof SCRYPT_PARAMS;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
	const salt = randomBytes(16).toString('hex');
	const derived = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'hex'), SCRYPT_PARAMS.keylen, {
		N: SCRYPT_PARAMS.N,
		r: SCRYPT_PARAMS.r,
		p: SCRYPT_PARAMS.p,
		maxmem: 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2
	});
	return {
		hash: derived.toString('hex'),
		salt,
		kdf: 'scrypt',
		params: SCRYPT_PARAMS
	};
}

export async function verifyPassword(
	password: string,
	storedHash: string,
	salt: string,
	params: { N: number; r: number; p: number; keylen: number } = SCRYPT_PARAMS
): Promise<boolean> {
	try {
		const derived = await scryptAsync(
			password.normalize('NFKC'),
			Buffer.from(salt, 'hex'),
			params.keylen,
			{
				N: params.N,
				r: params.r,
				p: params.p,
				maxmem: 128 * params.N * params.r * 2
			}
		);
		const expected = Buffer.from(storedHash, 'hex');
		if (expected.length !== derived.length) return false;
		return timingSafeEqual(expected, derived);
	} catch {
		return false;
	}
}

/**
 * Password policy. Deliberately modest and honest: length-based, no composition theatre,
 * and a generous maximum to avoid truncation surprises.
 */
export function validatePassword(password: string): { ok: true } | { ok: false; message: string } {
	if (password.length < 10) {
		return { ok: false, message: 'Use at least 10 characters.' };
	}
	if (password.length > 200) {
		return { ok: false, message: 'Use at most 200 characters.' };
	}
	return { ok: true };
}

/**
 * Email validation for sign-in/sign-up.
 *
 * IMPORTANT (PROJECT_BRIEF.md §9): we do NOT strip dots or plus-aliases. Normalizing
 * `a.b@gmail.com` to `ab@gmail.com` would merge distinct accounts on providers where
 * those are different mailboxes. Only case and surrounding whitespace are normalized.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validateEmail(email: string): { ok: true } | { ok: false; message: string } {
	const normalized = normalizeEmail(email);
	if (normalized.length > 254) return { ok: false, message: 'That email address is too long.' };
	// Intentionally permissive: authoritative validation is deliverability (confirmation email).
	if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalized)) {
		return { ok: false, message: 'Enter a valid email address.' };
	}
	return { ok: true };
}
