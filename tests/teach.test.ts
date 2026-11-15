import { describe, expect, it } from 'vitest';
import { measure } from '../client/src/tracking/calibration.ts';
import { Classifier, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, type Label } from '../client/src/tracking/model.ts';
import { synthFrame, type SynthState } from '../client/src/tracking/synthetic.ts';
import { REST_STEP_MS, Teacher, handFor, modelFrom, pickReps, pruneOutliers, type TeachStatus } from '../client/src/tracking/teach.ts';
import { CONFIG } from '../client/src/config.ts';
import { NO_DEFENSE, type DefenseState, type Punch, type PunchType, type Target } from '../shared/types.ts';

const DT = 1000 / 30;
const GUARD: DefenseState = { ...NO_DEFENSE, guard: true };
const cal = measure(Array.from({ length: 15 }, (_, i) => synthFrame({ t: i * DT, defense: GUARD })));

/**
 * Plays the whole guided calibration with synthetic moves and returns the trained profile.
 * `misread` makes the first verify attempt of that move a different punch (or the same punch at
 * another target), to check that the move comes back until it is read right.
 */
function teach(misread?: { prompt: string; throw: PunchType; target?: Target }) {
  const teacher = new Teacher('orthodox');
  const c = new Classifier(cal);
  c.model = (s) => teacher.decide(s);
  c.onSegment = (s) => teacher.segment(s);
  c.onDecision = (s, p) => teacher.decision(s, p);
  let t = 0;
  let punchAt = 0;
  let stepKey = '';
  let stepStart = 0;
  let thrown = false;
  let misreadDone = false;
  let throwType: PunchType | null = null;
  let throwTarget: Target = 'body';
  let s: TeachStatus | null = null;
  const results: string[] = [];
  for (let guard = 0; guard < 20000 && !teacher.done; guard++) {
    const step = s?.step ?? null;
    let st: SynthState = { t, defense: NO_DEFENSE };
    if (s?.phase === 'verify') {
      if (step && !s.verify!.result && !thrown) {
        thrown = true;
        punchAt = t + 200;
        const wrong = misread && !misreadDone && step.prompt === misread.prompt;
        if (wrong) misreadDone = true;
        throwType = wrong ? misread!.throw : step.type!;
        throwTarget = wrong ? misread!.target ?? step.target! : step.target!;
      }
      if (s.verify!.result) thrown = false;
      if (throwType) st = { t, defense: NO_DEFENSE, punch: { type: throwType, hand: handFor(throwType, 'orthodox'), target: throwTarget, startT: punchAt, windupMs: 60 } };
    } else if (step?.kind === 'punch') {
      if (t - punchAt > 800) punchAt = t;
      st = { t, defense: NO_DEFENSE, punch: { type: step.type!, hand: handFor(step.type!, 'orthodox'), target: step.target!, startT: punchAt + 100, windupMs: 60 } };
    } else if (step?.kind === 'rest') {
      // Guard up and down, then dropping the hands (gassed pose) and raising them again, ending at guard.
      const k = Math.floor((t - stepStart) / 900) % 2 === 1;
      st = step.id === 'drop' ? { t, defense: NO_DEFENSE, gassed: k && t - stepStart < REST_STEP_MS - 1500 } : { t, defense: k ? GUARD : NO_DEFENSE };
    } else if (step) {
      const on = t - stepStart > 300 && t - stepStart < 1500;
      st = { t, defense: { ...NO_DEFENSE, duck: on && step.kind === 'duck', slip: on && step.kind === 'slipLeft' ? 'left' : on && step.kind === 'slipRight' ? 'right' : 'none' } };
    }
    const out = c.update(synthFrame(st));
    s = teacher.update(t, out.features);
    if (s.verify?.result && results.at(-1) !== s.verify.result.text) results.push(s.verify.result.text);
    const key = `${s.phase}:${s.index}`;
    if (key !== stepKey) {
      stepKey = key;
      stepStart = t;
      punchAt = t;
    }
    t += DT;
  }
  return { profile: teacher.profile(), t, results, done: teacher.done };
}

