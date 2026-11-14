import { describe, expect, it } from 'vitest';
import { RULES } from '../shared/rules.ts';
import type { ServerMsg } from '../shared/types.ts';
import { Room, type Conn } from '../server/room.ts';

function conn(): Conn & { msgs: ServerMsg[] } {
  const msgs: ServerMsg[] = [];
  return { msgs, send: (m) => msgs.push(m) };
}

function setup() {
  let t = 0;
  const clock = { advance: (ms: number) => (t += ms) };
  const room = new Room('ABCD', () => t);
  const a = conn(), b = conn();
  room.join(a);
  room.join(b);
  const ready = { t: 'ready', ready: true, calibrated: true, stance: 'orthodox' } as const;
  return { room, a, b, clock, ready };
}

describe('room', () => {
  it('assigns two slots, rejects a third, and starts when both are ready', () => {
    const { room, a, b, ready } = setup();
    expect(room.join(conn())).toBeNull();
    room.handle(a, 0, ready);
    expect(room.match).toBeNull();
    room.handle(b, 1, ready);
    expect(room.match?.phase).toBe('countdown');
  });

  it('relays poses to the opponent and spectators but not the sender', () => {
    const { room, a, b } = setup();
    const s = conn();
    room.watch(s);
    const p = { lm: new Array(39).fill(0), off: [0, 0] as [number, number] };
    room.handle(a, 0, { t: 'pose', p });
    expect(b.msgs.some((m) => m.t === 'pose')).toBe(true);
    expect(s.msgs.some((m) => m.t === 'pose')).toBe(true);
    expect(a.msgs.some((m) => m.t === 'pose')).toBe(false);
  });

  it('pauses on disconnect, resumes on rejoin with the token', () => {
    const { room, a, b, ready, clock } = setup();
    room.handle(a, 0, ready);
    room.handle(b, 1, ready);
    const token = (b.msgs.find((m) => m.t === 'joined') as Extract<ServerMsg, { t: 'joined' }>).token!;
    room.leave(b);
    expect(room.match?.paused).toBe(true);
    clock.advance(30_000);
    room.tick();
    const b2 = conn();
    expect(room.join(b2, token)).toBe(1);
    expect(room.match?.paused).toBe(false);
  });

  it('gives a seat left in the lobby to a new player, but not one left mid-match', () => {
    const { room, a, b, ready } = setup();
    room.leave(b);
    const c = conn();
    expect(room.join(c)).toBe(1);
    room.handle(a, 0, ready);
    room.handle(c, 1, ready);
    room.leave(c);
    expect(room.join(conn())).toBeNull();
  });

  it('tells late joiners about a pause and about the result', () => {
    const { room, a, b, ready, clock } = setup();
    room.handle(a, 0, ready);
    room.handle(b, 1, ready);
    room.leave(b);
    const s = conn();
    room.watch(s);
    expect(s.msgs).toContainEqual({ t: 'event', ev: { e: 'paused', reason: 'disconnect' } });
    clock.advance(RULES.rejoinMs + 10);
    room.tick();
    const s2 = conn();
    room.watch(s2);
    expect(s2.msgs).toContainEqual({ t: 'event', ev: { e: 'matchEnd', result: { kind: 'forfeit', winner: 0 } } });
  });

  it('forfeits after the rejoin window', () => {
    const { room, a, b, ready, clock } = setup();
    room.handle(a, 0, ready);
    room.handle(b, 1, ready);
    room.leave(b);
    clock.advance(RULES.rejoinMs + 10);
    room.tick();
    expect(room.match?.result).toEqual({ kind: 'forfeit', winner: 0 });
  });
});
