// Shared calibration data: strict validation of uploads and the population prior built from them.
// Pure functions only, used by the Worker's DataDO, the Node dev server, the client and the tests.
import type { Hand, Stance, Target } from './types.ts';

/** Feature-vector version. Matches the client Profile version; bump both together. */
export const DATA_VERSION = 6;
export const FEATURE_COUNT = 17;
export const MAX_SAMPLES = 400;
export const MAX_SCORES = 24;
/** No feature of a real motion comes near this; anything past it is junk. */
export const FEATURE_LIMIT = 100;
export const MAX_BODY_BYTES = 96 * 1024;
/** Samples kept per role and label to build the prior from (reservoir sampling). */
export const RESERVOIR_SIZE = 240;
/** Representative samples returned per role and label. */
export const PRIOR_PER_GROUP = 40;

export const LABELS = ['straight', 'hook', 'uppercut', 'none'] as const;
export type DataLabel = (typeof LABELS)[number];
/** Lead or rear hand. The prior is stored per role so orthodox and southpaw data pool correctly. */
export type Role = 'lead' | 'rear';
export const ROLES: readonly Role[] = ['lead', 'rear'];

export interface UploadSample {
  hand: Hand;
  label: DataLabel;
  v: number[];
  target?: Target;
}

export interface UploadScore {
  id: string;
  ok: number;
  tries: number;
}

export interface CalibrationUpload {
  version: typeof DATA_VERSION;
  /** Random per-calibration id, not linked to the player. */
  id: string;
  client: string;
  stance: Stance;
  fps: number;
  model: 'full' | 'lite';
  samples: UploadSample[];
  scores: UploadScore[];
  /** Head dip (sw below neutral) the calibration set for a body shot (version 6 on). */
  bodyDip?: number;
  defense?: { duck: number; slipLeft: number; slipRight: number };
}

export interface PriorGroup {
  role: Role;
  label: DataLabel;
  /** Samples seen for this group across all accepted calibrations. */
  count: number;
  mean: number[];
  std: number[];
  samples: number[][];
}

export interface Prior {
  version: typeof DATA_VERSION;
  updated: number;
  calibrations: number;
  mean: number[];
  std: number[];
  groups: PriorGroup[];
}

export function roleOf(hand: Hand, stance: Stance): Role {
  return (hand === 'left') === (stance === 'orthodox') ? 'lead' : 'rear';
}

