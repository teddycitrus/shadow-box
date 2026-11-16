import type { ClientMsg, Slot } from '../shared/types.ts';
import type { Conn, Room } from './room.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Where a session finds rooms: a Map on the Node server, the single room of a Durable Object. */
export interface RoomRegistry {
  create(): Room;
  get(code: string): Room | undefined;
}

/**
 * One WebSocket connection. The first create/join/watch message binds it to a room; after that
 * player messages go to Room.handle. Shared by the Node server and the Cloudflare Durable Object.
 */
export class Session {
  private room: Room | null = null;
  private slot: Slot | null = null;

  constructor(private conn: Conn, private rooms: RoomRegistry, private now: () => number) {}

  message(data: string): void {
    let m: ClientMsg;
    try {
      m = JSON.parse(data) as ClientMsg;
    } catch {
      return;
    }
    const conn = this.conn;
    if (m.t === 'ping') {
      conn.send({ t: 'pong', c: m.c, s: Math.round(this.now()) });
      return;
    }
    if (!this.room) {
      if (m.t === 'create') {
        this.room = this.rooms.create();
        this.slot = this.room.join(conn);
      } else if (m.t === 'join' || m.t === 'watch') {
        const code = String(m.code ?? '').toUpperCase();
        const room = this.rooms.get(code);
        if (!room) return conn.send({ t: 'error', msg: `Room ${code} not found` });
        if (m.t === 'watch') {
          room.watch(conn);
          this.room = room;
        } else {
          this.slot = room.join(conn, m.token);
          if (this.slot === null) conn.send({ t: 'error', msg: `Room ${code} is full. Opening the spectator view.` });
          else this.room = room;
        }
      }
      return;
    }
    if (this.slot !== null) this.room.handle(conn, this.slot, m);
  }

  close(): void {
    this.room?.leave(this.conn);
    this.room = null;
  }
}
