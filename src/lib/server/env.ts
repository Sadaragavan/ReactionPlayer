/**
 * Server-only environment configuration.
 *
 * Nothing in this module may be imported from client code. SvelteKit's `$env/dynamic/private`
 * and `$lib/server/*` conventions enforce that at build time.
 *
 * No credentials are invented. Missing configuration selects an explicit, documented
 * development mode rather than silently pretending to be configured.
 */

import { env } from '$env/dynamic/private';
import { building } from '$app/environment';

export interface ServerConfig {
	readonly databaseUrl: string | null;
	readonly supabaseUrl: string | null;
	readonly supabaseAnonKey: string | null;
	/** Trusted-server only. Never serialized to the client. */
	readonly supabaseServiceKey: string | null;
	readonly authMode: 'supabase' | 'local-dev' | 'unconfigured';
	readonly isProduction: boolean;
	/** Development-only rate-limit capacity scaling. Forced to 1 in production. */
	readonly rateLimitMultiplier: number;
	readonly origin: string | null;
}

let cached: ServerConfig | null = null;

export function getServerConfig(): ServerConfig {
	if (cached) return cached;

	// `$env/dynamic/private` is typed from the env vars present at build time. All of
	// these are optional at runtime, so read them through an explicit optional shape.
	const raw = env as Record<string, string | undefined>;

	const databaseUrl = raw.DATABASE_URL?.trim() || null;
	const supabaseUrl = raw.PUBLIC_SUPABASE_URL?.trim() || null;
	const supabaseAnonKey = raw.PUBLIC_SUPABASE_ANON_KEY?.trim() || null;
	const supabaseServiceKey = raw.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
	const isProduction = raw.NODE_ENV === 'production';
	const allowDevAuth = raw.ALLOW_DEV_AUTH === 'true';

	const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

	let authMode: ServerConfig['authMode'];
	if (supabaseConfigured) {
		authMode = 'supabase';
	} else if (databaseUrl && allowDevAuth && !isProduction) {
		// Explicit opt-in, development only. Refuses to activate in production even if
		// ALLOW_DEV_AUTH is mistakenly set there.
		authMode = 'local-dev';
	} else {
		authMode = 'unconfigured';
	}

	cached = {
		databaseUrl,
		supabaseUrl,
		supabaseAnonKey,
		supabaseServiceKey,
		authMode,
		isProduction,
		rateLimitMultiplier: isProduction ? 1 : Number(raw.RATE_LIMIT_MULTIPLIER ?? '1') || 1,
		origin: raw.ORIGIN?.trim() || null
	};

	// During `vite build` modules are evaluated without runtime env; do not hard-fail.
	if (!building && isProduction && authMode === 'unconfigured') {
		console.error(
			'[config] Production build has no auth provider configured. ' +
				'Set PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY and DATABASE_URL. See docs/ENVIRONMENT.md.'
		);
	}

	return cached;
}

/** Test-only reset. */
export function resetServerConfigCache(): void {
	cached = null;
}

export function requireDatabaseUrl(): string {
	const url = getServerConfig().databaseUrl;
	if (!url) {
		throw new Error(
			'DATABASE_URL is not configured. Set it to your Supabase Postgres connection string ' +
				'(or a local development cluster). See docs/ENVIRONMENT.md.'
		);
	}
	return url;
}
