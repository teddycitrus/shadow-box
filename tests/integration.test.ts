import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.ts';
import { RULES } from '../shared/rules.ts';
import type { ClientMsg, DefenseState, FighterSnapshot, MatchEvent, MatchSnapshot, Punch, ServerMsg, Slot } from '../shared/types.ts';

interface Client {
  ws: WebSocket;
  log: ServerMsg[];
  send(m: ClientMsg): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UPPERCUT: Punch = { type: 'rightUppercut', hand: 'right', target: 'head' };
const COST = RULES.punchCost.uppercut;

let server: Awaited<ReturnType<typeof startServer>>;
let a: Client;
let b: Client;
let offset = 0;

function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const c: Client = { ws, log: [], send: (m) => ws.send(JSON.stringify(m)) };
  ws.on('message', (d) => c.log.push(JSON.parse(String(d)) as ServerMsg));
  return new Promise((ok, fail) => {
    ws.once('open', () => ok(c));
    ws.once('error', fail);
  });
}

/** Resolves with the log index of the first message at or after `since` matching `pred`. */
async function waitFor(c: Client, pred: (m: ServerMsg) => boolean, ms = 5_000, since = 0): Promise<number> {
  const deadline = performance.now() + ms;
  for (;;) {
    for (let i = since; i < c.log.length; i++) if (pred(c.log[i])) return i;
    since = c.log.length;
    if (performance.now() > deadline) throw new Error(`timed out after ${ms} ms`);
    await sleep(5);
  }
}

async function event(c: Client, pred: (e: MatchEvent) => boolean, ms = 5_000, since = 0) {
  const i = await waitFor(c, (m) => m.t === 'event' && pred(m.ev), ms, since);
  return { i, ev: (c.log[i] as Extract<ServerMsg, { t: 'event' }>).ev };
}

async function stateAfter(c: Client, since: number, pred: (s: MatchSnapshot) => boolean = () => true, ms = 5_000) {
  const i = await waitFor(c, (m) => m.t === 'state' && pred(m.s), ms, since + 1);
  return (c.log[i] as Extract<ServerMsg, { t: 'state' }>).s;
}

function latest(c: Client, slot: Slot): FighterSnapshot {
  for (let i = c.log.length - 1; i >= 0; i--) {
    const m = c.log[i];
    if (m.t === 'state') return m.s.fighters[slot];
  }
  throw new Error('no state yet');
}

const serverNow = () => performance.now() + offset;
const mark = (c: Client) => c.log.length - 1;
const punch = (p: Punch = UPPERCUT) => a.send({ t: 'punch', punch: p, at: serverNow() });
const defend = (c: Client, def: Partial<DefenseState>) =>
  c.send({ t: 'defense', def: { guard: false, duck: false, slip: 'none', ...def }, at: serverNow() });

/** Throws uppercuts from A, pacing for stamina, until B is knocked down. */
async function knockDownB(n: number) {
  for (;;) {
    const s = latest(a, 0);
    if (s.exhausted || s.stamina < COST + 1) {
      await sleep(200);
      continue;
    }
    const since = mark(a);
    punch();
    const { ev } = await event(a, (e) => e.e === 'land' && e.attacker === 0, 2_000, since);
    if (ev.e === 'land') expect(ev.outcome).toBe('hit');
    const kd = a.log.slice(since + 1).find((m) => m.t === 'event' && m.ev.e === 'knockdown');
    if (kd) {
      expect(kd).toMatchObject({ ev: { e: 'knockdown', slot: 1, n } });
      return;
    }
    await sleep(50);
  }
}

beforeAll(async () => {
  server = await startServer(0);
  a = await connect(server.port);
  b = await connect(server.port);
});

afterAll(async () => {
  a?.ws.terminate();
  b?.ws.terminate();
  await server?.close();
});

