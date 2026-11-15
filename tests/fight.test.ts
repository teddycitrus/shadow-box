import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NO_DEFENSE, type DefenseState, type MatchEvent, type MatchSnapshot, type Punch, type PunchType, type Target } from '../shared/types.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { synthFrame, type SynthState } from '../client/src/tracking/synthetic.ts';
import { REST_STEP_MS, handFor, type TeachStatus } from '../client/src/tracking/teach.ts';

/**
 * The whole chain a camera player goes through, with synthetic poses: guard calibration, the
 * guided teaching (through CameraInput, so the profile is saved to and loaded from storage like
 * in the browser), then a practice fight against the bot over PracticeLink, driven exactly like
 * views/player.ts drives it. Punches recognised in calibration must land in the fight.
 */

const DT = 1000 / 30;
const GUARD: DefenseState = { ...NO_DEFENSE, guard: true };
const store = new Map<string, string>();

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  vi.setSystemTime(0);
  vi.advanceTimersByTime(1_234_567);
  // The bot and the verify prompts are random; seed them so the fight is the same every run.
  let seed = Number(process.env.FIGHT_SEED ?? 7);
  vi.spyOn(Math, 'random').mockImplementation(() => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646);
  vi.stubGlobal('document', { createElement: () => ({}) });
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handle = (f: PoseFrame | null) => void;

/** Steps fake time by one frame and feeds the camera input the synthetic pose for that moment. */
function frame(handle: Handle, st: Omit<SynthState, 't'>): number {
  vi.advanceTimersByTime(DT);
  const t = performance.now();
  // The camera timestamp is the capture time, a little before the frame is processed.
  handle(synthFrame({ ...st, t: t - 25 } as SynthState));
  return t;
}

/** Plays the guided teaching through CameraInput's own Teacher, answering every prompt. */
function teachThrough(input: { teach: TeachStatus | null; calibrated: boolean }, handle: Handle): void {
  let punchAt = 0, stepStart = 0, thrown = false;
  let throwType: PunchType | null = null, throwTarget: Target = 'body';
  let key = '';
  for (let i = 0; i < 20_000 && !input.calibrated; i++) {
    const s = input.teach;
    const t = performance.now();
    const step = s?.step ?? null;
    let st: Omit<SynthState, 't'> = { defense: NO_DEFENSE };
    if (s?.phase === 'verify') {
      if (step && !s.verify!.result && !thrown) {
        thrown = true;
        punchAt = t + 200;
        throwType = step.type!;
        throwTarget = step.target!;
      }
      if (s.verify!.result) thrown = false;
      if (throwType) st = { defense: NO_DEFENSE, punch: { type: throwType, hand: handFor(throwType, 'orthodox'), target: throwTarget, startT: punchAt, windupMs: 60 } };
    } else if (step?.kind === 'punch') {
      if (t - punchAt > 800) punchAt = t;
      st = { defense: NO_DEFENSE, punch: { type: step.type!, hand: handFor(step.type!, 'orthodox'), target: step.target!, startT: punchAt + 100, windupMs: 60 } };
    } else if (step?.kind === 'rest') {
      const k = Math.floor((t - stepStart) / 900) % 2 === 1;
      st = step.id === 'drop' ? { defense: NO_DEFENSE, gassed: k && t - stepStart < REST_STEP_MS - 1500 } : { defense: k ? GUARD : NO_DEFENSE };
    } else if (step) {
      const on = t - stepStart > 300 && t - stepStart < 1500;
      st = { defense: { ...NO_DEFENSE, duck: on && step.kind === 'duck', slip: on && step.kind === 'slipLeft' ? 'left' : on && step.kind === 'slipRight' ? 'right' : 'none' } };
    }
    frame(handle, st);
    const k2 = `${input.teach?.phase}:${input.teach?.index}`;
    if (k2 !== key) {
      key = k2;
      stepStart = punchAt = performance.now();
    }
  }
}

