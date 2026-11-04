<script lang="ts">
	/**
	 * Playback surface (PROJECT_BRIEF.md §15) — the v0.0 vertical slice:
	 *   authenticated user -> two local videos -> server-authorized pass ->
	 *   align + synchronize -> save locally -> resume with permission/reselection.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		Upload,
		Film,
		LoaderCircle,
		TriangleExclamationPoint,
		Copy,
		Volume2,
		Crosshair,
		RotateCcw,
		Gauge,
		Lock,
		LockOpen,
		Clock
	} from '@lucide/svelte';
	import VideoStage from '$lib/components/VideoStage.svelte';
	import PlaybackHud from '$lib/components/PlaybackHud.svelte';
	import { PlayerController } from '$lib/state/player.svelte';
	import { sessionStore, createSessionVideo } from '$lib/state/session-store.svelte';
	import { toastStore } from '$lib/state/toast-store.svelte';
	import {
		pickVideoFile,
		storeFileHandle,
		type FileSystemFileHandleLike
	} from '$lib/persistence/file-handles';
	import { requestFingerprint } from '$lib/media/fingerprint-client';
	import { uiPolicy, syncPolicy } from '$lib/config/policy';
	import type { SessionVideo, VideoRole, LayoutType } from '$lib/contracts/session';
	import type { MediaReference } from '$lib/contracts/media';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let player: PlayerController | null = $state(null);
	let stageElement = $state<HTMLDivElement | null>(null);
	let hudVisible = $state(true);
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let isLoadingMedia = $state(false);
	let acquiringPass = $state(false);
	let passError = $state<string | null>(null);
	let nextAvailableAt = $state<string | null>(null);

	/** Pending file selections awaiting pass authorization. */
	let pending = $state<
		Record<string, { file: File; handle: FileSystemFileHandleLike | null; digest: string }>
	>({});

	let contextMenu = $state<{ video: SessionVideo; x: number; y: number } | null>(null);

	const videos = $derived(sessionStore.current.videos);
	const alignment = $derived(sessionStore.current.alignment);
	const needsSource = $derived(!videos.some((v) => v.role === 'source'));
	const needsReaction = $derived(!videos.some((v) => v.role === 'reaction'));
	const bothSelected = $derived(videos.length >= 2);

	onMount(() => {
		player = new PlayerController();
		if (!data.user) {
			goto('/signin?next=/session');
			return;
		}
		void refreshUsage();
		window.addEventListener('pointermove', revealHud);
		window.addEventListener('keydown', handleKeydown);
		revealHud();

		return () => {
			window.removeEventListener('pointermove', revealHud);
			window.removeEventListener('keydown', handleKeydown);
			if (hideTimer) clearTimeout(hideTimer);
			player?.destroy();
			player = null;
		};
	});

	// -------------------------------------------------------------------------
	// HUD visibility
	// -------------------------------------------------------------------------

	function revealHud() {
		hudVisible = true;
		if (hideTimer) clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			hudVisible = false;
		}, uiPolicy.hudAutoHideMs);
	}

	// -------------------------------------------------------------------------
	// Pass usage
	// -------------------------------------------------------------------------

	async function refreshUsage() {
		try {
			const response = await fetch('/api/passes');
			if (!response.ok) return;
			const status = await response.json();
			sessionStore.setUsage({
				baseUsed: status.usage.baseUsed,
				baseCapacity: status.usage.baseCapacity,
				bonusUsed: status.usage.bonusUsed,
				bonusCapacity: status.usage.bonusCapacity,
				nextAvailableAt: status.nextAvailableAt,
				tier: status.tier,
				videoLimit: status.videoLimit
			});
		} catch {
			// Non-fatal: the meter simply shows the last known value.
		}
	}

	// -------------------------------------------------------------------------
	// Media selection
	// -------------------------------------------------------------------------

	async function chooseFile(role: VideoRole) {
		if (!data.user) {
			toastStore.show('Sign in to start a session.', { kind: 'warning' });
			return;
		}
		revealHud();
		isLoadingMedia = true;
		try {
			const picked = await pickVideoFile();
			if (!picked) return;

			const { fingerprint } = await requestFingerprint(picked.file);

			// Register the fingerprint (private, owner-only). This is identification,
			// not verification of any catalog claim.
			let physicalId: string | null = null;
			try {
				const response = await fetch('/api/identities', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						digest: fingerprint.digest,
						provider: 'local-file',
						sizeBytes: fingerprint.sizeBytes,
						fileName: picked.file.name,
						exhaustive: fingerprint.exhaustive
					})
				});
				if (response.ok) {
					const body = await response.json();
					physicalId = body.physicalId ?? null;
				}
			} catch {
				// Identification is best-effort; the digest still keys the pass locally.
			}

			const handleId = picked.handle
				? await storeFileHandle(picked.handle, picked.file, fingerprint.digest)
				: null;

			const media: MediaReference = {
				provider: 'local-file',
				physicalId,
				fileHandleId: handleId,
				sourceUrl: null,
				playbackUrl: null,
				reselectHint: {
					fileName: picked.file.name,
					sizeBytes: picked.file.size,
					lastModifiedMs: picked.file.lastModified,
					fingerprintDigest: fingerprint.digest
				}
			};

			// Replace an existing video in the same role rather than stacking duplicates.
			const existing = videos.find((v) => v.role === role);
			if (existing) {
				player?.unregister(existing.id);
				sessionStore.removeVideo(existing.id);
			}

			const video = createSessionVideo({
				role,
				title: picked.file.name,
				media,
				index: videos.length,
				layout: alignment.layoutType
			});
			if (!sessionStore.addVideo(video)) return;

			pending[video.id] = { file: picked.file, handle: picked.handle, digest: fingerprint.digest };

			// A new pair invalidates any previous authorization.
			sessionStore.current.passId = null;

			if (sessionStore.current.videos.length >= 2) {
				await acquirePass();
			}
		} catch (error) {
			toastStore.show(
				error instanceof Error ? error.message : 'Could not read that file.',
				{ kind: 'error' }
			);
		} finally {
			isLoadingMedia = false;
		}
	}

	/** Request a server-authorized pass for the current pair. */
	async function acquirePass() {
		const source = videos.find((v) => v.role === 'source');
		const reaction = videos.find((v) => v.role === 'reaction');
		if (!source || !reaction) return;

		const sourceDigest = pending[source.id]?.digest ?? source.media.reselectHint?.fingerprintDigest;
		const reactionDigest =
			pending[reaction.id]?.digest ?? reaction.media.reselectHint?.fingerprintDigest;
		if (!sourceDigest || !reactionDigest) {
			passError = 'Both videos need to be identified before playback can start.';
			return;
		}

		acquiringPass = true;
		passError = null;
		nextAvailableAt = null;
		try {
			const response = await fetch('/api/passes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					// A fresh request id per attempt; retries of the SAME attempt reuse it
					// via the stored id below.
					requestId: crypto.randomUUID(),
					reaction: { physicalKey: reactionDigest, logicalId: reaction.logicalId },
					source: { physicalKey: sourceDigest, logicalId: source.logicalId }
				})
			});

			const body = await response.json();
			if (!response.ok) {
				if (body.error?.code === 'quota_exhausted') {
					passError = 'You have used all your session passes for now.';
					nextAvailableAt = body.error.details?.nextAvailableAt ?? null;
					if (body.error.details?.usage) {
						sessionStore.setUsage({
							...sessionStore.usage,
							...body.error.details.usage
						});
					}
				} else {
					passError = body.error?.message ?? 'Could not authorize this session.';
				}
				return;
			}

			sessionStore.applyPass(body.passId, {
				baseUsed: body.usage.baseUsed,
				baseCapacity: body.usage.baseCapacity,
				bonusUsed: body.usage.bonusUsed,
				bonusCapacity: body.usage.bonusCapacity,
				nextAvailableAt: body.nextAvailableAt,
				tier: body.tier,
				videoLimit: body.videoLimit
			});

			toastStore.show(
				body.outcome === 'reused'
					? 'Existing session pass reused — no new pass consumed.'
					: 'Session authorized for 24 hours.',
				{ kind: 'success' }
			);

			await loadPendingMedia();
		} catch {
			passError = 'Could not reach the pass service. Check your connection and try again.';
		} finally {
			acquiringPass = false;
		}
	}

	/** Attach runtime object URLs only after authorization succeeds. */
	async function loadPendingMedia() {
		for (const video of sessionStore.current.videos) {
			const entry = pending[video.id];
			if (!entry) continue;
			const element = player?.getElement(video.id);
			if (!element) continue;
			const url = player?.loadFile(video.id, entry.file) ?? null;
			if (url) sessionStore.updateVideo(video.id, { media: { ...video.media, playbackUrl: url } });
		}
		// Apply the default audio source: the reaction is usually the one you listen to.
		const reaction = sessionStore.current.videos.find((v) => v.role === 'reaction');
		if (reaction) player?.setAudioSource(reaction.id);
	}

	/** Re-register elements after they are rendered (Svelte binds them asynchronously). */
	async function registerElement(video: SessionVideo, element: HTMLVideoElement) {
		if (!player) return;
		await player.registerElement(video, element);
		const entry = pending[video.id];
		if (entry && sessionStore.current.passId) {
			const url = player.loadFile(video.id, entry.file);
			if (url) sessionStore.updateVideo(video.id, { media: { ...video.media, playbackUrl: url } });
		}
	}

	// -------------------------------------------------------------------------
	// Keyboard (§15)
	// -------------------------------------------------------------------------

	function handleKeydown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		// Never intercept typing or dialog interaction.
		if (
			target &&
			(target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.tagName === 'SELECT' ||
				target.isContentEditable ||
				target.closest('[role="dialog"]'))
		) {
			return;
		}
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (!player) return;

		switch (event.key) {
			case ' ':
				event.preventDefault();
				void player.togglePlay();
				revealHud();
				break;
			case 'l':
			case 'L':
				event.preventDefault();
				player.setLinked(!sessionStore.current.isLinked);
				revealHud();
				break;
			case 't':
			case 'T':
				event.preventDefault();
				sessionStore.setTheaterMode(!sessionStore.current.isTheaterMode);
				revealHud();
				break;
			case 'f':
			case 'F':
				event.preventDefault();
				void toggleFullscreen();
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (player.state.isPlaying) player.engine.seekBy(-syncPolicy.seekStepSeconds);
				else player.engine.frameStep(-1);
				revealHud();
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (player.state.isPlaying) player.engine.seekBy(syncPolicy.seekStepSeconds);
				else player.engine.frameStep(1);
				revealHud();
				break;
			case 'Escape':
				if (contextMenu) contextMenu = null;
				else if (sessionStore.current.isTheaterMode) sessionStore.setTheaterMode(false);
				break;
		}
	}

	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await (stageElement ?? document.documentElement).requestFullscreen();
		} catch {
			toastStore.show('Fullscreen was blocked by the browser.', { kind: 'warning' });
		}
	}

	// -------------------------------------------------------------------------
	// Context menu (§15)
	// -------------------------------------------------------------------------

	function openContextMenu(video: SessionVideo, event: MouseEvent) {
		event.preventDefault();
		contextMenu = { video, x: event.clientX, y: event.clientY };
		revealHud();
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	async function save() {
		if (!player) return;
		const ok = await player.save();
		toastStore.show(ok ? 'Session saved locally.' : 'Could not save this session.', {
			kind: ok ? 'success' : 'error'
		});
	}

	function resetAlignment() {
		sessionStore.setLayout(alignment.layoutType);
		toastStore.show('Viewport alignment reset.', { kind: 'info' });
	}

	const usageLabel = $derived(
		sessionStore.usage.tier === 'pro'
			? 'Pro · unlimited passes'
			: `${sessionStore.usage.baseUsed}/${sessionStore.usage.baseCapacity} passes used` +
					(sessionStore.usage.bonusCapacity > 0
						? ` · +${sessionStore.usage.bonusUsed}/${sessionStore.usage.bonusCapacity} bonus`
						: '')
	);
</script>

<svelte:window onclick={closeContextMenu} />

<div class="relative flex h-screen w-full overflow-hidden bg-black" bind:this={stageElement}>
	{#if player}
		<VideoStage
			{videos}
			coordinates={alignment.coordinates}
			locked={alignment.locked}
			{registerElement}
			onContextMenu={openContextMenu}
			onDoubleClick={() => void toggleFullscreen()}
		/>

		<!-- Setup overlay: shown until the pair is authorized -->
		{#if !sessionStore.current.passId}
			<div class="absolute inset-0 z-30 flex items-center justify-center bg-black/80 p-6">
				<div class="acrylic w-full max-w-xl rounded-xl p-6">
					<h1 class="text-lg font-semibold tracking-tight">Start a synchronized session</h1>
					<p class="mt-1 text-[13px] leading-relaxed text-white/55">
						Add the original source and the reaction. Nothing is uploaded — files stay on your
						device and play directly in your browser.
					</p>

					<div class="mt-5 grid grid-cols-2 gap-3">
						{#each [{ role: 'source', label: 'Source video', needed: needsSource }, { role: 'reaction', label: 'Reaction video', needed: needsReaction }] as slot (slot.role)}
							{@const existing = videos.find((v) => v.role === slot.role)}
							<button
								type="button"
								class="flex flex-col items-start gap-2 rounded-lg border border-white/12 bg-white/5 p-4 text-left transition-colors hover:border-[var(--color-accent)]/60 hover:bg-white/10 disabled:opacity-50"
								disabled={isLoadingMedia || acquiringPass}
								onclick={() => chooseFile(slot.role as VideoRole)}
								data-testid="pick-{slot.role}"
							>
								<div class="flex w-full items-center gap-2">
									{#if existing}
										<Film size={16} class="text-[var(--color-success)]" />
									{:else}
										<Upload size={16} class="text-white/50" />
									{/if}
									<span class="text-[13px] font-medium">{slot.label}</span>
								</div>
								<span class="line-clamp-2 text-[11px] leading-snug text-white/45">
									{existing ? existing.title : 'Choose a local video file'}
								</span>
							</button>
						{/each}
					</div>

					<div class="mt-4 flex items-center gap-2 text-[11px] text-white/45">
						<Clock size={13} />
						<span data-testid="pass-usage">{usageLabel}</span>
					</div>

					{#if isLoadingMedia}
						<p class="mt-3 flex items-center gap-2 text-[12px] text-white/60">
							<LoaderCircle size={14} class="animate-spin" />
							Identifying media…
						</p>
					{/if}

					{#if passError}
						<div
							class="mt-4 rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3"
							role="alert"
							data-testid="pass-error"
						>
							<p class="flex items-start gap-2 text-[12px] leading-relaxed text-white/85">
								<TriangleExclamationPoint size={14} class="mt-0.5 shrink-0" />
								{passError}
							</p>
							{#if nextAvailableAt}
								<p class="mt-1.5 pl-6 text-[11px] text-white/55">
									Next pass available {new Date(nextAvailableAt).toLocaleString()}.
								</p>
							{/if}
						</div>
					{/if}

					<div class="mt-5 flex items-center gap-2">
						<button
							type="button"
							class="btn-primary flex-1"
							disabled={!bothSelected || acquiringPass || isLoadingMedia}
							onclick={acquirePass}
							data-testid="authorize-session"
						>
							{#if acquiringPass}
								<LoaderCircle size={15} class="animate-spin" />
								Authorizing…
							{:else}
								Start session
							{/if}
						</button>
						<a href="/" class="btn-ghost">Cancel</a>
					</div>

					<p class="mt-3 text-[10px] leading-relaxed text-white/35">
						A pass covers this reaction/source pair for 24 hours. Reloading, resuming and
						rewatching within that window is free.
					</p>
				</div>
			</div>
		{/if}

		<PlaybackHud
			{videos}
			engineState={player.state}
			isLinked={sessionStore.current.isLinked}
			isTheaterMode={sessionStore.current.isTheaterMode}
			layout={alignment.layoutType}
			masterTimeSeconds={player.masterTimeSeconds}
			masterDurationSeconds={player.masterDurationSeconds}
			videoTimes={player.videoTimes}
			isSaving={sessionStore.isSaving}
			menuOpen={contextMenu !== null}
			visible={hudVisible}
			onTogglePlay={() => void player?.togglePlay()}
			onToggleLinked={() => player?.setLinked(!sessionStore.current.isLinked)}
			onToggleTheater={() => sessionStore.setTheaterMode(!sessionStore.current.isTheaterMode)}
			onToggleFullscreen={() => void toggleFullscreen()}
			onSeek={(seconds, videoId) => player?.engine.seek(seconds, videoId)}
			onSeekBy={(delta) => player?.engine.seekBy(delta)}
			onFrameStep={(direction) => player?.engine.frameStep(direction)}
			onVolume={(id, volume) => {
				player?.engine.setVolume(id, volume);
				sessionStore.updateVideo(id, { volume });
			}}
			onMute={(id, muted) => {
				player?.engine.setMuted(id, muted);
				sessionStore.updateVideo(id, { muted });
			}}
			onLayout={(layout: LayoutType) => sessionStore.setLayout(layout)}
			onAlign={(id) => player?.alignToCurrent(id)}
			onOffsetNudge={(id, delta) => player?.nudgeOffset(id, delta)}
			onSave={() => void save()}
			onInteract={revealHud}
		/>
	{/if}

	<!-- Video context menu (§15) -->
	{#if contextMenu}
		<div
			class="acrylic-strong fixed z-[60] w-60 overflow-hidden rounded-lg border border-white/12 py-1 shadow-2xl"
			style="left:{Math.min(contextMenu.x, window.innerWidth - 250)}px;top:{Math.min(
				contextMenu.y,
				window.innerHeight - 300
			)}px"
			role="menu"
			tabindex="-1"
			aria-label="Video options"
			onclick={(event) => event.stopPropagation()}
			onkeydown={(event) => event.key === 'Escape' && closeContextMenu()}
		>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					void player?.copyFrame(contextMenu!.video.id);
					closeContextMenu();
				}}
			>
				<Copy size={14} /> Copy frame
			</button>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					player?.setAudioSource(contextMenu!.video.id);
					closeContextMenu();
				}}
			>
				<Volume2 size={14} /> Set as audio source
			</button>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					player?.setMaster(contextMenu!.video.id);
					closeContextMenu();
				}}
			>
				<Crosshair size={14} /> Set as sync master
			</button>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					player?.alignToCurrent(contextMenu!.video.id);
					closeContextMenu();
				}}
			>
				<Crosshair size={14} /> Align to master position
			</button>

			<div class="my-1 h-px bg-white/8" aria-hidden="true"></div>

			<div class="px-3 py-1.5">
				<p class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/35">
					<Gauge size={11} /> Playback speed
				</p>
				<div class="flex flex-wrap gap-1">
					{#each [0.5, 0.75, 1, 1.25, 1.5, 2] as rate (rate)}
						<button
							type="button"
							class="rounded px-1.5 py-0.5 text-[11px] text-white/70 hover:bg-white/10"
							onclick={() => {
								player?.engine.setRate(rate, contextMenu!.video.id);
								sessionStore.updateVideo(contextMenu!.video.id, { playbackRate: rate });
								closeContextMenu();
							}}
						>
							{rate}×
						</button>
					{/each}
				</div>
			</div>

			<div class="my-1 h-px bg-white/8" aria-hidden="true"></div>

			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					resetAlignment();
					closeContextMenu();
				}}
			>
				<RotateCcw size={14} /> Reset viewport alignment
			</button>
			<button
				type="button"
				class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-white/80 hover:bg-white/10"
				role="menuitem"
				onclick={() => {
					sessionStore.setLayoutLocked(!alignment.locked);
					closeContextMenu();
				}}
			>
				{#if alignment.locked}<LockOpen size={14} />{:else}<Lock size={14} />{/if}
				{alignment.locked ? 'Unlock layout' : 'Lock layout'}
			</button>

			<p class="px-3 pt-2 pb-1 text-[10px] leading-snug text-white/30">
				Audio-track selection is not available for local HTML5 video.
			</p>
		</div>
	{/if}
</div>
