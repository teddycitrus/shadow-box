import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { Segment } from './classifier.ts';

/**
 * The model learns the punch shape per hand only; the hand and stance give the exact punch, and
 * height gives head or body. `none` marks motions that are not punches (retracting, adjusting).
 */
export type Kind = 'straight' | 'hook' | 'uppercut';
export type Label = Kind | 'none';

export function kindOf(type: PunchType): Kind {
  return type === 'jab' || type === 'cross' ? 'straight' : type.endsWith('Hook') ? 'hook' : 'uppercut';
}

export function punchOf(kind: Kind, hand: Hand, stance: Stance): PunchType {
  if (kind === 'straight') return hand === (stance === 'orthodox' ? 'left' : 'right') ? 'jab' : 'cross';
  return `${hand}${kind === 'hook' ? 'Hook' : 'Uppercut'}` as PunchType;
}

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
  return p ? kindOf(p.type) : 'none';
}

/**
 * Per-player k-nearest-neighbours over standardized segment features, trained from a short
 * guided calibration. Few examples per move, so a lazy learner beats anything with weights.
 */
export class KnnModel {
  private mean: number[] = [];
  private std: number[] = [];
  private data: Sample[];
  /** Motions further than this from every taught punch are rejected as non-punches. */
  readonly radius: number;

  constructor(samples: Sample[], private k = 3, rejectScale = CONFIG.model.rejectScale) {
    const n = samples[0]?.v.length ?? 0;
    for (let i = 0; i < n; i++) {
      const col = samples.map((s) => s.v[i]);
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      const sd = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1;
      this.mean.push(m);
      this.std.push(sd);
    }
    this.data = samples.map((s) => ({ ...s, v: this.norm(s.v) }));
    const d = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]));
    const nn = this.data
      .filter((s) => s.label !== 'none')
      .map((s) => Math.min(...this.data.filter((o) => o !== s && o.label === s.label).map((o) => d(o.v, s.v))))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    this.radius = nn.length ? Math.max(3.5, nn[Math.floor(nn.length / 2)] * rejectScale) : Infinity;
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
    const [best] = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    const nearestOfBest = near.find((x) => x.s.label === best)!.d;
    const label: Label = best !== 'none' && nearestOfBest > this.radius ? 'none' : best;
    return { label, votes: near.filter((x) => x.s.label === best).length, dist: nearestOfBest };
  }

  /**
   * Classifier hook: a punch, null for a non-punch, or undefined to defer to the rules.
   * `bodySplit` is the wrist height (sw below the shoulder line) that separates body from head.
   */
  decide(s: Segment, stance: Stance, bodySplit: number): Punch | null | undefined {
    const { label } = this.predict(s.hand, vector(s));
    if (label === 'none') return null;
    const target: Target = label !== 'uppercut' && s.peakY > bodySplit ? 'body' : 'head';
    return { type: punchOf(label, s.hand, stance), hand: s.hand, target };
  }
}
