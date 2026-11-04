/**
 * Migration runner.
 *
 * Applies supabase/migrations/*.sql in filename order inside a transaction per file,
 * recording each in public.schema_migrations so re-running is a no-op.
 *
 * Targets a real PostgreSQL database (Supabase in production, an embedded cluster in
 * tests). Uses DATABASE_URL. Never runs against a browser-reachable credential.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'supabase', 'migrations');

export interface MigrationFile {
	readonly name: string;
	readonly sql: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
	const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
	const files: MigrationFile[] = [];
	for (const name of entries) {
		files.push({ name, sql: await readFile(join(dir, name), 'utf8') });
	}
	return files;
}

/**
 * Minimal Supabase `auth` shim for non-Supabase clusters (tests/local dev).
 *
 * On a real Supabase project these already exist and this is skipped. It exists so the
 * exact same migrations can be verified against a vanilla PostgreSQL cluster, which is
 * what makes RLS and concurrency testable without cloud credentials.
 */
export const AUTH_SHIM_SQL = `
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase: reads the sub claim from the request JWT settings.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    ),
    ''
  )::uuid;
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant select on auth.users to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant execute on functions to authenticated, service_role;
`;

export interface MigrateOptions {
	/** Install the Supabase auth shim (non-Supabase clusters only). */
	readonly withAuthShim?: boolean;
	readonly dir?: string;
	readonly log?: (message: string) => void;
}

export async function migrate(
	sql: postgres.Sql,
	options: MigrateOptions = {}
): Promise<{ applied: string[]; skipped: string[] }> {
	const log = options.log ?? (() => {});
	const applied: string[] = [];
	const skipped: string[] = [];

	await sql.unsafe(`
		create table if not exists public.schema_migrations (
			name text primary key,
			applied_at timestamptz not null default now(),
			checksum text not null
		);
	`);

	if (options.withAuthShim) {
		const exists = await sql`select to_regclass('auth.users') is not null as present`;
		if (!exists[0]?.present) {
			log('installing Supabase auth shim (non-Supabase cluster)');
			await sql.unsafe(AUTH_SHIM_SQL);
		}
	}

	const rows = await sql<{ name: string; checksum: string }[]>`
		select name, checksum from public.schema_migrations
	`;
	const seen = new Map(rows.map((r) => [r.name, r.checksum]));

	for (const file of await loadMigrations(options.dir)) {
		const checksum = await sha256(file.sql);
		const previous = seen.get(file.name);
		if (previous) {
			if (previous !== checksum) {
				throw new Error(
					`Migration ${file.name} has changed after being applied. ` +
						`Migrations are immutable once applied; add a new migration instead.`
				);
			}
			skipped.push(file.name);
			continue;
		}
		log(`applying ${file.name}`);
		// One transaction per migration: a failure leaves no partial schema.
		await sql.begin(async (tx) => {
			await tx.unsafe(file.sql);
			await tx`insert into public.schema_migrations (name, checksum) values (${file.name}, ${checksum})`;
		});
		applied.push(file.name);
	}

	return { applied, skipped };
}

async function sha256(text: string): Promise<string> {
	const { createHash } = await import('node:crypto');
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

// CLI entry point.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error('DATABASE_URL is required. See .env.example.');
		process.exit(1);
	}
	const isSupabase = /supabase\.(co|com)/.test(url);
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		const result = await migrate(sql, {
			withAuthShim: !isSupabase,
			log: (m) => console.log(`[migrate] ${m}`)
		});
		console.log(
			`[migrate] done: ${result.applied.length} applied, ${result.skipped.length} already present`
		);
	} catch (error) {
		console.error('[migrate] failed:', error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await sql.end({ timeout: 5 });
	}
}
