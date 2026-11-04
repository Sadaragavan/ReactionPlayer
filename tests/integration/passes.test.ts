/**
 * Pass metering tests (PROJECT_BRIEF.md §7, §8, §20).
 *
 * These run against REAL PostgreSQL with REAL concurrent connections. The advisory-lock
 * guarantee cannot be meaningfully verified with a mock or a single connection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
	startTestDatabase,
	createUser,
	asUser,
	asService,
	agePass,
	grantPro,
	type TestDatabase
} from '../helpers/database';

interface PassResult {
	outcome: string;
	pass_id: string | null;
	pair_key: string | null;
	issued_at: string | null;
	expires_at: string | null;
	tier: string;
	capacity_class: string | null;
	base_used: number;
	base_capacity: number;
	bonus_used: number;
	bonus_capacity: number;
	next_available_at: string | null;
	reason: string | null;
}

describe('session pass issuance', () => {
	let db: TestDatabase;
	let userId: string;

	beforeAll(async () => {
		db = await startTestDatabase();
	});

	afterAll(async () => {
		await db?.stop();
	});

	beforeEach(async () => {
		const user = await createUser(db);
		userId = user.id;
	});

	async function issue(
		uid: string,
		pairKey: string,
		requestId = randomUUID()
	): Promise<PassResult> {
		const rows = await asUser(db, uid, async (tx) => {
			return await tx<PassResult[]>`
				select * from public.issue_session_pass(
					${uid}::uuid, ${pairKey}, ${requestId}::uuid, 'physical'
				)
			`;
		});
		return rows[0]!;
	}

	it('issues a pass with a 24-hour lifetime', async () => {
		const result = await issue(userId, 'pair-a');
		expect(result.outcome).toBe('issued');
		expect(result.tier).toBe('free');
		expect(result.capacity_class).toBe('base');
		expect(result.base_used).toBe(1);
		expect(result.base_capacity).toBe(6);

		const lifetimeHours =
			(new Date(result.expires_at!).getTime() - new Date(result.issued_at!).getTime()) / 3_600_000;
		expect(lifetimeHours).toBeCloseTo(24, 5);
	});

	it('reuses an unexpired pass for the same pair without consuming another', async () => {
		const first = await issue(userId, 'pair-a');
		const second = await issue(userId, 'pair-a');

		expect(second.outcome).toBe('reused');
		expect(second.pass_id).toBe(first.pass_id);
		expect(second.reason).toBe('existing_pass');
		expect(second.base_used).toBe(1);

		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(1);
	});

	it('treats reload/resume/rewatch as free within the pass lifetime', async () => {
		const first = await issue(userId, 'pair-a');
		for (let i = 0; i < 5; i++) {
			const again = await issue(userId, 'pair-a');
			expect(again.outcome).toBe('reused');
			expect(again.pass_id).toBe(first.pass_id);
		}
		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(1);
	});

	it('is idempotent for a retried request id', async () => {
		const requestId = randomUUID();
		const first = await issue(userId, 'pair-a', requestId);
		const retry = await issue(userId, 'pair-a', requestId);

		expect(retry.pass_id).toBe(first.pass_id);
		expect(retry.reason).toBe('idempotent_retry');
		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(1);
	});

	it('does not allocate twice when the SAME request id arrives concurrently', async () => {
		const requestId = randomUUID();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => issue(userId, 'pair-race', requestId))
		);
		const ids = new Set(results.map((r) => r.pass_id));
		expect(ids.size).toBe(1);
		expect(results.filter((r) => r.outcome === 'issued')).toHaveLength(1);

		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(1);
	});

	it('never exceeds the base quota under concurrent distinct-pair requests', async () => {
		// 20 simultaneous requests for 20 different pairs against a quota of 6.
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => issue(userId, `pair-${i}`))
		);

		const issued = results.filter((r) => r.outcome === 'issued');
		const denied = results.filter((r) => r.outcome === 'denied');

		expect(issued).toHaveLength(6);
		expect(denied).toHaveLength(14);
		expect(denied.every((r) => r.reason === 'quota_exhausted')).toBe(true);

		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(6);
	});

	it('never duplicates a pass when the same NEW pair is requested concurrently', async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, () => issue(userId, 'pair-same'))
		);
		expect(results.filter((r) => r.outcome === 'issued')).toHaveLength(1);
		expect(results.filter((r) => r.outcome === 'reused')).toHaveLength(9);
		expect(new Set(results.map((r) => r.pass_id)).size).toBe(1);
	});

	it('returns an understandable next-availability time when exhausted', async () => {
		for (let i = 0; i < 6; i++) await issue(userId, `pair-${i}`);
		const denied = await issue(userId, 'pair-overflow');

		expect(denied.outcome).toBe('denied');
		expect(denied.next_available_at).not.toBeNull();
		const waitMs = new Date(denied.next_available_at!).getTime() - Date.now();
		// The oldest pass was just issued, so capacity frees up in ~24h.
		expect(waitMs).toBeGreaterThan(23.9 * 3_600_000);
		expect(waitMs).toBeLessThanOrEqual(24 * 3_600_000);
	});

	it('uses a true rolling window, not a calendar day', async () => {
		const first = await issue(userId, 'pair-old');
		// Age the first pass to just outside the 24h window.
		await agePass(db, first.pass_id!, 24.5);

		// Five more, filling the window to 5 (the aged one no longer counts).
		for (let i = 0; i < 5; i++) await issue(userId, `pair-new-${i}`);
		const sixth = await issue(userId, 'pair-sixth');
		expect(sixth.outcome).toBe('issued');
		expect(sixth.base_used).toBe(6);

		const seventh = await issue(userId, 'pair-seventh');
		expect(seventh.outcome).toBe('denied');
	});

	it('requires a new pass after the old one expires', async () => {
		const first = await issue(userId, 'pair-a');
		await agePass(db, first.pass_id!, 25);

		const again = await issue(userId, 'pair-a');
		expect(again.outcome).toBe('issued');
		expect(again.pass_id).not.toBe(first.pass_id);
	});

	it('reports an expired pass honestly on an idempotent retry', async () => {
		const requestId = randomUUID();
		const first = await issue(userId, 'pair-a', requestId);
		await agePass(db, first.pass_id!, 25);

		const retry = await issue(userId, 'pair-a', requestId);
		expect(retry.outcome).toBe('expired');
		expect(retry.reason).toBe('pass_expired');
		expect(retry.pass_id).toBe(first.pass_id);
	});

	it('honours the exact expiration boundary', async () => {
		const first = await issue(userId, 'pair-boundary');
		// expires_at is issued_at + 24h; aging by 23.99h leaves it valid.
		await agePass(db, first.pass_id!, 23.99);
		const stillValid = await issue(userId, 'pair-boundary');
		expect(stillValid.outcome).toBe('reused');

		await agePass(db, first.pass_id!, 24.01);
		const expired = await issue(userId, 'pair-boundary');
		expect(expired.outcome).toBe('issued');
	});

	it('isolates quotas between users', async () => {
		const other = await createUser(db);
		for (let i = 0; i < 6; i++) await issue(userId, `pair-${i}`);

		const exhausted = await issue(userId, 'pair-overflow');
		expect(exhausted.outcome).toBe('denied');

		const otherResult = await issue(other.id, 'pair-0');
		expect(otherResult.outcome).toBe('issued');
	});

	it('refuses to allocate passes for another account', async () => {
		const other = await createUser(db);
		await expect(
			asUser(db, userId, async (tx) => {
				return await tx`
					select * from public.issue_session_pass(
						${other.id}::uuid, 'pair-x', ${randomUUID()}::uuid, 'physical'
					)
				`;
			})
		).rejects.toThrow(/only allocate for themselves/);
	});

	it('prevents reading another user\'s passes through RLS', async () => {
		const other = await createUser(db);
		await issue(userId, 'pair-secret');
		const visible = await asUser(db, other.id, async (tx) => {
			return await tx`select * from public.session_passes where user_id = ${userId}`;
		});
		expect(visible).toHaveLength(0);
	});

	it('prevents a client from inserting a pass directly, bypassing quota', async () => {
		await expect(
			asUser(db, userId, async (tx) => {
				return await tx`
					insert into public.session_passes
						(user_id, pair_key, expires_at, request_id, policy_version)
					values
						(${userId}, 'pair-forged', now() + interval '24 hours', ${randomUUID()}, 'x')
				`;
			})
		).rejects.toThrow(/row-level security|permission denied/);
	});

	it('gives Pro unlimited passes while still recording them', async () => {
		await grantPro(db, userId);
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) => issue(userId, `pro-pair-${i}`))
		);
		expect(results.every((r) => r.outcome === 'issued')).toBe(true);
		expect(results.every((r) => r.tier === 'pro')).toBe(true);
		expect(results.every((r) => r.capacity_class === 'pro')).toBe(true);

		const count = await db.admin`
			select count(*)::int as n from public.session_passes where user_id = ${userId}
		`;
		expect(count[0]!.n).toBe(12);
	});

	it('reverts to metered behaviour when a Pro grant expires', async () => {
		const grantId = await grantPro(db, userId, 1);
		// Backdate the whole interval: the grant_interval_valid constraint correctly
		// rejects ends_at <= starts_at, so both ends must move together.
		await db.admin`
			update public.entitlement_grants
			set starts_at = now() - interval '2 hours',
			    ends_at = now() - interval '1 hour'
			where id = ${grantId}
		`;
		const result = await issue(userId, 'pair-after-expiry');
		expect(result.tier).toBe('free');
		expect(result.capacity_class).toBe('base');
	});

	it('denies passes to a suspended account with an accurate reason', async () => {
		await db.admin`update public.profiles set account_state = 'suspended' where id = ${userId}`;
		const result = await issue(userId, 'pair-suspended');
		expect(result.outcome).toBe('denied');
		expect(result.reason).toBe('account_not_active');
	});

	it('rejects a missing pair key or request id', async () => {
		await expect(
			asUser(db, userId, async (tx) => {
				return await tx`
					select * from public.issue_session_pass(${userId}::uuid, '', ${randomUUID()}::uuid, 'physical')
				`;
			})
		).rejects.toThrow(/pair_key is required/);

		await expect(
			asUser(db, userId, async (tx) => {
				return await tx`
					select * from public.issue_session_pass(${userId}::uuid, 'pair-x', null, 'physical')
				`;
			})
		).rejects.toThrow(/request_id is required/);
	});

	describe('tagging bonus', () => {
		async function grantBonus(uid: string, contributions: number) {
			return await asService(db, async (tx) => {
				return await tx`select * from public.grant_tagging_bonus(${uid}::uuid, ${contributions})`;
			});
		}

		it('does not grant a bonus below the contribution threshold', async () => {
			const rows = await grantBonus(userId, 3);
			expect(rows[0]!.id).toBeNull();
		});

		it('grants exactly two extra passes at four contributions', async () => {
			const rows = await grantBonus(userId, 4);
			expect(rows[0]!.passes_granted).toBe(2);

			// Exhaust the six base passes.
			for (let i = 0; i < 6; i++) await issue(userId, `pair-${i}`);
			const seventh = await issue(userId, 'pair-7');
			const eighth = await issue(userId, 'pair-8');
			const ninth = await issue(userId, 'pair-9');

			expect(seventh.outcome).toBe('issued');
			expect(seventh.capacity_class).toBe('bonus');
			expect(eighth.outcome).toBe('issued');
			expect(eighth.capacity_class).toBe('bonus');
			expect(ninth.outcome).toBe('denied');
		});

		it('grants the bonus exactly once per rolling window, even concurrently', async () => {
			const results = await Promise.all(Array.from({ length: 6 }, () => grantBonus(userId, 4)));
			const ids = new Set(results.map((r) => r[0]!.id));
			expect(ids.size).toBe(1);

			const count = await db.admin`
				select count(*)::int as n from public.tag_bonus_grants where user_id = ${userId}
			`;
			expect(count[0]!.n).toBe(1);
		});

		it('does not grant the bonus to a client directly', async () => {
			await expect(
				asUser(db, userId, async (tx) => {
					return await tx`select * from public.grant_tagging_bonus(${userId}::uuid, 99)`;
				})
			).rejects.toThrow(/permission denied/);
		});

		it('keeps already-issued passes valid after the bonus window closes', async () => {
			await grantBonus(userId, 4);
			for (let i = 0; i < 6; i++) await issue(userId, `pair-${i}`);
			const bonusPass = await issue(userId, 'pair-bonus');
			expect(bonusPass.capacity_class).toBe('bonus');

			// Close the bonus window but leave the pass itself unexpired.
			await db.admin`
				update public.tag_bonus_grants
				set window_ends_at = now() - interval '1 minute' where user_id = ${userId}
			`;

			const reused = await issue(userId, 'pair-bonus');
			expect(reused.outcome).toBe('reused');
			expect(reused.pass_id).toBe(bonusPass.pass_id);

			// New allocations no longer get bonus capacity.
			const afterWindow = await issue(userId, 'pair-after-window');
			expect(afterWindow.outcome).toBe('denied');
			expect(afterWindow.bonus_capacity).toBe(0);
		});
	});

	describe('pass status projection', () => {
		it('reports usage without allocating', async () => {
			await issue(userId, 'pair-a');
			const before = await db.admin`
				select count(*)::int as n from public.session_passes where user_id = ${userId}
			`;
			const rows = await asUser(db, userId, async (tx) => {
				return await tx<PassResult[]>`select * from public.pass_status(${userId}::uuid)`;
			});
			const after = await db.admin`
				select count(*)::int as n from public.session_passes where user_id = ${userId}
			`;
			expect(rows[0]!.base_used).toBe(1);
			expect(rows[0]!.base_capacity).toBe(6);
			expect(after[0]!.n).toBe(before[0]!.n);
		});

		it('refuses to report another user\'s status', async () => {
			const other = await createUser(db);
			await expect(
				asUser(db, userId, async (tx) => {
					return await tx`select * from public.pass_status(${other.id}::uuid)`;
				})
			).rejects.toThrow(/their own status/);
		});
	});
});
