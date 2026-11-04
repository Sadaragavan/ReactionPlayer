/**
 * Open-redirect guard for `next` / `returnTo` parameters.
 *
 * A single implementation is used by every endpoint that accepts a post-authentication
 * destination, so the guard cannot drift between routes.
 *
 * Only a same-origin relative path is accepted. Rejected:
 *   - absolute URLs           https://evil.example
 *   - protocol-relative       //evil.example
 *   - backslash variants      /\evil.example  and  \/evil.example
 *     (browsers normalize `\` to `/`, so these become protocol-relative)
 *   - control characters      /\tevil.example, header/URL-parser confusion
 *   - anything not starting with exactly one `/`
 *
 * The fallback is always `/`, never the caller's input.
 */
export function safeRelativePath(value: string | null | undefined, fallback = '/'): string {
	if (!value) return fallback;

	// Reject control characters and DEL without a control-character regex, scanning codes
	// instead. These can confuse URL parsers and, if ever echoed into a header, enable
	// response splitting.
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return fallback;
	}

	if (!value.startsWith('/')) return fallback;
	if (value.startsWith('//')) return fallback;
	if (value.includes('\\')) return fallback;

	// A scheme cannot appear before the first '/' in a relative path, but guard against
	// whitespace-prefixed input that some parsers trim.
	if (value.trim() !== value) return fallback;

	return value;
}
