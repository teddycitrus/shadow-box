import { describe, expect, it } from 'vitest';
import { measure } from '../client/src/tracking/calibration.ts';
import { Classifier, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, type Label } from '../client/src/tracking/model.ts';
import { synthFrame, type SynthState } from '../client/src/tracking/synthetic.ts';
import { REST_STEP_MS, Teacher, comboTypes, handFor, modelFrom, pickCombos, pickReps, pruneOutliers, type TeachStatus } from '../client/src/tracking/teach.ts';
import { CONFIG } from '../client/src/config.ts';
import { NO_DEFENSE, type DefenseState, type Punch, type PunchType, type Target } from '../shared/types.ts';

const DT = 1000 / 30;
const GUARD: DefenseState = { ...NO_DEFENSE, guard: true };
const cal = measure(Array.from({ length: 15 }, (_, i) => synthFrame({ t: i * DT, defense: GUARD })));

/** A jab, cross, left hook combo starting at t0, one punch every 480 ms (each takes 420 ms). */
function comboState(t: number, t0: number): SynthState {
  const types = comboTypes('orthodox');
  const i = Math.max(0, Math.min(types.length - 1, Math.floor((t - t0 - 100) / 480)));
  const type = types[i];
  return { t, defense: NO_DEFENSE, punch: { type, hand: handFor(type, 'orthodox'), target: 'head', startT: t0 + 100 + i * 480, windupMs: 0 } };
}

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
  /** Per learn step: time spent on it and the reps it had counted. */
  const stepTimes = new Map<string, { ms: number; reps: number }>();
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
    } else if (step?.kind === 'combo') {
      st = comboState(t, punchAt);
      if (t - punchAt > 2000) punchAt = t;
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
    if (s.phase === 'learn' && s.step) stepTimes.set(s.step.id, { ms: (stepTimes.get(s.step.id)?.ms ?? 0) + DT, reps: s.reps });
    if (s.verify?.result && results.at(-1) !== s.verify.result.text) results.push(s.verify.result.text);
    const key = `${s.phase}:${s.index}`;
    if (key !== stepKey) {
      stepKey = key;
      stepStart = t;
      punchAt = t;
    }
    t += DT;
  }
  return { profile: teacher.profile(), t, results, done: teacher.done, stepTimes };
}