export function handOf(role: Role, stance: Stance): Hand {
  return (role === 'lead') === (stance === 'orthodox') ? 'left' : 'right';
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CLIENT_RE = /^[\w.+-]{1,32}$/;
const SCORE_ID_RE = /^[A-Za-z]{2,20}-(head|body)$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const int = (x: unknown, lo: number, hi: number): x is number => num(x, lo, hi) && Number.isInteger(x);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Returns a cleaned copy with only the known fields, or an error message. */
export function validateCalibration(x: unknown): CalibrationUpload | string {
  if (!isObj(x)) return 'body must be an object';
  if (x.version !== DATA_VERSION) return `version must be ${DATA_VERSION}`;
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return 'bad id';
  if (typeof x.client !== 'string' || !CLIENT_RE.test(x.client)) return 'bad client';
  if (x.stance !== 'orthodox' && x.stance !== 'southpaw') return 'bad stance';
  if (!num(x.fps, 0, 240)) return 'bad fps';
  if (x.model !== 'full' && x.model !== 'lite') return 'bad model';
  if (!Array.isArray(x.samples) || x.samples.length < 1 || x.samples.length > MAX_SAMPLES) return `samples must be 1 to ${MAX_SAMPLES}`;
  const samples: UploadSample[] = [];
  for (const s of x.samples as unknown[]) {
    if (!isObj(s)) return 'bad sample';
    if (s.hand !== 'left' && s.hand !== 'right') return 'bad sample hand';
    if (!LABELS.includes(s.label as DataLabel)) return 'bad sample label';
    if (!Array.isArray(s.v) || s.v.length !== FEATURE_COUNT || !s.v.every((n) => num(n, -FEATURE_LIMIT, FEATURE_LIMIT))) return 'bad sample vector';
    if (s.target !== undefined && s.target !== 'head' && s.target !== 'body') return 'bad sample target';
    const out: UploadSample = { hand: s.hand, label: s.label as DataLabel, v: (s.v as number[]).map((n) => round(n, 4)) };
    if (s.target !== undefined && s.label === 'straight') out.target = s.target;
    samples.push(out);
  }
  if (!samples.some((s) => s.label !== 'none')) return 'no punch samples';
  if (!Array.isArray(x.scores) || x.scores.length > MAX_SCORES) return 'bad scores';
  const scores: UploadScore[] = [];
  for (const s of x.scores as unknown[]) {
    if (!isObj(s) || typeof s.id !== 'string' || !SCORE_ID_RE.test(s.id) || !int(s.tries, 0, 50) || !int(s.ok, 0, s.tries)) return 'bad score';
    scores.push({ id: s.id, ok: s.ok, tries: s.tries });
  }
  const out: CalibrationUpload = {
    version: DATA_VERSION, id: x.id, client: x.client, stance: x.stance, fps: round(x.fps, 1), model: x.model, samples, scores,
  };
  if (x.bodyDip !== undefined) {
    if (!num(x.bodyDip, 0, 5)) return 'bad bodyDip';
    out.bodyDip = round(x.bodyDip, 4);
  }
  if (x.defense !== undefined) {
    const d = x.defense;
    if (!isObj(d) || !num(d.duck, 0, 5) || !num(d.slipLeft, 0, 5) || !num(d.slipRight, 0, 5)) return 'bad defense';
    out.defense = { duck: round(d.duck, 4), slipLeft: round(d.slipLeft, 4), slipRight: round(d.slipRight, 4) };
  }
  return out;
}

/** Share of verify attempts read right, or 1 when nothing was verified. */
export function quality(c: CalibrationUpload): number {
  const tries = c.scores.reduce((n, s) => n + s.tries, 0);
  return tries ? c.scores.reduce((n, s) => n + s.ok, 0) / tries : 1;
}

/** Calibrations read back worse than this are stored but left out of the prior. */
export const MIN_QUALITY = 0.5;

export interface Reservoir {
  /** Samples offered so far. */
  count: number;
  items: number[][];
}

export const groupKey = (role: Role, label: DataLabel) => `${role}:${label}`;

/** Adds a calibration's samples to the per-group reservoirs. Returns the keys that changed. */
export function addToReservoirs(res: Map<string, Reservoir>, c: CalibrationUpload, rng: () => number, size = RESERVOIR_SIZE): Set<string> {
  const changed = new Set<string>();
  for (const s of c.samples) {
    const key = groupKey(roleOf(s.hand, c.stance), s.label);
    let r = res.get(key);
    if (!r) res.set(key, (r = { count: 0, items: [] }));
    r.count++;
    changed.add(key);
    if (r.items.length < size) r.items.push(s.v);
    else {
      const j = Math.floor(rng() * r.count);
      if (j < size) r.items[j] = s.v;
    }
  }
  return changed;
}

function stats(vs: number[][]): { mean: number[]; std: number[] } {
  const mean = Array<number>(FEATURE_COUNT).fill(0), std = Array<number>(FEATURE_COUNT).fill(0);
  if (!vs.length) return { mean, std };
  for (const v of vs) for (let i = 0; i < FEATURE_COUNT; i++) mean[i] += v[i] / vs.length;
  for (const v of vs) for (let i = 0; i < FEATURE_COUNT; i++) std[i] += (v[i] - mean[i]) ** 2 / vs.length;
  return { mean, std: std.map(Math.sqrt) };
}

/** Squared distance between rows a and b of flat arrays (FEATURE_COUNT numbers per row). */
function sq(x: Float64Array, a: number, y: Float64Array, b: number): number {
  const ao = a * FEATURE_COUNT, bo = b * FEATURE_COUNT;
  let s = 0;
  for (let i = 0; i < FEATURE_COUNT; i++) {
    const d = x[ao + i] - y[bo + i];
    s += d * d;
  }
  return s;
}

/**
 * Picks k real samples that cover the set: k-means++ seeding and a few Lloyd iterations on
 * standardized features, then the member nearest each centre. Works on flat typed arrays, so a
 * rebuild allocates a few buffers instead of thousands of small arrays.
 */
export function representatives(vs: number[][], k: number, scale: number[], rng: () => number, iters = 4): number[][] {
  if (vs.length <= k) return vs;
  const n = vs.length, F = FEATURE_COUNT;
  const z = new Float64Array(n * F);
  for (let i = 0; i < n; i++) for (let f = 0; f < F; f++) z[i * F + f] = vs[i][f] / (scale[f] || 1);
  const centers = new Float64Array(k * F);
  let nc = 0;
  const addCenter = (i: number) => {
    centers.set(z.subarray(i * F, i * F + F), nc * F);
    nc++;
  };
  addCenter(Math.floor(rng() * n));
  const d2 = new Float64Array(n);
  for (let i = 0; i < n; i++) d2[i] = sq(z, i, centers, 0);
  while (nc < k) {
    let total = 0;
    for (let i = 0; i < n; i++) total += d2[i];
    if (total <= 0) break;
    let r = rng() * total, idx = 0;
    while (idx < n - 1 && (r -= d2[idx]) > 0) idx++;
    addCenter(idx);
    for (let i = 0; i < n; i++) d2[i] = Math.min(d2[i], sq(z, i, z, idx));
  }
  const assign = new Int32Array(n);
  const sums = new Float64Array(nc * F);
  const counts = new Int32Array(nc);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < nc; c++) {
        const d = sq(z, i, centers, c);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const so = assign[i] * F;
      for (let f = 0; f < F; f++) sums[so + f] += z[i * F + f];
      counts[assign[i]]++;
    }
    for (let c = 0; c < nc; c++) if (counts[c]) for (let f = 0; f < F; f++) centers[c * F + f] = sums[c * F + f] / counts[c];
  }
  const picked = new Set<number>();
  for (let c = 0; c < nc; c++) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (picked.has(i)) continue;
      const d = sq(z, i, centers, c);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) picked.add(best);
  }
  return [...picked].sort((a, b) => a - b).map((i) => vs[i]);
}

