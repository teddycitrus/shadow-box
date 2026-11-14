import { randomBytes } from 'node:crypto';
import { Match } from '../shared/match.ts';
import { RULES } from '../shared/rules.ts';
import {
  NO_DEFENSE, other,
  type ClientMsg, type DefenseState, type LobbyPlayer, type ServerMsg, type Slot, type Stance, type WirePose,
} from '../shared/types.ts';

export interface Conn {
  send(m: ServerMsg): void;
}

interface Player {
  token: string;
  conn: Conn | null;
  calibrated: boolean;
  ready: boolean;
  stance: Stance;
  def: DefenseState;
  pose: WirePose | null;
  leftAt: number;
}

const ACTIVE = new Set(['countdown', 'round', 'break']);

/** One 1v1 room: two player slots, any number of spectators, one authoritative Match. */
export class Room {
  readonly players: [Player | null, Player | null] = [null, null];
  readonly spectators = new Set<Conn>();
  match: Match | null = null;
  lastActivity: number;
  private lastState = 0;
  private seq = 1;

  constructor(readonly code: string, private now: () => number) {
    this.lastActivity = now();
  }

  get empty(): boolean {
    return this.spectators.size === 0 && this.players.every((p) => !p?.conn);
  }

  join(conn: Conn, token?: string): Slot | null {
    const slot = this.players.findIndex((p) => p && token && p.token === token);
    if (slot >= 0) return this.attach(slot as Slot, conn);
    let free = this.players.findIndex((p) => p === null);
    // Outside a live match, a seat whose player has left can go to someone new.
    if (free < 0 && !(this.match && ACTIVE.has(this.match.phase))) {
      free = this.players.findIndex((p) => !p?.conn);
      // The old result belongs to the player who left, so the newcomer starts from the lobby.
      if (free >= 0) this.match = null;
    }
    if (free < 0) return null;
    this.players[free] = {
      token: randomBytes(12).toString('hex'), conn: null, calibrated: false, ready: false,
      stance: 'orthodox', def: NO_DEFENSE, pose: null, leftAt: 0,
    };
    return this.attach(free as Slot, conn);
  }

  private attach(slot: Slot, conn: Conn): Slot {
    const p = this.players[slot]!;
    p.conn = conn;
    conn.send({ t: 'joined', code: this.code, role: 'player', slot, token: p.token });
    if (this.match?.paused && this.players.every((x) => x?.conn)) this.match.resume(this.now());
    this.sendLobby();
    this.sendState(true);
    this.catchUp(conn);
    return slot;
  }

  watch(conn: Conn): void {
    this.spectators.add(conn);
    conn.send({ t: 'joined', code: this.code, role: 'spectator', slot: null, token: null });
    this.sendLobby();
    this.sendState(true);
    this.catchUp(conn);
  }

  /** Replays the event a late joiner needs to show the right screen (pause banner or result). */
  private catchUp(conn: Conn): void {
    const m = this.match;
    if (m?.paused) conn.send({ t: 'event', ev: { e: 'paused', reason: 'disconnect' } });
    else if (m?.result) conn.send({ t: 'event', ev: { e: 'matchEnd', result: m.result } });
  }

  leave(conn: Conn): void {
    this.spectators.delete(conn);
    const slot = this.players.findIndex((p) => p?.conn === conn);
    if (slot >= 0) {
      const p = this.players[slot]!;
      p.conn = null;
      p.ready = false;
      p.leftAt = this.now();
      if (this.match && ACTIVE.has(this.match.phase)) this.match.pause(this.now(), 'disconnect');
    }
    this.sendLobby();
    this.flush();
  }

  handle(conn: Conn, slot: Slot, m: ClientMsg): void {
    const p = this.players[slot];
    if (!p || p.conn !== conn) return;
    this.lastActivity = this.now();
    const now = this.now();
    switch (m.t) {
      case 'pose':
        if (!Array.isArray(m.p?.lm) || m.p.lm.length !== 39) return;
        p.pose = m.p;
        this.broadcast({ t: 'pose', slot, p: m.p, def: p.def }, conn);
        break;
      case 'defense':
        p.def = m.def;
        this.match?.setDefense(slot, m.def, m.at, now);
        break;
      case 'punch':
        this.match?.punch(slot, m.punch, m.at, now);
        this.flush();
        break;
      case 'ready':
        p.ready = m.ready;
        p.calibrated = m.calibrated;
        p.stance = m.stance === 'southpaw' ? 'southpaw' : 'orthodox';
        this.maybeStart();
        this.sendLobby();
        break;
    }
  }

  private maybeStart(): void {
    if (this.match && this.match.phase !== 'ended') return;
    if (!this.players.every((p) => p?.conn && p.ready && p.calibrated)) return;
    this.match = new Match();
    for (const p of this.players) p!.ready = false;
    this.match.start(this.now());
    this.sendState(true);
  }

  tick(): void {
    const now = this.now();
    const m = this.match;
    if (m) {
      if (m.paused) {
        for (const [i, p] of this.players.entries()) {
          if (p && !p.conn && now - p.leftAt > RULES.rejoinMs) m.forfeit(i as Slot);
        }
      }
      m.tick(now);
      this.flush();
    }
    if (now - this.lastState >= 100) this.sendState();
  }

  private rejoinMs(): number | null {
    if (!this.match?.paused) return null;
    const gone = this.players.filter((p) => p && !p.conn).map((p) => p!.leftAt);
    return gone.length ? Math.max(0, RULES.rejoinMs - (this.now() - Math.min(...gone))) : null;
  }

  private flush(): void {
    if (!this.match) return;
    const evs = this.match.drain();
    for (const ev of evs) this.broadcast({ t: 'event', ev, at: this.now(), id: this.seq++ });
    if (evs.length) this.sendState(true);
  }

  private sendState(force = false): void {
    if (!this.match) return;
    if (!force && this.match.phase === 'ended') return;
    this.lastState = this.now();
    this.broadcast({ t: 'state', s: this.match.snapshot(), rejoinMs: this.rejoinMs() });
  }

  sendLobby(): void {
    const view = (p: Player | null): LobbyPlayer | null =>
      p && { connected: !!p.conn, calibrated: p.calibrated, ready: p.ready, stance: p.stance };
    this.broadcast({ t: 'lobby', players: [view(this.players[0]), view(this.players[1])], spectators: this.spectators.size });
  }

  private broadcast(m: ServerMsg, except?: Conn): void {
    for (const p of this.players) if (p?.conn && p.conn !== except) p.conn.send(m);
    for (const s of this.spectators) if (s !== except) s.send(m);
  }

  opponentOf(slot: Slot): Player | null {
    return this.players[other(slot)];
  }
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newCode(taken: (c: string) => boolean): string {
  for (;;) {
    const c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
    if (!taken(c)) return c;
  }
}
