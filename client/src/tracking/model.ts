import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { PathPoint, Segment } from './classifier.ts';

/**
 * The model learns the punch shape per hand only; the hand and stance give the exact punch, and
 * the head dip gives the target (targetOf). `none` marks motions that are not punches
 * (adjusting the guard, dropping or raising the hands, wind-ups).
 */
export type Kind = 'straight' | 'hook' | 'uppercut';
export type Label = Kind | 'none';

export function kindOf(type: PunchType): Kind {
  return type === 'jab' || type === 'cross' ? 'straight' : type.endsWith('Hook') ? 'hook' : 'uppercut';
}


function punchOf(kind: Kind, hand: Hand, stance: Stance): PunchType {
  if (kind === 'straight') return hand === (stance === 'orthodox' ? 'left' : 'right') ? 'jab' : 'cross';
  return `${hand}${kind === 'hook' ? 'Hook' : 'Uppercut'}` as PunchType;
}

/**
 * Head or body, for every punch kind: a punch thrown crouched (head dipped at least `bodyDip` below
 * its neutral position by the peak) is a body shot, a punch thrown standing is a head shot. The head
 * drop reads the same from any camera height, unlike the fist height.
 */
export function targetOf(s: Pick<Segment, 'dip'>, bodyDip: number = CONFIG.punch.bodyDip): Target {
  return s.dip >= bodyDip ? 'body' : 'head';
}

/**
 * The player's body-shot dip: bodyDipFraction of the way from how far the head moves on standing
 * punches (median, 0 when none) to how deep the player crouches on body punches (median of the
 * crouch reps, or the demonstrated duck when there are fewer than two), clamped to
 * [bodyDipMin, bodyDipMax]. Nothing measured gives the default.
 */
