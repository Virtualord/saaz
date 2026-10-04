import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from this file's own location, not process.cwd(), so the alias and the
// build output stay correct regardless of where the dev server is started.
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, 'web');
// Must point at web/src, not web: tsconfig maps "@/*" -> "./web/src/*".
const srcRoot = path.resolve(webRoot, 'src');

export default defineConfig({
  root: webRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    /**
     * `@/` -> `web/src`, matching the `paths` entry in tsconfig.json.
     *
     * Vite does NOT read tsconfig `paths`, so without this the production build
     * and `tsc` resolve `@/components/ui/card` fine while the dev server fails
     * with "Failed to resolve import". Both sides have to declare it.
     */
    alias: {
      '@': srcRoot,
    },
  },
  build: {
    outDir: path.resolve(here, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});