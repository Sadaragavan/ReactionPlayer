<script lang="ts">
	/**
	 * Saved sessions (PROJECT_BRIEF.md §15) and the resume flow (§4).
	 *
	 * Resume never assumes a file is reachable:
	 *   1. Try the stored File System Access handle (re-requesting permission).
	 *   2. If unsupported/denied/moved, fall back to explicit reselection with a hint.
	 *   3. Re-acquire or reuse a server pass for the pair before playback.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		FolderOpen,
		Play,
		Copy,
		Trash,
		Download,
		LoaderCircle,
		TriangleExclamationPoint,
		Upload,
		X
	} from '@lucide/svelte';
	import NavDock from '$lib/components/NavDock.svelte';
	import { sessionStore } from '$lib/state/session-store.svelte';
	import { toastStore } from '$lib/state/toast-store.svelte';
	import {
		listSessions,
		loadSession,
		deleteSession,
		duplicateSession,
		exportSessionConfig,
		type SessionSummary
	} from '$lib/persistence/sessions';
	import {
		restoreFile,
		pickVideoFile,
		assessReselectedFile,
		supportsFileHandles
	} from '$lib/persistence/file-handles';
	import { requestFingerprint } from '$lib/media/fingerprint-client';
	import { formatRelativeTime, formatBytes } from '$lib/utils/format';
	import type { Session, SessionVideo } from '$lib/contracts/session';

	interface Props {
		data: { user: { id: string } | null };
	}
	let { data }: Props = $props();

	let sessions = $state<SessionSummary[]>([]);
	let loading = $state(true);
	let resumeState = $state<{
		session: Session;
		pending: SessionVideo[];
		current: SessionVideo | null;
		message: string | null;
		warning: string | null;
		busy: boolean;
	} | null>(null);

	onMount(async () => {
		if (!data.user) {
			goto('/signin?next=/sessions');
			return;
		}
		await refresh();
	});

	async function refresh() {
		loading = true;
		try {
			sessions = await listSessions();
		} finally {
			loading = false;
		}
	}

	async function startResume(id: string) {
		const session = await loadSession(id);
		if (!session) {
			toastStore.show('That session could not be loaded.', { kind: 'error' });
			return;
		}
		const localVideos = session.videos.filter((v) => v.media.provider === 'local-file');
		resumeState = {
			session,
			pending: [...localVideos],
			current: localVideos[0] ?? null,
			message: null,
			warning: null,
			busy: false
		};
		await attemptHandleRestore();
	}

	/** Step 1: try the durable handle (requires a user gesture — the Resume click). */
	async function attemptHandleRestore() {
		if (!resumeState?.current) return;
		const video = resumeState.current;
		resumeState.busy = true;
		resumeState.message = null;
		try {
			if (!video.media.fileHandleId) {
				resumeState.message = supportsFileHandles()
					? 'This video was added without a reusable file reference. Choose the file again.'
					: 'This browser cannot reopen files automatically. Choose the file again to continue.';
				return;
			}
			const outcome = await restoreFile(video.media.fileHandleId);
			if (outcome.status === 'restored') {
				await acceptFile(video, outcome.file);
				return;
			}
			resumeState.message = outcome.reason;
		} finally {
			resumeState.busy = false;
		}
	}

	/** Step 2: explicit reselection fallback. */
	async function reselect() {
		if (!resumeState?.current) return;
		const video = resumeState.current;
		resumeState.busy = true;
		try {
			const picked = await pickVideoFile();
			if (!picked) return;
			const { fingerprint } = await requestFingerprint(picked.file);
			const hint = video.media.reselectHint;
			if (hint) {
				const assessment = assessReselectedFile(picked.file, hint, fingerprint.digest);
				resumeState.warning = assessment.warning;
			}
			await acceptFile(video, picked.file);
		} finally {
			resumeState.busy = false;
		}
	}

	/** Store the runtime file and advance to the next video needing restoration. */
	async function acceptFile(video: SessionVideo, file: File) {
		if (!resumeState) return;
		// Runtime object URL only; never persisted (§4).
		const url = URL.createObjectURL(file);
		const target = resumeState.session.videos.find((v) => v.id === video.id);
		if (target) {
			target.media = { ...target.media, playbackUrl: url };
			target.title = file.name;
		}
		resumeState.pending = resumeState.pending.filter((v) => v.id !== video.id);
		resumeState.current = resumeState.pending[0] ?? null;
		resumeState.message = null;

		if (resumeState.current) {
			await attemptHandleRestore();
		} else {
			await finishResume();
		}
	}

	/** Step 3: re-authorize the pair, then hand off to the player. */
	async function finishResume() {
		if (!resumeState) return;
		const session = resumeState.session;
		resumeState.busy = true;
		try {
			const source = session.videos.find((v) => v.role === 'source');
			const reaction = session.videos.find((v) => v.role === 'reaction');
			const sourceDigest = source?.media.reselectHint?.fingerprintDigest;
			const reactionDigest = reaction?.media.reselectHint?.fingerprintDigest;

			if (sourceDigest && reactionDigest) {
				const response = await fetch('/api/passes', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						reaction: { physicalKey: reactionDigest, logicalId: reaction?.logicalId },
						source: { physicalKey: sourceDigest, logicalId: source?.logicalId }
					})
				});
				const body = await response.json();
				if (!response.ok) {
					const detail =
						body.error?.code === 'quota_exhausted' && body.error.details?.nextAvailableAt
							? ` Next pass available ${new Date(body.error.details.nextAvailableAt).toLocaleString()}.`
							: '';
					toastStore.show((body.error?.message ?? 'Could not authorize this session.') + detail, {
						kind: 'error'
					});
					resumeState.busy = false;
					return;
				}
				session.passId = body.passId;
				sessionStore.setUsage({
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
						? 'Resumed on your existing pass — no new pass consumed.'
						: 'Session re-authorized for 24 hours.',
					{ kind: 'success' }
				);
			}

			sessionStore.replace(session);
			// Hand the runtime URLs to the player via sessionStorage-free in-memory store.
			resumeState = null;
			await goto('/session?resumed=1');
		} finally {
			if (resumeState) resumeState.busy = false;
		}
	}

	function cancelResume() {
		// Release any object URLs created during a cancelled resume.
		for (const video of resumeState?.session.videos ?? []) {
			if (video.media.playbackUrl) URL.revokeObjectURL(video.media.playbackUrl);
		}
		resumeState = null;
	}

	async function remove(id: string) {
		await deleteSession(id);
		await refresh();
		toastStore.show('Session deleted.', { kind: 'info' });
	}

	async function duplicate(id: string) {
		const copy = await duplicateSession(id);
		await refresh();
		toastStore.show(copy ? 'Session duplicated.' : 'Could not duplicate that session.', {
			kind: copy ? 'success' : 'error'
		});
	}

	async function exportConfig(id: string) {
		const session = await loadSession(id);
		if (!session) return;
		const blob = new Blob([exportSessionConfig(session)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = `${session.name.replace(/[^\w.-]+/g, '_')}.reactionplayer.json`;
		anchor.click();
		URL.revokeObjectURL(url);
		toastStore.show('Configuration exported. It contains no media files.', { kind: 'success' });
	}
</script>

<div class="flex h-screen w-full overflow-hidden">
	<NavDock
		canContinue={sessions.length > 0}
		onContinue={() => sessions[0] && startResume(sessions[0].id)}
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
		<div class="mx-auto max-w-4xl px-8 py-10">
			<div class="flex items-center gap-3">
				<FolderOpen size={20} class="text-[var(--color-accent)]" />
				<h1 class="text-xl font-semibold tracking-tight">Saved sessions</h1>
			</div>
			<p class="mt-1.5 text-[13px] text-white/50">
				Stored locally in this browser. Media files are never copied here — resuming reconnects to
				your own files.
			</p>

			{#if !supportsFileHandles()}
				<div class="acrylic mt-5 rounded-lg border border-white/10 px-4 py-3">
					<p class="text-[11px] leading-relaxed text-white/55">
						This browser does not support automatic file reopening. When you resume, you will be
						asked to choose each video again. Your offsets and layout are preserved.
					</p>
				</div>
			{/if}

			{#if loading}
				<p class="mt-8 flex items-center gap-2 text-sm text-white/50">
					<LoaderCircle size={16} class="animate-spin" /> Loading sessions…
				</p>
			{:else if sessions.length === 0}
				<div class="acrylic mt-8 rounded-xl p-8 text-center">
					<p class="text-sm text-white/60">No saved sessions yet.</p>
					<a href="/session" class="btn-primary mt-4 inline-flex">Start a session</a>
				</div>
			{:else}
				<div class="mt-6 flex flex-col gap-3">
					{#each sessions as session (session.id)}
						<div class="acrylic rounded-xl p-4" data-testid="session-card">
							<div class="flex items-start gap-4">
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium">{session.name}</p>
									<p class="mt-0.5 text-[11px] text-white/45">
										{session.videoCount} videos · saved {formatRelativeTime(session.savedAtMs)}
										{#if session.progressFraction > 0}
											· {Math.round(session.progressFraction * 100)}% through
										{/if}
									</p>
									<p class="mt-1 truncate text-[11px] text-white/35">
										{session.videoTitles.join(' · ')}
									</p>
									{#if session.progressFraction > 0}
										<div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
											<div
												class="h-full rounded-full bg-[var(--color-accent)]"
												style="width:{Math.round(session.progressFraction * 100)}%"
											></div>
										</div>
									{/if}
								</div>
								<div class="flex shrink-0 items-center gap-1">
									<button
										type="button"
										class="btn-primary !px-3 !py-1.5 !text-[12px]"
										onclick={() => startResume(session.id)}
										data-testid="resume-session"
									>
										<Play size={14} /> Resume
									</button>
									<button
										type="button"
										class="icon-button tip"
										data-tip="Duplicate"
										aria-label="Duplicate session"
										onclick={() => duplicate(session.id)}
									>
										<Copy size={15} />
									</button>
									<button
										type="button"
										class="icon-button tip"
										data-tip="Export config"
										aria-label="Export session configuration"
										onclick={() => exportConfig(session.id)}
									>
										<Download size={15} />
									</button>
									<button
										type="button"
										class="icon-button tip"
										data-tip="Delete"
										aria-label="Delete session"
										onclick={() => remove(session.id)}
									>
										<Trash size={15} />
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</main>

	<!-- Resume dialog: permission / reselection flow -->
	{#if resumeState}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6"
			role="dialog"
			aria-modal="true"
			aria-labelledby="resume-title"
		>
			<div class="acrylic-strong w-full max-w-lg rounded-xl border border-white/12 p-6">
				<div class="flex items-start justify-between gap-4">
					<div>
						<h2 id="resume-title" class="text-base font-semibold">Reconnect your files</h2>
						<p class="mt-1 text-[12px] text-white/50">{resumeState.session.name}</p>
					</div>
					<button type="button" class="icon-button" aria-label="Cancel resume" onclick={cancelResume}>
						<X size={16} />
					</button>
				</div>

				{#if resumeState.current}
					{@const video = resumeState.current}
					<div class="mt-5 rounded-lg border border-white/10 bg-white/5 p-4">
						<p class="text-[10px] uppercase tracking-wide text-white/40">
							{video.role} video
						</p>
						<p class="mt-1 truncate text-[13px] font-medium">
							{video.media.reselectHint?.fileName ?? video.title}
						</p>
						{#if video.media.reselectHint?.sizeBytes}
							<p class="mt-0.5 text-[11px] text-white/40">
								{formatBytes(video.media.reselectHint.sizeBytes)}
							</p>
						{/if}
					</div>

					{#if resumeState.message}
						<p class="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-white/65">
							<TriangleExclamationPoint size={14} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
							{resumeState.message}
						</p>
					{/if}

					{#if resumeState.warning}
						<p class="mt-3 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-[11px] leading-relaxed">
							{resumeState.warning}
						</p>
					{/if}

					<div class="mt-5 flex gap-2">
						<button
							type="button"
							class="btn-primary flex-1"
							disabled={resumeState.busy}
							onclick={reselect}
							data-testid="reselect-file"
						>
							{#if resumeState.busy}
								<LoaderCircle size={15} class="animate-spin" />
							{:else}
								<Upload size={15} />
							{/if}
							Choose file
						</button>
						{#if video.media.fileHandleId}
							<button
								type="button"
								class="btn-ghost"
								disabled={resumeState.busy}
								onclick={attemptHandleRestore}
							>
								Try permission again
							</button>
						{/if}
					</div>

					<p class="mt-3 text-[11px] text-white/40">
						{resumeState.pending.length} of {resumeState.session.videos.length} files remaining.
					</p>
				{:else}
					<p class="mt-5 flex items-center gap-2 text-[13px] text-white/65">
						<LoaderCircle size={15} class="animate-spin" /> Re-authorizing session…
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>
