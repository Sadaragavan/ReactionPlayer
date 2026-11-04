/** Display helpers. Server timestamps are UTC; these render in the viewer's locale. */

export function formatRelativeTime(isoOrMs: string | number): string {
	const ms = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
	if (!Number.isFinite(ms)) return 'unknown';
	const deltaSeconds = Math.round((Date.now() - ms) / 1000);
	if (deltaSeconds < 45) return 'just now';
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['minute', 60],
		['hour', 3600],
		['day', 86400],
		['week', 604800],
		['month', 2592000],
		['year', 31536000]
	];
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	let chosen: Intl.RelativeTimeFormatUnit = 'year';
	let divisor = 31536000;
	for (const [unit, seconds] of units) {
		if (Math.abs(deltaSeconds) < seconds * (unit === 'minute' ? 60 : 1)) {
			chosen = unit;
			divisor = seconds;
			break;
		}
	}
	// Pick the largest unit that still yields a value >= 1.
	for (let i = units.length - 1; i >= 0; i--) {
		const [unit, seconds] = units[i]!;
		if (Math.abs(deltaSeconds) >= seconds) {
			chosen = unit;
			divisor = seconds;
			break;
		}
	}
	return formatter.format(-Math.round(deltaSeconds / divisor), chosen);
}

export function formatDateTime(isoOrMs: string | number): string {
	const date = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
	if (Number.isNaN(date.getTime())) return 'unknown';
	return date.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function formatDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds)) return '0:00';
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
		: `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null): string {
	if (bytes === null || !Number.isFinite(bytes)) return 'unknown size';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
