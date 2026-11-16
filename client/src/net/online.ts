import type { ClientMsg, DefenseState, MatchSnapshot, Punch, ServerMsg, Slot, Stance, WirePose } from '../../../shared/types.ts';
import { applyPoseDelta, decodeDefense, decodeSnapshot, flattenPose, poseDelta, unflattenPose } from '../../../shared/wire.ts';
import { sound } from '../audio/sound.ts';
import { noopHandlers, type MatchLink } from './link.ts';

/** Shared audio latency budget: covers network jitter so all viewers hear a cue together. */
const AUDIO_SYNC_MS = 180;

export type Connect = { create: true } | { join: string } | { watch: string };

const tokenKey = (code: string) => `shadowbox:token:${code}`;

/** WebSocket link to the authoritative server, with clock sync and automatic reconnect. */
export class OnlineLink implements MatchLink {
  slot: Slot | null = null;
  code: string | null = null;
  handlers = noopHandlers();
  onJoined: (code: string, slot: Slot | null) => void = () => {};
  onError: (msg: string) => void = () => {};
  onConnection: (up: boolean) => void = () => {};
  private ws: WebSocket | null = null;
  private offset = 0;
  private bestRtt = Infinity;
  private lastReady: Extract<ClientMsg, { t: 'ready' }> | null = null;
  /** Last full pose per slot, the base the server's pose deltas apply to. Reset on each join. */
  private poseBase: [number[] | null, number[] | null] = [null, null];
  /** Last pose sent since this socket joined; later poses go up as deltas from it. */
  private poseSent: number[] | null = null;
  private joined = false;
  private closed = false;

  constructor(private mode: Connect) {
    this.open();
    setInterval(() => this.ping(), 3000);
  }

  /** Converts a performance.now() timestamp into server time. */
  serverTime(local: number): number {
    return local + this.offset;
  }

  private open(): void {
    // The query routes the socket to its room's Durable Object on Cloudflare; the first message
    // below still names the room, which is all the Node server needs.
    const m0 = this.mode;
    const code = this.code ?? ('join' in m0 ? m0.join : 'watch' in m0 ? m0.watch : null);
    const query = code ? `code=${encodeURIComponent(code)}` : 'create=1';
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${query}`);
    this.ws = ws;
    this.joined = false;
    ws.onopen = () => {
      this.onConnection(true);
      const m = this.mode;
      if ('create' in m && !this.code) this.send({ t: 'create' });
      else if ('watch' in m) this.send({ t: 'watch', code: m.watch });
      else {
        const code = this.code ?? (m as { join: string }).join;
        this.send({ t: 'join', code, token: localStorage.getItem(tokenKey(code)) ?? undefined });
      }
      for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 120);
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = () => {
      this.onConnection(false);
      if (!this.closed) setTimeout(() => this.open(), 1500);
    };
  }

  private receive(m: ServerMsg): void {
    switch (m.t) {
      case 'joined':
        this.code = m.code;
        this.slot = m.slot;
        this.poseBase = [null, null];
        this.poseSent = null;
        this.joined = true;
        if (m.token) localStorage.setItem(tokenKey(m.code), m.token);
        if (this.lastReady) this.send(this.lastReady);
        this.onJoined(m.code, m.slot);
        break;
      case 'error':
        this.closed = m.msg.startsWith('Room');
        this.onError(m.msg);
        break;
      case 'pong': {
        const now = performance.now();
        const rtt = now - m.c;
        if (rtt <= this.bestRtt * 1.2 || rtt < 60) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = m.s - (m.c + rtt / 2);
        }
        break;
      }
      case 'lobby':
        this.handlers.lobby(m.players, m.spectators);
        break;
      case 'pose': {
        // Older servers sent the plain pose in `p` and the defense object in `def`.
        const old = m as { p?: WirePose; def?: DefenseState };
        if (old.p && old.def) {
          this.handlers.pose(m.slot, old.p, old.def);
          break;
        }
        const base = this.poseBase[m.slot];
        const full = m.k ?? (m.dp && base ? applyPoseDelta(base, m.dp) : null);
        if (!full) break;
        this.poseBase[m.slot] = full;
        this.handlers.pose(m.slot, unflattenPose(full), decodeDefense(m.d));
        break;
      }
      case 'state': {
        // Older servers sent the plain snapshot and `rejoinMs`.
        const s: unknown = m.s;
        const rejoin = m.r ?? (m as { rejoinMs?: number | null }).rejoinMs ?? null;
        this.handlers.state(Array.isArray(s) ? decodeSnapshot(s) : (s as MatchSnapshot), rejoin);
        break;
      }
      case 'event': {
        // Every client schedules the event's sounds for the same server moment (event time plus a
        // small shared latency budget), with the same seeded random choices.
        const wait = m.at === undefined ? 0 : Math.min(600, Math.max(0, m.at + AUDIO_SYNC_MS - this.serverTime(performance.now())));
        sound.cue(wait / 1000, m.id, () => this.handlers.event(m.ev));
        break;
      }
    }
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private ping(): void {
    this.send({ t: 'ping', c: Math.round(performance.now() * 10) / 10 });
  }

  punch(punch: Punch, at: number): void {
    this.send({ t: 'punch', punch, at: Math.round(this.serverTime(at)) });
  }

  defense(def: DefenseState, at: number): void {
    this.send({ t: 'defense', def, at: Math.round(this.serverTime(at)) });
  }

  pose(p: WirePose): void {
    // The server keeps a delta base per join, so nothing is sent until this socket has joined.
    if (!this.joined || this.ws?.readyState !== WebSocket.OPEN) return;
    const cur = flattenPose(p);
    const prev = this.poseSent;
    this.poseSent = cur;
    this.send(prev ? { t: 'pose', dp: poseDelta(cur, prev) } : { t: 'pose', k: cur });
  }

  ready(ready: boolean, calibrated: boolean, stance: Stance): void {
    this.lastReady = { t: 'ready', ready, calibrated, stance };
    this.send(this.lastReady);
  }
}