describe('guided calibration', () => {
  const { profile, t, done, stepTimes } = teach();

  it('finishes in a few minutes', () => {
    expect(done).toBe(true);
    expect(t).toBeLessThan(240_000);
  });

  it('learns every punch it prompted, with all of its reps', () => {
    expect(profile.version).toBe(7);
    expect(profile.learned).toEqual([
      'jab-head', 'cross-head', 'leftHook-head', 'rightHook-head', 'leftUppercut-head', 'rightUppercut-head', 'jab-body', 'cross-body',
    ]);
    // The normal reps, a fast pass of every standing punch, and the three punches of each combo.
    const taught = 8 * CONFIG.model.repsPerMove + 6 * CONFIG.model.fastReps + 3 * CONFIG.model.comboReps;
    expect(profile.samples.filter((s) => s.label !== 'none').length).toBeGreaterThanOrEqual(taught - 4);
  });

  it('collects every fast rep and combo without waiting for the step to time out', () => {
    const steps = new Teacher('orthodox').steps.filter((s) => s.fast || s.kind === 'combo');
    expect(steps).toHaveLength(7);
    for (const s of steps) {
      const got = stepTimes.get(s.id)!;
      expect(got.reps, s.id).toBe(s.reps);
      expect(got.ms, s.id).toBeLessThan(CONFIG.model.moveTimeoutMs);
    }
  });

  it('sets the body dip between standing and the crouch', () => {
    expect(profile.bodyDip).toBeGreaterThanOrEqual(CONFIG.punch.bodyDipMin);
    expect(profile.bodyDip).toBeLessThanOrEqual(CONFIG.punch.bodyDipMax);
    // Clearly below the dip of a synthetic crouched punch at its peak (about 0.6 sw).
    expect(profile.bodyDip).toBeLessThan(0.5);
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
    // Every taught move (all six standing, jab and cross crouched), and crouched hooks and
    // uppercuts, which were never taught crouched but still read as body shots from the dip.
    const cases: [PunchType, Target][] = [
      ['jab', 'head'], ['cross', 'head'], ['leftHook', 'head'], ['rightHook', 'head'], ['leftUppercut', 'head'], ['rightUppercut', 'head'],
      ['jab', 'body'], ['cross', 'body'], ['leftHook', 'body'], ['rightHook', 'body'], ['leftUppercut', 'body'], ['rightUppercut', 'body'],
    ];
    for (const [type, target] of cases) {
      const c = new Classifier(cal);
      c.model = (s) => model.decide(s, 'orthodox', profile.bodyDip);
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
    const r = teach({ prompt: 'Jab', throw: 'jab', target: 'body' });
    expect(r.done).toBe(true);
    expect(r.results).toContain('Read as body. Stand tall for a head shot');
    const jab = r.profile.scores.find((s) => s.prompt === 'Jab')!;
    expect(jab.wrongTarget).toBe(1);
    expect(jab.ok).toBeGreaterThanOrEqual(CONFIG.model.verifyPasses);
  });

  it('says when a body shot was thrown standing', () => {
    const r = teach({ prompt: 'Crouch and cross', throw: 'cross', target: 'head' });
    expect(r.done).toBe(true);
    expect(r.results).toContain('Read as head. Crouch lower for a body shot');
    const cross = r.profile.scores.find((s) => s.prompt === 'Crouch and cross')!;
    expect(cross.wrongTarget).toBe(1);
    expect(cross.ok).toBeGreaterThanOrEqual(CONFIG.model.verifyPasses);
  });

  it('teaches the duck first, every punch standing then fast, then jab and cross crouched, then a combo', () => {
    const all = new Teacher('orthodox').steps;
    expect(all.findIndex((s) => s.kind === 'duck')).toBeLessThan(all.findIndex((s) => s.kind === 'punch'));
    const steps = all.filter((s) => s.kind === 'punch' && !s.fast);
    expect(steps.filter((s) => s.target === 'body').map((s) => s.prompt)).toEqual(['Crouch and jab', 'Crouch and cross']);
    expect(steps.filter((s) => s.target === 'head')).toHaveLength(6);
    for (const s of steps) {
      expect(s.how).toContain(s.target === 'head' ? 'standing tall' : 'like a duck');
      expect(s.how).toContain(`${CONFIG.model.repsPerMove} times`);
    }
    // Each standing punch is followed right away by the same punch thrown fast.
    for (const s of steps.filter((x) => x.target === 'head')) {
      const next = all[all.indexOf(s) + 1];
      expect(next).toMatchObject({ kind: 'punch', type: s.type, target: 'head', fast: true, reps: CONFIG.model.fastReps });
      expect(next.how).toContain(`${CONFIG.model.fastReps} times`);
    }
    expect(all.at(-1)).toMatchObject({ kind: 'combo', reps: CONFIG.model.comboReps });
  });

  it('verifies only the normal moves, not the fast passes', () => {
    expect(profile.scores.map((s) => s.id)).not.toContain('jab-head-fast');
  });
});

/** A bare segment for the rep-picking and outlier helpers. */
function seg(hand: 'left' | 'right', t: number, travel: number, dx = 0, dy = travel): Segment {
  const p = (x: number, y: number, tt: number) => ({ t: tt, x, y, ex: x - 0.3, ey: y - 0.5, s: 1 });
  const start = p(-0.5, 0, t - 150), peak = p(-0.5 + dx, dy, t);
  return {
    hand, startT: t - 150, peakT: t, endT: t + 60, dIn: dx, rise: dy, fwd: 0, forward: 0, elbow: 150, startElbow: 90, startY: 0, peakY: -dy,
    chinY: -0.3, startHead: 0.6, peakHead: 1, scaleGain: 0, travel, maxSpeed: 8, maxUp: 0, reach: 1, startReach: 0.7, fromGuard: true,
    start, peak, nose: { x: 0.3, y: 0.4 }, path: [start, peak], other: 0, otherRise: 0, headDrop: 0, dip: 0,
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

  it('keeps fast reps apart when they follow each other closely', () => {
    // Back-to-back fast jabs: each motion starts 120 ms after the previous one ended.
    const segs = [0, 1, 2].map((i) => seg('left', 1000 + i * 330, 1.2));
    expect(pickReps(segs, 'left', 3).reps).toHaveLength(1);
    expect(pickReps(segs, 'left', 3, CONFIG.model.fastAttemptGapMs).reps).toEqual(segs);
  });

  it('matches jab, cross and hook in each combo and skips incomplete ones', () => {
    const combo = (t: number) => [seg('left', t, 1.3), seg('right', t + 350, 1.4), seg('left', t + 700, 1.5, 1.4, 0.4)];
    const a = combo(1000), b = combo(4000);
    // A fidget of the lead hand before the jab, and an attempt with no cross.
    const fidget = seg('left', 3500, 0.5);
    const broken = [seg('left', 8000, 1.3), seg('left', 8500, 1.5)];
    expect(pickCombos([...a, fidget, ...b, ...broken], 'orthodox')).toEqual([a, b]);
    // Southpaw: the jab and hook are thrown with the right hand.
    const sp = [seg('right', 1000, 1.3), seg('left', 1350, 1.4), seg('right', 1700, 1.5)];
    expect(pickCombos(sp, 'southpaw')).toEqual([sp]);
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
