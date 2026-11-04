/**
 * Server hooks: request-scoped identity resolution.
 *
 * `locals.user` is populated ONLY from a verified session lookup. No client-supplied
 * header, cookie value or body field is trusted as an identity or entitlement claim.
 *
 * No per-user mutable state is stored in module scope (PROJECT_BRIEF.md §4).
 */

import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { resolveUser, resolveTier } from '$lib/server/auth/provider';
import { getServerConfig } from '$lib/server/env';
import { configureRateLimits } from '$lib/server/services/rate-limit';

const identity: Handle = async ({ event, resolve }) => {
	event.locals.user = await resolveUser(event.cookies);
	event.locals.tier = await resolveTier(event.locals.user?.id ?? null);
	return resolve(event);
};

const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	// Media is user-supplied and may be cross-origin; these headers do not restrict playback
	// but do reduce framing and MIME-sniffing risk.
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'SAMEORIGIN');
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), display-capture=()'
	);
	const config = getServerConfig();
	if (config.isProduction) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	return response;
};

// Apply development-only rate-limit scaling once, at module load. `configureRateLimits`
// refuses to scale in production regardless of configuration.
const startupConfig = getServerConfig();
configureRateLimits({
	multiplier: startupConfig.rateLimitMultiplier,
	isProduction: startupConfig.isProduction
});

export const handle = sequence(identity, securityHeaders);

/** Log unexpected server errors without leaking internals to the client. */
export const handleError = ({ error, event }: { error: unknown; event: { url: URL } }) => {
	const message = error instanceof Error ? error.message : 'Unknown error';
	console.error(`[server-error] ${event.url.pathname}: ${message}`);
	return { message: 'Something went wrong. Please try again.' };
};
