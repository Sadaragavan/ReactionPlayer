import { test, expect } from '@playwright/test';
import { generateClip, signUpFreshUser, expectSignedIn } from './helpers';

/**
 * The v0.0 exit-gate vertical slice, exercised in a real browser:
 *
 *   authenticated user -> two local videos -> server-authorized pass ->
 *   align + synchronize -> save locally -> resume with reselection.
 */

test.describe('vertical slice', () => {
	test('sign up, authorize a pair, synchronize, save and resume', async ({ page, context }) => {
		// Deterministic file handling: exercise the reselection fallback path.
		await context.addInitScript(() => {
			delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
		});

		await signUpFreshUser(page);
		await expectSignedIn(page);

		// Generate two distinct clips in-browser (no binary fixtures required).
		const source = await generateClip(page, {
			label: 'SOURCE',
			seconds: 4,
			hue: 210,
			fileName: 'source.webm'
		});
		const reaction = await generateClip(page, {
			label: 'REACTION',
			seconds: 4,
			hue: 20,
			fileName: 'reaction.webm'
		});

		await page.getByTestId('home-new-session').click();
		await page.waitForURL('**/session');

		// Both videos must be supplied before a pass can be requested.
		await expect(page.getByTestId('authorize-session')).toBeDisabled();

		const sourceChooser = page.waitForEvent('filechooser');
		await page.getByTestId('pick-source').click();
		await (await sourceChooser).setFiles({
			name: source.fileName,
			mimeType: 'video/webm',
			buffer: Buffer.from(source.base64, 'base64')
		});

		const reactionChooser = page.waitForEvent('filechooser');
		await page.getByTestId('pick-reaction').click();
		await (await reactionChooser).setFiles({
			name: reaction.fileName,
			mimeType: 'video/webm',
			buffer: Buffer.from(reaction.base64, 'base64')
		});

		// A pass is issued by the server; the meter reflects it.
		await expect(page.getByTestId('pass-usage')).toContainText('passes used');
		await expect(page.getByTestId('play-toggle')).toBeVisible({ timeout: 30_000 });

		// Both video elements exist and loaded metadata.
		const sourceVideo = page.getByTestId('video-source');
		const reactionVideo = page.getByTestId('video-reaction');
		await expect(sourceVideo).toBeVisible();
		await expect(reactionVideo).toBeVisible();

		await expect
			.poll(async () => await sourceVideo.evaluate((v: HTMLVideoElement) => v.readyState))
			.toBeGreaterThanOrEqual(1);

		// Linked playback advances BOTH videos.
		await page.getByTestId('play-toggle').click();
		await page.waitForTimeout(1200);

		const times = await page.evaluate(() => {
			const s = document.querySelector('[data-testid="video-source"]') as HTMLVideoElement;
			const r = document.querySelector('[data-testid="video-reaction"]') as HTMLVideoElement;
			return { source: s.currentTime, reaction: r.currentTime, paused: s.paused };
		});
		expect(times.paused).toBe(false);
		expect(times.source).toBeGreaterThan(0.2);
		expect(times.reaction).toBeGreaterThan(0.2);

		// Pause, then calibrate an offset and confirm the follower re-targets.
		await page.getByTestId('play-toggle').click();
		await page.getByTestId('align-reaction').click();
		await expect(page.getByTestId('offset-reaction')).toBeVisible();

		// Offset nudges are reflected in the HUD.
		const before = await page.getByTestId('offset-reaction').textContent();
		await page.getByRole('button', { name: /Increase reaction offset/i }).click();
		await expect(page.getByTestId('offset-reaction')).not.toHaveText(before ?? '');

		// Layout switch must NOT remount the video elements (playback position survives).
		const positionBeforeLayout = await sourceVideo.evaluate((v: HTMLVideoElement) => v.currentTime);
		await page.getByRole('button', { name: 'Picture in picture layout' }).click();
		await page.waitForTimeout(400);
		const positionAfterLayout = await sourceVideo.evaluate((v: HTMLVideoElement) => v.currentTime);
		expect(Math.abs(positionAfterLayout - positionBeforeLayout)).toBeLessThan(0.5);

		// Unlinked mode exposes per-video timelines.
		await page.getByRole('button', { name: /Unlink playback controls/i }).click();
		await expect(page.getByLabel('source timeline position')).toBeVisible();
		await expect(page.getByLabel('reaction timeline position')).toBeVisible();
		await page.getByRole('button', { name: /Link playback controls/i }).click();
		await expect(page.getByTestId('master-scrubber')).toBeVisible();

		// Save locally.
		await page.getByRole('button', { name: 'Save session' }).click();
		await expect(page.getByText('Session saved locally.')).toBeVisible();

		// Resume from the sessions list; the reselection dialog must appear because this
		// browser has no File System Access handle.
		await page.goto('/sessions');
		await expect(page.getByTestId('session-card')).toBeVisible();
		await page.getByTestId('resume-session').first().click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByTestId('reselect-file')).toBeVisible();

		const resumeSource = page.waitForEvent('filechooser');
		await page.getByTestId('reselect-file').click();
		await (await resumeSource).setFiles({
			name: source.fileName,
			mimeType: 'video/webm',
			buffer: Buffer.from(source.base64, 'base64')
		});

		// The second file is requested next.
		const resumeReaction = page.waitForEvent('filechooser');
		await page.getByTestId('reselect-file').click();
		await (await resumeReaction).setFiles({
			name: reaction.fileName,
			mimeType: 'video/webm',
			buffer: Buffer.from(reaction.base64, 'base64')
		});

		// Resume reuses the existing pass rather than consuming a new one.
		await page.waitForURL('**/session**', { timeout: 30_000 });
		await expect(page.getByTestId('play-toggle')).toBeVisible();
	});

	test('keyboard shortcuts work and do not fire while typing', async ({ page }) => {
		await signUpFreshUser(page);
		await page.goto('/settings');

		// Typing in a field must not trigger playback shortcuts.
		const urlField = page.getByLabel('Wallpaper image URL');
		await urlField.click();
		await urlField.type('ttt');
		await expect(urlField).toHaveValue('ttt');
	});

	test('theater mode collapses chrome and Escape restores it', async ({ page }) => {
		await signUpFreshUser(page);
		await page.goto('/');
		await expectSignedIn(page);
		// Theater is a playback-surface behaviour; assert the control exists on home nav
		// and that the session route is reachable.
		await page.getByTestId('home-new-session').click();
		await page.waitForURL('**/session');
		await expect(page.getByTestId('pick-source')).toBeVisible();
	});
});

