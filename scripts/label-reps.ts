// Candidate punch peaks of one clip, for hand-checking against its webm. Found without the
// classifier's segmenter: each wrist's on-screen distance from its rest (guard) position, relative
// to the shoulder midpoint in calibrated shoulder widths, with the rest position the rolling median
// of the wrist over REST_MS. A candidate is a local maximum of that distance at least MIN_TRAVEL sw
// out, standing at least MIN_PROM sw above the dips on both sides, and the highest within MIN_SEP_MS.
// Times are seconds from the first frame (the eval-gt convention) and seconds into the webm.
// Usage: npx tsx scripts/label-reps.ts tests/fixtures/fast/<file>.json [minTravel]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Hand, PunchType, Stance } from '../shared/types.ts';
import { HAND_IDX, L, type PoseFrame } from '../client/src/tracking/frame.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import type { Recording } from './eval-core.ts';

const REST_MS = 3000;
const MIN_SEP_MS = 150;
const MIN_PROM = 0.3;
const MIN_TRAVEL = Number(process.argv[3] ?? 0.5);

export interface Peak { hand: Hand; t: number; d: number; prom: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** Distance of a wrist from its rolling rest position, per frame, in shoulder widths. */
export function travel(frames: PoseFrame[], hand: Hand, sw: number): number[] {
  const rel = frames.map((f) => {
    const w = f.img[HAND_IDX[hand].wrist], a = f.img[L.lShoulder], b = f.img[L.rShoulder];
    return { x: (w.x - (a.x + b.x) / 2) / sw, y: (w.y - (a.y + b.y) / 2) / sw };
  });
  let lo = 0, hi = 0;
  return rel.map((p, i) => {
    while (frames[lo].t < frames[i].t - REST_MS / 2) lo++;
    while (hi < frames.length && frames[hi].t <= frames[i].t + REST_MS / 2) hi++;
    const win = rel.slice(lo, hi);
    return Math.hypot(p.x - median(win.map((q) => q.x)), p.y - median(win.map((q) => q.y)));
  });
}

export function peaks(frames: PoseFrame[], hand: Hand, sw: number, minTravel = MIN_TRAVEL): Peak[] {
  const d = travel(frames, hand, sw);
  const out: Peak[] = [];
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i] < minTravel || d[i] < d[i - 1] || d[i] < d[i + 1]) continue;
    // Prominence: the higher of the lowest dips before the next higher point on each side.
    let l = d[i], r = d[i];
    for (let j = i - 1; j >= 0 && d[j] <= d[i]; j--) l = Math.min(l, d[j]);
    for (let j = i + 1; j < d.length && d[j] <= d[i]; j++) r = Math.min(r, d[j]);
    const prom = d[i] - Math.max(l, r);
    if (prom >= MIN_PROM) out.push({ hand, t: frames[i].t, d: d[i], prom });
  }
  return out.filter((p) => !out.some((q) => q !== p && Math.abs(q.t - p.t) < MIN_SEP_MS && (q.d > p.d || (q.d === p.d && q.t < p.t))));
}

/** Expected types matched in order to the candidates of their hand; the rest get the hand's straight and a note. */
function guessTypes(all: Peak[], expected: PunchType[], stance: Stance): { p: Peak; type: PunchType; note: string }[] {
  let k = 0;
  return all.map((p) => {
    if (k < expected.length && handFor(expected[k], stance) === p.hand) return { p, type: expected[k++], note: '' };
    const note = !expected.length ? ' // check type' : k < expected.length ? ' // out of order, extra?' : ' // extra?';
    return { p, type: handFor('jab', stance) === p.hand ? 'jab' : 'cross', note };
  });
}

if (process.argv[1]?.endsWith('label-reps.ts')) {
  const file = process.argv[2];
  if (!file) {
    console.log('Usage: npx tsx scripts/label-reps.ts tests/fixtures/fast/<file>.json [minTravel]');
    process.exit(1);
  }
  const rec = JSON.parse(readFileSync(file, 'utf8')) as Recording & { videoStartT?: number; video?: string };
  const stance = rec.stance ?? 'orthodox';
  const t0 = rec.frames[0].t;
  const sw = rec.calibration?.swImg ?? 0.25;
  const vt = (t: number) => (rec.videoStartT != null ? `video ${((t - rec.videoStartT) / 1000).toFixed(2).padStart(6)} s` : 'no video');
  console.log(`== ${file}  ${rec.frames.length} frames, ${((rec.frames.at(-1)!.t - t0) / 1000).toFixed(1)} s${rec.video ? `, video ${rec.video}` : ''}`);
  console.log(`expected: ${rec.expected?.join(', ') || 'unknown'}`);
  const all: Peak[] = [];
  for (const hand of ['left', 'right'] as const) {
    const ps = peaks(rec.frames, hand, sw);
    all.push(...ps);
    console.log(`\n${hand} wrist, ${ps.length} candidates`);
    for (const p of ps) console.log(`  t ${((p.t - t0) / 1000).toFixed(2).padStart(6)} s  ${vt(p.t)}  out ${p.d.toFixed(2)} sw  prom ${p.prom.toFixed(2)}`);
  }
  all.sort((a, b) => a.t - b.t);
  // Single-move clips only count the punching hand; combos and free clips use both.
  const one = rec.expected?.length && new Set(rec.expected).size === 1 && rec.expected.length === (rec.reps ?? 0) ? handFor(rec.expected[0], stance) : null;
  const picked = one ? all.filter((p) => p.hand === one).map((p) => ({ p, type: rec.expected![0], note: '' })) : guessTypes(all, rec.expected ?? [], stance);
  const key = basename(file).replace(/\.json$/, '');
  console.log(`\nPaste into FAST_REPS in scripts/eval-gt.ts after checking each time against the video:`);
  console.log(`  '${key}': [`);
  for (const { p, type, note } of picked) console.log(`    { type: '${type}', t: ${Number(((p.t - t0) / 1000).toFixed(2))} },${note}`);
  console.log('  ],');
}
