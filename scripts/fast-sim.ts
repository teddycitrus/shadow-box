// Fast-punch simulation from recorded clips, shared by scripts/eval-fast.ts and the tests. The
// recorded reps were thrown at a teaching pace; a real fast punch covers the same path in a third
// to half the time, so the camera sees it in fewer frames. speedUp() replays a clip with time
// running `factor` times faster around each rep (or over the whole clip), resampled at the clip's
// own frame gaps, and can add what a fast arm does to the tracker: extra landmark lag and a
// blurred wrist that trails behind with low visibility.
import type { Lm, PoseFrame } from '../client/src/tracking/frame.ts';
import type { Recording } from './eval-core.ts';

export interface FastOptions {
  /** Time runs this many times faster inside the punch windows (or everywhere with whole). */
  factor: number;
  /** Speed up the whole clip (returns and pauses too: combos, double jabs). */
  whole?: boolean;
  /** Window around each rep peak (ms of original time) that is sped up. */
  before?: number;
  after?: number;
  /** Extra exponential lag on the arm landmarks (per-frame factor, 1 = none). */
  lag?: number;
  /** Wrist blur: above this wrist speed (sw/s) the wrist trails by blurLag and drops to low visibility. */
  blurSpeed?: number;
  blurLag?: number;
}

const ARM = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const WRISTS = [15, 16, 17, 18, 19, 20, 21, 22];

/** Returns the sped-up recording and the rep times (ms, absolute) mapped onto it. */
export function speedUp(rec: Recording, repsMs: number[], o: FastOptions): { rec: Recording; reps: number[] } {
  const fr = rec.frames;
  const before = o.before ?? 400, after = o.after ?? 300;
  const inWin = (t: number) => o.whole || repsMs.some((r) => t >= r - before && t <= r + after);
  // New time of every original frame.
  const nt: number[] = [fr[0].t];
  for (let i = 1; i < fr.length; i++) {
    const dt = fr[i].t - fr[i - 1].t;
    nt.push(nt[i - 1] + dt / (inWin((fr[i].t + fr[i - 1].t) / 2) ? o.factor : 1));
  }
  const toNew = (t: number) => {
    let i = 1;
    while (i < fr.length - 1 && fr[i].t < t) i++;
    const u = (t - fr[i - 1].t) / (fr[i].t - fr[i - 1].t || 1);
    return nt[i - 1] + (nt[i] - nt[i - 1]) * Math.max(0, Math.min(1, u));
  };
  // Resample at the clip's own frame gaps, in order.
  const gaps = fr.slice(1).map((f, i) => f.t - fr[i].t);
  const out: PoseFrame[] = [];
  let t = nt[0], g = 0, j = 1;
  const end = nt[nt.length - 1];
  while (t <= end) {
    while (j < nt.length - 1 && nt[j] < t) j++;
    const u = Math.max(0, Math.min(1, (t - nt[j - 1]) / (nt[j] - nt[j - 1] || 1)));
    const a = fr[j - 1], b = fr[j];
    const mix = (p: Lm[], q: Lm[]) => p.map((x, k) => ({ x: x.x + (q[k].x - x.x) * u, y: x.y + (q[k].y - x.y) * u, z: x.z + (q[k].z - x.z) * u, v: x.v + (q[k].v - x.v) * u }));
    out.push({ t, img: mix(a.img, b.img), world: mix(a.world, b.world) });
    t += gaps[g++ % gaps.length];
  }
  const sw = rec.calibration!.swImg;
  const lag = o.lag ?? 1;
  // Tracker lag and blur, applied to the resampled (true) motion.
  // Lag replaces landmark objects instead of mutating them, so these keep the true wrists.
  const truth = out.map((f) => [f.img[15], f.img[16]]);
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1], f = out[i];
    const dt = (f.t - p.t) / 1000;
    for (const side of [0, 1]) {
      // Speed of the true wrist motion (before lag and blur).
      const speed = Math.hypot(truth[i][side].x - truth[i - 1][side].x, truth[i][side].y - truth[i - 1][side].y) / sw / dt;
      const blurred = o.blurSpeed !== undefined && speed > o.blurSpeed;
      const k = blurred ? Math.min(lag, o.blurLag ?? 0.5) : lag;
      if (k >= 1) continue;
      for (const idx of ARM.filter((x) => x % 2 === (side ? 0 : 1))) {
        const wk = WRISTS.includes(idx) ? k : lag;
        for (const set of ['img', 'world'] as const) {
          const q = p[set][idx], r = f[set][idx];
          f[set][idx] = { x: q.x + (r.x - q.x) * wk, y: q.y + (r.y - q.y) * wk, z: q.z + (r.z - q.z) * wk, v: blurred && WRISTS.includes(idx) ? 0.3 : r.v };
        }
      }
    }
  }
  return { rec: { ...rec, frames: out }, reps: repsMs.map(toNew) };
}