test('two clients play a match to a KO over the websocket', async () => {
  a.send({ t: 'create' });
  const joined = a.log[await waitFor(a, (m) => m.t === 'joined')];
  expect(joined).toMatchObject({ t: 'joined', slot: 0, role: 'player' });
  if (joined.t !== 'joined') return;
  expect(joined.token).toBeTruthy();

  b.send({ t: 'join', code: joined.code });
  expect(b.log[await waitFor(b, (m) => m.t === 'joined')]).toMatchObject({ slot: 1, code: joined.code });
  const both = (m: ServerMsg) => m.t === 'lobby' && m.players.every((p) => p?.connected);
  await waitFor(a, both);
  await waitFor(b, both);

  const t0 = performance.now();
  a.send({ t: 'ping', c: t0 });
  const pong = a.log[await waitFor(a, (m) => m.t === 'pong' && m.c === t0)];
  if (pong.t === 'pong') offset = pong.s - (t0 + performance.now()) / 2;

  for (const c of [a, b]) c.send({ t: 'ready', ready: true, calibrated: true, stance: 'orthodox' });
  await waitFor(a, (m) => m.t === 'state' && m.s.phase === 'countdown');
  await waitFor(a, (m) => m.t === 'state' && m.s.phase === 'round', RULES.countdownMs + 2_000);
  expect(latest(a, 0).stamina).toBe(RULES.maxStamina);

  let since = mark(a);
  punch();
  let land = await event(a, (e) => e.e === 'land', 2_000, since);
  expect(land.ev).toMatchObject({ outcome: 'hit', damage: 16.5, attacker: 0 });
  let s = await stateAfter(a, land.i);
  expect(s.fighters[1].hp).toBe(RULES.maxHp - 16.5);
  expect(s.fighters[0].stamina).toBe(RULES.maxStamina - COST);

  defend(b, { guard: true });
  await sleep(50);
  const pre = latest(a, 0).stamina;
  since = mark(a);
  punch();
  land = await event(a, (e) => e.e === 'land', 2_000, since);
  expect(land.ev).toMatchObject({ outcome: 'block', damage: 2.5 });
  s = await stateAfter(a, land.i);
  expect(s.fighters[1].hp).toBe(81);
  expect(s.fighters[1].stamina).toBeLessThanOrEqual(RULES.maxStamina - RULES.blockCost - 16.5 * RULES.blockStaminaPerDamage + 1);
  expect(pre - s.fighters[0].stamina).toBeCloseTo(COST, 0);

  defend(b, { guard: false });
  await sleep(RULES.defenseWindowBeforeMs + 100);
  since = mark(a);
  await knockDownB(1);
  expect(latest(a, 1).status).toBe('down');
  await event(a, (e) => e.e === 'count' && e.slot === 1 && e.n === 1, 2_000, since);

  defend(b, { guard: true });
  const up = await event(a, (e) => e.e === 'getUp' && e.slot === 1, RULES.getUpHoldMs[0] + 1_500, since);
  expect(a.log.slice(since, up.i).some((m) => m.t === 'event' && m.ev.e === 'count' && m.ev.n === 2)).toBe(true);
  s = await stateAfter(a, up.i);
  expect(s.fighters[1].hp).toBe(RULES.getUpRestoreHp[0]);

  defend(b, { guard: false });
  await sleep(RULES.getUpAnimMs + RULES.protectAfterGetUpMs + 200);
  expect(latest(a, 1)).toMatchObject({ status: 'up', protectedMs: 0 });
  since = mark(a);
  await knockDownB(2);

  const end = await event(a, (e) => e.e === 'matchEnd', RULES.countMax * RULES.countStepMs + 2_000, since);
  expect(end.ev).toMatchObject({ result: { kind: 'ko', winner: 0 } });
  expect(a.log.slice(since).some((m) => m.t === 'event' && m.ev.e === 'count' && m.ev.n === RULES.countMax)).toBe(true);
}, 60_000);
