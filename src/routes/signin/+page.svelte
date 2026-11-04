<script lang="ts">
	import { enhance } from '$app/forms';
	import { MonitorPlay, LoaderCircle, TriangleExclamationPoint, Info } from '@lucide/svelte';

	interface Props {
		data: {
			authMode: 'supabase' | 'local-dev' | 'unconfigured';
			next: string;
			mode: 'signin' | 'signup';
		};
		form: { message?: string; field?: string; email?: string; mode?: string; info?: boolean } | null;
	}
	let { data, form }: Props = $props();

	// Seeding form state from props intentionally captures the initial value only: the
	// user then edits these fields, and a later prop change must not clobber their input.
	// svelte-ignore state_referenced_locally
	let mode = $state<'signin' | 'signup'>(data.mode);
	let submitting = $state(false);
	// svelte-ignore state_referenced_locally
	let email = $state(form?.email ?? '');

	const isSignup = $derived(mode === 'signup');
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-md">
		<div class="mb-6 flex items-center gap-3">
			<div class="flex size-10 items-center justify-center rounded-xl bg-[var(--color-accent-strong)]">
				<MonitorPlay size={20} />
			</div>
			<div>
				<h1 class="text-lg font-semibold tracking-tight">
					{isSignup ? 'Create your account' : 'Sign in'}
				</h1>
				<p class="text-[12px] text-white/50">ReactionPlayer</p>
			</div>
		</div>

		{#if data.authMode === 'unconfigured'}
			<div class="acrylic rounded-xl border border-[var(--color-warning)]/40 p-5" role="alert">
				<p class="flex items-start gap-2 text-sm font-medium">
					<TriangleExclamationPoint size={16} class="mt-0.5 shrink-0 text-[var(--color-warning)]" />
					Authentication is not configured
				</p>
				<p class="mt-2 text-[12px] leading-relaxed text-white/60">
					This deployment has no auth provider yet. An operator must configure Supabase, or enable
					the local development provider for non-production use. See
					<code class="rounded bg-white/10 px-1">docs/ENVIRONMENT.md</code>.
				</p>
			</div>
		{:else}
			<div class="acrylic rounded-xl p-6">
				{#if data.authMode === 'local-dev'}
					<div class="mb-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
						<p class="text-[11px] leading-relaxed text-white/55">
							<strong class="text-white/75">Development mode.</strong>
							Accounts are stored in a local PostgreSQL database with hashed passwords. No email
							is sent. This provider is never available in production.
						</p>
					</div>
				{/if}

				<form
					method="POST"
					action={isSignup ? '?/signup' : '?/signin'}
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							submitting = false;
							await update();
						};
					}}
					class="flex flex-col gap-4"
				>
					<input type="hidden" name="next" value={data.next} />

					<label class="flex flex-col gap-1.5">
						<span class="text-[12px] font-medium text-white/70">Email</span>
						<input
							type="email"
							name="email"
							class="field"
							bind:value={email}
							required
							autocomplete="email"
							aria-invalid={form?.field === 'email'}
							data-testid="email"
						/>
					</label>

					<label class="flex flex-col gap-1.5">
						<span class="text-[12px] font-medium text-white/70">Password</span>
						<input
							type="password"
							name="password"
							class="field"
							required
							minlength={isSignup ? 10 : undefined}
							autocomplete={isSignup ? 'new-password' : 'current-password'}
							aria-invalid={form?.field === 'password'}
							data-testid="password"
						/>
						{#if isSignup}
							<span class="text-[11px] text-white/40">At least 10 characters.</span>
						{/if}
					</label>

					{#if isSignup}
						<label class="flex items-start gap-2.5">
							<input type="checkbox" name="acceptTerms" class="mt-0.5 size-4 shrink-0" required />
							<span class="text-[11px] leading-relaxed text-white/60">
								I understand this service does not host or provide videos, that I must have the right
								to access the media I use, and that operational account data is required to run the
								service. Optional watch history, contributions, analytics and public display are
								separate choices I control in Settings.
							</span>
						</label>
					{/if}

					{#if form?.message}
						<div
							class="flex items-start gap-2 rounded-lg border px-3 py-2 {form.info
								? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
								: 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10'}"
							role={form.info ? 'status' : 'alert'}
							data-testid="auth-message"
						>
							{#if form.info}
								<Info size={14} class="mt-0.5 shrink-0" />
							{:else}
								<TriangleExclamationPoint size={14} class="mt-0.5 shrink-0" />
							{/if}
							<p class="text-[12px] leading-relaxed">{form.message}</p>
						</div>
					{/if}

					<button type="submit" class="btn-primary w-full" disabled={submitting} data-testid="auth-submit">
						{#if submitting}
							<LoaderCircle size={15} class="animate-spin" />
						{/if}
						{isSignup ? 'Create account' : 'Sign in'}
					</button>
				</form>

				<div class="mt-4 border-t border-white/8 pt-4 text-center">
					<button
						type="button"
						class="text-[12px] text-[var(--color-accent)] hover:underline"
						onclick={() => (mode = isSignup ? 'signin' : 'signup')}
					>
						{isSignup ? 'Already have an account? Sign in' : 'Need an account? Create one'}
					</button>
				</div>
			</div>

			<p class="mt-4 text-center text-[11px] leading-relaxed text-white/35">
				Your account is anonymous to other users by default. No username is derived from your email
				address.
			</p>
		{/if}

		<div class="mt-4 text-center">
			<a href="/" class="text-[12px] text-white/40 hover:text-white/70">Back to home</a>
		</div>
	</div>
</div>
