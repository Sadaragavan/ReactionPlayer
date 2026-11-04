import type { PageServerLoad, Actions } from './$types';
import { fail, redirect } from '@sveltejs/kit';
import { signIn, signUp, signOut } from '$lib/server/auth/provider';
import { getServerConfig } from '$lib/server/env';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/services/rate-limit';
import { isAppError } from '$lib/contracts/errors';
import { safeRelativePath } from '$lib/server/safe-redirect';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) {
		throw redirect(303, safeRelativePath(url.searchParams.get('next')));
	}
	return {
		authMode: getServerConfig().authMode,
		next: safeRelativePath(url.searchParams.get('next')),
		mode: url.searchParams.get('mode') === 'signup' ? 'signup' : 'signin'
	};
};

export const actions: Actions = {
	signin: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');
		const next = safeRelativePath(url.searchParams.get('next') ?? String(form.get('next') ?? '/'));

		try {
			// Rate-limit per address to slow credential stuffing. Shared IPs are not
			// treated as proof of abuse (§9); this only throttles attempts.
			enforceRateLimit(`signin:${getClientAddress()}`, RATE_LIMITS.signIn);
		} catch (error) {
			if (isAppError(error)) {
				return fail(error.status, { message: error.message, email, mode: 'signin' });
			}
			throw error;
		}

		const result = await signIn(cookies, email, password);
		if (result.error) {
			return fail(400, {
				message: result.error.message,
				field: result.error.field,
				email,
				mode: 'signin'
			});
		}
		throw redirect(303, next);
	},

	signup: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');
		const accepted = form.get('acceptTerms') === 'on';
		const next = safeRelativePath(url.searchParams.get('next') ?? String(form.get('next') ?? '/'));

		if (!accepted) {
			return fail(400, {
				message: 'Please confirm you understand how this service handles your media and data.',
				email,
				mode: 'signup'
			});
		}

		try {
			enforceRateLimit(`signup:${getClientAddress()}`, RATE_LIMITS.signUp);
		} catch (error) {
			if (isAppError(error)) {
				return fail(error.status, { message: error.message, email, mode: 'signup' });
			}
			throw error;
		}

		const result = await signUp(cookies, email, password);
		if (result.error) {
			return fail(400, {
				message: result.error.message,
				field: result.error.field,
				email,
				mode: 'signup'
			});
		}
		if (result.needsEmailConfirmation) {
			return {
				message: 'Check your email to confirm your address, then sign in.',
				email,
				mode: 'signin',
				info: true
			};
		}
		throw redirect(303, next);
	},

	signout: async ({ cookies }) => {
		await signOut(cookies);
		throw redirect(303, '/signin');
	}
};
