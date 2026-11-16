import { describe, expect, it } from 'vitest';
import { fixtureReps, labelledSegments, loadFixtures, scoreCalibration, type Recording } from '../scripts/eval-core.ts';
import { Calibrator, framingCheck, measure } from '../client/src/tracking/calibration.ts';
import { Classifier } from '../client/src/tracking/classifier.ts';
import { KnnModel, vector } from '../client/src/tracking/model.ts';
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
    // Stepping toward or away from the camera scales the body (here around the head, so it stays in frame).
    const c = f.img[0];
    const scaled = (k: number): PoseFrame => ({ ...f, img: f.img.map((p) => ({ ...p, x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k })) });
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
    ['leftUppercut', 'left', 'body'],
    ['rightUppercut', 'right', 'body'],
  ];
  for (const [type, hand, target] of cases) {
    it(`detects a ${target} ${type} exactly once`, () => {
      const { punches } = run(throwSeq(type, hand, target));
      expect(punches).toEqual([{ type, hand, target, at: expect.any(Number) }]);
    });
  }

  it('a crouched punch still fires, as a body shot, while the head reads as ducking', () => {
    const { punches, defenses } = run(throwSeq('cross', 'right', 'body'));
    expect(punches.map((p) => p.target)).toEqual(['body']);
    expect(defenses.some((d) => d.duck)).toBe(true);
    // Standing tall: a head shot, and never a duck.
    const tall = run(throwSeq('cross', 'right', 'head'));
    expect(tall.punches.map((p) => p.target)).toEqual(['head']);
    expect(tall.defenses.some((d) => d.duck)).toBe(false);
  });

  it('throws body shots from a held crouch', () => {
    const seq: SynthState[] = [];
    for (let t = 0; t < 1600; t += 1000 / FPS) {
      const startT = t < 800 ? 300 : 900;
      seq.push({ t, defense: { ...NO_DEFENSE, duck: t >= 100 }, punch: { type: 'jab', hand: 'left', target: 'body', startT, windupMs: 0 } });
    }
    const { punches, defenses } = run(seq);
    expect(punches.map((p) => `${p.type}:${p.target}`)).toEqual(['jab:body', 'jab:body']);
    expect(defenses.at(-1)!.duck).toBe(true);
  });

  it('ducking down and back up fires no punch', () => {
    const seq: SynthState[] = [];
    for (let t = 0; t < 3000; t += 1000 / FPS) seq.push({ t, defense: { ...GUARD, duck: Math.floor(t / 500) % 2 === 1 } });
    const { punches, defenses } = run(seq);
    expect(punches).toEqual([]);
    expect(defenses.filter((d, i) => d.duck && !defenses[i - 1]?.duck).length).toBeGreaterThanOrEqual(2);
  });

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

  it('reads every punch thrown twice as fast, exactly once', () => {
    // The synthetic arm plays twice as fast while frames still come at 30 fps: the extension takes
    // 70 ms, about two frames.
    for (const [type, hand, target] of cases) {
      const c = new Classifier(cal);
      const got: Punch[] = [];
      for (const s of throwSeq(type, hand, target)) got.push(...c.update({ ...synthFrame({ ...s, t: s.t * 2 }), t: s.t }).punches);
      expect(got.map((p) => `${p.type}:${p.target}`), `${type} ${target}`).toEqual([`${type}:${target}`]);
    }
  });

  it('fires both punches of a double jab thrown before the hand is back at guard', () => {
    // The second jab leaves while the first is still on its way back; the peaks are 300 ms apart.
    const seq: SynthState[] = [];
    for (let t = 0; t < 1000; t += 1000 / FPS) {
      seq.push({ t, defense: NO_DEFENSE, punch: { type: 'jab', hand: 'left', target: 'head', startT: t < 400 ? 100 : 400, windupMs: 0 } });
    }
    expect(run(seq).punches.map((p) => p.type)).toEqual(['jab', 'jab']);
  });

  it('fires every punch of a fast jab, cross, hook combo', () => {
    const order: [PunchType, 'left' | 'right'][] = [['jab', 'left'], ['cross', 'right'], ['leftHook', 'left']];
    const seq: SynthState[] = [];
    for (let t = 0; t < 1500; t += 1000 / FPS) {
      const i = Math.max(0, Math.min(2, Math.floor((t - 100) / 330)));
      seq.push({ t, defense: NO_DEFENSE, punch: { type: order[i][0], hand: order[i][1], target: 'head', startT: 100 + i * 330, windupMs: 0 } });
    }
    expect(run(seq).punches.map((p) => p.type)).toEqual(['jab', 'cross', 'leftHook']);
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
  const hold = (def: DefenseState, gassed = false) => run(Array.from({ length: 20 }, (_, i) => ({ t: i * 33, defense: def, gassed }))).defenses.at(-1)!;
  it('detects guard', () => expect(hold(GUARD)).toEqual(GUARD));
  it('detects duck', () => expect(hold({ ...NO_DEFENSE, duck: true }).duck).toBe(true));
  it('detects slips by side', () => {
    expect(hold({ ...NO_DEFENSE, slip: 'left' }).slip).toBe('left');
    expect(hold({ ...NO_DEFENSE, slip: 'right' }).slip).toBe('right');
  });
  it('dropped hands are no guard', () => expect(hold(NO_DEFENSE, true).guard).toBe(false));
});

