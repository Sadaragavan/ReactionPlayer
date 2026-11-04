<script lang="ts">
	/**
	 * Playback HUD (PROJECT_BRIEF.md §15).
	 *
	 * - Docked directly to the top/bottom window borders (no floating gap).
	 * - Auto-hides after ~2.5s of pointer inactivity.
	 * - Stays visible while keyboard focus is inside, while scrubbing, or while a menu is open.
	 * - Linked mode shows ONE master timeline; unlinked shows per-video timelines.
	 *   The scrubbers animate between the two without remounting video elements.
	 */
	import {
		Play,
		Pause,
		Link,
		Unlink,
		Maximize,
		Minimize,
		Volume2,
		VolumeX,
		Save,
		Columns2,
		PictureInPicture2,
		Crosshair,
		StepBack,
		StepForward,
		LoaderCircle,
		TriangleExclamationPoint
	} from '@lucide/svelte';
	import type { SessionVideo, LayoutType } from '$lib/contracts/session';
	import type { EngineState } from '$lib/sync/engine';
	import { syncPolicy } from '$lib/config/policy';

	interface Props {
		videos: SessionVideo[];
		engineState: EngineState;
		isLinked: boolean;
		isTheaterMode: boolean;
		layout: LayoutType;
		masterTimeSeconds: number;
		masterDurationSeconds: number | null;
		videoTimes: Record<string, number>;
		isSaving: boolean;
		menuOpen: boolean;
		visible: boolean;
		onTogglePlay: () => void;
		onToggleLinked: () => void;
		onToggleTheater: () => void;
		onToggleFullscreen: () => void;
		onSeek: (seconds: number, videoId?: string) => void;
		onSeekBy: (delta: number) => void;
		onFrameStep: (direction: 1 | -1) => void;
		onVolume: (id: string, volume: number) => void;
		onMute: (id: string, muted: boolean) => void;
		onLayout: (layout: LayoutType) => void;
		onAlign: (id: string) => void;
		onOffsetNudge: (id: string, deltaMs: number) => void;
		onSave: () => void;
		onInteract: () => void;
	}

	let {
		videos,
		engineState,
		isLinked,
		isTheaterMode,
		layout,
		masterTimeSeconds,
		masterDurationSeconds,
		videoTimes,
		isSaving,
		menuOpen,
		visible,
		onTogglePlay,
		onToggleLinked,
		onToggleTheater,
		onToggleFullscreen,
		onSeek,
		onSeekBy,
		onFrameStep,
		onVolume,
		onMute,
		onLayout,
		onAlign,
		onOffsetNudge,
		onSave,
		onInteract
	}: Props = $props();

	let scrubbing = $state(false);
	let focusWithin = $state(false);

	// Never hide while the user is actively interacting (§15).
	const effectiveVisible = $derived(visible || scrubbing || focusWithin || menuOpen);

	function formatTime(seconds: number | null | undefined): string {
		if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '0:00';
		const total = Math.max(0, Math.floor(seconds));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		return h > 0
			? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
			: `${m}:${String(s).padStart(2, '0')}`;
	}

	function handleScrub(event: Event, videoId?: string) {
		const value = Number((event.target as HTMLInputElement).value);
		onSeek(value, videoId);
		onInteract();
	}

	const blocking = $derived(engineState.blockingReason);
</script>

<!-- TOP HUD: docked flush to the top window border -->
<div
	class="acrylic-strong pointer-events-auto absolute inset-x-0 top-0 z-40 flex items-center gap-2 border-b border-white/8 px-3 py-2 transition-transform duration-[var(--hud-transition)] ease-out {effectiveVisible
		? 'translate-y-0'
		: '-translate-y-full'}"
	onfocusin={() => (focusWithin = true)}
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node)) focusWithin = false;
	}}
	data-testid="hud-top"
