<script lang="ts">
	/**
	 * Toast host (PROJECT_BRIEF.md §16).
	 * Max three stacked, ARIA live region, never obscures media controls (docked above
	 * the bottom HUD), respects reduced motion via global CSS.
	 */
	import { X, CircleCheck, Info, TriangleExclamationPoint } from '@lucide/svelte';
	import { toastStore } from '$lib/state/toast-store.svelte';

	const icons = {
		info: Info,
		success: CircleCheck,
		warning: TriangleExclamationPoint,
		error: TriangleExclamationPoint
	};

	const tones = {
		info: 'border-white/12 text-white/85',
		success: 'border-[var(--color-success)]/40 text-white',
		warning: 'border-[var(--color-warning)]/45 text-white',
		error: 'border-[var(--color-danger)]/50 text-white'
	};
</script>

<div
	class="pointer-events-none fixed bottom-24 right-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
	role="region"
	aria-label="Notifications"
>
	<div aria-live="polite" aria-atomic="false" class="flex flex-col gap-2">
		{#each toastStore.items as toast (toast.id)}
			{@const Icon = icons[toast.kind]}
			<div
				class="acrylic pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-xl {tones[
					toast.kind
				]}"
			>
				<Icon size={16} class="mt-0.5 shrink-0 opacity-80" />
				<p class="flex-1 text-[13px] leading-snug">{toast.message}</p>
				{#if toast.action}
					<button
						type="button"
						class="shrink-0 rounded px-2 py-0.5 text-[12px] font-medium text-[var(--color-accent)] hover:bg-white/10"
						onclick={() => {
							toast.action?.run();
							toastStore.dismiss(toast.id);
						}}
					>
						{toast.action.label}
					</button>
				{/if}
				<button
					type="button"
					class="icon-button !size-6 shrink-0"
					aria-label="Dismiss notification"
					onclick={() => toastStore.dismiss(toast.id)}
				>
					<X size={13} />
				</button>
			</div>
		{/each}
	</div>
</div>
