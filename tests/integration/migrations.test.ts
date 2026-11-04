import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDatabase, createUser, asUser, type TestDatabase } from '../helpers/database';
import { policy } from '../../src/lib/config/policy';

describe('migrations', () => {
	let db: TestDatabase;

	beforeAll(async () => {
		db = await startTestDatabase();
	});

	afterAll(async () => {
		await db?.stop();
	});

	it('applies every migration against real PostgreSQL', async () => {
		const rows = await db.admin<{ name: string }[]>`
			select name from public.schema_migrations order by name
		`;
		expect(rows.length).toBeGreaterThanOrEqual(6);
		expect(rows.map((r) => r.name)).toContain('0003_session_passes.sql');
	});

	it('is idempotent when re-run', async () => {
		const { migrate } = await import('../../scripts/migrate');
		const result = await migrate(db.admin, { withAuthShim: true });
		expect(result.applied).toEqual([]);
		expect(result.skipped.length).toBeGreaterThanOrEqual(6);
	});

	it('creates a profile automatically on signup, with no public identity', async () => {
		const user = await createUser(db);
		const rows = await db.admin`
			select nickname, nickname_confirmed_public_at, account_state
			from public.profiles where id = ${user.id}
		`;
		expect(rows[0]!.nickname).toBeNull();
		expect(rows[0]!.nickname_confirmed_public_at).toBeNull();
		expect(rows[0]!.account_state).toBe('active');
	});

	it('defaults public display to anonymous without exposing the account id', async () => {
		const user = await createUser(db);
		const rows = await db.admin<{ display: string }[]>`
			select public.public_display_name(${user.id}) as display
		`;
		expect(rows[0]!.display).toBe('Anonymous contributor');
	});

	it('enables row-level security on every application table', async () => {
		const rows = await db.admin<{ tablename: string; rowsecurity: boolean }[]>`
			select tablename, rowsecurity from pg_tables
			where schemaname = 'public' and tablename <> 'schema_migrations'
		`;
		expect(rows.length).toBeGreaterThan(20);
		const unprotected = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
		// schema_contracts / policy_versions / consent_purposes / retention_classes /
		// feature_flags are global reference data, readable but not user-scoped.
		const allowedReference = new Set([
			'schema_contracts',
			'policy_versions',
			'consent_purposes',
			'retention_classes',
			'feature_flags'
		]);
		expect(unprotected.filter((t) => !allowedReference.has(t))).toEqual([]);
	});

	it('keeps surprise drops and billing disabled pending legal review', async () => {
		const rows = await db.admin<{ key: string; enabled: boolean }[]>`
			select key, enabled from public.feature_flags
			where key in ('surprise_drops','stripe_billing','automated_restrictions')
		`;
		expect(rows.every((r) => r.enabled === false)).toBe(true);
	});

	it('refuses to enable a legally-gated flag without recorded review', async () => {
		await expect(
			db.admin`update public.feature_flags set enabled = true where key = 'surprise_drops'`
		).rejects.toThrow(/legal_review_gate/);
	});

	it('exposes the seeded policy to the database so client and server agree', async () => {
		const rows = await db.admin<{ payload: { pass: { basePassesPerWindow: number } } }[]>`
			select public.active_policy() as payload
		`;
		expect(rows[0]!.payload.pass.basePassesPerWindow).toBe(6);
	});

	/**
	 * Drift guard. The TypeScript module supplies the typed shape and the seed; the database
	 * row is authoritative at runtime. If they diverge, the client would display one rule
	 * while the server enforced another — the exact failure mode the brief warns about.
	 * This compares EVERY field recursively, not a sample.
	 */
	it('the entire seeded policy matches the TypeScript policy exactly', async () => {
		const rows = await db.admin<{ payload: { version: string } }[]>`
			select public.active_policy() as payload
		`;
		const remote = rows[0]!.payload;

		expect(remote.version).toBe(policy.version);

		const differences: string[] = [];
		const compare = (local: unknown, dbValue: unknown, path: string): void => {
			if (Array.isArray(local)) {
				if (!Array.isArray(dbValue)) {
					differences.push(`${path}: expected an array, got ${typeof dbValue}`);
					return;
				}
				if (local.length !== dbValue.length) {
					differences.push(`${path}: length ${local.length} vs ${dbValue.length}`);
					return;
				}
				local.forEach((item, i) => compare(item, dbValue[i], `${path}[${i}]`));
				return;
			}
			if (local !== null && typeof local === 'object') {
				if (dbValue === null || typeof dbValue !== 'object' || Array.isArray(dbValue)) {
					differences.push(`${path}: expected an object in the database`);
					return;
				}
				const dbRecord = dbValue as Record<string, unknown>;
				for (const [key, value] of Object.entries(local)) {
					if (!(key in dbRecord)) {
						differences.push(`${path}.${key}: missing from the database policy`);
						continue;
					}
					compare(value, dbRecord[key], path ? `${path}.${key}` : key);
				}
				for (const key of Object.keys(dbRecord)) {
					if (!(key in (local as Record<string, unknown>))) {
						differences.push(`${path}.${key}: present in the database but not in policy.ts`);
					}
				}
				return;
			}
			if (local !== dbValue) {
				differences.push(`${path}: ${JSON.stringify(local)} vs ${JSON.stringify(dbValue)}`);
			}
		};

		compare(policy, remote, '');
		expect(differences, differences.join('\n')).toEqual([]);
	});

	it('rejects a non-owner reading another profile through RLS', async () => {
		const a = await createUser(db);
		const b = await createUser(db);
		const visible = await asUser(db, a.id, async (tx) => {
			return await tx`select id from public.profiles where id = ${b.id}`;
		});
		expect(visible).toHaveLength(0);
	});
});
