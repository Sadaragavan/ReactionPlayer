import type { LayoutServerLoad } from './$types';
import { getServerConfig } from '$lib/server/env';
import { checkDatabase } from '$lib/server/db/client';

export const load: LayoutServerLoad = async ({ locals }) => {
	const config = getServerConfig();

	// Surface configuration state so the UI can explain setup instead of failing silently.
	// No secrets are returned — only the mode and a readiness message.
	let setup: { ready: boolean; message: string } = { ready: true, message: '' };
	if (config.authMode === 'unconfigured') {
		setup = {
			ready: false,
			message:
				'No authentication provider is configured yet. Follow docs/ENVIRONMENT.md to connect Supabase, or enable the local development provider.'
		};
	} else if (config.authMode === 'local-dev') {
		const db = await checkDatabase();
		setup = {
			ready: db.ok,
			message: db.ok ? 'Local development mode.' : db.message
		};
	}

	return {
		user: locals.user,
		tier: locals.tier,
		authMode: config.authMode,
		setup
	};
};
