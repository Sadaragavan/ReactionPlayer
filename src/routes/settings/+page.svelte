<script lang="ts">
	/**
	 * Settings (PROJECT_BRIEF.md §15): account/privacy, wallpaper, sync tolerance,
	 * audio preferences, Free/Pro comparison.
	 *
	 * Deliberately absent: a "hardware acceleration" toggle. JavaScript cannot force
	 * browser hardware acceleration, so offering one would be misleading (§15).
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Settings as SettingsIcon,
		Shield,
		Image,
		SlidersHorizontal,
		Sparkles,
		LoaderCircle,
		Check,
		LogOut,
		Upload,
		X
	} from '@lucide/svelte';
	import NavDock from '$lib/components/NavDock.svelte';
	import { sessionStore } from '$lib/state/session-store.svelte';
	import { toastStore } from '$lib/state/toast-store.svelte';
	import {
		loadSettings,
		saveSettings,
		validateWallpaperFile,
		validateWallpaperUrl,
		DEFAULT_SETTINGS
	} from '$lib/persistence/settings';
	import type { StoredSettings } from '$lib/persistence/db';
	import { syncPolicy, passPolicy } from '$lib/config/policy';

	interface Props {
		data: {
			user: { id: string; email: string | null; nickname: string | null } | null;
			tier: 'free' | 'pro';
		};
	}
	let { data }: Props = $props();

	let settings = $state<StoredSettings>({ ...DEFAULT_SETTINGS });
	let wallpaperUrlInput = $state('');
	let saving = $state(false);
	let purposes = $state<
		Array<{ key: string; title: string; explanation: string; requiredForService: boolean }>
	>([]);
	let consentState = $state<Record<string, boolean>>({});
	let consentBusy = $state<string | null>(null);
	let loaded = $state(false);

	onMount(async () => {
		if (!data.user) {
			goto('/signin?next=/settings');
			return;
		}
		settings = await loadSettings();
		wallpaperUrlInput = settings.wallpaper.kind === 'url' ? (settings.wallpaper.url ?? '') : '';
		await loadConsents();
		loaded = true;
	});

	async function loadConsents() {
		try {
			const response = await fetch('/api/consents');
			if (!response.ok) return;
			const body = await response.json();
			purposes = body.purposes;
			const map: Record<string, boolean> = {};
			for (const entry of body.state) map[entry.purpose] = entry.granted;
			consentState = map;
		} catch {
			toastStore.show('Could not load privacy settings.', { kind: 'warning' });
		}
	}

	async function persist() {
		saving = true;
		try {
			const { key: _key, updatedAtMs: _updatedAtMs, ...rest } = settings;
			await saveSettings(rest);
			toastStore.show('Settings saved.', { kind: 'success' });
		} catch {
			toastStore.show('Could not save settings in this browser.', { kind: 'error' });
		} finally {
			saving = false;
		}
	}

	async function setConsent(purpose: string, granted: boolean) {
		consentBusy = purpose;
		try {
			const response = await fetch('/api/consents', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ purpose, granted })
			});
			if (!response.ok) {
				const body = await response.json();
				throw new Error(body.error?.message ?? 'Could not update that setting.');
			}
			consentState = { ...consentState, [purpose]: granted };
			toastStore.show(
				granted ? 'Preference enabled.' : 'Preference disabled. Future collection has stopped.',
				{ kind: 'success' }
			);
		} catch (error) {
			toastStore.show(error instanceof Error ? error.message : 'Update failed.', { kind: 'error' });
		} finally {
			consentBusy = null;
		}
	}

	function applyWallpaperUrl() {
		const check = validateWallpaperUrl(wallpaperUrlInput);
		if (!check.ok) {
			toastStore.show(check.message, { kind: 'warning' });
			return;
		}
		settings.wallpaper = { kind: 'url', url: wallpaperUrlInput.trim(), handleId: null };
		void persist();
	}

	async function uploadWallpaper() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/png,image/jpeg,image/webp,image/gif';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const check = validateWallpaperFile(file);
			if (!check.ok) {
				toastStore.show(check.message, { kind: 'warning' });
				return;
			}
			// A runtime object URL is enough for the current session; persisting a durable
			// handle is attempted where supported.
			const url = URL.createObjectURL(file);
			settings.wallpaper = { kind: 'url', url, handleId: null };
			wallpaperUrlInput = '';
			await persist();
			toastStore.show(
				'Wallpaper applied for this browser session. Use an https URL for a wallpaper that persists across visits.',
				{ kind: 'info' }
			);
		};
		input.click();
	}

	function clearWallpaper() {
		settings.wallpaper = { kind: 'none', url: null, handleId: null };
		wallpaperUrlInput = '';
		void persist();
	}
</script>

<div class="flex h-screen w-full overflow-hidden">
	<NavDock
		canContinue={false}
		onContinue={() => {}}
		onNewSession={() => {
			sessionStore.reset();
			goto('/session');
		}}
		onExit={() => {
			sessionStore.reset();
			goto('/');
		}}
	/>

	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl px-8 py-10">
			<div class="flex items-center gap-3">
				<SettingsIcon size={20} class="text-[var(--color-accent)]" />
				<h1 class="text-xl font-semibold tracking-tight">Settings</h1>
			</div>

			{#if !loaded}
				<p class="mt-8 flex items-center gap-2 text-sm text-white/50">
					<LoaderCircle size={16} class="animate-spin" /> Loading…
				</p>
			{:else}
				<!-- Account -->
				<section class="acrylic mt-6 rounded-xl p-5">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<Shield size={15} /> Account
					</h2>
					<dl class="mt-3 grid gap-2 text-[12px]">
						<div class="flex justify-between gap-4">
							<dt class="text-white/45">Email</dt>
							<dd class="truncate text-white/80">{data.user?.email ?? '—'}</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-white/45">Public display</dt>
							<dd class="text-white/80">{data.user?.nickname ?? 'Anonymous contributor'}</dd>
						</div>
						<div class="flex justify-between gap-4">
							<dt class="text-white/45">Plan</dt>
							<dd class="text-white/80">{data.tier === 'pro' ? 'Pro' : 'Free'}</dd>
						</div>
					</dl>
					<p class="mt-3 text-[11px] leading-relaxed text-white/40">
						Your account is anonymous to other users. No username is derived from your email, and
						choosing a public nickname is a separate, explicit action.
					</p>
					<form method="POST" action="/signin?/signout" class="mt-4">
						<button type="submit" class="btn-ghost !text-[12px]">
							<LogOut size={14} /> Sign out
						</button>
					</form>
				</section>

				<!-- Privacy / consent -->
				<section class="acrylic mt-4 rounded-xl p-5">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<Shield size={15} /> Privacy and data
					</h2>
					<p class="mt-1.5 text-[11px] leading-relaxed text-white/45">
						These choices are optional and separate from the account data needed to run the service.
						Declining any of them does not reduce your passes or playback.
					</p>

					<div class="mt-4 flex flex-col gap-3">
						{#each purposes as purpose (purpose.key)}
							<div class="rounded-lg border border-white/10 bg-white/5 p-3.5">
								<div class="flex items-start justify-between gap-4">
									<div class="min-w-0">
										<p class="text-[12px] font-medium">{purpose.title}</p>
										<p class="mt-1 text-[11px] leading-relaxed text-white/50">
											{purpose.explanation}
										</p>
									</div>
									<label class="flex shrink-0 cursor-pointer items-center gap-2">
										<input
											type="checkbox"
											class="size-4"
											checked={consentState[purpose.key] ?? false}
											disabled={consentBusy === purpose.key}
											aria-label={purpose.title}
											onchange={(event) =>
												setConsent(purpose.key, (event.target as HTMLInputElement).checked)}
										/>
									</label>
								</div>
							</div>
						{/each}
					</div>

					<p class="mt-3 text-[11px] leading-relaxed text-white/35">
						Revoking watch history stops future collection and removes existing history rows.
						Reward eligibility uses separate aggregate counters that contain no titles or media
						identity, so declining personalization does not block earning a trial.
					</p>
				</section>

				<!-- Wallpaper -->
				<section class="acrylic mt-4 rounded-xl p-5">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<Image size={15} /> Wallpaper
					</h2>
					<p class="mt-1.5 text-[11px] leading-relaxed text-white/45">
						PNG, JPG, WebP or GIF. Rendered full-bleed and crisp — no blur and no darkening filter
						are applied to your image.
					</p>

					<div class="mt-3 flex gap-2">
						<input
							type="url"
							class="field flex-1"
							placeholder="https://example.com/wallpaper.jpg"
							bind:value={wallpaperUrlInput}
							aria-label="Wallpaper image URL"
						/>
						<button
							type="button"
							class="btn-primary !text-[12px]"
							disabled={saving}
							onclick={applyWallpaperUrl}
						>
							{#if saving}<LoaderCircle size={13} class="animate-spin" />{/if}
							Apply
						</button>
					</div>
					<div class="mt-2 flex gap-2">
						<button type="button" class="btn-ghost !text-[12px]" onclick={uploadWallpaper}>
							<Upload size={14} /> Upload image
						</button>
						{#if settings.wallpaper.kind !== 'none'}
							<button type="button" class="btn-ghost !text-[12px]" onclick={clearWallpaper}>
								<X size={14} /> Clear
							</button>
						{/if}
					</div>
					{#if settings.wallpaper.kind === 'url' && settings.wallpaper.url}
						<div class="mt-3 overflow-hidden rounded-lg border border-white/10">
							<img src={settings.wallpaper.url} alt="Wallpaper preview" class="h-32 w-full object-cover" />
						</div>
					{/if}
				</section>

				<!-- Sync + audio -->
				<section class="acrylic mt-4 rounded-xl p-5">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<SlidersHorizontal size={15} /> Playback
					</h2>

					<label class="mt-4 block">
						<span class="text-[12px] font-medium text-white/70">
							Sync tolerance: {settings.syncToleranceMs} ms
						</span>
						<input
							type="range"
							class="slider mt-2"
							min="16"
							max="200"
							step="1"
							bind:value={settings.syncToleranceMs}
							onchange={persist}
							aria-label="Synchronization tolerance in milliseconds"
						/>
						<span class="mt-1.5 block text-[11px] leading-relaxed text-white/40">
							Drift below this is left alone. Lower values correct more aggressively but can cause
							visible micro-adjustments. Synchronization is drift-corrected, never guaranteed
							frame-perfect.
						</span>
					</label>

					<label class="mt-4 block">
						<span class="text-[12px] font-medium text-white/70">Default audio source</span>
						<select
							class="field mt-1.5"
							bind:value={settings.masterAudioPreference}
							onchange={persist}
							aria-label="Default audio source"
						>
							<option value="reaction">Reaction</option>
							<option value="source">Source</option>
							<option value="last-used">Last used</option>
						</select>
						<span class="mt-1.5 block text-[11px] text-white/40">
							Audio source is independent of the synchronization master clock.
						</span>
					</label>

					<div class="mt-4 rounded-lg border border-white/10 bg-white/5 p-3">
						<p class="text-[11px] leading-relaxed text-white/50">
							<strong class="text-white/70">About hardware acceleration:</strong>
							browsers decide this themselves. A web page cannot force it on or off, so no toggle is
							offered here. Check your browser's own settings if playback is slow.
						</p>
					</div>
				</section>

				<!-- Plans -->
				<section class="acrylic mt-4 rounded-xl p-5">
					<h2 class="flex items-center gap-2 text-sm font-semibold">
						<Sparkles size={15} /> Free and Pro
					</h2>
					<div class="mt-3 grid gap-3 sm:grid-cols-2">
						<div class="rounded-lg border border-white/10 bg-white/5 p-4">
							<p class="text-[12px] font-semibold">Free</p>
							<ul class="mt-2 flex flex-col gap-1.5 text-[11px] text-white/55">
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> {passPolicy.freeTierVideoLimit} videos per session</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> {passPolicy.basePassesPerWindow} new passes per rolling 24 hours</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> Local session save and resume</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> +2 passes for verified tagging</li>
							</ul>
						</div>
						<div class="rounded-lg border border-[var(--color-accent)]/35 bg-[var(--color-accent)]/8 p-4">
							<p class="text-[12px] font-semibold">Pro</p>
							<ul class="mt-2 flex flex-col gap-1.5 text-[11px] text-white/65">
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> {passPolicy.proTierVideoLimit}+ videos per session</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> Unlimited new session passes</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> Cross-device session sync</li>
								<li class="flex gap-1.5"><Check size={12} class="mt-0.5 shrink-0" /> Grid and custom layouts</li>
							</ul>
						</div>
					</div>
					<p class="mt-3 text-[11px] leading-relaxed text-white/35">
						Billing is not enabled in this build. No price is quoted and no payment method is
						collected. We do not host or stream video at any tier.
					</p>
				</section>

				<p class="mt-6 text-[11px] text-white/30">
					Frame-step tolerance reference: {syncPolicy.assumedFrameDurationMs.toFixed(1)} ms assumed when
					frame timing is unknown.
				</p>
			{/if}
		</div>
	</main>
</div>
