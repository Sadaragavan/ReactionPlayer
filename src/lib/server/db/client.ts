/**
 * Trusted-server database access with genuine RLS enforcement.
 *
 * DESIGN: a single code path for both Supabase and local development.
 *
 * Supabase exposes a standard Postgres connection string, so we connect directly and
 * impersonate the request's identity per transaction:
 *
 *   set local role authenticated;
 *   select set_config('request.jwt.claim.sub', <user id>, true);
 *
 * `authenticated` is NOT a superuser and has no BYPASSRLS, so every row-level policy
 * applies exactly as it does through Supabase's REST API. auth.uid() reads that claim.
 *
 * This means:
 *   - No service-role key is needed for ordinary user operations.
 *   - A bug in a query cannot silently read another user's rows: RLS still blocks it.
 *   - Privileged work must explicitly opt into `asService`, which is auditable.
 *
 * CONNECTION POOL IS MODULE-SCOPED AND STATELESS PER REQUEST. No per-user mutable state
 * lives in module globals (PROJECT_BRIEF.md §4); identity is bound per transaction only.
 */

import postgres from 'postgres';
import { building } from '$app/environment';
import { getServerConfig } from '../env';
import { AppError } from '../../contracts/errors';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

let pool: Sql | null = null;

function getPool(): Sql {
	if (pool) return pool;
	const config = getServerConfig();
	if (!config.databaseUrl) {
		throw new AppError(
			'internal',
			'The service is not configured yet. See docs/ENVIRONMENT.md for setup steps.'
		);
	}
	pool = postgres(config.databaseUrl, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10,
		onnotice: () => {},
		// Fail fast rather than queueing forever during an outage.
		max_lifetime: 60 * 30
	});
	return pool;
}

/**
 * Run `fn` inside a transaction bound to a user identity, with RLS enforced.
 *
 * The SET LOCAL is transaction-scoped, so a pooled connection can never leak a previous
 * request's identity into the next request.
 */
export async function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
	if (!userId) throw new AppError('unauthenticated', 'Sign in to continue.');
	assertUuid(userId);
	const sql = getPool();
	return (await sql.begin(async (tx) => {
		await tx.unsafe(`set local role authenticated`);
		await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
		return await fn(tx);
	})) as T;
}

/**
 * Run `fn` as service_role. Bypasses RLS — use ONLY for trusted operations that cannot
 * be expressed as the user (bonus grants, audit appends, webhook processing).
 *
 * Every call site should be justifiable and, where consequential, audited.
 */
export async function asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
	const sql = getPool();
	return (await sql.begin(async (tx) => {
		await tx.unsafe(`set local role service_role`);
		return await fn(tx);
	})) as T;
}

/** Read-only helper for unprivileged reference data (policy, feature flags). */
export async function asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
	const sql = getPool();
	return (await sql.begin(async (tx) => {
		await tx.unsafe(`set local role anon`);
		return await fn(tx);
	})) as T;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Guard before interpolating an id into a SET LOCAL statement. */
export function assertUuid(value: string): void {
	if (!isUuid(value)) {
		throw new AppError('invalid_input', 'Malformed identifier.');
	}
}

export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end({ timeout: 5 });
		pool = null;
	}
}

/** Health probe used by the setup screen and operational checks. */
export async function checkDatabase(): Promise<{ ok: boolean; message: string }> {
	if (building) return { ok: false, message: 'Build-time evaluation.' };
	try {
		const sql = getPool();
		const rows = await sql<{ ok: boolean }[]>`select true as ok`;
		if (!rows[0]?.ok) return { ok: false, message: 'Database did not respond.' };
		const migrated = await sql<{ present: boolean }[]>`
			select to_regclass('public.session_passes') is not null as present
		`;
		if (!migrated[0]?.present) {
			return { ok: false, message: 'Database reachable but migrations have not been applied.' };
		}
		return { ok: true, message: 'Database ready.' };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : 'Database unavailable.'
		};
	}
}

export type { Sql, Tx };
