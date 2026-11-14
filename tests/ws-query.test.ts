import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.ts';
import type { ServerMsg } from '../shared/types.ts';

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer(0);
});
afterAll(() => server.close());

function firstJoined(path: string, first: object): Promise<Extract<ServerMsg, { t: 'joined' }>> {
  const ws = new WebSocket(`ws://localhost:${server.port}${path}`);
  return new Promise((ok, fail) => {
    ws.once('open', () => ws.send(JSON.stringify(first)));
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      if (m.t === 'joined') ok(m);
      if (m.t === 'error') fail(new Error(m.msg));
    });
    ws.once('error', fail);
  });
}

test('the Node server accepts the Cloudflare routing query on /ws', async () => {
  const a = await firstJoined('/ws?create=1', { t: 'create' });
  expect(a.slot).toBe(0);
  const b = await firstJoined(`/ws?code=${a.code}`, { t: 'join', code: a.code });
  expect(b.slot).toBe(1);
  const c = await firstJoined(`/ws?code=${a.code}`, { t: 'watch', code: a.code });
  expect(c.role).toBe('spectator');
});
