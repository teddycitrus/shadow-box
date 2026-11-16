// Cloudflare Worker: static assets for the client, one Durable Object per room, and a single
// DataDO holding the shared calibration data.
import { DurableObject } from 'cloudflare:workers';
import type { ServerMsg } from '../shared/types.ts';
import { CalibrationStore, type DataKV } from '../server/data-store.ts';
import { Room, newCode, type Conn } from '../server/room.ts';
import { MAX_MESSAGE_BYTES, Session } from '../server/session.ts';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<RoomDO>;
  DATA: DurableObjectNamespace<DataDO>;
  /** Set with `wrangler secret put ADMIN_KEY` to enable /api/export. */
  ADMIN_KEY?: string;
}

const CODE_RE = /^[A-Z]{4}$/;
const CREATE_TRIES = 8;
const TICK_MS = 1000 / 60;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/audio-manifest') return env.ASSETS.fetch(new URL('/audio-manifest.json', url));
    if (url.pathname.startsWith('/api/')) return env.DATA.get(env.DATA.idFromName('global')).fetch(req);
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

/**
 * One room. Holds the Room in memory and ticks it at 60 Hz only while a match is running (or
 * paused, waiting on a rejoin), so a lobby or a finished match costs no CPU between messages.
 */
export class RoomDO extends DurableObject<Env> {
  private code = '';
  private room: Room | null = null;
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
      sendRaw: (json: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(json);
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
      this.syncTicking();
    };
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > MAX_MESSAGE_BYTES) return;
      session.message(e.data);
      this.syncTicking();
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

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Runs the tick timer exactly while the room needs it and someone is connected; checked after
   * every message and close. An empty paused room resumes ticking (and forfeits if the rejoin
   * window has passed) when the next socket sends its join.
   */
  private syncTicking(): void {
    if (this.room?.needsTick && !this.room.empty) {
      this.timer ??= setInterval(() => this.tick(), TICK_MS);
    } else if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    this.room?.tick();
    // A match that just ended (KO, decision, forfeit) stops the timer until the next one starts.
    if (!this.room?.needsTick || this.room.empty) this.syncTicking();
  }
}

/** The one global calibration data store (idFromName('global')). */
export class DataDO extends DurableObject<Env> {
  private store: CalibrationStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const st = ctx.storage;
    const kv: DataKV = {
      get: (k) => st.get(k),
      put: (e) => st.put(e),
      list: async <T>(prefix: string, startAfter: string | undefined, limit: number) =>
        [...(await st.list<T>({ prefix, startAfter, limit })).entries()],
    };
    this.store = new CalibrationStore(kv);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const r = await this.store.handle({
      method: req.method,
      path: url.pathname,
      search: url.searchParams,
      ip: req.headers.get('CF-Connecting-IP') ?? 'unknown',
      auth: req.headers.get('Authorization'),
      adminKey: this.env.ADMIN_KEY || undefined,
      body: () => req.text(),
    });
    if (r.json === undefined) return Response.json(r.body, { status: r.status, headers: r.headers });
    return new Response(r.json, { status: r.status, headers: { 'Content-Type': 'application/json', ...r.headers } });
  }
}
