// Shared by the evaluation scripts and tests/classifier.test.ts: labels the motion segments in
// recorded clips from the hand-checked reps in eval-gt.ts and scores the per-player k-NN as if
// trained by the guided calibration.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import type { PunchType, Stance, Target } from '../shared/types.ts';
import type { Calibration } from '../client/src/tracking/calibration.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { KnnModel, headHeight, headLineFrom, kindOf, vector, type Label } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { FIXTURE_REPS } from './eval-gt.ts';

export interface Recording {
  calibration: Calibration | null;
  frames: PoseFrame[];
  stance?: Stance;
  expected?: PunchType[];
  expectedTarget?: Target;
  defense?: 'guard' | 'duck' | 'slipLeft' | 'slipRight';
  reps?: number;
}

export interface LabelledSegment {
  clip: string;
  seg: Segment;
  label: Label;
  target: Target;
}

export function loadFixtures(dir = 'tests/fixtures'): { file: string; rec: Recording }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, rec: JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Recording }))
    .filter(({ rec }) => rec.calibration && rec.frames.length);
}

/** Every motion segment of a recording, replayed through the live classifier with no model. */
export function segmentsOf(rec: Recording, frames = rec.frames): Segment[] {
  const c = new Classifier(rec.calibration!);
  c.stance = rec.stance ?? 'orthodox';
  const segs: Segment[] = [];
  c.onSegment = (s) => segs.push(s);
  c.model = () => null;
  for (const f of frames) c.update(f);
  return segs;
}

/** The hand-checked reps of a fixture clip, by its file name (empty for defense clips). */
export function fixtureReps(file: string): number[] {
  return FIXTURE_REPS[file.replace(/^(orthodox|southpaw)-/, '').replace('.json', '')] ?? [];
}

/**
 * Every gated motion in a clip. Each hand-checked rep labels the motion of the punching hand
 * whose peak is closest to it (within 350 ms); every other motion is a non-punch.
 */
export function labelledSegments(file: string, rec: Recording): LabelledSegment[] {
  const out = segmentsOf(rec).filter(passesGate).map((seg): LabelledSegment => ({ clip: file, seg, label: 'none', target: 'head' }));
  const type = rec.expected?.[0];
  if (!type) return out;
  const hand = handFor(type, rec.stance ?? 'orthodox');
  const t0 = rec.frames[0].t;
  for (const t of fixtureReps(file)) {
    const at = t0 + t * 1000;
    const best = out
      .filter((s) => s.seg.hand === hand && s.label === 'none' && Math.abs(s.seg.peakT - at) <= 350)
      .sort((a, b) => Math.abs(a.seg.peakT - at) - Math.abs(b.seg.peakT - at))[0];
    if (best) Object.assign(best, { label: kindOf(type), target: rec.expectedTarget ?? 'head' });
  }
  return out;
}

export interface Score {
  punches: number;
  exact: number;
  nonPunches: number;
  falseFires: number;
}

/**
 * Simulates the guided calibration: the first `shots` reps of each clip (in time order) train the
 * model together with the non-punch motions before them; everything after is the test set.
 * A test punch is exact when the punch type and the head/body target are both right.
 */
export function scoreCalibration(all: LabelledSegment[], shots = 3): Score {
  const train: LabelledSegment[] = [];
  const test: LabelledSegment[] = [];
  for (const clip of new Set(all.map((s) => s.clip))) {
    const segs = all.filter((s) => s.clip === clip).sort((a, b) => a.seg.peakT - b.seg.peakT);
    const reps = segs.filter((s) => s.label !== 'none');
    const cut = reps.length > shots ? reps[shots - 1].seg.endT : reps.length ? Infinity : segs[Math.floor(segs.length / 2)]?.seg.endT ?? Infinity;
    for (const s of segs) (s.seg.endT <= cut ? train : test).push(s);
  }
  const m = new KnnModel(train.map((s) => ({ hand: s.seg.hand, label: s.label, v: vector(s.seg) })));
  const line = headLineFrom(train.filter((s) => s.label === 'straight').map((s) => ({ hand: s.seg.hand, h: headHeight(s.seg), target: s.target })));
  const score: Score = { punches: 0, exact: 0, nonPunches: 0, falseFires: 0 };
  for (const s of test) {
    const p = m.decide(s.seg, 'orthodox', line);
    if (s.label === 'none') {
      score.nonPunches++;
      if (p) score.falseFires++;
    } else {
      score.punches++;
      if (p && kindOf(p.type) === s.label && p.target === s.target) score.exact++;
    }
  }
  return score;
}
