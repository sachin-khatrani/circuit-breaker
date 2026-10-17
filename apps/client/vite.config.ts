import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The game server (npm run dev:server) listens here; Vite forwards Socket.IO and the ranking API
// to it so the page talks to one origin in development (cookies included), as in production.
const GAME_SERVER = process.env.GAME_SERVER ?? 'http://127.0.0.1:3001';
const proxy = {
  '/socket.io': { target: GAME_SERVER, ws: true },
  '/api': { target: GAME_SERVER },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    proxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // three.js alone is ~700 kB minified; one game bundle is expected.
    chunkSizeWarningLimit: 2000,
  },
});