export function bodyDipFrom(crouch: number[], stand: number[], duck: number | null): number {
  const p = CONFIG.punch;
  const med = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const deep = crouch.length >= 2 ? med(crouch) : duck;
  if (deep === null || !(deep > 0)) return p.bodyDip;
  const floor = stand.length ? Math.max(0, med(stand)) : 0;
  return Math.max(p.bodyDipMin, Math.min(p.bodyDipMax, floor + (deep - floor) * p.bodyDipFraction));
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

/**
 * Per-segment feature vector, all in the hand's own on-screen frame (sw units, x toward the body
 * midline, y up), so both hands share one frame. World depth and the 3D elbow angle are left out:
 * MediaPipe gets them wrong too often on fast punches. Layout (FEATURE_COUNT entries): dx, dy,
 * peakNoseX, peakNoseY, forearmX, forearmY, elbowDx, elbowDy, scale, bendX, bendY, windBack,
 * duration, other, startNoseX, startNoseY, headDrop.
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

/** Prior samples count less than the player's own: their distances are scaled up by this. */
const PRIOR_PENALTY = 1.3;

export interface Prediction {
  label: Label;
  /** Distance to the nearest taught example of each label (Infinity when none). */
  dist: Partial<Record<Label, number>>;
}

/** A training sample as matched: its standardized vector, and whether it is a prior sample. */
interface Ref {
  label: Label;
  v: number[];
  prior: boolean;
}

/**
 * Per-player k-nearest-neighbours over standardized segment features, trained by the guided
 * calibration. Few examples per move, so a lazy learner beats anything with weights.
 */
export class KnnModel {
  private mean: number[] = [];
  private std: number[] = [];
  private data: Sample[];
  /** Motions further than this from every taught punch are rejected as non-punches. */
  readonly radius: number;
  /**
   * Per hand, everything a motion is matched against: the player's own samples, then the
   * population prior's (normalized like the player's own and matched at PRIOR_PENALTY times
   * their distance), each in the order given.
   */
  private refs = new Map<Hand, Ref[]>();
  /** Scratch distances, reused across predictions. */
  private dist = new Float64Array(0);

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
    const add = (hand: Hand, r: Ref) => {
      const list = this.refs.get(hand);
      if (list) list.push(r);
      else this.refs.set(hand, [r]);
    };
    for (const s of this.data) add(s.hand, { label: s.label, v: s.v, prior: false });
    if (n) for (const s of prior) if (s.v.length === n) add(s.hand, { label: s.label, v: this.norm(s.v), prior: true });
    const nn: number[] = [];
    for (const s of this.data) {
      if (s.label === 'none') continue;
      let m = Infinity;
      for (const o of this.data) if (o !== s && o.hand === s.hand && o.label === s.label) m = Math.min(m, dist(o.v, s.v));
      if (Number.isFinite(m)) nn.push(m);
    }
    nn.sort((a, b) => a - b);
    this.radius = nn.length ? Math.max(CONFIG.model.minRadius, nn[Math.floor(nn.length / 2)] * rejectScale) : Infinity;
  }

  private norm(v: number[]): number[] {
    return v.map((x, i) => (x - this.mean[i]) / this.std[i]);
  }

  predict(hand: Hand, raw: number[]): Prediction {
    const v = this.norm(raw);
    const refs = this.refs.get(hand) ?? [];
    const n = refs.length;
    const nearest: Prediction['dist'] = {};
    if (!n) return { label: 'none', dist: nearest };
    if (this.dist.length < n) this.dist = new Float64Array(n);
    const d = this.dist;
    let finite = true;
    for (let i = 0; i < n; i++) {
      const r = refs[i];
      d[i] = r.prior ? dist(r.v, v) * PRIOR_PENALTY : dist(r.v, v);
      if (!Number.isFinite(d[i])) finite = false;
    }
    // The k nearest, nearest first (ties in sample order, as a stable sort would leave them).
    let top: number[];
    if (finite && Number.isInteger(this.k) && this.k >= 1) {
      top = nearestK(d, n, this.k);
      // Nearest distance per label, keyed in the order the labels first appear by distance.
      const labels: Label[] = [], min: number[] = [], first: number[] = [];
      for (let i = 0; i < n; i++) {
        const j = labels.indexOf(refs[i].label);
        if (j < 0) {
          labels.push(refs[i].label);
          min.push(d[i]);
          first.push(i);
        } else if (d[i] < min[j]) {
          min[j] = d[i];
          first[j] = i;
        }
      }
      const byDist = labels.map((_, j) => j).sort((a, b) => min[a] - min[b] || first[a] - first[b]);
      for (const j of byDist) nearest[labels[j]] = min[j];
    } else {
      // Non-finite distances or an unusual k: sort everything, exactly as a full ranking would.
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[a] - d[b]);
      for (const i of order) if (nearest[refs[i].label] === undefined) nearest[refs[i].label] = d[i];
      top = order.slice(0, this.k);
    }
    const score = new Map<Label, number>();
    for (const i of top) score.set(refs[i].label, (score.get(refs[i].label) ?? 0) + 1 / (d[i] + 0.3));
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
    let own = Infinity;
    for (let i = 0; i < d.length; i++) if (this.data[i].label === label) own = Math.min(own, d[i]);
    const out: number[] = [];
    for (let i = 0; i < d.length; i++) if (this.data[i].label === 'none' && d[i] < own) out.push(i);
    return out.sort((a, b) => d[a] - d[b]).slice(0, CONFIG.model.maxShadowDrop);
  }

  /** Classifier hook: a punch, or null for a non-punch. */
  decide(s: Segment, stance: Stance, bodyDip: number = CONFIG.punch.bodyDip): Punch | null {
    const label = confident(this.predict(s.hand, vector(s)));
    if (label === 'none') return null;
    return { type: punchOf(label, s.hand, stance), hand: s.hand, target: targetOf(s, bodyDip) };
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

/**
 * Indices of the k smallest of d[0..n), smallest first, ties in index order (what a stable sort
 * of all n would put first). All values must be finite.
 */
function nearestK(d: Float64Array, n: number, k: number): number[] {
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = d[i];
    if (top.length === k && !(x < d[top[k - 1]])) continue;
    let p = top.length === k ? k - 1 : top.length;
    while (p > 0 && d[top[p - 1]] > x) {
      top[p] = top[p - 1];
      p--;
    }
    top[p] = i;
  }
  return top;
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
