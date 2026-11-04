import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Trusted-backend deployment.
 *
 * The pass/quota service, entitlement resolution, staff authorization and (later) Stripe
 * webhooks all require a trusted server runtime. `adapter-node` produces a standalone Node
 * server so those operations never depend on client code. A static-only adapter is
 * deliberately NOT used (see PROJECT_BRIEF.md §2).
 *
 * Swapping to another Node/hosting target later is a one-line change here; no application
 * code depends on the adapter.
 */
/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		runes: true
	},
	kit: {
		adapter: adapter(),
		alias: {
			$lib: 'src/lib'
		},
		// The dev/preview origin is a proxied https host in the sandbox; SvelteKit's CSRF
		// protection compares Origin to the request host, which the proxy preserves.
		// No wildcard allowance is configured.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// Local blob: media (user files) and data: wallpapers.
				'media-src': ['self', 'blob:'],
				'img-src': ['self', 'blob:', 'data:', 'https:'],
				'style-src': ['self', 'unsafe-inline'],
				'script-src': ['self'],
				'connect-src': ['self', 'https:'],
				'frame-src': ['self', 'https://www.youtube.com', 'https://player.vimeo.com'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
