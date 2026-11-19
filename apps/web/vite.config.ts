import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    // The API runs separately in development; same-origin /api avoids CORS.
    proxy: { '/api': { target: 'http://127.0.0.1:4000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
});
