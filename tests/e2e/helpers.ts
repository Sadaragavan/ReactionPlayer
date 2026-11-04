import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * E2E helpers.
 *
 * Test media is GENERATED IN THE BROWSER with canvas.captureStream + MediaRecorder, so the
 * suite needs no binary fixtures, no ffmpeg, and no network access to sample videos. Each
 * clip renders a visible frame counter, which makes drift observable in traces.
 */

export interface GeneratedClip {
	/** Base64-encoded webm bytes. */
	base64: string;
	fileName: string;
	mimeType: string;
	durationSeconds: number;
}

/** Record a short clip inside the page. Runs entirely client-side. */
export async function generateClip(
	page: Page,
	options: { label: string; seconds: number; hue: number; fileName: string }
): Promise<GeneratedClip> {
	return await page.evaluate(async ({ label, seconds, hue, fileName }) => {
		const canvas = document.createElement('canvas');
		canvas.width = 320;
		canvas.height = 180;
		const ctx = canvas.getContext('2d')!;
		const stream = canvas.captureStream(30);

		const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
		const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
		const recorder = new MediaRecorder(stream, { mimeType });
		const chunks: Blob[] = [];
		recorder.ondataavailable = (event) => event.data.size > 0 && chunks.push(event.data);

		const started = performance.now();
		let raf = 0;
		const draw = () => {
			const elapsed = (performance.now() - started) / 1000;
			ctx.fillStyle = `hsl(${hue}, 45%, 18%)`;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.fillStyle = '#fff';
			ctx.font = 'bold 22px sans-serif';
			ctx.fillText(label, 14, 34);
			ctx.font = 'bold 44px monospace';
			ctx.fillText(elapsed.toFixed(2), 14, 100);
			// A moving marker makes frame-level differences visible in recordings.
			ctx.fillStyle = `hsl(${hue}, 80%, 65%)`;
			ctx.fillRect((elapsed * 60) % canvas.width, 140, 24, 24);
			raf = requestAnimationFrame(draw);
		};
		draw();

		const done = new Promise<Blob>((resolve) => {
			recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
		});
		recorder.start(100);
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
		recorder.stop();
		cancelAnimationFrame(raf);
		const blob = await done;

		const buffer = new Uint8Array(await blob.arrayBuffer());
		let binary = '';
		for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i]!);

		return {
			base64: btoa(binary),
			fileName,
			mimeType,
			durationSeconds: seconds
		};
	}, options);
}

/** Feed a generated clip into a file input / picker interception. */
export async function attachClipToPicker(
	page: Page,
	clip: GeneratedClip,
	trigger: () => Promise<void>
): Promise<void> {
	// The app uses showOpenFilePicker when available and falls back to <input type=file>.
	// Playwright's filechooser event covers the input path; for the FS Access path we
	// remove the API so the deterministic input path is exercised.
	await page.addInitScript(() => {
		// Force the reselection-capable path so tests are deterministic across browsers.
		delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
	});

	const chooserPromise = page.waitForEvent('filechooser');
	await trigger();
	const chooser = await chooserPromise;
	await chooser.setFiles({
		name: clip.fileName,
		mimeType: 'video/webm',
		buffer: Buffer.from(clip.base64, 'base64')
	});
}

/** Create an account through the real form and land signed in. */
export async function signUpFreshUser(page: Page): Promise<string> {
	const email = `e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;
	await page.goto('/signin?mode=signup');
	await page.getByTestId('email').fill(email);
	await page.getByTestId('password').fill('correct-horse-battery-staple');
	await page.getByRole('checkbox').check();
	await page.getByTestId('auth-submit').click();
	await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
	return email;
}

export async function expectSignedIn(page: Page): Promise<void> {
	await expect(page.getByTestId('home-new-session')).toBeVisible();
}
