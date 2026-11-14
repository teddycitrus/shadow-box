import type { ClientMsg, DefenseState, Punch, ServerMsg, Slot, Stance, WirePose } from '../../../shared/types.ts';
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
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
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
      case 'pose':
        this.handlers.pose(m.slot, m.p, m.def);
        break;
      case 'state':
        this.handlers.state(m.s, m.rejoinMs);
        break;
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
    this.send({ t: 'ping', c: performance.now() });
  }

  punch(punch: Punch, at: number): void {
    this.send({ t: 'punch', punch, at: this.serverTime(at) });
  }

  defense(def: DefenseState, at: number): void {
    this.send({ t: 'defense', def, at: this.serverTime(at) });
  }

  pose(p: WirePose): void {
    this.send({ t: 'pose', p });
  }

  ready(ready: boolean, calibrated: boolean, stance: Stance): void {
    this.lastReady = { t: 'ready', ready, calibrated, stance };
    this.send(this.lastReady);
  }
}