describe('camera player, calibration to fight', async () => {
  const { CameraInput } = await import('../client/src/tracking/input.ts');
  const { PracticeLink } = await import('../client/src/practice/bot.ts');

  /** A fresh CameraInput through guard calibration, loading whatever profile is stored. */
  function calibrate() {
    const input = new CameraInput();
    const handle = (f: PoseFrame | null) => (input as unknown as { handle: Handle }).handle(f);
    for (let i = 0; i < 90 && !(input.status?.stage === 'done'); i++) frame(handle, { defense: GUARD });
    expect(input.status?.stage).toBe('done');
    return { input, handle };
  }

  it('teaches, saves the profile, and reads every punch back after a reload', () => {
    const { input, handle } = calibrate();
    expect(input.teach === null && !input.calibrated).toBe(true);
    teachThrough(input, handle);
    expect(input.calibrated).toBe(true);
    expect(input.learned).toHaveLength(8);
    expect(store.get('shadowbox:profile:v5')).toBeTruthy();
  });

  it('lands the punches it was taught in a practice fight against the bot', () => {
    // A new page load: the profile comes back from storage.
    const { input, handle } = calibrate();
    expect(input.calibrated).toBe(true);
    const link = new PracticeLink();
    const events: MatchEvent[] = [];
    let snap: MatchSnapshot | null = null;
    let sent = 0;
    // views/player.ts, reduced to what reaches the match.
    let lastDef: DefenseState | null = null;
    link.handlers = {
      lobby() {},
      pose() {},
      event: (e) => void events.push(e),
      state: (s) => {
        snap = s;
        const me = s.fighters[0];
        input.gassed = me.gassed;
        input.canPunch = s.phase === 'round' && !s.paused && me.status === 'up' && !me.exhausted;
      },
    };
    input.onTick = (t) => {
      const now = performance.now();
      if (!lastDef || lastDef.guard !== t.defense.guard || lastDef.duck !== t.defense.duck || lastDef.slip !== t.defense.slip) {
        lastDef = t.defense;
        link.defense(t.defense, now);
      }
      for (const p of t.punches) {
        sent++;
        link.punch({ type: p.type, hand: p.hand, target: p.target } as Punch, p.at);
      }
    };
    link.ready(true, input.calibrated, 'orthodox');
    // Countdown, in guard.
    for (let i = 0; i < 120; i++) frame(handle, { defense: GUARD });
    expect((snap as MatchSnapshot | null)?.phase).toBe('round');

    // A fighter's rhythm: a punch, back to guard, a short pause, for 25 seconds. Between punches the
    // hands rest where they rested while teaching, which the classifier reads as a guard.
    const order: [PunchType, Target][] = [
      ['jab', 'head'], ['cross', 'head'], ['leftHook', 'body'], ['jab', 'body'], ['rightUppercut', 'body'],
      ['cross', 'body'], ['rightHook', 'body'], ['leftUppercut', 'body'],
    ];
    let thrown = 0, guardFrames = 0, frames = 0, exhaustedSince: number | null = null, longestExhausted = 0;
    const end = performance.now() + 25_000;
    let next = performance.now() + 200;
    let cur: SynthState['punch'] | undefined;
    while (performance.now() < end && (snap as MatchSnapshot | null)?.phase === 'round') {
      const t = performance.now();
      if (t >= next) {
        const [type, target] = order[thrown % order.length];
        cur = { type, hand: handFor(type, 'orthodox'), target, startT: t, windupMs: 60 };
        thrown++;
        next = t + 1_300;
      }
      frame(handle, { defense: NO_DEFENSE, punch: cur });
      if (input.debug?.defense.guard) guardFrames++;
      frames++;
      const ex = !!(snap as MatchSnapshot | null)?.fighters[0].exhausted;
      if (ex && exhaustedSince === null) exhaustedSince = t;
      if (!ex) exhaustedSince = null;
      if (exhaustedSince !== null) longestExhausted = Math.max(longestExhausted, t - exhaustedSince);
    }
    for (let i = 0; i < 30; i++) frame(handle, { defense: GUARD });

    const throws = events.filter((e) => e.e === 'throw' && e.slot === 0).length;
    const lands = events.filter((e): e is Extract<MatchEvent, { e: 'land' }> => e.e === 'land' && e.attacker === 0);
    const knockedDown = events.some((e) => e.e === 'knockdown' && e.slot === 1);
    const connected = lands.filter((e) => e.outcome === 'hit' || e.outcome === 'block').length;
    // Before the stamina fix, guard (where a camera player's hands rest) drained stamina and stopped
    // recovery, so the player went exhausted within seconds and stayed there: 4 of 22 got through.
    if (process.env.FIGHT_SEED) console.log({ thrown, sent, longestExhausted, connected, knockedDown, outcomes: lands.map((e) => e.outcome).join(' ') });
    expect(sent, `guard ${(guardFrames / frames).toFixed(2)}`).toBeGreaterThanOrEqual(thrown * 0.65);
    expect(longestExhausted).toBeLessThan(5_000);
    // The view learns of exhaustion from the next snapshot, so one punch can race it.
    expect(throws).toBeGreaterThanOrEqual(sent - 1);
    // A punch still in flight when its thrower is knocked down is dropped.
    expect(lands.length).toBeGreaterThanOrEqual(throws - 1);
    expect(connected).toBeGreaterThanOrEqual(sent * (knockedDown ? 0.6 : 0.9));
  });
});
