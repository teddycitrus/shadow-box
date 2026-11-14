import { describe, expect, it } from 'vitest';
import { measure } from '../client/src/tracking/calibration.ts';
import { Classifier } from '../client/src/tracking/classifier.ts';
import { KnnModel } from '../client/src/tracking/model.ts';
import { synthFrame, type SynthState } from '../client/src/tracking/synthetic.ts';
import { Teacher, handFor, modelFrom } from '../client/src/tracking/teach.ts';
import { NO_DEFENSE, type DefenseState, type Punch, type PunchType, type Target } from '../shared/types.ts';

const DT = 1000 / 30;
const GUARD: DefenseState = { ...NO_DEFENSE, guard: true };
const cal = measure(Array.from({ length: 15 }, (_, i) => synthFrame({ t: i * DT, defense: GUARD })));

/** Plays the whole guided calibration with synthetic moves and returns the trained profile. */
function teach() {
  const teacher = new Teacher('orthodox');
  const c = new Classifier(cal);
  c.model = () => null;
  c.onSegment = (s) => teacher.segment(s);
  let t = 0;
  let punchAt = 0;
  let stepIndex = -1;
  let stepStart = 0;
  for (let guard = 0; guard < 20000 && !teacher.done; guard++) {
    const step = teacher.steps[Math.min(stepIndex < 0 ? 0 : stepIndex, teacher.steps.length - 1)];
    let st: SynthState = { t, defense: NO_DEFENSE };
    if (step.kind === 'punch') {
      if (t - punchAt > 800) punchAt = t;
      st = { t, defense: NO_DEFENSE, punch: { type: step.type!, hand: handFor(step.type!, 'orthodox'), target: step.target!, startT: punchAt + 100, windupMs: 60 } };
    } else {
      const on = t - stepStart > 300 && t - stepStart < 1500;
      st = { t, defense: { ...NO_DEFENSE, duck: on && step.kind === 'duck', slip: on && step.kind === 'slipLeft' ? 'left' : on && step.kind === 'slipRight' ? 'right' : 'none' } };
    }
    const out = c.update(synthFrame(st));
    const s = teacher.update(t, out.features);
    if (s.index !== stepIndex) {
      stepIndex = s.index;
      stepStart = t;
      punchAt = t;
    }
    t += DT;
  }
  return { profile: teacher.profile(), t };
}

describe('guided calibration', () => {
  const { profile, t } = teach();

  it('finishes within about a minute', () => {
    expect(t).toBeLessThan(65_000);
  });

  it('learns every punch it prompted', () => {
    expect(profile.learned).toHaveLength(8);
    expect(profile.samples.filter((s) => s.label !== 'none').length).toBe(24);
    expect(profile.bodySplit).toBeGreaterThan(-1);
  });

  it('sets duck and slip thresholds from what the player showed', () => {
    expect(profile.defense.duck).toBeGreaterThan(0.3);
    expect(profile.defense.slipLeft).toBeGreaterThan(0.25);
    expect(profile.defense.slipRight).toBeGreaterThan(0.25);
  });

  it('the trained model classifies fresh punches correctly', () => {
    const model = modelFrom(profile)!;
    expect(model).toBeInstanceOf(KnnModel);
    const cases: [PunchType, Target][] = [
      ['jab', 'head'], ['cross', 'head'], ['leftHook', 'head'], ['rightHook', 'head'],
      ['leftUppercut', 'head'], ['rightUppercut', 'head'], ['jab', 'body'], ['cross', 'body'],
    ];
    for (const [type, target] of cases) {
      const c = new Classifier(cal);
      c.model = (s) => model.decide(s, 'orthodox', profile.bodySplit);
      const got: Punch[] = [];
      for (let k = 0; k < 900; k += DT) {
        got.push(...c.update(synthFrame({ t: k, defense: NO_DEFENSE, punch: { type, hand: handFor(type, 'orthodox'), target, startT: 100, windupMs: 80 } })).punches);
      }
      expect(got.map((p) => `${p.type}:${p.target}`), `${type} ${target}`).toEqual([`${type}:${target}`]);
    }
  });
});
