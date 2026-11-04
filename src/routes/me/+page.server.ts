import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Stable account entry point. Account details and privacy controls live in /settings;
 * this alias exists so external links and future emails have a durable target.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(303, '/signin?next=/me');
	redirect(303, '/settings');
};