describe('recorded fixtures (tests/fixtures, see FIXTURES.md)', () => {
  const fixtures = loadFixtures();
  const byName = (id: string) => fixtures.find((f) => f.file.endsWith(`-${id}.json`));
  if (!fixtures.length) it.skip('no recorded fixtures yet', () => {});

  const hasPunches = fixtures.some((f) => f.rec.expected?.length);
  const segs = hasPunches ? fixtures.flatMap(({ file, rec }) => labelledSegments(file, rec)) : [];

  it.skipIf(!hasPunches)('finds nearly every hand-checked rep as a motion', () => {
    const reps = fixtures.reduce((n, f) => n + fixtureReps(f.file).length, 0);
    expect(segs.filter((s) => s.label !== 'none').length / reps).toBeGreaterThanOrEqual(0.85);
  });

  it.skipIf(!hasPunches)('the per-player model learns real punches from a 3-rep calibration', () => {
    const s = scoreCalibration(segs, 3);
    expect(s.punches).toBeGreaterThan(0);
    expect(s.exact / s.punches).toBeGreaterThanOrEqual(0.85);
    expect(s.falseFires / Math.max(1, s.nonPunches)).toBeLessThanOrEqual(0.1);
  });

  it.skipIf(!hasPunches)('still reads most punches from a 2-rep calibration', () => {
    const s = scoreCalibration(segs, 2);
    expect(s.exact / s.punches).toBeGreaterThanOrEqual(0.7);
    expect(s.falseFires / Math.max(1, s.nonPunches)).toBeLessThanOrEqual(0.1);
  });

  it.skipIf(!hasPunches)('fires right after the peak instead of waiting for the retraction', () => {
    const m = new KnnModel(segs.map((s) => ({ hand: s.seg.hand, label: s.label, v: vector(s.seg) })));
    const lags: number[] = [];
    for (const { rec } of fixtures.filter((f) => f.rec.expected?.length)) {
      const c = new Classifier(rec.calibration!);
      c.model = (seg) => m.decide(seg, 'orthodox');
      rec.frames.forEach((f, i) => {
        // Frames from the peak to the frame the punch fired on.
        for (const p of c.update(f).punches) lags.push(i - rec.frames.findIndex((g) => g.t === p.at));
      });
    }
    expect(lags.length).toBeGreaterThan(20);
    expect(Math.min(...lags)).toBeGreaterThanOrEqual(0);
    expect(lags.filter((n) => n <= 2).length / lags.length).toBeGreaterThanOrEqual(0.9);
  });

  const onsets = (rec: Recording) => {
    const c = new Classifier(rec.calibration!);
    const n = { guard: 0, duck: 0, slipLeft: 0, slipRight: 0 };
    let prev = { ...n };
    for (const f of rec.frames) {
      const d = c.update(f).defense;
      const cur = { guard: +d.guard, duck: +d.duck, slipLeft: +(d.slip === 'left'), slipRight: +(d.slip === 'right') };
      for (const k of Object.keys(n) as (keyof typeof n)[]) if (cur[k] && !prev[k]) n[k]++;
      prev = cur;
    }
    return n;
  };
  for (const [id, key, min] of [['guard', 'guard', 4], ['duck', 'duck', 4], ['slip-left', 'slipLeft', 3], ['slip-right', 'slipRight', 3]] as const) {
    it.skipIf(!byName(id))(`detects most reps in the ${id} clip`, () => {
      expect(onsets(byName(id)!.rec)[key]).toBeGreaterThanOrEqual(min);
    });
  }
  it.skipIf(!fixtures.length)('rarely ducks by accident while punching', () => {
    const punchClips = fixtures.filter((f) => f.rec.expected?.length);
    const ducks = punchClips.reduce((n, f) => n + onsets(f.rec).duck, 0);
    expect(ducks).toBeLessThanOrEqual(punchClips.length * 0.25);
  });
});
