/**
 * Bootstrap the first Owner OUT OF BAND (PROJECT_BRIEF.md §10).
 *
 * There is deliberately no public client flow that can create staff. This script is run
 * by an operator with direct database access:
 *
 *   DATABASE_URL=... npm run grant:owner -- user@example.com
 *
 * The action is audited. The account must already exist and (in production) must have
 * MFA enrolled before it can perform privileged actions — requireStaff() enforces aal2.
 */

import postgres from 'postgres';
import { normalizeEmail } from '../src/lib/server/auth/password.ts';

async function main() {
	const emailArg = process.argv[2];
	const url = process.env.DATABASE_URL;

	if (!url) {
		console.error('DATABASE_URL is required.');
		process.exit(1);
	}
	if (!emailArg) {
		console.error('Usage: npm run grant:owner -- user@example.com');
		process.exit(1);
	}
	const email = normalizeEmail(emailArg);
	const sql = postgres(url, { max: 1, onnotice: () => {} });

	try {
		const users = await sql<{ id: string }[]>`
			select id from auth.users where email = ${email}
		`;
		const user = users[0];
		if (!user) {
			console.error(`No account found for ${email}. Create the account first, then re-run.`);
			process.exitCode = 1;
			return;
		}

		const existing = await sql<{ id: string }[]>`
			select id from public.staff_role_grants
			where user_id = ${user.id} and role = 'owner' and revoked_at is null
		`;
		if (existing.length > 0) {
			console.log('That account already holds an active Owner grant. No change made.');
			return;
		}

		await sql.begin(async (tx) => {
			await tx`
				insert into public.staff_role_grants (user_id, role, granted_by, reason)
				values (${user.id}, 'owner', null, 'Out-of-band bootstrap via scripts/grant-owner.ts')
			`;
			await tx`
				select public.append_audit(
					${user.id}::uuid, 'owner', 'bootstrap_owner', 'user', ${user.id}::uuid,
					${tx.json({ method: 'cli_script' })}::jsonb, 'security_audit'
				)
			`;
		});

		console.log(`Owner role granted to ${email}.`);
		console.log('');
		console.log('IMPORTANT: privileged actions require MFA (aal2). Enrol a second factor');
		console.log('for this account in Supabase Auth before using the controller.');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error) => {
	console.error('Failed:', error instanceof Error ? error.message : error);
	process.exit(1);
});