describe('guided calibration', () => {
  const { profile, t, done } = teach();

  it('finishes in a few minutes', () => {
    expect(done).toBe(true);
    expect(t).toBeLessThan(180_000);
  });

  it('learns every punch it prompted, with all of its reps', () => {
    expect(profile.version).toBe(5);
    expect(profile.learned).toEqual([
      'jab-body', 'cross-body', 'leftHook-body', 'rightHook-body', 'leftUppercut-body', 'rightUppercut-body', 'jab-head', 'cross-head',
    ]);
    expect(profile.samples.filter((s) => s.label !== 'none').length).toBeGreaterThanOrEqual(8 * CONFIG.model.repsPerMove);
    for (const hand of ['left', 'right'] as const) {
      expect(profile.headLine[hand]).toBeGreaterThanOrEqual(CONFIG.punch.headLineMin);
      expect(profile.headLine[hand]).toBeLessThanOrEqual(CONFIG.punch.headLineMax);
    }
  });

  it('verifies every move with the player\'s own model', () => {
    expect(profile.scores).toHaveLength(8);
    for (const s of profile.scores) expect(s.ok, s.prompt).toBeGreaterThanOrEqual(CONFIG.model.verifyPasses);
  });

  it('sets duck and slip thresholds from what the player showed', () => {
    expect(profile.defense.duck).toBeGreaterThan(0.3);
    expect(profile.defense.slipLeft).toBeGreaterThan(0.25);
    expect(profile.defense.slipRight).toBeGreaterThan(0.25);
  });

  it('the trained model classifies fresh punches correctly', () => {
    const model = modelFrom(profile)!;
    expect(model).toBeInstanceOf(KnnModel);
    // Every taught move: all six to the body, jab and cross to the head.
    const cases: [PunchType, Target][] = [
      ['jab', 'body'], ['cross', 'body'], ['leftHook', 'body'], ['rightHook', 'body'], ['leftUppercut', 'body'], ['rightUppercut', 'body'],
      ['jab', 'head'], ['cross', 'head'],
    ];
    for (const [type, target] of cases) {
      const c = new Classifier(cal);
      c.model = (s) => model.decide(s, 'orthodox', profile.headLine);
      const got: Punch[] = [];
      for (let k = 0; k < 900; k += DT) {
        got.push(...c.update(synthFrame({ t: k, defense: NO_DEFENSE, punch: { type, hand: handFor(type, 'orthodox'), target, startT: 100, windupMs: 80 } })).punches);
      }
      expect(got.map((p) => `${p.type}:${p.target}`), `${type} ${target}`).toEqual([`${type}:${target}`]);
    }
  });

  it('brings a misread move back and teaches it until it is read right', () => {
    const r = teach({ prompt: 'Left hook', throw: 'leftUppercut' });
    expect(r.done).toBe(true);
    expect(r.results).toContain('Read as Left uppercut');
    const hook = r.profile.scores.find((s) => s.prompt === 'Left hook')!;
    expect(hook.tries).toBeGreaterThan(hook.ok);
    expect(hook.ok).toBeGreaterThanOrEqual(CONFIG.model.verifyPasses);
  });

  it('says when a head shot was read as a body shot', () => {
    const r = teach({ prompt: 'Jab to the head', throw: 'jab', target: 'body' });
    expect(r.done).toBe(true);
    expect(r.results).toContain('Read as body. Bring your fist up to eye level');
    const jab = r.profile.scores.find((s) => s.prompt === 'Jab to the head')!;
    expect(jab.wrongTarget).toBe(1);
    expect(jab.ok).toBeGreaterThanOrEqual(CONFIG.model.verifyPasses);
  });

  it('steps aim at the chest by default and only the head steps go high', () => {
    const r = teach();
    const steps = new Teacher('orthodox').steps.filter((s) => s.kind === 'punch');
    expect(steps.filter((s) => s.target === 'head').map((s) => s.prompt)).toEqual(['Jab to the head', 'Cross to the head']);
    for (const s of steps) expect(s.how).toContain(s.target === 'head' ? 'eye level' : 'chest');
    expect(r.done).toBe(true);
  });
});

/** A bare segment for the rep-picking and outlier helpers. */
function seg(hand: 'left' | 'right', t: number, travel: number, dx = 0, dy = travel): Segment {
  const p = (x: number, y: number, tt: number) => ({ t: tt, x, y, ex: x - 0.3, ey: y - 0.5, s: 1 });
  const start = p(-0.5, 0, t - 150), peak = p(-0.5 + dx, dy, t);
  return {
    hand, startT: t - 150, peakT: t, endT: t + 60, dIn: dx, rise: dy, fwd: 0, forward: 0, elbow: 150, startElbow: 90, startY: 0, peakY: -dy,
    chinY: -0.3, startHead: 0.6, peakHead: 1, scaleGain: 0, travel, maxSpeed: 8, maxUp: 0, reach: 1, startReach: 0.7, fromGuard: true,
    start, peak, nose: { x: 0.3, y: 0.4 }, path: [start, peak], other: 0, otherRise: 0, headDrop: 0,
  };
}

describe('rep picking and outliers', () => {
  it('takes the biggest motion of each attempt and skips fidgets', () => {
    const windup = seg('left', 1000, 0.6);
    const punch = seg('left', 1250, 1.4);
    const fidget = seg('left', 2500, 0.56);
    const other = seg('right', 3000, 1.2);
    const second = seg('left', 3500, 1.3);
    const { reps, rest } = pickReps([windup, punch, fidget, other, second], 'left', 5);
    expect(reps).toEqual([punch, second]);
    expect(rest).toEqual([windup, fidget, other]);
  });

  it('caps the reps at the number asked for', () => {
    const segs = [1, 2, 3, 4].map((i) => seg('left', i * 1000, 1.2));
    expect(pickReps(segs, 'left', 3).reps).toHaveLength(3);
  });

  it('drops a rep that is far from the rest of its move', () => {
    const taught: { seg: Segment; label: Label }[] = [
      ...[0, 1, 2, 3, 4].map((i) => ({ seg: seg('left', i * 1000, 1.2 + i * 0.02, 0.1, 1.2), label: 'straight' as Label })),
      ...[0, 1, 2].map((i) => ({ seg: seg('left', 9000 + i * 1000, 1.5 + i * 0.02, 1.4, 0.3), label: 'hook' as Label })),
    ];
    const odd = { seg: seg('left', 20000, 1.3, -1.6, -2.5), label: 'straight' as Label };
    const kept = pruneOutliers([...taught, odd]);
    expect(kept).not.toContain(odd);
    expect(kept).toHaveLength(taught.length);
  });
});
