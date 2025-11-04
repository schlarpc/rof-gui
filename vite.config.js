import { defineConfig } from 'vite';
import { copyFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
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
    },
  ],
});
