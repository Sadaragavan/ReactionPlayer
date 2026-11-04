import { describe, it, expect } from 'vitest';
import { planSamples, computeFingerprint } from '../../src/lib/media/fingerprint';
import { fingerprintPolicy } from '../../src/lib/config/policy';
import { assessReselectedFile } from '../../src/lib/persistence/file-handles';
import { validateWallpaperFile, validateWallpaperUrl } from '../../src/lib/persistence/settings';
import {
	checkRateLimit,
	RATE_LIMITS,
	enforceRateLimit,
	configureRateLimits,
	resetRateLimits
} from '../../src/lib/server/services/rate-limit';
import { requireStaff } from '../../src/lib/server/services/staff-service';
import { AppError, toStructuredError } from '../../src/lib/contracts/errors';
import type { SessionUser } from '../../src/lib/contracts/auth';
import { validatePassword, validateEmail, normalizeEmail } from '../../src/lib/server/auth/password';
import { safeRelativePath } from '../../src/lib/server/safe-redirect';

describe('sampled fingerprinting', () => {
	it('hashes a small file exhaustively in one chunk', () => {
		const samples = planSamples(1024);
		expect(samples).toHaveLength(1);
		expect(samples[0]).toEqual({ position: 'first', offsetBytes: 0, lengthBytes: 1024 });
	});

	it('samples first/middle/last for a large file without reading it all', () => {
		const size = 4 * 1024 * 1024 * 1024; // 4 GiB
		const samples = planSamples(size);
		expect(samples.map((s) => s.position)).toEqual(['first', 'middle', 'last']);
		const totalRead = samples.reduce((sum, s) => sum + s.lengthBytes, 0);
		// Only ~192 KiB read from a 4 GiB file.
		expect(totalRead).toBeLessThanOrEqual(fingerprintPolicy.chunkBytes * 3);
		expect(totalRead).toBeGreaterThan(0);
	});

	it('never samples beyond the end of the file', () => {
		for (const size of [1, 1024, 8 * 1024 * 1024 + 1, 100 * 1024 * 1024, 5 * 1024 ** 3]) {
			for (const sample of planSamples(size)) {
				expect(sample.offsetBytes).toBeGreaterThanOrEqual(0);
				expect(sample.offsetBytes + sample.lengthBytes).toBeLessThanOrEqual(size);
			}
		}
	});

	it('de-duplicates overlapping samples just above the exhaustive threshold', () => {
		const size = fingerprintPolicy.fullHashCeilingBytes + 1;
		const samples = planSamples(size);
		const keys = samples.map((s) => `${s.offsetBytes}:${s.lengthBytes}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('produces a stable digest for identical content', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const read = async () => bytes.buffer as ArrayBuffer;
		const a = await computeFingerprint(5, read, 1000);
		const b = await computeFingerprint(5, read, 2000);
		expect(a.digest).toBe(b.digest);
		expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(a.exhaustive).toBe(true);
	});

	it('changes the digest when the file size changes', async () => {
		const read = async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
		const a = await computeFingerprint(3, read);
		const b = await computeFingerprint(4, read);
		expect(a.digest).not.toBe(b.digest);
	});

	it('changes the digest when sampled content changes', async () => {
		const a = await computeFingerprint(3, async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
		const b = await computeFingerprint(3, async () => new Uint8Array([1, 2, 4]).buffer as ArrayBuffer);
		expect(a.digest).not.toBe(b.digest);
	});

	it('records the scheme version so a future scheme cannot collide', async () => {
		const result = await computeFingerprint(3, async () => new Uint8Array([1]).buffer as ArrayBuffer);
		expect(result.schemeVersion).toBe(fingerprintPolicy.schemeVersion);
	});
});

describe('reselected file assessment', () => {
	const hint = { fileName: 'episode.mkv', sizeBytes: 1000, fingerprintDigest: 'abc' };

	it('accepts a matching fingerprint without a warning', () => {
		const file = new File([new Uint8Array(1000)], 'renamed.mkv');
		const result = assessReselectedFile(file, hint, 'abc');
		expect(result.matches).toBe(true);
		expect(result.warning).toBeNull();
	});

	it('accepts a size match when no fingerprint is available', () => {
		const file = new File([new Uint8Array(1000)], 'other.mkv');
		expect(assessReselectedFile(file, hint, null).matches).toBe(true);
	});

	it('warns but allows a name match with a different size (re-encode)', () => {
		const file = new File([new Uint8Array(500)], 'episode.mkv');
		const result = assessReselectedFile(file, hint, 'different');
		expect(result.matches).toBe(true);
		expect(result.warning).toMatch(/different encode/i);
	});

	it('flags a clearly different file without blocking the user', () => {
		const file = new File([new Uint8Array(50)], 'something-else.mp4');
		const result = assessReselectedFile(file, hint, 'different');
		expect(result.matches).toBe(false);
		expect(result.warning).toMatch(/does not look like/i);
	});
});

describe('wallpaper validation', () => {
	it('accepts the documented image types', () => {
		for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
			expect(validateWallpaperFile(new File([new Uint8Array(10)], 'w', { type })).ok).toBe(true);
		}
	});

	it('rejects other types and oversized files', () => {
		expect(validateWallpaperFile(new File([], 'w.svg', { type: 'image/svg+xml' })).ok).toBe(false);
		const big = new File([new Uint8Array(13 * 1024 * 1024)], 'w.png', { type: 'image/png' });
		expect(validateWallpaperFile(big).ok).toBe(false);
	});

	it('accepts https and rejects insecure or non-image URLs', () => {
		expect(validateWallpaperUrl('https://example.com/a.jpg').ok).toBe(true);
		expect(validateWallpaperUrl('http://example.com/a.jpg').ok).toBe(false);
		expect(validateWallpaperUrl('javascript:alert(1)').ok).toBe(false);
		expect(validateWallpaperUrl('data:text/html,<script>').ok).toBe(false);
		expect(validateWallpaperUrl('data:image/png;base64,AAA').ok).toBe(true);
		expect(validateWallpaperUrl('not a url').ok).toBe(false);
	});
});

describe('rate limiting', () => {
	it('allows up to capacity then refuses', () => {
		const rule = { capacity: 3, refillPerSecond: 1 / 60 };
		const key = `test-${Math.random()}`;
		expect(checkRateLimit(key, rule, 0).allowed).toBe(true);
		expect(checkRateLimit(key, rule, 0).allowed).toBe(true);
		expect(checkRateLimit(key, rule, 0).allowed).toBe(true);
		const fourth = checkRateLimit(key, rule, 0);
		expect(fourth.allowed).toBe(false);
		expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
	});

	it('refills over time', () => {
		const rule = { capacity: 1, refillPerSecond: 1 };
		const key = `test-${Math.random()}`;
		expect(checkRateLimit(key, rule, 0).allowed).toBe(true);
		expect(checkRateLimit(key, rule, 0).allowed).toBe(false);
		expect(checkRateLimit(key, rule, 1000).allowed).toBe(true);
	});

	it('keeps separate buckets per key', () => {
		const rule = { capacity: 1, refillPerSecond: 0.001 };
		expect(checkRateLimit('a-' + Math.random(), rule, 0).allowed).toBe(true);
		expect(checkRateLimit('b-' + Math.random(), rule, 0).allowed).toBe(true);
	});

	it('defines conservative limits for sensitive endpoints', () => {
		expect(RATE_LIMITS.signUp.capacity).toBeLessThanOrEqual(RATE_LIMITS.signIn.capacity);
		expect(RATE_LIMITS.passIssue.capacity).toBeGreaterThan(0);
	});

	it('throws a structured 429 with a retry hint when exceeded', () => {
		resetRateLimits();
		const rule = { capacity: 1, refillPerSecond: 1 / 60 };
		enforceRateLimit('enforce-test', rule);
		try {
			enforceRateLimit('enforce-test', rule);
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(AppError);
			expect((error as AppError).status).toBe(429);
			expect((error as AppError).toJSON().details?.retryAfterSeconds).toBeGreaterThan(0);
		}
	});

	it('scales capacity outside production so repeated test runs are possible', () => {
		resetRateLimits();
		configureRateLimits({ multiplier: 10, isProduction: false });
		const rule = { capacity: 2, refillPerSecond: 1 / 3600 };
		for (let i = 0; i < 20; i++) enforceRateLimit('scaled-dev', rule);
		expect(() => enforceRateLimit('scaled-dev', rule)).toThrow(AppError);
	});

	it('REFUSES to scale limits in production, whatever is configured', () => {
		resetRateLimits();
		configureRateLimits({ multiplier: 1000, isProduction: true });
		const rule = { capacity: 2, refillPerSecond: 1 / 3600 };
		enforceRateLimit('prod-guard', rule);
		enforceRateLimit('prod-guard', rule);
		expect(() => enforceRateLimit('prod-guard', rule)).toThrow(AppError);
	});

	it('ignores a non-finite or sub-unit multiplier', () => {
		for (const multiplier of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 0.5]) {
			resetRateLimits();
			configureRateLimits({ multiplier, isProduction: false });
			const rule = { capacity: 1, refillPerSecond: 1 / 3600 };
			enforceRateLimit(`invalid-${multiplier}`, rule);
			expect(() => enforceRateLimit(`invalid-${multiplier}`, rule)).toThrow(AppError);
		}
		resetRateLimits();
	});
});

describe('staff authorization', () => {
	const base: SessionUser = {
		id: '11111111-1111-1111-1111-111111111111',
		email: 'staff@example.test',
		emailVerified: true,
		nickname: null,
		staffRoles: ['moderator'],
		assuranceLevel: 'aal2'
	};

	it('refuses an unauthenticated caller', () => {
		expect(() => requireStaff(null, 'verify_tag_claim')).toThrow(AppError);
	});

	it('refuses a non-staff user', () => {
		expect(() => requireStaff({ ...base, staffRoles: [] }, 'verify_tag_claim')).toThrow(
			/permission/
		);
	});

	it('requires MFA for privileged access', () => {
		expect(() => requireStaff({ ...base, assuranceLevel: 'aal1' }, 'verify_tag_claim')).toThrow(
			/Two-factor/
		);
	});

	it('fails closed when assurance level is unknown (dev provider)', () => {
		expect(() => requireStaff({ ...base, assuranceLevel: 'unknown' }, 'verify_tag_claim')).toThrow(
			/Two-factor/
		);
	});

	it('enforces least privilege: support cannot verify claims', () => {
		expect(() =>
			requireStaff({ ...base, staffRoles: ['support'] }, 'verify_tag_claim')
		).toThrow(/permission/);
	});

	it('allows a moderator to verify a claim', () => {
		expect(requireStaff(base, 'verify_tag_claim')).toBe('moderator');
	});

	it('blocks judging your own claim', () => {
		expect(() =>
			requireStaff(base, 'verify_tag_claim', { subjectUserId: base.id })
		).toThrow(/own claims/);
	});

	it('blocks granting yourself benefits', () => {
		const admin: SessionUser = { ...base, staffRoles: ['admin'] };
		expect(() => requireStaff(admin, 'grant_passes', { subjectUserId: admin.id })).toThrow(
			/own claims/
		);
	});

	it('allows acting on a different user', () => {
		expect(
			requireStaff(base, 'verify_tag_claim', {
				subjectUserId: '22222222-2222-2222-2222-222222222222'
			})
		).toBe('moderator');
	});

	it('requires a second approver or a recorded solo-operator exception for high-risk actions', () => {
		const owner: SessionUser = { ...base, staffRoles: ['owner'] };
		expect(() => requireStaff(owner, 'manage_policy')).toThrow(/second approver/);
		expect(
			requireStaff(owner, 'manage_policy', {
				soloFounderException: { acknowledgedBy: owner.id, reason: 'Single operator during alpha' }
			})
		).toBe('owner');
	});

	it('returns the highest held role for the audit record', () => {
		expect(requireStaff({ ...base, staffRoles: ['support', 'admin'] }, 'grant_passes')).toBe('admin');
	});
});

describe('structured errors', () => {
	it('maps codes to appropriate HTTP statuses', () => {
		expect(new AppError('unauthenticated', 'x').status).toBe(401);
		expect(new AppError('forbidden', 'x').status).toBe(403);
		expect(new AppError('quota_exhausted', 'x').status).toBe(429);
		expect(new AppError('invalid_input', 'x').status).toBe(400);
	});

	it('never leaks internal error messages to the client', () => {
		const leaky = new Error('relation "secret_table" does not exist; password=hunter2');
		const structured = toStructuredError(leaky);
		expect(structured.message).toBe('Something went wrong. Please try again.');
		expect(JSON.stringify(structured)).not.toContain('hunter2');
		expect(JSON.stringify(structured)).not.toContain('secret_table');
	});

	it('preserves safe details on an AppError', () => {
		const error = new AppError('quota_exhausted', 'Used up', { nextAvailableAt: '2026-01-01' });
		expect(error.toJSON().details).toEqual({ nextAvailableAt: '2026-01-01' });
	});
});

describe('credential validation', () => {
	it('requires a reasonable minimum length without composition theatre', () => {
		expect(validatePassword('short').ok).toBe(false);
		expect(validatePassword('a long enough passphrase').ok).toBe(true);
		expect(validatePassword('x'.repeat(201)).ok).toBe(false);
	});

	it('does NOT strip dots or plus-aliases from emails', () => {
		// Stripping these would merge distinct mailboxes on some providers (§9).
		expect(normalizeEmail('A.B+tag@Example.com')).toBe('a.b+tag@example.com');
		expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
		expect(normalizeEmail('a.b@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
	});

	it('validates email shape permissively', () => {
		expect(validateEmail('user@example.com').ok).toBe(true);
		expect(validateEmail('no-at-sign').ok).toBe(false);
		expect(validateEmail('user@localhost').ok).toBe(false);
		expect(validateEmail('a b@example.com').ok).toBe(false);
	});
});

describe('open-redirect guard', () => {
	const hostile = [
		'https://evil.example/path',
		'http://evil.example',
		'//evil.example/path',
		'/\\evil.example',
		'\\/evil.example',
		'/\tevil.example',
		'/\nSet-Cookie: a=b',
		'/\u0000evil',
		'/\u007fevil',
		'javascript:alert(1)',
		'  /leading-space',
		'/trailing-space ',
		'evil.example',
		''
	];

	for (const value of hostile) {
		it(`rejects ${JSON.stringify(value)}`, () => {
			expect(safeRelativePath(value)).toBe('/');
		});
	}

	it('falls back to a caller-supplied default', () => {
		expect(safeRelativePath('//evil.example', '/settings')).toBe('/settings');
		expect(safeRelativePath(null, '/settings')).toBe('/settings');
		expect(safeRelativePath(undefined)).toBe('/');
	});

	for (const value of ['/', '/sessions', '/session?resumed=1', '/settings#privacy', '/a/b?c=d&e=f']) {
		it(`accepts ${JSON.stringify(value)}`, () => {
			expect(safeRelativePath(value)).toBe(value);
		});
	}
});
