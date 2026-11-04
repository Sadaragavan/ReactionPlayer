import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests.
 *
 * These require a real Chromium download (`npx playwright install chromium`). They run in
 * CI. In restricted sandboxes without access to the Playwright CDN they cannot execute;
 * that limitation is recorded in IMPLEMENTATION_STATUS.md rather than hidden.
 *
 * The suite starts its own PostgreSQL cluster and dev server via webServer, so it is
 * self-contained and needs no cloud credentials.
 */
export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		screenshot: 'only-on-failure',
		// Autoplay must be permitted for playback assertions to be meaningful.
		launchOptions: {
			args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
		}
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: process.env.E2E_BASE_URL
		? undefined
		: {
				command: 'npm run db:setup:dev & sleep 12 && npm run dev',
				url: 'http://127.0.0.1:5173',
				reuseExistingServer: !process.env.CI,
				timeout: 180_000,
				stdout: 'pipe',
				stderr: 'pipe'
			}
});
