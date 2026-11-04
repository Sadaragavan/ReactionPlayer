<script lang="ts">
	/**
	 * Video stage (PROJECT_BRIEF.md §15).
	 *
	 * Video elements are keyed by video id and NEVER remounted when layout or linked state
	 * changes, so playback is not disrupted by a layout transition. Only the positioning
	 * wrapper's style changes, which is GPU-friendly (transform/size on a wrapper).
	 */
	import type { SessionVideo, ViewportCoordinates } from '$lib/contracts/session';
	import { clamp01 } from '$lib/contracts/session';

	interface Props {
		videos: SessionVideo[];
		coordinates: Record<string, ViewportCoordinates>;
		locked: boolean;
		registerElement: (video: SessionVideo, element: HTMLVideoElement) => void;
		onContextMenu: (video: SessionVideo, event: MouseEvent) => void;
		onDoubleClick: (video: SessionVideo) => void;
	}

	let {
		videos,
		coordinates,
		locked,
		registerElement,
		onContextMenu,
		onDoubleClick
	}: Props = $props();

	function styleFor(video: SessionVideo, index: number): string {
		const coord = coordinates[video.id];
		if (!coord) {
			// Fallback split so a video is never invisible before coordinates exist.
			const width = 100 / Math.max(1, videos.length);
			return `left:${index * width}%;top:0%;width:${width}%;height:100%;z-index:${index};`;
		}
		const x = clamp01(coord.x) * 100;
		const y = clamp01(coord.y) * 100;
		const w = clamp01(coord.width) * 100;
		const h = clamp01(coord.height) * 100;
		return `left:${x}%;top:${y}%;width:${w}%;height:${h}%;z-index:${coord.z};opacity:${clamp01(coord.opacity)};`;
	}

	/**
	 * Svelte action that hands the rendered element to the player.
	 *
	 * An action (rather than bind:this) is used because the element must be registered
	 * exactly once per video id and must survive layout changes without remounting.
	 */
	function registerAction(
		node: HTMLVideoElement,
		params: { video: SessionVideo; register: (v: SessionVideo, el: HTMLVideoElement) => void }
	) {
		params.register(params.video, node);
		return {
			update(next: { video: SessionVideo; register: (v: SessionVideo, el: HTMLVideoElement) => void }) {
				// Only re-register if the video identity changed; the node itself is stable.
				if (next.video.id !== params.video.id) next.register(next.video, node);
				params = next;
			}
		};
	}

	/** Crop is expressed as inset fractions of the source frame. */
	function cropStyle(video: SessionVideo): string {
		const crop = coordinates[video.id]?.crop;
		if (!crop) return '';
		const top = clamp01(crop.top) * 100;
		const right = clamp01(crop.right) * 100;
		const bottom = clamp01(crop.bottom) * 100;
		const left = clamp01(crop.left) * 100;
		if (top + right + bottom + left === 0) return '';
		return `clip-path: inset(${top}% ${right}% ${bottom}% ${left}%);`;
	}
</script>

<div class="absolute inset-0 overflow-hidden bg-black" data-testid="video-stage">
	{#each videos as video, index (video.id)}
		<div
			class="absolute transition-[left,top,width,height] duration-300 ease-out"
			style={styleFor(video, index)}
			data-testid="viewport-{video.role}"
		>
			<video
				class="size-full bg-black object-contain"
				style={cropStyle(video)}
				playsinline
				preload="metadata"
				use:registerAction={{ video, register: registerElement }}
				oncontextmenu={(event) => onContextMenu(video, event)}
				ondblclick={() => onDoubleClick(video)}
				data-testid="video-{video.role}"
				aria-label="{video.role} video: {video.title}"
			></video>

			{#if locked}
				<!-- Locked layouts must not be draggable/resizable (§15). A transparent
				     shield also prevents accidental native video interaction. -->
				<div class="pointer-events-none absolute inset-0" aria-hidden="true"></div>
			{/if}
		</div>
	{/each}

	{#if videos.length === 0}
		<div class="flex h-full items-center justify-center">
			<p class="text-sm text-white/35">Add a source and a reaction to begin.</p>
		</div>
	{/if}
</div>
