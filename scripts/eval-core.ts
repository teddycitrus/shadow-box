// Shared by scripts/eval-model.ts and tests/classifier.test.ts: labels the motion segments in
// recorded clips and scores the per-player k-NN as if trained by the guided calibration.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import type { PunchType, Stance, Target } from '../shared/types.ts';
import type { Calibration } from '../client/src/tracking/calibration.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { KnnModel, vector, type Label, type Sample } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';

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
}

export function loadFixtures(dir = 'tests/fixtures'): { file: string; rec: Recording }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({ file, rec: JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Recording }))
    .filter(({ rec }) => rec.calibration && rec.frames.length);
}

/** Every gated motion in a clip; the strongest `reps` motions of the expected hand get the move's label. */
export function labelledSegments(file: string, rec: Recording): LabelledSegment[] {
  const c = new Classifier(rec.calibration!);
  c.stance = rec.stance ?? 'orthodox';
  const segs: Segment[] = [];
  c.onSegment = (s) => segs.push(s);
  c.model = () => null;
  for (const f of rec.frames) c.update(f);
  const out = segs.filter(passesGate).map((seg): LabelledSegment => ({ clip: file, seg, label: 'none' }));
  const type = rec.expected?.[0];
  if (type) {
    const hand = handFor(type, rec.stance ?? 'orthodox');
    const ranked = out.filter((s) => s.seg.hand === hand).sort((a, b) => b.seg.maxSpeed * b.seg.travel - a.seg.maxSpeed * a.seg.travel);
    const picked: LabelledSegment[] = [];
    for (const s of ranked) {
      if (picked.length >= (rec.reps ?? rec.expected!.length)) break;
      if (picked.every((p) => Math.abs(p.seg.peakT - s.seg.peakT) > 450)) picked.push(s);
    }
    for (const s of picked) s.label = `${type}:${rec.expectedTarget ?? 'head'}` as Label;
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
 */
export function scoreCalibration(all: LabelledSegment[], shots = 3, k = 3): Score {
  const train: LabelledSegment[] = [];
  const test: LabelledSegment[] = [];
  for (const clip of new Set(all.map((s) => s.clip))) {
    const segs = all.filter((s) => s.clip === clip).sort((a, b) => a.seg.peakT - b.seg.peakT);
    const reps = segs.filter((s) => s.label !== 'none');
    const cut = reps.length > shots ? reps[shots - 1].seg.endT : reps.length ? Infinity : segs[Math.floor(segs.length / 2)]?.seg.endT ?? Infinity;
    for (const s of segs) (s.seg.endT <= cut ? train : test).push(s);
  }
  const sample = (s: LabelledSegment): Sample => ({ hand: s.seg.hand, label: s.label, v: vector(s.seg) });
  const m = new KnnModel(train.map(sample), k);
  const score: Score = { punches: 0, exact: 0, nonPunches: 0, falseFires: 0 };
  for (const s of test) {
    const p = m.predict(s.seg.hand, vector(s.seg)).label;
    if (s.label === 'none') {
      score.nonPunches++;
      if (p !== 'none') score.falseFires++;
    } else {
      score.punches++;
      if (p === s.label) score.exact++;
    }
  }
  return score;
}
