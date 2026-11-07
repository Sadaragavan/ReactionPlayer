import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

/**
 * `npm run build`        → regular multi-file build in dist/
 * `npm run build:single` → everything (JS, CSS, font, sample clips) inlined into one dist/index.html
 */
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [svelte(), tailwindcss(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900
  },
  server: { host: true, port: 5173 }
}));
