/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: { outDir: '../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
