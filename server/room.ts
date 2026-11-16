import { Match } from '../shared/match.ts';
import { RULES } from '../shared/rules.ts';
import { POSE_LEN, applyPoseDelta, cleanPose, encodeDefense, encodeSnapshot, flattenPose, poseDelta, snapshotKey } from '../shared/wire.ts';
import {
  NO_DEFENSE, other,
  type ClientMsg, type DefenseState, type LobbyPlayer, type ServerMsg, type Slot, type Stance,
} from '../shared/types.ts';

export interface Conn {
  send(m: ServerMsg): void;
  /** Sends an already serialized message, so a broadcast is stringified once for everyone. */
  sendRaw?(json: string): void;
}

interface Player {
  token: string;
  conn: Conn | null;
  calibrated: boolean;
  ready: boolean;
  stance: Stance;
  def: DefenseState;
  /** Last pose received from this player, the base its uplink deltas apply to. Reset on attach. */
  poseIn: number[] | null;
  leftAt: number;
}

const ACTIVE = new Set(['countdown', 'round', 'break']);
/** Snapshot rate cap, and the longest gap between snapshots while a match runs. */
const STATE_MS = 100;
const STATE_HEARTBEAT_MS = 1_000;

/** Web Crypto works in Node and in Workers, so the room runs unchanged in both. */
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One 1v1 room: two player slots, any number of spectators, one authoritative Match. */
export class Room {
  readonly players: [Player | null, Player | null] = [null, null];
  readonly spectators = new Set<Conn>();
  match: Match | null = null;
  lastActivity: number;
  /** Last snapshot sent, and last time one was considered. */
  private lastState = -Infinity;
  private lastCheck = -Infinity;
  private lastKey = '';
  private seq = 1;
  /** Last relayed pose per slot, flattened. Every connected receiver holds the same base. */
  private poses: [number[] | null, number[] | null] = [null, null];

  constructor(readonly code: string, private now: () => number) {
    this.lastActivity = now();
  }

  /** True while the match clock, a pause timeout or pending events need tick() calls. */
  get needsTick(): boolean {
    return !!this.match && this.match.phase !== 'ended' && this.match.phase !== 'lobby';
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
      token: randomHex(12), conn: null, calibrated: false, ready: false,
      stance: 'orthodox', def: NO_DEFENSE, poseIn: null, leftAt: 0,
    };
    return this.attach(free as Slot, conn);
  }

  private attach(slot: Slot, conn: Conn): Slot {
    const p = this.players[slot]!;
    p.conn = conn;
    p.poseIn = null;
    conn.send({ t: 'joined', code: this.code, role: 'player', slot, token: p.token });
    if (this.match?.paused && this.players.every((x) => x?.conn)) this.match.resume(this.now());
    this.sendLobby();
    this.sendState(true);
    this.catchUp(conn);
    this.sendPoses(conn, other(slot));
    return slot;
  }

  watch(conn: Conn): void {
    this.spectators.add(conn);
    conn.send({ t: 'joined', code: this.code, role: 'spectator', slot: null, token: null });
    this.sendLobby();
    this.sendState(true);
    this.catchUp(conn);
    this.sendPoses(conn, 0);
    this.sendPoses(conn, 1);
  }

  /** Gives a newcomer the full last pose of a slot, so the deltas that follow apply to it. */
  private sendPoses(conn: Conn, slot: Slot): void {
    const k = this.poses[slot];
    if (k) conn.send({ t: 'pose', slot, k, d: encodeDefense(this.players[slot]?.def ?? NO_DEFENSE) });
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
      case 'pose': {
        const cur = readPose(m, p.poseIn);
        if (!cur) return;
        p.poseIn = cur;
        // Relayed as a delta from the slot's last relayed pose (the first one in full).
        const prev = this.poses[slot];
        this.poses[slot] = cur;
        const d = encodeDefense(p.def);
        this.broadcast(prev ? { t: 'pose', slot, dp: poseDelta(cur, prev), d } : { t: 'pose', slot, k: cur, d }, conn);
        break;
      }
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
    if (now - this.lastCheck >= STATE_MS) this.sendState();
  }

  private rejoinMs(): number | null {
    if (!this.match?.paused) return null;
    const gone = this.players.filter((p) => p && !p.conn).map((p) => p!.leftAt);
    return gone.length ? Math.max(0, RULES.rejoinMs - (this.now() - Math.min(...gone))) : null;
  }

  private flush(): void {
    if (!this.match) return;
    const evs = this.match.drain();
    if (!evs.length) return;
    const at = Math.round(this.now());
    for (const ev of evs) this.broadcast({ t: 'event', ev, at, id: this.seq++ });
    this.sendState(true);
  }

  /**
   * Sends a snapshot when something a viewer can see has changed (see snapshotKey), at most every
   * STATE_MS and at least every STATE_HEARTBEAT_MS. Forced sends go out regardless.
   */
  private sendState(force = false): void {
    if (!this.match) return;
    if (!force && this.match.phase === 'ended') return;
    const now = this.now();
    this.lastCheck = now;
    const s = encodeSnapshot(this.match.snapshot());
    const rejoin = this.rejoinMs();
    const key = snapshotKey(s, rejoin);
    if (!force && key === this.lastKey && now - this.lastState < STATE_HEARTBEAT_MS) return;
    this.lastState = now;
    this.lastKey = key;
    this.broadcast(rejoin === null ? { t: 'state', s } : { t: 'state', s, r: Math.round(rejoin) });
  }

  sendLobby(): void {
    const view = (p: Player | null): LobbyPlayer | null =>
      p && { connected: !!p.conn, calibrated: p.calibrated, ready: p.ready, stance: p.stance };
    this.broadcast({ t: 'lobby', players: [view(this.players[0]), view(this.players[1])], spectators: this.spectators.size });
  }

  private broadcast(m: ServerMsg, except?: Conn): void {
    let json: string | null = null;
    const out = (c: Conn) => {
      if (c === except) return;
      if (c.sendRaw) c.sendRaw((json ??= JSON.stringify(m)));
      else c.send(m);
    };
    for (const p of this.players) if (p?.conn) out(p.conn);
    for (const s of this.spectators) out(s);
  }

  opponentOf(slot: Slot): Player | null {
    return this.players[other(slot)];
  }
}

/**
 * The flattened pose in a client pose message, or null if it is malformed or is a delta with no
 * base. Only the known fields are read, so extra junk in a message is not fanned out.
 */
function readPose(m: Extract<ClientMsg, { t: 'pose' }>, base: number[] | null): number[] | null {
  const ok = (a: unknown): a is number[] => Array.isArray(a) && a.length === POSE_LEN;
  if (ok(m.k)) return cleanPose(m.k);
  if (ok(m.dp)) return base ? cleanPose(applyPoseDelta(base, m.dp)) : null;
  if (Array.isArray(m.p?.lm) && m.p.lm.length === 39) return flattenPose(m.p);
  return null;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newCode(taken: (c: string) => boolean): string {
  for (;;) {
    const c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
    if (!taken(c)) return c;
  }
}