/** Builds the compact population prior from the reservoirs. */
export function computePrior(res: Map<string, Reservoir>, calibrations: number, now: number, rng: () => number, perGroup = PRIOR_PER_GROUP): Prior {
  const all = [...res.values()].flatMap((r) => r.items);
  const g = stats(all);
  const scale = g.std.map((s) => Math.max(0.05, s));
  const r3 = (v: number[]) => v.map((x) => round(x, 3));
  const r2 = (v: number[]) => v.map((x) => round(x, 2));
  const groups: PriorGroup[] = [];
  for (const role of ROLES) {
    for (const label of LABELS) {
      const r = res.get(groupKey(role, label));
      if (!r?.items.length) continue;
      const s = stats(r.items);
      groups.push({ role, label, count: r.count, mean: r3(s.mean), std: r3(s.std), samples: representatives(r.items, perGroup, scale, rng).map(r2) });
    }
  }
  return { version: DATA_VERSION, updated: now, calibrations, mean: r3(g.mean), std: r3(g.std), groups };
}

/** Loose shape check of a downloaded prior, so a broken response is ignored instead of used. */
export function isPrior(x: unknown): x is Prior {
  if (!isObj(x) || x.version !== DATA_VERSION || !Array.isArray(x.groups)) return false;
  return x.groups.every((g: unknown) => isObj(g) && ROLES.includes(g.role as Role) && LABELS.includes(g.label as DataLabel) && Array.isArray(g.samples)
    && g.samples.every((v: unknown) => Array.isArray(v) && v.length === FEATURE_COUNT && v.every((n) => num(n, -FEATURE_LIMIT, FEATURE_LIMIT))));
}

/** Seeded PRNG (mulberry32) so tests and prior rebuilds are reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
