/**
 * Toast store (PROJECT_BRIEF.md §16).
 *
 * Caps: at most three stacked toasts, ordinary toasts 3–5s, important results remain
 * accessible afterwards via the caller (and later the inbox). Transactional messages are
 * never subject to promotional caps.
 */

import { uiPolicy } from '../config/policy';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export type ToastCategory = 'transactional' | 'promotional';

export interface Toast {
	readonly id: string;
	readonly kind: ToastKind;
	readonly category: ToastCategory;
	readonly message: string;
	readonly createdAtMs: number;
	readonly durationMs: number;
	/** Optional action, e.g. "Retry" or "Choose file". */
	readonly action?: { readonly label: string; readonly run: () => void };
}

class ToastStore {
	items = $state<Toast[]>([]);
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	show(
		message: string,
		options: {
			kind?: ToastKind;
			category?: ToastCategory;
			durationMs?: number;
			action?: { label: string; run: () => void };
		} = {}
	): string {
		const id = crypto.randomUUID();
		const kind = options.kind ?? 'info';
		const durationMs =
			options.durationMs ??
			(kind === 'error' || kind === 'warning'
				? uiPolicy.toastImportantDurationMs
				: uiPolicy.toastDurationMs);

		const toast: Toast = {
			id,
			kind,
			category: options.category ?? 'transactional',
			message,
			createdAtMs: Date.now(),
			durationMs,
			action: options.action
		};

		// Enforce the stack cap by dropping the oldest non-error toast first.
		const next = [...this.items, toast];
		while (next.length > uiPolicy.maxStackedToasts) {
			const dropIndex = next.findIndex((t) => t.kind !== 'error');
			const removed = next.splice(dropIndex >= 0 ? dropIndex : 0, 1)[0];
			if (removed) this.clearTimer(removed.id);
		}
		this.items = next;

		if (durationMs > 0) {
			this.timers.set(
				id,
				setTimeout(() => this.dismiss(id), durationMs)
			);
		}
		return id;
	}

	dismiss(id: string): void {
		this.clearTimer(id);
		this.items = this.items.filter((t) => t.id !== id);
	}

	clear(): void {
		for (const id of this.timers.keys()) this.clearTimer(id);
		this.items = [];
	}

	private clearTimer(id: string): void {
		const timer = this.timers.get(id);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(id);
		}
	}
}

export const toastStore = new ToastStore();