>
	<div class="flex items-center gap-1">
		<button
			type="button"
			class="icon-button tip tip-below"
			data-tip={isLinked ? 'Unlink controls (L)' : 'Link controls (L)'}
			data-active={isLinked}
			aria-label={isLinked ? 'Unlink playback controls' : 'Link playback controls'}
			aria-pressed={isLinked}
			onclick={onToggleLinked}
		>
			{#if isLinked}<Link size={17} />{:else}<Unlink size={17} />{/if}
		</button>

		<div class="mx-1 h-5 w-px bg-white/10" aria-hidden="true"></div>

		<button
			type="button"
			class="icon-button tip tip-below"
			data-tip="Split layout"
			data-active={layout === 'split'}
			aria-label="Split layout"
			aria-pressed={layout === 'split'}
			onclick={() => onLayout('split')}
		>
			<Columns2 size={17} />
		</button>
		<button
			type="button"
			class="icon-button tip tip-below"
			data-tip="Picture in picture"
			data-active={layout === 'pip'}
			aria-label="Picture in picture layout"
			aria-pressed={layout === 'pip'}
			onclick={() => onLayout('pip')}
		>
			<PictureInPicture2 size={17} />
		</button>
	</div>

	<div class="flex-1"></div>

	{#if blocking}
		<div
			class="flex items-center gap-1.5 rounded-md bg-[var(--color-warning)]/15 px-2 py-1 text-[11px] text-[var(--color-warning)]"
			role="status"
		>
			{#if blocking.kind === 'buffering'}
				<LoaderCircle size={12} class="animate-spin" />
				Buffering…
			{:else}
				<TriangleExclamationPoint size={12} />
				{blocking.kind === 'autoplay-rejected'
					? 'Press play to start'
					: blocking.kind === 'all-ended'
						? 'Playback finished'
						: 'Playback problem'}
			{/if}
		</div>
	{/if}

	{#if isLinked && engineState.followers.length > 0}
		<div class="hidden items-center gap-2 text-[11px] text-white/45 lg:flex" aria-live="off">
			{#each engineState.followers as follower (follower.id)}
				<span title="Drift relative to the master clock. Correction is perceptual, not frame-exact.">
					drift {follower.driftMs >= 0 ? '+' : ''}{Math.round(follower.driftMs)}ms
				</span>
			{/each}
		</div>
	{/if}

	<div class="flex items-center gap-1">
		<button
			type="button"
			class="icon-button tip tip-below"
			data-tip="Save session"
			aria-label="Save session"
			disabled={isSaving}
			onclick={onSave}
		>
			{#if isSaving}<LoaderCircle size={17} class="animate-spin" />{:else}<Save size={17} />{/if}
		</button>
		<button
			type="button"
			class="icon-button tip tip-below"
			data-tip={isTheaterMode ? 'Exit theater (T)' : 'Theater mode (T)'}
			data-active={isTheaterMode}
			aria-label={isTheaterMode ? 'Exit theater mode' : 'Enter theater mode'}
			aria-pressed={isTheaterMode}
			onclick={onToggleTheater}
		>
			{#if isTheaterMode}<Minimize size={17} />{:else}<Maximize size={17} />{/if}
		</button>
	</div>
</div>

<!-- BOTTOM HUD: docked flush to the bottom window border -->
<div
	class="acrylic-strong pointer-events-auto absolute inset-x-0 bottom-0 z-40 border-t border-white/8 transition-transform duration-[var(--hud-transition)] ease-out {effectiveVisible
		? 'translate-y-0'
		: 'translate-y-full'}"
	onfocusin={() => (focusWithin = true)}
	onfocusout={(event) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node)) focusWithin = false;
	}}
	data-testid="hud-bottom"
>
	<!-- Master timeline (linked) -->
	{#if isLinked}
		<div class="flex items-center gap-3 px-3 pt-2.5">
			<span class="w-14 shrink-0 text-right font-mono text-[11px] text-white/60">
				{formatTime(masterTimeSeconds)}
			</span>
			<input
				type="range"
				class="slider flex-1"
				min="0"
				max={masterDurationSeconds ?? 0}
				step="0.05"
				value={masterTimeSeconds}
				disabled={!masterDurationSeconds}
				aria-label="Master timeline position"
				onpointerdown={() => (scrubbing = true)}
				onpointerup={() => (scrubbing = false)}
				oninput={(event) => handleScrub(event)}
				data-testid="master-scrubber"
			/>
			<span class="w-14 shrink-0 font-mono text-[11px] text-white/40">
				{formatTime(masterDurationSeconds)}
			</span>
		</div>
	{/if}

	<!-- Per-video timelines (unlinked). Rendered in a separate container so the video
	     elements themselves are untouched by the transition. -->
	{#if !isLinked}
		<div class="flex flex-col gap-1.5 px-3 pt-2.5">
			{#each videos as video (video.id)}
				<div class="flex items-center gap-2.5">
					<span class="w-16 shrink-0 truncate text-[10px] uppercase tracking-wide text-white/40">
						{video.role}
					</span>
					<span class="w-12 shrink-0 text-right font-mono text-[11px] text-white/60">
						{formatTime(videoTimes[video.id] ?? 0)}
					</span>
					<input
						type="range"
						class="slider flex-1"
						min="0"
						max={video.durationSeconds ?? 0}
						step="0.05"
						value={videoTimes[video.id] ?? 0}
						disabled={!video.durationSeconds}
						aria-label="{video.role} timeline position"
						onpointerdown={() => (scrubbing = true)}
						onpointerup={() => (scrubbing = false)}
						oninput={(event) => handleScrub(event, video.id)}
					/>
					<span class="w-12 shrink-0 font-mono text-[11px] text-white/40">
						{formatTime(video.durationSeconds)}
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Transport + per-video audio/offset -->
	<div class="flex flex-wrap items-center gap-2 px-3 py-2">
		<div class="flex items-center gap-0.5">
			<button
				type="button"
				class="icon-button tip"
				data-tip="Back 5s (←)"
				aria-label="Seek back five seconds"
				onclick={() => onSeekBy(-syncPolicy.seekStepSeconds)}
			>
				<StepBack size={17} />
			</button>
			<button
				type="button"
				class="icon-button tip !size-10 !bg-white/10"
				data-tip={engineState.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
				aria-label={engineState.isPlaying ? 'Pause' : 'Play'}
				onclick={onTogglePlay}
				data-testid="play-toggle"
			>
				{#if engineState.isPlaying}<Pause size={19} />{:else}<Play size={19} />{/if}
			</button>
			<button
				type="button"
				class="icon-button tip"
				data-tip="Forward 5s (→)"
				aria-label="Seek forward five seconds"
				onclick={() => onSeekBy(syncPolicy.seekStepSeconds)}
			>
				<StepForward size={17} />
			</button>

			{#if !engineState.isPlaying}
				<!-- Approximate frame stepping: HTML5 exposes no exact frame-step API. -->
				<div class="ml-1 flex items-center gap-0.5 rounded-md bg-white/5 px-1">
					<button
						type="button"
						class="icon-button tip !size-7"
						data-tip="Previous frame (approx.)"
						aria-label="Step back one frame (approximate)"
						onclick={() => onFrameStep(-1)}
					>
						<StepBack size={13} />
					</button>
					<span class="px-0.5 text-[9px] uppercase tracking-wide text-white/35">frame</span>
					<button
						type="button"
						class="icon-button tip !size-7"
						data-tip="Next frame (approx.)"
						aria-label="Step forward one frame (approximate)"
						onclick={() => onFrameStep(1)}
					>
						<StepForward size={13} />
					</button>
				</div>
			{/if}
		</div>

		<div class="mx-1 h-6 w-px bg-white/10" aria-hidden="true"></div>

		{#each videos as video (video.id)}
			<div class="flex items-center gap-1.5 rounded-lg bg-white/5 px-2 py-1">
				<span class="max-w-20 truncate text-[10px] uppercase tracking-wide text-white/45">
					{video.role}
				</span>

				<button
					type="button"
					class="icon-button tip !size-7"
					data-tip={video.muted ? 'Unmute' : 'Mute'}
					aria-label={video.muted ? `Unmute ${video.role}` : `Mute ${video.role}`}
					aria-pressed={video.muted}
					onclick={() => onMute(video.id, !video.muted)}
				>
					{#if video.muted}<VolumeX size={14} />{:else}<Volume2 size={14} />{/if}
				</button>
				<input
					type="range"
					class="slider !w-16"
					min="0"
					max="1"
					step="0.01"
					value={video.volume}
					aria-label="{video.role} volume"
					oninput={(event) => onVolume(video.id, Number((event.target as HTMLInputElement).value))}
				/>

				{#if video.id !== engineState.masterId}
					<div class="mx-0.5 h-4 w-px bg-white/10" aria-hidden="true"></div>
					<button
						type="button"
						class="icon-button tip !size-7"
						data-tip="Align to master position"
						aria-label="Align {video.role} to the master position"
						onclick={() => onAlign(video.id)}
						data-testid="align-{video.role}"
					>
						<Crosshair size={14} />
					</button>
					<div class="flex items-center gap-0.5">
						<button
							type="button"
							class="rounded px-1 py-0.5 font-mono text-[10px] text-white/55 hover:bg-white/10"
							aria-label="Decrease {video.role} offset by 100 milliseconds"
							onclick={() => onOffsetNudge(video.id, -100)}
						>
							−
						</button>
						<span
							class="w-16 text-center font-mono text-[10px] text-white/70"
							title="Offset relative to the master timeline. Positive means this video runs ahead."
							data-testid="offset-{video.role}"
						>
							{video.offsetMs >= 0 ? '+' : ''}{(video.offsetMs / 1000).toFixed(2)}s
						</span>
						<button
							type="button"
							class="rounded px-1 py-0.5 font-mono text-[10px] text-white/55 hover:bg-white/10"
							aria-label="Increase {video.role} offset by 100 milliseconds"
							onclick={() => onOffsetNudge(video.id, 100)}
						>
							+
						</button>
					</div>
				{:else}
					<span class="rounded bg-[var(--color-accent)]/20 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--color-accent)]">
						Master
					</span>
				{/if}
			</div>
		{/each}

		<div class="flex-1"></div>

		<button
			type="button"
			class="icon-button tip"
			data-tip="Fullscreen (F)"
			aria-label="Toggle browser fullscreen"
			onclick={onToggleFullscreen}
		>
			<Maximize size={16} />
		</button>
	</div>
</div>
