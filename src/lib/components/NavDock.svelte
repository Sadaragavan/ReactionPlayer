<script lang="ts">
	/**
	 * Persistent left navigation dock (PROJECT_BRIEF.md §15).
	 * ~256px wide, edge-to-edge, dark acrylic. Collapses in theater mode.
	 */
	import {
		House,
		MonitorPlay,
		FolderOpen,
		Layers,
		Settings,
		LogOut,
		Play
	} from '@lucide/svelte';
	import { page } from '$app/state';

	interface Props {
		canContinue: boolean;
		onContinue: () => void;
		onNewSession: () => void;
		onExit: () => void;
		collapsed?: boolean;
	}

	let { canContinue, onContinue, onNewSession, onExit, collapsed = false }: Props = $props();

	const items = [
		{ href: '/', label: 'Home', icon: House },
		{ href: '/sessions', label: 'Load Session', icon: FolderOpen },
		{ href: '/presets', label: 'Presets', icon: Layers, disabled: true, note: 'Coming later' },
		{ href: '/settings', label: 'Settings', icon: Settings }
	];
</script>

{#if !collapsed}
	<nav
		class="acrylic-strong flex h-full w-64 shrink-0 flex-col border-r border-white/8"
		aria-label="Main navigation"
	>
		<div class="flex items-center gap-2.5 px-5 py-5">
			<div class="flex size-8 items-center justify-center rounded-lg bg-[var(--color-accent-strong)]">
				<MonitorPlay size={18} />
			</div>
			<div class="min-w-0">
				<p class="truncate text-sm font-semibold tracking-tight">ReactionPlayer</p>
				<p class="truncate text-[11px] text-white/40">Synchronized playback</p>
			</div>
		</div>

		<div class="flex flex-col gap-1 px-3">
			<button
				type="button"
				class="btn-primary w-full justify-start"
				disabled={!canContinue}
				onclick={onContinue}
				title={canContinue ? 'Resume your last session' : 'No saved session to resume yet'}
			>
				<Play size={16} />
				Continue
			</button>
			<button type="button" class="btn-ghost mt-1 w-full justify-start" onclick={onNewSession}>
				<MonitorPlay size={16} />
				New Session
			</button>
		</div>

		<div class="mt-5 flex flex-1 flex-col gap-0.5 px-3">
			{#each items as item (item.href)}
				{@const active = page.url.pathname === item.href}
				{#if item.disabled}
					<span
						class="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/25"
						title={item.note}
						aria-disabled="true"
					>
						<item.icon size={17} />
						{item.label}
						<span class="ml-auto text-[10px] uppercase tracking-wide">Soon</span>
					</span>
				{:else}
					<a
						href={item.href}
						class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors {active
							? 'bg-white/10 text-white'
							: 'text-white/60 hover:bg-white/5 hover:text-white'}"
						aria-current={active ? 'page' : undefined}
					>
						<item.icon size={17} />
						{item.label}
					</a>
				{/if}
			{/each}
		</div>

		<div class="border-t border-white/8 px-3 py-3">
			<button
				type="button"
				class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white"
				onclick={onExit}
				title="Leave and reset the current session"
			>
				<LogOut size={17} />
				Exit
			</button>
			<p class="px-3 pt-1 text-[10px] leading-relaxed text-white/25">
				Exit resets session state. It does not close the browser tab.
			</p>
		</div>
	</nav>
{/if}
