import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/rof-gui/',
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless still enables cross-origin isolation (so ffmpeg.wasm
      // can use SharedArrayBuffer) while letting cross-origin resources
      // without CORP headers (e.g. the Inter font CDN) load.
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    fs: {
      allow: [
        // Allow serving files from the project root
        '.',
        // Allow serving files from Nix store (for symlinked node_modules)
        '/nix/store',
      ],
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  plugins: [
    svelte({
      compilerOptions: { runes: true }
    }),
    {
      name: 'copy-coi-serviceworker',
      configureServer(server) {
        // For dev mode, serve directly from node_modules
        server.middlewares.use((req, res, next) => {
          if (req.url === '/coi-serviceworker.js') {
            const filePath = resolve('node_modules/coi-serviceworker/coi-serviceworker.min.js');
            res.setHeader('Content-Type', 'application/javascript');
            res.end(readFileSync(filePath));
            return;
          }
          next();
        });
      },
      writeBundle() {
        // Copy to dist for production build (only writes to output dir)
        copyFileSync(
          'node_modules/coi-serviceworker/coi-serviceworker.min.js',
          'dist/coi-serviceworker.js'
        );
      },
    } satisfies Plugin,
  ],
});
