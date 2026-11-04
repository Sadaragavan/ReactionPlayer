import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeAuthCode } from '$lib/server/auth/provider';
import { safeRelativePath } from '$lib/server/safe-redirect';

/**
 * Landing point for Supabase email-confirmation, magic-link and OAuth redirects.
 *
 * The code is exchanged server-side; the resulting session is written to httpOnly cookies
 * by the SSR client. `next` passes through the shared open-redirect guard.
 */

export const GET: RequestHandler = async ({ url, cookies }) => {
	const next = safeRelativePath(url.searchParams.get('next'));

	// Supabase reports provider-side failures on the query string.
	const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
	if (providerError) {
		redirect(303, `/signin?error=${encodeURIComponent('That sign-in link could not be used.')}`);
	}

	const code = url.searchParams.get('code');
	if (!code) {
		redirect(303, '/signin?error=' + encodeURIComponent('That sign-in link is incomplete.'));
	}

	const result = await exchangeAuthCode(cookies, code);
	if (result.error || !result.user) {
		const message = result.error?.message ?? 'Could not complete sign-in.';
		redirect(303, `/signin?error=${encodeURIComponent(message)}`);
	}

	redirect(303, next);
};
