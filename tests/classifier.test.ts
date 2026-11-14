import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Calibrator, framingCheck, measure } from '../client/src/tracking/calibration.ts';
import { Classifier } from '../client/src/tracking/classifier.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { synthFrame, type SynthState } from '../client/src/tracking/synthetic.ts';
import { NO_DEFENSE, type DefenseState, type Punch, type PunchType, type Stance, type Target } from '../shared/types.ts';

const GUARD: DefenseState = { ...NO_DEFENSE, guard: true };
const FPS = 30;

function guardFrames(ms: number, t0 = 0): PoseFrame[] {
  const out: PoseFrame[] = [];
  for (let t = t0; t < t0 + ms; t += 1000 / FPS) out.push(synthFrame({ t, defense: GUARD }));
  return out;
}

const cal = measure(guardFrames(500));

function run(states: SynthState[], stance: Stance = 'orthodox') {
  const c = new Classifier(cal);
  c.stance = stance;
  const punches: Punch[] = [];
  const defenses: DefenseState[] = [];
  for (const s of states) {
    const out = c.update(synthFrame(s));
    punches.push(...out.punches);
    defenses.push(out.defense);
  }
  return { punches, defenses };
}

function throwSeq(type: PunchType, hand: 'left' | 'right', target: Target, ms = 900): SynthState[] {
  const out: SynthState[] = [];
  for (let t = 0; t < ms; t += 1000 / FPS) {
    out.push({ t, defense: NO_DEFENSE, punch: { type, hand, target, startT: 100, windupMs: 80 } });
  }
  return out;
}

describe('calibration and framing', () => {
  it('measures sensible body proportions', () => {
    expect(cal.swWorld).toBeCloseTo(0.38, 2);
    expect(cal.armWorld).toBeCloseTo(0.55, 1);
    expect(cal.swImg).toBeGreaterThan(0.2);
  });

  it('completes after 2 s of a held guard', () => {
    const c = new Calibrator();
    let last = c.update(null);
    expect(last).toMatchObject({ stage: 'framing', message: 'Step into view' });
    for (const f of guardFrames(2100)) last = c.update(f);
    expect(last.stage).toBe('done');
  });

  it('asks to move closer or step back', () => {
    const f = synthFrame({ t: 0, defense: GUARD });
    const scaled = (k: number): PoseFrame => ({ ...f, img: f.img.map((p) => ({ ...p, x: 0.9 + (p.x - 0.9) * k, y: 0.5 + (p.y - 0.5) * k })) });
    expect(framingCheck(f)).toBeNull();
    expect(framingCheck(scaled(0.4))).toBe('Move closer');
    expect(framingCheck(scaled(2))).toBe('Step back');
    const cut = { ...f, img: f.img.map((p, i) => (i === 0 ? { ...p, v: 0.1 } : p)) };
    expect(framingCheck(cut)).toBe('Raise the camera');
  });
});

describe('punch classification', () => {
  const cases: [PunchType, 'left' | 'right', Target][] = [
    ['jab', 'left', 'head'],
    ['jab', 'left', 'body'],
    ['cross', 'right', 'head'],
    ['cross', 'right', 'body'],
    ['leftHook', 'left', 'head'],
    ['rightHook', 'right', 'head'],
    ['leftHook', 'left', 'body'],
    ['rightHook', 'right', 'body'],
    ['leftUppercut', 'left', 'head'],
    ['rightUppercut', 'right', 'head'],
  ];
  for (const [type, hand, target] of cases) {
    it(`detects a ${target} ${type} exactly once`, () => {
      const { punches } = run(throwSeq(type, hand, target));
      expect(punches).toEqual([{ type, hand, target, at: expect.any(Number) }]);
    });
  }

  it('maps the lead hand to jab for southpaws', () => {
    const { punches } = run(throwSeq('jab', 'right', 'head'), 'southpaw');
    expect(punches.map((p) => p.type)).toEqual(['jab']);
  });

  it('fires near the peak extension', () => {
    const c = new Classifier(cal);
    let at = 0;
    for (const s of throwSeq('cross', 'right', 'head')) at = c.update(synthFrame(s)).punches[0]?.at ?? at;
    expect(at).toBeGreaterThan(100 + 80 + 90);
    expect(at).toBeLessThan(100 + 80 + 140 + 80);
  });

  it('does not fire when standing still in guard', () => {
    const { punches } = run(guardFrames(2000).map((f) => ({ t: f.t, defense: GUARD })));
    expect(punches).toEqual([]);
  });

  it('locks the hand out until it returns to guard and the cooldown passes', () => {
    const seq: SynthState[] = [];
    for (let t = 0; t < 1400; t += 1000 / FPS) {
      const startT = t < 700 ? 100 : 700;
      seq.push({ t, defense: NO_DEFENSE, punch: { type: 'jab', hand: 'left', target: 'head', startT, windupMs: 0 } });
    }
    expect(run(seq).punches).toHaveLength(2);
  });
});

describe('defense', () => {
  const hold = (def: DefenseState) => run(Array.from({ length: 20 }, (_, i) => ({ t: i * 33, defense: def }))).defenses.at(-1)!;
  it('detects guard', () => expect(hold(GUARD)).toEqual(GUARD));
  it('detects duck', () => expect(hold({ ...NO_DEFENSE, duck: true }).duck).toBe(true));
  it('detects slips by side', () => {
    expect(hold({ ...NO_DEFENSE, slip: 'left' }).slip).toBe('left');
    expect(hold({ ...NO_DEFENSE, slip: 'right' }).slip).toBe('right');
  });
  it('hands down is no guard', () => expect(hold(NO_DEFENSE).guard).toBe(false));
});

describe('recorded fixtures', () => {
  const dir = 'tests/fixtures';
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  it.skipIf(files.length === 0)('replays recorded sessions with their labelled punches', () => {
    for (const file of files) {
      const rec = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as { calibration: typeof cal; frames: PoseFrame[]; expected?: PunchType[] };
      if (!rec.expected) continue;
      const c = new Classifier(rec.calibration);
      const got = rec.frames.flatMap((f) => c.update(f).punches.map((p) => p.type));
      expect(got, file).toEqual(rec.expected);
    }
  });
});
