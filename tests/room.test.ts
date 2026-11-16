import { describe, expect, it } from 'vitest';
import { RULES } from '../shared/rules.ts';
import type { ServerMsg } from '../shared/types.ts';
import { Room, type Conn } from '../server/room.ts';
import { applyPoseDelta, decodeDefense, decodeSnapshot, encodeDefense, encodeSnapshot, unflattenPose } from '../shared/wire.ts';

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

  it('serializes a broadcast once and sends the same string to everyone', () => {
    const { room, a } = setup();
    const raws: string[][] = [[], []];
    const r1: Conn = { send: () => {}, sendRaw: (j) => raws[0].push(j) };
    const r2: Conn = { send: () => {}, sendRaw: (j) => raws[1].push(j) };
    room.watch(r1);
    room.watch(r2);
    raws[0].length = raws[1].length = 0;
    const p = { lm: new Array(39).fill(7), off: [1, 2] as [number, number], junk: 'x'.repeat(100) };
    room.handle(a, 0, { t: 'pose', p });
    expect(raws[0]).toHaveLength(1);
    expect(raws[0][0]).toBe(raws[1][0]);
    const m = JSON.parse(raws[0][0]) as Extract<ServerMsg, { t: 'pose' }>;
    expect(m).toEqual({ t: 'pose', slot: 0, k: [...p.lm, 1, 2], d: 0 });
  });

  it('relays later poses as deltas and gives late joiners the full last pose', () => {
    const { room, a, b } = setup();
    const lm = Array.from({ length: 39 }, (_, i) => i * 10);
    room.handle(a, 0, { t: 'pose', p: { lm, off: [0, 0] } });
    room.handle(a, 0, { t: 'defense', def: { guard: true, duck: false, slip: 'left' }, at: 0 });
    const lm2 = lm.map((v, i) => v + (i % 3) - 1);
    room.handle(a, 0, { t: 'pose', p: { lm: lm2, off: [5, -5] } });
    const poses = b.msgs.filter((m) => m.t === 'pose') as Extract<ServerMsg, { t: 'pose' }>[];
    expect(poses[0].k).toEqual([...lm, 0, 0]);
    const got = unflattenPose(applyPoseDelta(poses[0].k!, poses[1].dp!));
    expect(got).toEqual({ lm: lm2, off: [5, -5] });
    expect(decodeDefense(poses[1].d)).toEqual({ guard: true, duck: false, slip: 'left' });
    const s = conn();
    room.watch(s);
    const late = s.msgs.filter((m) => m.t === 'pose') as Extract<ServerMsg, { t: 'pose' }>[];
    expect(late).toEqual([{ t: 'pose', slot: 0, k: [...lm2, 5, -5], d: poses[1].d }]);
  });

  it('takes uplink poses as a keyframe then deltas, and needs a new keyframe after a rejoin', () => {
    const { room, a, b } = setup();
    const k = Array.from({ length: 41 }, (_, i) => i);
    const dp = k.map(() => 2);
    const relayed = () => (b.msgs.filter((m) => m.t === 'pose') as Extract<ServerMsg, { t: 'pose' }>[]);
    room.handle(a, 0, { t: 'pose', dp });
    expect(relayed()).toHaveLength(0);
    room.handle(a, 0, { t: 'pose', k });
    room.handle(a, 0, { t: 'pose', dp });
    expect(relayed().map((m) => m.k ?? m.dp)).toEqual([k, dp]);
    const token = (a.msgs.find((m) => m.t === 'joined') as Extract<ServerMsg, { t: 'joined' }>).token!;
    room.leave(a);
    const a2 = conn();
    room.join(a2, token);
    room.handle(a2, 0, { t: 'pose', dp });
    expect(relayed()).toHaveLength(2);
  });

  it('sends snapshots only when something visible changes, with a heartbeat', () => {
    const { room, a, b, ready, clock } = setup();
    room.handle(a, 0, ready);
    room.handle(b, 1, ready);
    for (let t = 0; t < RULES.countdownMs + 200; t += 16) {
      clock.advance(16);
      room.tick();
    }
    expect(room.match?.phase).toBe('round');
    const before = a.msgs.length;
    // Idle at full stamina: only the clock's whole seconds change.
    for (let t = 0; t < 3_000; t += 16) {
      clock.advance(16);
      room.tick();
    }
    const states = a.msgs.slice(before).filter((m) => m.t === 'state');
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect(states.length).toBeLessThanOrEqual(4);
    const last = decodeSnapshot((states.at(-1) as Extract<ServerMsg, { t: 'state' }>).s);
    expect(last.phase).toBe('round');
    expect(Number.isInteger(last.clockMs)).toBe(true);
  });
});

describe('wire encoding', () => {
  it('round-trips snapshots and defense', () => {
    const s = {
      phase: 'round', paused: true, round: 2, clockMs: 12_345,
      fighters: [
        { hp: 81, stamina: 42.5, gassed: false, exhausted: true, knockdowns: 1, status: 'down', count: 3, getUpProgress: 0.25, protectedMs: 0 },
        { hp: 100, stamina: 12, gassed: true, exhausted: false, knockdowns: 0, status: 'gettingUp', count: 0, getUpProgress: 0, protectedMs: 900 },
      ],
      result: { kind: 'tko', winner: 1 },
    } as const;
    expect(decodeSnapshot(encodeSnapshot(structuredClone(s) as never))).toEqual(s);
    expect(decodeSnapshot(encodeSnapshot({ ...structuredClone(s), result: { kind: 'draw', winner: null } } as never)).result).toEqual({ kind: 'draw', winner: null });
    for (const slip of ['none', 'left', 'right'] as const) {
      for (const guard of [false, true]) {
        const d = { guard, duck: !guard, slip };
        expect(decodeDefense(encodeDefense(d))).toEqual(d);
      }
    }
  });
});