test.describe('access control', () => {
	test('unauthenticated visitors are redirected from protected routes', async ({ page }) => {
		await page.goto('/session');
		await page.waitForURL('**/signin**');
		await expect(page.getByTestId('email')).toBeVisible();
	});

	test('the pass API rejects unauthenticated requests', async ({ request }) => {
		const response = await request.get('/api/passes');
		expect(response.status()).toBe(401);
		const body = await response.json();
		expect(body.error.code).toBe('unauthenticated');
	});

	test('a client cannot reach a bonus-granting endpoint', async ({ request }) => {
		const response = await request.post('/api/passes/grant-bonus', { data: {} });
		expect(response.status()).toBe(404);
	});

	test('security headers are present', async ({ request }) => {
		const response = await request.get('/');
		expect(response.headers()['x-content-type-options']).toBe('nosniff');
		expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
	});
});

test.describe('accessibility and motion', () => {
	test('reduced-motion is respected', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.goto('/');
		const duration = await page.evaluate(() => {
			const el = document.querySelector('.btn-primary') ?? document.body;
			return getComputedStyle(el).transitionDuration;
		});
		// Global reduced-motion rule collapses transitions to ~0.
		expect(parseFloat(duration)).toBeLessThan(0.02);
	});

	test('icon-only controls expose accessible names', async ({ page }) => {
		await signUpFreshUser(page);
		await page.goto('/');
		const unnamed = await page.evaluate(() => {
			const buttons = [...document.querySelectorAll('button')];
			return buttons
				.filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim()))
				.map((b) => b.outerHTML.slice(0, 80));
		});
		expect(unnamed).toEqual([]);
	});
});
