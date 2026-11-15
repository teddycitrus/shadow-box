import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { PathPoint, Segment } from './classifier.ts';

/**
 * The model learns the punch shape per hand only; the hand and stance give the exact punch, and
 * a learned height line gives head or body. `none` marks motions that are not punches
 * (adjusting the guard, dropping or raising the hands, wind-ups).
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

/** Wrist height at the peak (sw below the shoulder line) past which a straight is a body shot, per hand. */
export type BodySplit = Record<Hand, number>;

export interface Sample {
  hand: Hand;
  label: Label;
  v: number[];
}

/** Point at fraction k of the path's arc length. */
function along(path: PathPoint[], k: number): { x: number; y: number } {
  const len: number[] = [0];
  for (let i = 1; i < path.length; i++) len.push(len[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  const target = len.at(-1)! * k;
  for (let i = 1; i < path.length; i++) {
    if (len[i] >= target) {
      const u = len[i] === len[i - 1] ? 0 : (target - len[i - 1]) / (len[i] - len[i - 1]);
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * u, y: path[i - 1].y + (path[i].y - path[i - 1].y) * u };
    }
  }
  return { x: path.at(-1)!.x, y: path.at(-1)!.y };
}

export const FEATURES = [
  'dx', 'dy', 'peakNoseX', 'peakNoseY', 'forearmX', 'forearmY', 'elbowDx', 'elbowDy', 'scale',
  'bendX', 'bendY', 'windBack', 'duration', 'other', 'startNoseX', 'startNoseY', 'headDrop',
] as const;

/**
 * Per-segment feature vector, all in the hand's own on-screen frame (sw units, x toward the body
 * midline, y up), so both hands share one frame. World depth and the 3D elbow angle are left out:
 * MediaPipe gets them wrong too often on fast punches.
 */
export function vector(s: Segment): number[] {
  const st = s.start, pk = s.peak;
  const dx = pk.x - st.x, dy = pk.y - st.y;
  const n = Math.hypot(dx, dy) || 1;
  const toPeak = s.path.filter((p) => p.t <= pk.t);
  const mid = along(toPeak.length > 1 ? toPeak : [st, pk], 0.5);
  let back = 0;
  for (const p of toPeak) back = Math.min(back, ((p.x - st.x) * dx + (p.y - st.y) * dy) / n);
  const clamp = (v: number, a: number) => Math.max(-a, Math.min(a, v));
  return [
    dx, dy,
    pk.x - s.nose.x, pk.y - s.nose.y,
    pk.ex - pk.x, pk.ey - pk.y,
    pk.ex - st.ex, pk.ey - st.ey,
    clamp(Math.log(Math.max(0.05, pk.s) / Math.max(0.05, st.s)), 1),
    mid.x - (st.x + pk.x) / 2, mid.y - (st.y + pk.y) / 2,
    back,
    (pk.t - st.t) / 150,
    s.other,
    st.x - s.nose.x, st.y - s.nose.y,
    s.headDrop,
  ];
}

/** Relative feature weights after standardizing (tuned on the recorded data, see scripts/eval-calibration.ts). */
export let WEIGHTS: number[] = FEATURES.map(() => 1);
export function setWeights(w: number[]): void {
  WEIGHTS = w;
}

export interface Prediction {
  label: Label;
  /** Distance to the nearest taught example of each label (Infinity when none). */
  dist: Partial<Record<Label, number>>;
}

/**
 * Per-player k-nearest-neighbours over standardized, weighted segment features, trained by the
 * guided calibration. Few examples per move, so a lazy learner beats anything with weights.
 */
export class KnnModel {
  private mean: number[] = [];
  private std: number[] = [];
  private data: Sample[];
  /** Motions further than this from every taught punch are rejected as non-punches. */
  readonly radius: number;

  constructor(samples: Sample[], private k: number = CONFIG.model.k, rejectScale: number = CONFIG.model.rejectScale) {
    const n = samples[0]?.v.length ?? 0;
    for (let i = 0; i < n; i++) {
      const col = samples.map((s) => s.v[i]);
      const m = col.reduce((a, b) => a + b, 0) / col.length;
      // Floored so a feature that barely varies in the taught set cannot dominate the distance.
      const sd = Math.max(CONFIG.model.minStd, Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length));
      this.mean.push(m);
      this.std.push(sd);
    }
    this.data = samples.map((s) => ({ ...s, v: this.norm(s.v) }));
    const nn = this.data
      .filter((s) => s.label !== 'none')
      .map((s) => Math.min(...this.data.filter((o) => o !== s && o.hand === s.hand && o.label === s.label).map((o) => dist(o.v, s.v))))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    this.radius = nn.length ? Math.max(CONFIG.model.minRadius, nn[Math.floor(nn.length / 2)] * rejectScale) : Infinity;
  }

  private norm(v: number[]): number[] {
    return v.map((x, i) => ((x - this.mean[i]) / this.std[i]) * (WEIGHTS[i] ?? 1));
  }

  predict(hand: Hand, raw: number[]): Prediction {
    const v = this.norm(raw);
    const near = this.data
      .filter((s) => s.hand === hand)
      .map((s) => ({ s, d: dist(s.v, v) }))
      .sort((a, b) => a.d - b.d);
    const nearest: Prediction['dist'] = {};
    for (const { s, d } of near) if (nearest[s.label] === undefined) nearest[s.label] = d;
    if (!near.length) return { label: 'none', dist: nearest };
    const score = new Map<Label, number>();
    for (const { s, d } of near.slice(0, this.k)) score.set(s.label, (score.get(s.label) ?? 0) + 1 / (d + 0.3));
    let best = [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (best !== 'none' && nearest[best]! > this.radius) best = 'none';
    return { label: best, dist: nearest };
  }

  /** Classifier hook: a punch, or null for a non-punch. */
  decide(s: Segment, stance: Stance, split: BodySplit): Punch | null {
    const label = confident(this.predict(s.hand, vector(s)));
    if (label === 'none') return null;
    const target: Target = label === 'straight' && s.peakY > split[s.hand] ? 'body' : 'head';
    return { type: punchOf(label, s.hand, stance), hand: s.hand, target };
  }
}

/**
 * Hooks and uppercuts only win when they are clearly closer than a straight; a close call goes to
 * the straight, which is the safer read of an unclear motion.
 */
export function confident(p: Prediction): Label {
  const { label, dist: d } = p;
  if (label !== 'hook' && label !== 'uppercut') return label;
  const straight = d.straight ?? Infinity;
  return straight <= d[label]! * CONFIG.model.straightMargin ? 'straight' : label;
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
