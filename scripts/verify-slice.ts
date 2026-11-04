/**
 * End-to-end verification of the v0.0 vertical slice against a RUNNING dev server.
 *
 * Exercises the real HTTP surface (not mocks): signup -> session cookie -> fingerprint
 * registration -> pass issuance -> reuse -> quota exhaustion -> cross-user isolation.
 *
 *   npm run verify:slice            # expects the dev server on :5173
 *
 * This complements the SQL-level integration tests by proving the trusted server
 * boundary works over the network, including cookies and CSRF.
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
 * This harness asserts against arbitrary JSON responses from the HTTP API. Typing every
 * response shape here would duplicate the contracts without adding safety; the API
 * contracts themselves are typed in src/lib/contracts and checked by svelte-check. */

const BASE = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:5173';

interface CookieJar {
	[name: string]: string;
}

function makeJar(): CookieJar {
	return {};
}

function cookieHeader(jar: CookieJar): string {
	return Object.entries(jar)
		.map(([k, v]) => `${k}=${v}`)
		.join('; ');
}

function absorbCookies(jar: CookieJar, response: Response): void {
	for (const raw of response.headers.getSetCookie?.() ?? []) {
		const [pair] = raw.split(';');
		if (!pair) continue;
		const index = pair.indexOf('=');
		if (index < 0) continue;
		const name = pair.slice(0, index).trim();
		const value = pair.slice(index + 1).trim();
		if (value === '') delete jar[name];
		else jar[name] = value;
	}
}

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
	checks++;
	if (condition) {
		console.log(`  PASS  ${label}`);
	} else {
		failures++;
		console.log(`  FAIL  ${label}`);
		if (detail !== undefined) console.log('        ', JSON.stringify(detail));
	}
}

async function signUp(jar: CookieJar, email: string): Promise<boolean> {
	// SvelteKit form actions require a same-origin Origin header for CSRF protection.
	const body = new URLSearchParams({
		email,
		password: 'correct-horse-battery-staple',
		acceptTerms: 'on',
		next: '/'
	});
	const response = await fetch(`${BASE}/signin?/signup`, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			origin: BASE,
			cookie: cookieHeader(jar)
		},
		body,
		redirect: 'manual'
	});
	absorbCookies(jar, response);
	if (response.status === 303) return true;

	// SvelteKit form actions return HTTP 200 with a devalue payload even on FAILURE.
	// Treating any 200 as success would mask real errors, so inspect the payload.
	const text = await response.text();
	if (text.includes('"type":"failure"') || text.includes('"type":"error"')) {
		console.log('    signup FAILED:', text.slice(0, 300));
		if (text.includes('Too many attempts')) {
			console.log(
				'    -> Sign-up rate limit reached. Set RATE_LIMIT_MULTIPLIER=100 in .env for\n' +
					'       repeated local runs, then restart the dev server. This scaling is\n' +
					'       refused when NODE_ENV=production.'
			);
		}
		return false;
	}
	return response.status === 200;
}

