import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg, Slot } from '../shared/types.ts';
import { Room, newCode, type Conn } from './room.ts';

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

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = { send: (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) };
    let room: Room | null = null;
    let slot: Slot | null = null;

    ws.on('message', (data) => {
      let m: ClientMsg;
      try {
        m = JSON.parse(String(data)) as ClientMsg;
      } catch {
        return;
      }
      if (m.t === 'ping') {
        conn.send({ t: 'pong', c: m.c, s: now() });
        return;
      }
      if (!room) {
        if (m.t === 'create') {
          room = new Room(newCode((c) => rooms.has(c)), now);
          rooms.set(room.code, room);
          slot = room.join(conn);
        } else if (m.t === 'join' || m.t === 'watch') {
          const code = String(m.code ?? '').toUpperCase();
          room = rooms.get(code) ?? null;
          if (!room) return conn.send({ t: 'error', msg: `Room ${code} not found` });
          if (m.t === 'watch') room.watch(conn);
          else {
            slot = room.join(conn, m.token);
            if (slot === null) {
              conn.send({ t: 'error', msg: `Room ${code} is full. Opening the spectator view.` });
              room = null;
            }
          }
        }
        return;
      }
      if (slot !== null) room.handle(conn, slot, m);
    });

    ws.on('close', () => room?.leave(conn));
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
    console.log(`Shadow Box server on http://localhost:${port}`);
    if (!existsSync(ROOT)) console.log('dist/client is missing; run npm run build (or use npm run dev on :5173)');
  });
}
