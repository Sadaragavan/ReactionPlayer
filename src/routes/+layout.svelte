<script lang="ts">
	import '../app.css';
	import Toasts from '$lib/components/Toasts.svelte';

	let { children } = $props();
</script>

{@render children()}

<!--
	Mounted once at the root so notifications survive client-side navigation.
	NavDock is mounted per-page instead: the playback route deliberately renders
	edge-docked chrome rather than the standard navigation dock.
-->
<Toasts />
