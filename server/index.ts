import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMsg } from '../shared/types.ts';
import { Room, newCode, type Conn } from './room.ts';
import { MAX_MESSAGE_BYTES, Session, type RoomRegistry } from './session.ts';

const ROOT = resolve('dist/client');
const ROOM_IDLE_MS = 10 * 60_000;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.glb': 'model/gltf-binary',
};

const now = () => performance.now();

export function startServer(port: number, opts: { tickMs?: number } = {}): Promise<{ port: number; close(): Promise<void> }> {
  const rooms = new Map<string, Room>();

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/audio-manifest') {
      const dir = join(ROOT, 'audio');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mp3')) : []));
      return;
    }
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    if (!extname(path)) path = join(ROOT, 'index.html');
    if (!existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = extname(path);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    createReadStream(path).pipe(res);
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  const registry: RoomRegistry = {
    create() {
      const room = new Room(newCode((c) => rooms.has(c)), now);
      rooms.set(room.code, room);
      return room;
    },
    get: (code) => rooms.get(code),
  };

  // The room is chosen by the first create/join/watch message. Query parameters (?create=1,
  // ?code=XXXX) are only needed for Durable Object routing on Cloudflare and are ignored here.
  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = { send: (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) };
    const session = new Session(conn, registry, now);
    ws.on('message', (data) => session.message(String(data)));
    ws.on('close', () => session.close());
  });

  const timer = setInterval(() => {
    const t = now();
    for (const [code, r] of rooms) {
      r.tick();
      if (r.empty && t - r.lastActivity > ROOM_IDLE_MS) rooms.delete(code);
    }
  }, opts.tickMs ?? 1000 / 60);

  const close = () => new Promise<void>((done) => {
    clearInterval(timer);
    for (const c of wss.clients) c.terminate();
    wss.close();
    http.close(() => done());
    http.closeAllConnections();
  });

  return new Promise((ok, fail) => {
    http.once('error', fail);
    http.listen(port, () => {
      http.off('error', fail);
      ok({ port: (http.address() as AddressInfo).port, close });
    });
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const PORT = Number(process.env.PORT ?? 3000);
  startServer(PORT).then(({ port }) => {
    console.log(`Keyboard Warrior server on http://localhost:${port}`);
    if (!existsSync(ROOT)) console.log('dist/client is missing; run npm run build (or use npm run dev on :5173)');
  });
}
