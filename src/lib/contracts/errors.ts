/**
 * Structured application errors (PROJECT_BRIEF.md §2).
 *
 * Every error carries a stable machine-readable `code`, a user-safe `message`, and an
 * HTTP status. Internal details are logged server-side, never leaked to the client.
 */

export type ErrorCode =
	| 'unauthenticated'
	| 'forbidden'
	| 'mfa_required'
	| 'invalid_input'
	| 'not_found'
	| 'quota_exhausted'
	| 'rate_limited'
	| 'conflict'
	| 'provider_unsupported'
	| 'media_permission_denied'
	| 'internal';

export interface StructuredError {
	readonly code: ErrorCode;
	readonly message: string;
	readonly status: number;
	/** Optional non-sensitive context (e.g. nextAvailableAt for quota errors). */
	readonly details?: Record<string, unknown>;
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
	unauthenticated: 401,
	forbidden: 403,
	mfa_required: 403,
	invalid_input: 400,
	not_found: 404,
	quota_exhausted: 429,
	rate_limited: 429,
	conflict: 409,
	provider_unsupported: 422,
	media_permission_denied: 403,
	internal: 500
};

export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly details: Record<string, unknown> | undefined;

	constructor(
		code: ErrorCode,
		message: string,
		details?: Record<string, unknown>,
		options?: { cause?: unknown }
	) {
		super(message, options);
		this.name = 'AppError';
		this.code = code;
		this.status = STATUS_BY_CODE[code];
		this.details = details;
	}

	/** Client-safe serialization. Never includes stack traces or internal causes. */
	toJSON(): StructuredError {
		return {
			code: this.code,
			message: this.message,
			status: this.status,
			...(this.details ? { details: this.details } : {})
		};
	}
}

export function isAppError(value: unknown): value is AppError {
	return value instanceof AppError;
}

/** Convert anything thrown into a client-safe structured error. */
export function toStructuredError(value: unknown): StructuredError {
	if (isAppError(value)) return value.toJSON();
	// Do not leak database/driver messages, which can contain schema or credential hints.
	return {
		code: 'internal',
		message: 'Something went wrong. Please try again.',
		status: 500
	};
}

export function jsonError(value: unknown): Response {
	const structured = toStructuredError(value);
	return new Response(JSON.stringify({ error: structured }), {
		status: structured.status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}
