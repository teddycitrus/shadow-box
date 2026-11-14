/// <reference types="vitest/config" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Dev only: lets the ?record=1 tuner save labelled clips straight into tests/fixtures/. */
const fixtureWriter: Plugin = {
  name: 'fixture-writer',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__fixtures/', (req, res) => {
      const name = decodeURIComponent((req.url ?? '').slice(1));
      if (req.method !== 'POST' || !/^(sessions\/)?[\w-][\w.-]*\.json$/.test(name) || name.includes('..')) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        mkdirSync(name.startsWith('sessions/') ? 'tests/fixtures/sessions' : 'tests/fixtures', { recursive: true });
        writeFileSync(`tests/fixtures/${name}`, Buffer.concat(chunks));
        res.end('ok');
      });
    });
  },
};

export default defineConfig({
  plugins: [fixtureWriter],
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
