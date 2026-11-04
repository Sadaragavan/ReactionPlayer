import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0',
		port: 5173,
		// The sandbox proxies the dev server under https://<port>-<sandbox>.e2b.app.
		// Allow that host plus normal local development. This is a dev-server allowlist,
		// not an application authorization control.
		allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1']
	},
	preview: {
		host: '0.0.0.0',
		port: 4173,
		allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.test.ts'],
					exclude: ['tests/e2e/**']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['tests/integration/**/*.test.ts'],
					// Real Postgres cluster startup + migration; generous timeouts.
					testTimeout: 60_000,
					hookTimeout: 180_000,
					// One shared cluster; files run sequentially to avoid port conflicts.
					fileParallelism: false
				}
			}
		]
	}
});