async function api(
	jar: CookieJar,
	path: string,
	init: RequestInit = {}
): Promise<{ status: number; body: Record<string, any> | null }> {
	const response = await fetch(`${BASE}${path}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			origin: BASE,
			cookie: cookieHeader(jar),
			...(init.headers ?? {})
		}
	});
	absorbCookies(jar, response);
	let body: Record<string, any> | null;
	try {
		body = (await response.json()) as Record<string, any>;
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

function digest(seed: string): string {
	// Deterministic 64-hex stand-in for a sampled fingerprint. The server only validates
	// the shape; real clients compute SHA-256 in a worker.
	let out = '';
	let h = 0x811c9dc5;
	for (let i = 0; out.length < 64; i++) {
		for (const ch of `${seed}:${i}`) {
			h ^= ch.charCodeAt(0);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		out += h.toString(16).padStart(8, '0');
	}
	return out.slice(0, 64);
}

async function main() {
	console.log(`\nVerifying v0.0 vertical slice against ${BASE}\n`);

	const stamp = Date.now();
	const alice = makeJar();
	const bob = makeJar();
	const aliceEmail = `alice.${stamp}@example.test`;
	const bobEmail = `bob.${stamp}@example.test`;

	console.log('1. Accounts');
	check('alice can create an account', await signUp(alice, aliceEmail));
	check('a session cookie was issued', Object.keys(alice).some((k) => k.includes('session')));
	check('bob can create an account', await signUp(bob, bobEmail));

	const unauth = await api(makeJar(), '/api/passes', { method: 'GET' });
	check('unauthenticated pass request is rejected', unauth.status === 401, unauth);

	console.log('\n2. Media identification');
	const sourceDigest = digest(`source-${stamp}`);
	const reactionDigest = digest(`reaction-${stamp}`);
	const identity = await api(alice, '/api/identities', {
		method: 'POST',
		body: JSON.stringify({
			digest: sourceDigest,
			provider: 'local-file',
			sizeBytes: 1_500_000_000,
			fileName: 'source.mkv',
			exhaustive: false
		})
	});
	check('fingerprint registers', identity.status === 200 && Boolean(identity.body?.physicalId), identity);
	const badIdentity = await api(alice, '/api/identities', {
		method: 'POST',
		body: JSON.stringify({ digest: 'not-a-digest', provider: 'local-file' })
	});
	check('malformed fingerprint is rejected', badIdentity.status === 400, badIdentity);

	console.log('\n3. Pass issuance');
	const pair = {
		reaction: { physicalKey: reactionDigest },
		source: { physicalKey: sourceDigest }
	};
	const first = await api(alice, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({ requestId: crypto.randomUUID(), ...pair })
	});
	check('pass is issued', first.status === 200 && first.body?.outcome === 'issued', first);
	check('tier is free', first.body?.tier === 'free');
	check('video limit is 2 for free tier', first.body?.videoLimit === 2);
	check('base usage is 1 of 6', first.body?.usage?.baseUsed === 1 && first.body?.usage?.baseCapacity === 6);

	const lifetimeHours =
		(new Date(first.body.expiresAt).getTime() - Date.now()) / 3_600_000;
	check('pass lifetime is ~24 hours', lifetimeHours > 23.9 && lifetimeHours <= 24, { lifetimeHours });

	const reused = await api(alice, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({ requestId: crypto.randomUUID(), ...pair })
	});
	check('same pair reuses the pass', reused.body?.outcome === 'reused', reused);
	check('reuse returns the same pass id', reused.body?.passId === first.body?.passId);
	check('reuse does not consume quota', reused.body?.usage?.baseUsed === 1, reused.body?.usage);

	const retryId = crypto.randomUUID();
	const idemA = await api(alice, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({ requestId: retryId, reaction: { physicalKey: digest(`r2-${stamp}`) }, source: { physicalKey: digest(`s2-${stamp}`) } })
	});
	const idemB = await api(alice, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({ requestId: retryId, reaction: { physicalKey: digest(`r2-${stamp}`) }, source: { physicalKey: digest(`s2-${stamp}`) } })
	});
	check('retry with the same requestId is idempotent', idemA.body?.passId === idemB.body?.passId);

	console.log('\n4. Concurrency and quota');
	// Alice has used 2. Fire 12 concurrent distinct pairs; only 4 more may be issued.
	const concurrent = await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			api(alice, '/api/passes', {
				method: 'POST',
				body: JSON.stringify({
					requestId: crypto.randomUUID(),
					reaction: { physicalKey: digest(`rc-${stamp}-${i}`) },
					source: { physicalKey: digest(`sc-${stamp}-${i}`) }
				})
			})
		)
	);
	const issued = concurrent.filter((r) => r.body?.outcome === 'issued').length;
	const denied = concurrent.filter((r) => r.status === 429).length;
	check('exactly 4 more passes issued under concurrency', issued === 4, { issued, denied });
	check('the other 8 are denied with 429', denied === 8, { issued, denied });

	const exhausted = await api(alice, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			reaction: { physicalKey: digest('overflow-r') },
			source: { physicalKey: digest('overflow-s') }
		})
	});
	check('quota exhaustion returns 429', exhausted.status === 429, exhausted);
	check(
		'a next-availability time is returned',
		typeof exhausted.body?.error?.details?.nextAvailableAt === 'string',
		exhausted.body?.error
	);

	const status = await api(alice, '/api/passes', { method: 'GET' });
	check('status reports 6 of 6 used', status.body?.usage?.baseUsed === 6, status.body?.usage);

	console.log('\n5. Isolation');
	const bobPass = await api(bob, '/api/passes', {
		method: 'POST',
		body: JSON.stringify({ requestId: crypto.randomUUID(), ...pair })
	});
	check('bob is unaffected by alice exhausting her quota', bobPass.body?.outcome === 'issued', bobPass);
	check('bob gets a different pass id', bobPass.body?.passId !== first.body?.passId);
	const bobStatus = await api(bob, '/api/passes', { method: 'GET' });
	check('bob usage is 1', bobStatus.body?.usage?.baseUsed === 1, bobStatus.body?.usage);

	console.log('\n6. Consent');
	const consents = await api(alice, '/api/consents', { method: 'GET' });
	check('consent purposes are listed', Array.isArray(consents.body?.purposes) && consents.body.purposes.length === 4);
	check('all optional purposes start ungranted', (consents.body?.state ?? []).length === 0);
	const grant = await api(alice, '/api/consents', {
		method: 'POST',
		body: JSON.stringify({ purpose: 'watch_history', granted: true })
	});
	check('consent can be granted', grant.status === 200 && grant.body?.state?.granted === true, grant);
	const revoke = await api(alice, '/api/consents', {
		method: 'POST',
		body: JSON.stringify({ purpose: 'watch_history', granted: false })
	});
	check('consent can be revoked', revoke.status === 200 && revoke.body?.state?.granted === false, revoke);
	const badConsent = await api(alice, '/api/consents', {
		method: 'POST',
		body: JSON.stringify({ purpose: 'not_a_purpose', granted: true })
	});
	check('unknown purpose is rejected', badConsent.status === 400, badConsent);

	console.log('\n7. Sync profiles');
	const pairKey = [ `physical:local-file:${reactionDigest}`, `physical:local-file:${sourceDigest}` ].sort().join('|');
	const saveProfile = await api(alice, '/api/sync-profiles', {
		method: 'POST',
		body: JSON.stringify({ pairKey, offsetMs: 30_000 })
	});
	check('a private offset can be saved', saveProfile.status === 200 && saveProfile.body?.offsetMs === 30_000, saveProfile);
	check('saved offset is marked unverified', saveProfile.body?.verificationState === 'unverified');
	const loadProfile = await api(alice, `/api/sync-profiles?pairKey=${encodeURIComponent(pairKey)}`);
	check('the offset loads back', loadProfile.body?.profile?.offsetMs === 30_000, loadProfile);
	const bobLoad = await api(bob, `/api/sync-profiles?pairKey=${encodeURIComponent(pairKey)}`);
	check('bob cannot read alice’s private offset', bobLoad.body?.profile === null, bobLoad);

	console.log('\n8. Trusted-only functions');
	// A client must not be able to grant itself bonus passes. There is no HTTP route for
	// it, and the SQL function is revoked from `authenticated` (verified in SQL tests).
	const bonusRoute = await fetch(`${BASE}/api/passes/grant-bonus`, { method: 'POST' });
	check('no client route exists for granting bonuses', bonusRoute.status === 404, { status: bonusRoute.status });

	console.log('\n9. Redirect safety');
	// These endpoints accept a `next` parameter. A crafted link must not be able to turn
	// them into an open redirect off the origin.
	const hostile = [
		'//evil.example/path',
		'https://evil.example/path',
		'/\\evil.example',
		'/\tjavascript:alert(1)'
	];
	for (const target of hostile) {
		const response = await fetch(
			`${BASE}/auth/callback?code=not-a-real-code&next=${encodeURIComponent(target)}`,
			{ redirect: 'manual' }
		);
		const location = response.headers.get('location') ?? '';
		check(
			`auth callback refuses redirect to ${JSON.stringify(target)}`,
			response.status >= 300 &&
				response.status < 400 &&
				!location.includes('evil.example') &&
				!location.startsWith('//'),
			{ status: response.status, location }
		);
	}

	const noCode = await fetch(`${BASE}/auth/callback`, { redirect: 'manual' });
	check(
		'auth callback without a code returns to sign-in',
		(noCode.headers.get('location') ?? '').startsWith('/signin'),
		{ status: noCode.status, location: noCode.headers.get('location') }
	);

	const me = await fetch(`${BASE}/me`, { redirect: 'manual' });
	check(
		'/me requires an account',
		(me.headers.get('location') ?? '').startsWith('/signin'),
		{ status: me.status, location: me.headers.get('location') }
	);

	console.log(`\n${checks - failures}/${checks} checks passed.\n`);
	if (failures > 0) {
		console.error(`${failures} check(s) FAILED.`);
		process.exit(1);
	}
	console.log('Vertical slice verified end-to-end.');
}

main().catch((error) => {
	console.error('Verification crashed:', error);
	process.exit(1);
});
