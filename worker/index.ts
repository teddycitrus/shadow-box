// Cloudflare Worker: static assets for the client plus one Durable Object per room.
import { DurableObject } from 'cloudflare:workers';
import type { ServerMsg } from '../shared/types.ts';
import { Room, newCode, type Conn } from '../server/room.ts';
import { MAX_MESSAGE_BYTES, Session } from '../server/session.ts';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
}

const CODE_RE = /^[A-Z]{4}$/;
const CREATE_TRIES = 8;
const TICK_MS = 1000 / 60;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/audio-manifest') return env.ASSETS.fetch(new URL('/audio-manifest.json', url));
    if (url.pathname !== '/ws') return env.ASSETS.fetch(req);
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });

    if (url.searchParams.has('create')) {
      // A Durable Object cannot be found without its name, so the Worker picks the code and
      // retries if that room is already in use.
      for (let i = 0; i < CREATE_TRIES; i++) {
        const res = await toRoom(env, req, newCode(() => false), true);
        if (res.status !== 409) return res;
      }
      return new Response('no free room code', { status: 503 });
    }
    const code = (url.searchParams.get('code') ?? '').toUpperCase();
    if (!CODE_RE.test(code)) return new Response('missing or invalid ?code', { status: 400 });
    return toRoom(env, req, code, false);
  },
} satisfies ExportedHandler<Env>;

function toRoom(env: Env, req: Request, code: string, create: boolean): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set('X-Room-Code', code);
  if (create) headers.set('X-Room-Create', '1');
  return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(req.url, { headers });
}

/** One room. Holds the Room in memory and ticks it at 60 Hz while any socket is connected. */
export class RoomDO extends DurableObject<Env> {
  private code = '';
  private room: Room | null = null;
  private sockets = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now = () => Date.now();

  async fetch(req: Request): Promise<Response> {
    const code = req.headers.get('X-Room-Code') ?? '';
    if (!CODE_RE.test(code)) return new Response('bad room code', { status: 400 });
    this.code = code;
    if (req.headers.get('X-Room-Create') && this.room && !this.room.empty) return new Response('room in use', { status: 409 });

    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    const conn: Conn = {
      send: (m: ServerMsg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      },
    };
    const session = new Session(conn, {
      // Reuse a live room on a create race; otherwise start fresh so stale results do not leak.
      create: () => (this.room = this.room && !this.room.empty ? this.room : new Room(this.code, this.now)),
      get: (c) => (c === this.code ? this.room ?? undefined : undefined),
    }, this.now);

    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      session.close();
      if (--this.sockets === 0) this.stopTicking();
    };
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE_BYTES) return;
      session.message(e.data);
    });
    ws.addEventListener('close', () => {
      close();
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    });
    ws.addEventListener('error', close);

    this.sockets++;
    this.startTicking();
    return new Response(null, { status: 101, webSocket: client });
  }

  private startTicking(): void {
    this.timer ??= setInterval(() => this.room?.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
