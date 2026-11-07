<script lang="ts">
  /**
   * Home hub. The wallpaper (or plain black) runs edge to edge behind the dock.
   * It is never blurred and, unless the user asks for a veil in Settings, never
   * dimmed; with a wallpaper set nothing else is drawn over the picture, the dock
   * is all the chrome Home needs. Dropping video files anywhere opens New Session
   * with them in place.
   */
  import { Clapperboard, Sparkles } from '@lucide/svelte';
  import { dropzone } from '$lib/actions/dropzone';
  import Dock from '$lib/components/shell/Dock.svelte';
  import Logo from '$lib/components/shell/Logo.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { demoSessionInput, warmDemoClips } from '$lib/engine/demo';
  import type { PickedFile } from '$lib/engine/media';
  import { router } from '$lib/stores/router.svelte';
  import { session } from '$lib/stores/session.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { ui } from '$lib/stores/ui.svelte';

  const wallpaper = $derived(settings.wallpaper);

  function onfiles(files: PickedFile[]) {
    ui.newSessionFiles = files;
    ui.newSessionOpen = true;
  }

  async function demo() {
    await warmDemoClips();
    session.create(demoSessionInput(settings.settings.defaultLayout, settings.playback.masterAudio, settings.playback.autoLink));
    router.go('session');
  }
</script>

<div class="relative flex h-full overflow-hidden bg-black max-md:flex-col" use:dropzone={{ accept: 'video', multiple: true, onfiles }}>
  {#if wallpaper}
    <!-- object-fit: cover, no filter. A GIF is just an <img>, so it animates for free. -->
    <img src={wallpaper.url} alt="" class="absolute inset-0 size-full object-cover" draggable="false" />
    {#if !settings.settings.wallpaperClear}<div class="absolute inset-0 bg-black/55"></div>{/if}
  {/if}

  <Dock overlay={!!wallpaper} />

  <main class="relative z-10 flex min-w-0 flex-1 items-center justify-center p-8 max-md:pb-24 md:p-14">
    {#if wallpaper}
      <h1 class="sr-only">Reaction Player</h1>
    {:else}
      <div class="flex max-w-md flex-col items-center gap-6 text-center">
        <Logo size={44} />
        <div>
          <h1 class="title-wide text-[34px] md:text-[44px]">Reaction Player</h1>
          <p class="mt-3 text-fg-2">Drop a source and a reaction video here to begin.</p>
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <Button variant="primary" size="lg" icon={Clapperboard} onclick={() => (ui.newSessionOpen = true)}>New session</Button>
          <Button variant="secondary" size="lg" icon={Sparkles} onclick={demo}>Try the demo</Button>
        </div>
      </div>
    {/if}
  </main>
</div>
