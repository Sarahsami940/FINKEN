import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Builds the service worker (sw.js) with the list of every file the app is
 * made of, so the whole app can open offline, and a version that changes
 * whenever any file does, so devices pick up new releases.
 */
function serviceWorker(): Plugin {
  return {
    name: 'finken-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      const icons = readdirSync(join(import.meta.dirname, 'public/icons')).map((f) => `/icons/${f}`);
      const files = ['/', '/manifest.webmanifest', ...icons, ...built.map((f) => `/${f}`)].sort();
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const template = readFileSync(join(import.meta.dirname, 'sw.js'), 'utf8');
      const source = template.replace("'__VERSION__'", JSON.stringify(version)).replace('self.__PRECACHE', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    strictPort: false,
    // The API runs separately in development; same-origin /api avoids CORS.
    proxy: { '/api': { target: process.env.FINKEN_API_PROXY ?? 'http://127.0.0.1:4000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  preview: {
    proxy: { '/api': { target: process.env.FINKEN_API_PROXY ?? 'http://127.0.0.1:4000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
