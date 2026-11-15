import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { PathPoint, Segment } from './classifier.ts';

/**
 * The model learns the punch shape per hand only; the hand and stance give the exact punch, and
 * the fist height against the player's head line gives the target (targetOf). `none` marks motions that are not punches
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

/**
 * Per hand: the lowest fist peak, in sw above the nose (negative is below), that still reads as a
 * head shot. Everything below it is a body shot.
 */
export type HeadLine = Record<Hand, number>;

export const DEFAULT_HEAD_LINE: HeadLine = { left: CONFIG.punch.headLine, right: CONFIG.punch.headLine };

/** Fist height at the peak relative to the nose, in sw (up positive). */
export function headHeight(s: Pick<Segment, 'peak' | 'nose'>): number {
  return s.peak.y - s.nose.y;
}

/**
 * Head or body. Every punch is a body shot unless the fist clearly went high: at or above the
 * player's head line for straights, at or above the line but never stricter than nose level for
 * hooks (a hook does not come toward the camera, so it does not rise on screen like a straight),
 * and up to chin level for uppercuts. The chin sits 45% of the way from the nose to the shoulder
 * line (as in the classifier), so it is 0.45 of the nose height below the nose.
 * Picked on the recorded reps (scripts/eval-target.ts).
 */
export function targetOf(s: Pick<Segment, 'hand' | 'peak' | 'nose'>, kind: Kind, line: HeadLine = DEFAULT_HEAD_LINE): Target {
  const l = line[s.hand];
  const need = kind === 'straight' ? l : Math.min(l, CONFIG.punch.headLine) - (kind === 'uppercut' ? 0.45 * s.nose.y : 0);
  return headHeight(s) >= need ? 'head' : 'body';
}

export interface Sample {
  hand: Hand;
  label: Label;
  v: number[];
  /** Head or body, on taught punch reps (prior samples have none). */
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
  decide(s: Segment, stance: Stance, line: HeadLine = DEFAULT_HEAD_LINE): Punch | null {
    const label = confident(this.predict(s.hand, vector(s)));
    if (label === 'none') return null;
    return { type: punchOf(label, s.hand, stance), hand: s.hand, target: targetOf(s, label, line) };
  }
}

/**
 * The player's head line per hand, from their taught straights (height = headHeight of the rep):
 * midway between the median head rep and the median body rep of that hand, falling back to both
 * hands together and then to nose level, and always clamped to [headLineMin, headLineMax], so a
 * head shot never needs less than a fist at about chin height.
 */
export function headLineFrom(straights: { hand: Hand; h: number; target: Target }[]): HeadLine {
  const p = CONFIG.punch;
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const line = (xs: typeof straights): number | null => {
    const head = xs.filter((x) => x.target === 'head').map((x) => x.h), body = xs.filter((x) => x.target === 'body').map((x) => x.h);
    if (!head.length || !body.length || med(head) <= med(body)) return null;
    return (med(head) + med(body)) / 2;
  };
  const clamp = (v: number) => Math.max(p.headLineMin, Math.min(p.headLineMax, v));
  const both = line(straights) ?? p.headLine;
  return {
    left: clamp(line(straights.filter((x) => x.hand === 'left')) ?? both),
    right: clamp(line(straights.filter((x) => x.hand === 'right')) ?? both),
  };
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
