<script lang="ts">
	/**
	 * Home (PROJECT_BRIEF.md §15): full-bleed wallpaper, crisp, no blur, no global
	 * darkening filter, object-fit cover, persistent 256px left dock.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { MonitorPlay, Clock, Shield, Film, TriangleExclamationPoint } from '@lucide/svelte';
	import NavDock from '$lib/components/NavDock.svelte';
	import { sessionStore } from '$lib/state/session-store.svelte';
	import { toastStore } from '$lib/state/toast-store.svelte';
	import { getResumableSession, type SessionSummary } from '$lib/persistence/sessions';
	import { loadSettings } from '$lib/persistence/settings';
	import { formatRelativeTime } from '$lib/utils/format';
	import type { StoredSettings } from '$lib/persistence/db';

	interface Props {
		data: {
			user: { id: string; email: string | null; nickname: string | null } | null;
			tier: 'free' | 'pro';
			authMode: 'supabase' | 'local-dev' | 'unconfigured';
			setup: { ready: boolean; message: string };
		};
	}
	let { data }: Props = $props();

	let resumable = $state<SessionSummary | null>(null);
	let settings = $state<StoredSettings | null>(null);

	onMount(async () => {
		[resumable, settings] = await Promise.all([getResumableSession(), loadSettings()]);
	});

	const wallpaperUrl = $derived(
		settings?.wallpaper.kind === 'url' ? settings.wallpaper.url : null
	);

	function newSession() {
		sessionStore.reset();
		goto('/session');
	}

	function continueSession() {
		if (!resumable) return;
		goto(`/sessions?resume=${resumable.id}`);
	}

	function exit() {
		sessionStore.reset();
		toastStore.show('Session state reset. Your saved sessions are untouched.', { kind: 'info' });
	}
</script>

<div class="relative flex h-screen w-full overflow-hidden">
	<!-- Full-bleed wallpaper. Deliberately NO blur and NO darkening overlay on the image
	     itself; readability comes from the acrylic dock and card surfaces (§15). -->
	<div class="absolute inset-0 -z-10">
		{#if wallpaperUrl}
			<img
				src={wallpaperUrl}
				alt=""
				class="size-full object-cover"
				style="image-rendering: auto;"
				decoding="async"
			/>
		{:else}
			<!-- Default: a crisp geometric gradient, not a blurred placeholder. -->
			<div
				class="size-full"
				style="background:
					radial-gradient(1200px 600px at 15% 10%, oklch(0.32 0.09 275 / 0.55), transparent 60%),
					radial-gradient(900px 500px at 85% 80%, oklch(0.28 0.1 200 / 0.45), transparent 60%),
					linear-gradient(160deg, oklch(0.15 0.01 280), oklch(0.1 0.005 280));"
			></div>
		{/if}
	</div>

	<NavDock
		canContinue={resumable !== null}
		onContinue={continueSession}
		onNewSession={newSession}
		onExit={exit}
	/>

	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-4xl px-8 py-12">
			{#if !data.setup.ready}
				<div
					class="acrylic mb-6 rounded-xl border border-[var(--color-warning)]/40 p-5"
					role="alert"
				>
					<p class="flex items-start gap-2 text-sm font-medium">
						<TriangleExclamationPoint size={16} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
						Setup required
					</p>
					<p class="mt-2 pl-6 text-[13px] leading-relaxed text-white/65">{data.setup.message}</p>
					<p class="mt-2 pl-6 text-[12px] text-white/45">
						See <code class="rounded bg-white/10 px-1">docs/ENVIRONMENT.md</code> in the repository.
					</p>
				</div>
			{/if}

			{#if data.authMode === 'local-dev'}
				<div class="acrylic mb-6 rounded-lg border border-white/10 px-4 py-2.5">
					<p class="text-[11px] leading-relaxed text-white/55">
						<strong class="text-white/75">Local development mode.</strong>
						Accounts and passes are enforced by a local PostgreSQL server, not Supabase.
						This mode is disabled in production.
					</p>
				</div>
			{/if}

			<div class="acrylic rounded-2xl p-8">
				<div class="flex items-center gap-3">
					<div class="flex size-11 items-center justify-center rounded-xl bg-[var(--color-accent-strong)]">
						<MonitorPlay size={22} />
					</div>
					<div>
						<h1 class="text-2xl font-semibold tracking-tight">Watch reactions in sync</h1>
						<p class="text-[13px] text-white/55">
							{data.user
								? `Signed in${data.user.nickname ? ` as ${data.user.nickname}` : ''} · ${data.tier === 'pro' ? 'Pro' : 'Free'}`
								: 'Sign in to start a session'}
						</p>
					</div>
				</div>

				<p class="mt-5 max-w-2xl text-[13px] leading-relaxed text-white/65">
					Bring your own reaction video and the original source. ReactionPlayer aligns them on one
					timeline and keeps them together while you watch. Videos play directly from your device or
					from an authorized URL — nothing is uploaded, hosted or redistributed here.
				</p>

				<div class="mt-6 flex flex-wrap gap-2.5">
					{#if data.user}
						<button type="button" class="btn-primary" onclick={newSession} data-testid="home-new-session">
							<MonitorPlay size={16} /> New Session
						</button>
						<button
							type="button"
							class="btn-ghost"
							disabled={!resumable}
							onclick={continueSession}
							title={resumable ? `Resume "${resumable.name}"` : 'No saved session yet'}
						>
							<Clock size={16} /> Continue
						</button>
					{:else}
						<a href="/signin" class="btn-primary">Sign in to begin</a>
						<a href="/signin?mode=signup" class="btn-ghost">Create account</a>
					{/if}
				</div>

				{#if resumable}
					<div class="mt-6 rounded-lg border border-white/10 bg-white/5 p-4">
						<p class="text-[10px] uppercase tracking-wide text-white/40">Last session</p>
						<p class="mt-1 truncate text-sm font-medium">{resumable.name}</p>
						<p class="mt-0.5 text-[11px] text-white/45">
							{resumable.videoCount} videos · saved {formatRelativeTime(resumable.savedAtMs)}
							{#if resumable.progressFraction > 0}
								· {Math.round(resumable.progressFraction * 100)}% through
							{/if}
						</p>
					</div>
				{/if}
			</div>

			<div class="mt-6 grid gap-4 sm:grid-cols-3">
				{#each [
					{ icon: Film, title: 'Your media stays yours', body: 'Local files play in the browser. No upload, no hosting, no redistribution.' },
					{ icon: Clock, title: 'One offset per pair', body: 'Align once. A session pass covers the pair for 24 hours, including reloads.' },
					{ icon: Shield, title: 'Anonymous by default', body: 'Contributions are anonymous unless you explicitly choose a public nickname.' }
				] as card (card.title)}
					<div class="acrylic rounded-xl p-4">
						<card.icon size={17} class="text-[var(--color-accent)]" />
						<p class="mt-2.5 text-[13px] font-medium">{card.title}</p>
						<p class="mt-1 text-[11px] leading-relaxed text-white/50">{card.body}</p>
					</div>
				{/each}
			</div>

			<p class="mt-6 text-[11px] leading-relaxed text-white/35">
				Playback support depends on the provider. DRM-protected services cannot be embedded here,
				and this app never bypasses paywalls or access controls.
			</p>
		</div>
	</main>
</div>
