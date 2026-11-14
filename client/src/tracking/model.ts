import type { Hand, Punch, PunchType, Target } from '../../../shared/types.ts';
import type { Segment } from './classifier.ts';

/** `none` marks motions that are not punches (returning to guard, adjusting, retracting). */
export type Label = `${PunchType}:${Target}` | 'none';

export interface Sample {
  hand: Hand;
  label: Label;
  v: number[];
}

/**
 * Per-segment feature vector for the learned classifier. Elbow angles are left out: MediaPipe's
 * 3D elbow is too noisy to separate punches (it still gates them, see passesGate).
 */
export function vector(s: Segment): number[] {
  return [
    s.dIn, s.rise, s.fwd, s.forward, s.startY, s.peakY, s.startHead, s.peakHead, s.scaleGain,
    s.travel, s.maxSpeed / 5, s.maxUp / 5, s.reach, s.reach - s.startReach, (s.peakT - s.startT) / 150,
  ];
}

export function labelOf(p: Punch | null): Label {
  return p ? `${p.type}:${p.target}` : 'none';
}

/**
 * Per-player k-nearest-neighbours over standardized segment features, trained from a short
 * guided calibration. Few examples per move, so a lazy learner beats anything with weights.
 */
export class KnnModel {
  private mean: number[] = [];
  private std: number[] = [];
  private data: Sample[];

  constructor(samples: Sample[], private k = 3) {
    const n = samples[0]?.v.length ?? 0;
    for (let i = 0; i < n; i++) {
      const col = samples.map((s) => s.v[i]);
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      const sd = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1;
      this.mean.push(m);
      this.std.push(sd);
    }
    this.data = samples.map((s) => ({ ...s, v: this.norm(s.v) }));
  }

  private norm(v: number[]): number[] {
    return v.map((x, i) => (x - this.mean[i]) / this.std[i]);
  }

  predict(hand: Hand, raw: number[]): { label: Label; votes: number; dist: number } {
    const v = this.norm(raw);
    const near = this.data
      .filter((s) => s.hand === hand)
      .map((s) => ({ s, d: Math.hypot(...s.v.map((x, i) => x - v[i])) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.k);
    if (!near.length) return { label: 'none', votes: 0, dist: Infinity };
    const score = new Map<Label, number>();
    for (const { s, d } of near) score.set(s.label, (score.get(s.label) ?? 0) + 1 / (d + 0.3));
    const [label] = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    return { label, votes: near.filter((x) => x.s.label === label).length, dist: near[0].d };
  }

  /** Classifier hook: a punch, null for a non-punch, or undefined to defer to the rules. */
  decide(s: Segment): Punch | null | undefined {
    const { label } = this.predict(s.hand, vector(s));
    if (label === 'none') return null;
    const [type, target] = label.split(':') as [PunchType, Target];
    return { type, hand: s.hand, target };
  }
}
