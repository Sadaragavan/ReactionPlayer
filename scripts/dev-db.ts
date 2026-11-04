/**
 * Local development database bootstrap.
 *
 * Starts a REAL PostgreSQL cluster in ./.devdb, applies the Supabase migrations, installs
 * the development-only auth schema, and seeds the active policy from TypeScript.
 *
 * This lets the entire vertical slice run without cloud credentials, while exercising the
 * same SQL, RLS and atomic pass logic used against Supabase in production.
 *
 *   npm run db:setup:dev     # start + migrate + seed, then keep running
 *
 * For a Supabase project instead, set DATABASE_URL and run `npm run db:migrate`.
 */

import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.ts';
import { policy } from '../src/lib/config/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dataDir = join(root, '.devdb');
const portFile = join(root, '.devdb', 'port.json');

const PORT = Number(process.env.DEV_DB_PORT ?? 55_432);
const USER = 'rp_dev';
const PASSWORD = 'rp_dev';
const DATABASE = 'reactionplayer';

async function main() {
	const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
	await mkdir(dataDir, { recursive: true });

	const cluster = new EmbeddedPostgres({
		databaseDir: dataDir,
		user: USER,
		password: PASSWORD,
		port: PORT,
		persistent: true
	});

	if (fresh) {
		console.log('[dev-db] initialising a new PostgreSQL cluster in .devdb/');
		await cluster.initialise();
	}
	await cluster.start();
	console.log(`[dev-db] PostgreSQL listening on 127.0.0.1:${PORT}`);

	try {
		await cluster.createDatabase(DATABASE);
		console.log(`[dev-db] created database "${DATABASE}"`);
	} catch {
		// Already exists on a subsequent run.
	}

	const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
	const sql = postgres(url, { max: 2, onnotice: () => {} });

	try {
		const result = await migrate(sql, {
			withAuthShim: true,
			log: (m) => console.log(`[dev-db] ${m}`)
		});
		console.log(
			`[dev-db] migrations: ${result.applied.length} applied, ${result.skipped.length} already present`
		);

		// Development-only auth schema. Deliberately outside supabase/migrations/.
		const devAuthSql = await readFile(join(root, 'src/lib/server/db/dev-auth.sql'), 'utf8');
		await sql.unsafe(devAuthSql);
		console.log('[dev-db] development auth schema ready');

		// Seed/refresh the active policy so DB enforcement matches the TypeScript defaults.
		await sql`
			insert into public.policy_versions (version, payload, status, activated_at, notes)
			values (${policy.version}, ${sql.json(policy)}, 'active', now(),
			        'Seeded from src/lib/config/policy.ts by db:setup:dev')
			on conflict (version) do update
				set payload = excluded.payload, status = 'active', activated_at = now()
		`;
		// Ensure exactly one active policy.
		await sql`
			update public.policy_versions set status = 'superseded'
			where version <> ${policy.version} and status = 'active'
		`;
		console.log(`[dev-db] active policy: ${policy.version}`);

		await sql.unsafe(`
			grant select, insert, update, delete on all tables in schema public to authenticated;
			grant usage, select on all sequences in schema public to authenticated;
			grant all on all tables in schema public to service_role;
			grant usage, select on all sequences in schema public to service_role;
			grant usage on schema dev_auth to service_role;
			grant all on all tables in schema dev_auth to service_role;
		`);

		await writeFile(portFile, JSON.stringify({ port: PORT, url }, null, 2));

		console.log('');
		console.log('[dev-db] Ready. Add this to your .env:');
		console.log(`  DATABASE_URL=${url}`);
		console.log('  ALLOW_DEV_AUTH=true');
		console.log('');
		console.log('[dev-db] Press Ctrl+C to stop the database.');
	} catch (error) {
		await sql.end({ timeout: 5 });
		await cluster.stop();
		throw error;
	}

	// Keep the cluster alive until interrupted.
	const shutdown = async () => {
		console.log('\n[dev-db] shutting down…');
		await sql.end({ timeout: 5 });
		await cluster.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error) => {
	console.error('[dev-db] failed:', error instanceof Error ? error.message : error);
	process.exit(1);
});
