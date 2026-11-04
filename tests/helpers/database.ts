/**
 * Integration-test database harness.
 *
 * Spins up a REAL PostgreSQL cluster (embedded-postgres) rather than mocking the
 * database. This matters: RLS policies, SECURITY DEFINER behaviour, advisory locks and
 * concurrent pass issuance can only be meaningfully verified against real Postgres.
 *
 * Tests run as the `authenticated` role with a per-connection JWT subject, exactly as
 * Supabase does, so RLS is genuinely exercised rather than bypassed by a superuser.
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../scripts/migrate';
import { policy } from '../../src/lib/config/policy';

export interface TestDatabase {
	readonly url: string;
	/** Superuser connection: setup/teardown and privileged assertions only. */
	readonly admin: postgres.Sql;
	readonly port: number;
	stop(): Promise<void>;
}

let portCounter = 55_500 + Math.floor(Math.random() * 400);

export async function startTestDatabase(): Promise<TestDatabase> {
	const databaseDir = await mkdtemp(join(tmpdir(), 'rp-pg-'));
	const port = portCounter++;

	const cluster = new EmbeddedPostgres({
		databaseDir,
		user: 'rp_admin',
		password: 'rp_admin',
		port,
		persistent: true,
		// Keep the cluster quiet; tests assert on data, not logs.
		onLog: () => {},
		onError: () => {}
	});

	await cluster.initialise();
	await cluster.start();
	await cluster.createDatabase('reactionplayer_test');

	const url = `postgres://rp_admin:rp_admin@127.0.0.1:${port}/reactionplayer_test`;
	const admin = postgres(url, { max: 4, onnotice: () => {} });

	// The application roles must not be superusers, or RLS would be bypassed and the
	// isolation tests would prove nothing.
	await migrate(admin, { withAuthShim: true });

	// Seed the active policy from the TypeScript defaults so DB and client agree.
	await admin`
		insert into public.policy_versions (version, payload, status, activated_at, notes)
		values (
			${policy.version},
			${admin.json(policy as unknown as postgres.JSONValue)},
			'active', now(), 'Seeded from src/lib/config/policy.ts for tests'
		)
		on conflict (version) do update set payload = excluded.payload
	`;

	// Grant table privileges to the application roles (RLS still constrains rows).
	await admin.unsafe(`
		grant select, insert, update, delete on all tables in schema public to authenticated;
		grant usage, select on all sequences in schema public to authenticated;
		grant all on all tables in schema public to service_role;
		grant usage, select on all sequences in schema public to service_role;
	`);

	return {
		url,
		admin,
		port,
		async stop() {
			await admin.end({ timeout: 5 });
			await cluster.stop();
			await rm(databaseDir, { recursive: true, force: true });
		}
	};
}

/** Create an auth user + profile, returning its id. */
export async function createUser(
	db: TestDatabase,
	email = `${randomUUID()}@example.test`
): Promise<{ id: string; email: string }> {
	const rows = await db.admin<{ id: string }[]>`
		insert into auth.users (email, email_confirmed_at)
		values (${email}, now())
		returning id
	`;
	const id = rows[0]!.id;
	// The signup trigger creates the profile; assert it did.
	const profile = await db.admin`select id from public.profiles where id = ${id}`;
	if (profile.length === 0) throw new Error('signup trigger did not create a profile');
	return { id, email };
}

/**
 * A connection acting as `authenticated` with the given user as JWT subject.
 *
 * `set role` is applied per session; `request.jwt.claim.sub` is what auth.uid() reads.
 * Because the role is NOT a superuser and does not have BYPASSRLS, every policy applies.
 */
export async function connectAs(
	db: TestDatabase,
	userId: string,
	options: { max?: number } = {}
): Promise<postgres.Sql> {
	const sql = postgres(db.url, {
		max: options.max ?? 2,
		onnotice: () => {},
		// Applied to every new physical connection in the pool.
		connection: {
			}
	});

	// Reserve a single connection when max=1 so SET ROLE persists for the caller.
	await sql.unsafe(`set role authenticated`);
	await sql.unsafe(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
	return sql;
}

/**
 * Run a callback inside a transaction scoped to a user identity.
 * Preferred for concurrent tests: each call gets its own connection and its own
 * transaction-scoped identity, so advisory locks behave exactly as in production.
 */
export async function asUser<T>(
	db: TestDatabase,
	userId: string,
	fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
	const sql = postgres(db.url, { max: 1, onnotice: () => {} });
	try {
		return await sql.begin(async (tx) => {
			await tx.unsafe(`set local role authenticated`);
			await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
			return await fn(tx);
		}) as T;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

/** Run a callback as service_role (trusted server operations). */
export async function asService<T>(
	db: TestDatabase,
	fn: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
	const sql = postgres(db.url, { max: 1, onnotice: () => {} });
	try {
		return await sql.begin(async (tx) => {
			await tx.unsafe(`set local role service_role`);
			return await fn(tx);
		}) as T;
	} finally {
		await sql.end({ timeout: 5 });
	}
}

/** Move an existing pass's timestamps to simulate elapsed time. Admin-only. */
export async function agePass(
	db: TestDatabase,
	passId: string,
	hoursAgo: number
): Promise<void> {
	// Multiply an interval rather than make_interval(hours => ...), which requires an
	// integer and would reject fractional hours used for boundary tests.
	await db.admin`
		update public.session_passes
		set issued_at = now() - (${hoursAgo} * interval '1 hour'),
		    expires_at = now() - (${hoursAgo} * interval '1 hour') + interval '24 hours'
		where id = ${passId}
	`;
}

export async function grantPro(
	db: TestDatabase,
	userId: string,
	hours = 24
): Promise<string> {
	const rows = await db.admin<{ id: string }[]>`
		insert into public.entitlement_grants (user_id, tier, source, starts_at, ends_at)
		values (${userId}, 'pro', 'manual', now(), now() + make_interval(hours => ${hours}))
		returning id
	`;
	return rows[0]!.id;
}
