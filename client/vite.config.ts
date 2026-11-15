import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    fs: { allow: ['..'] },
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
      '/api': { target: 'http://127.0.0.1:3000' },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2019',
    sourcemap: false,
    assetsInlineLimit: 200000,
    chunkSizeWarningLimit: 900,
  },
});
