import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { PathPoint, Segment } from './classifier.ts';

/**
 * The model learns the punch shape per hand only; the hand and stance give the exact punch, and
 * the player's own head and body reps give the target (TargetModel). `none` marks motions that are not punches
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
  /** Head or body, on taught punch reps (older profiles and prior samples have none). */
  target?: Target;
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

/** Prior samples count less than the player's own: their distances are scaled up by this. */
export const PRIOR_PENALTY = 1.3;

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

  /** Population prior samples, normalized like the player's own and matched at PRIOR_PENALTY times their distance. */
  private prior: Sample[] = [];
  /** Head or body from the player's own reps (prior samples carry no target). */
  private targets: TargetModel;

  constructor(samples: Sample[], private k: number = CONFIG.model.k, rejectScale: number = CONFIG.model.rejectScale, prior: Sample[] = []) {
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
    this.targets = new TargetModel(samples);
    if (n) this.prior = prior.filter((s) => s.v.length === n).map((s) => ({ ...s, v: this.norm(s.v) }));
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
      .concat(this.prior.filter((s) => s.hand === hand).map((s) => ({ s, d: dist(s.v, v) * PRIOR_PENALTY })))
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

  /**
   * Indices (into the samples given to the constructor) of the hand's non-punch examples that are
   * nearer to this motion than every taught example of `label`, nearest first and at most
   * maxShadowDrop of them: the ones that made it read as no punch.
   */
  shadowing(hand: Hand, raw: number[], label: Label): number[] {
    const v = this.norm(raw);
    const d = this.data.map((s) => (s.hand === hand ? dist(s.v, v) : Infinity));
    const own = Math.min(...this.data.map((s, i) => (s.label === label ? d[i] : Infinity)));
    return this.data
      .flatMap((s, i) => (s.label === 'none' && d[i] < own ? [i] : []))
      .sort((a, b) => d[a] - d[b])
      .slice(0, CONFIG.model.maxShadowDrop);
  }

  /** Classifier hook: a punch, or null for a non-punch. */
  decide(s: Segment, stance: Stance, split: BodySplit): Punch | null {
    const v = vector(s);
    const label = confident(this.predict(s.hand, v));
    if (label === 'none') return null;
    const target: Target = this.targets.target(s.hand, label, v) ?? (label === 'straight' && s.peakY > split[s.hand] ? 'body' : 'head');
    return { type: punchOf(label, s.hand, stance), hand: s.hand, target };
  }
}

/**
 * Head/body features, as indices into vector(): where the fist ends up relative to the nose, in
 * sw, in the hand's mirrored frame. Relative to the player's own body, so it holds up across
 * camera heights, unlike a fixed height line (from a high camera a head jab can end below the
 * shoulders on screen). Picked by leave-one-out on the recorded reps: 29/29 against 25/29 for the
 * height line (scripts/eval-calibration.ts --line compares).
 */
export let TARGET_FEATURES: number[] = [2, 3];
export function setTargetFeatures(f: number[]): void {
  TARGET_FEATURES = f;
}

/** The other hand's reps count, at this multiple of their distance. */
const OTHER_HAND_PENALTY = 1.2;

/**
 * Head or body by nearest neighbours among the player's own reps of the same punch, taught to
 * both targets. Both hands' reps are used (in each hand's mirrored frame they land in the same
 * places, and five reps per target and hand is too few on its own), the other hand's slightly
 * further away. Returns null when the punch was never taught to both head and body; the caller
 * then uses the height line for straights and head for the rest.
 */
export class TargetModel {
  private groups = new Map<Kind, { mean: number[]; std: number[]; data: { hand: Hand; target: Target; v: number[] }[] }>();

  constructor(samples: Sample[]) {
    const reps = samples.filter((s) => s.label !== 'none' && s.target);
    for (const kind of ['straight', 'hook', 'uppercut'] as Kind[]) {
      const xs = reps.filter((s) => s.label === kind);
      if (xs.some((s) => s.target === 'head') && xs.some((s) => s.target === 'body')) this.groups.set(kind, fit(xs));
    }
  }

  target(hand: Hand, kind: Kind, v: number[]): Target | null {
    const g = this.groups.get(kind);
    if (!g) return null;
    const x = TARGET_FEATURES.map((i, j) => (v[i] - g.mean[j]) / g.std[j]);
    const near = g.data
      .map((s) => ({ s, d: dist(s.v, x) * (s.hand === hand ? 1 : OTHER_HAND_PENALTY) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, CONFIG.model.targetK);
    let head = 0, body = 0;
    for (const { s, d } of near) {
      if (s.target === 'body') body += 1 / (d + 0.3);
      else head += 1 / (d + 0.3);
    }
    return body > head ? 'body' : 'head';
  }
}

function fit(xs: Sample[]): { mean: number[]; std: number[]; data: { hand: Hand; target: Target; v: number[] }[] } {
  const cols = TARGET_FEATURES.map((i) => xs.map((s) => s.v[i]));
  const mean = cols.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
  const std = cols.map((c, j) => Math.max(CONFIG.model.minStd, Math.sqrt(c.reduce((a, b) => a + (b - mean[j]) ** 2, 0) / c.length)));
  return { mean, std, data: xs.map((s) => ({ hand: s.hand, target: s.target!, v: TARGET_FEATURES.map((i, j) => (s.v[i] - mean[j]) / std[j]) })) };
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
