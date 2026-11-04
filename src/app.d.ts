import type { SessionUser } from '$lib/contracts/auth';

declare global {
	namespace App {
		interface Locals {
			/** Verified server-side. Never populated from client-supplied claims. */
			user: SessionUser | null;
			/** Effective entitlement tier, resolved server-side. */
			tier: 'free' | 'pro';
		}
		interface PageData {
			user: SessionUser | null;
			tier: 'free' | 'pro';
		}
		interface Error {
			message: string;
			code?: string;
		}
	}
}

export {};
