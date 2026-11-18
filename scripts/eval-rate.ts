// Frame-rate invariance: replays the fixture clips at their recorded rate (about 25 fps) and
// upsampled to about 2x and 2.4x (50 to 60 fps, like a faster webcam), and counts how many
// hand-checked reps the segmenter and gate find, how many fire and read right, and the extra fires.
// Upsampling interpolates the landmarks linearly onto an even time grid, then tops the jitter back
// up: an interpolated frame at fraction u between two recorded frames carries only
// (1-u)^2 + u^2 of their noise variance, so each landmark coordinate gets Gaussian noise of
// sigma * sqrt(2u(1-u)), where sigma is that coordinate's frame-to-frame jitter measured on the
// still parts of tests/fixtures/orthodox-guard.json (see measureJitter). Every frame then carries
// the recorded amount of jitter. Each rep is read by a model trained on every other rep:
//   same-rate: trained on the clips at the replayed rate (teach and play on the same camera).
//   native-taught: trained at the recorded rate, read at the replayed rate.
// rules: no taught model, the hand-written rules decide. Defense clips: any fire is false.
// Usage: npx tsx scripts/eval-rate.ts [--no-jitter] [--jitter-scale K] [--seed N] [--verbose]
import { pathToFileURL } from 'node:url';
import { CONFIG } from '../client/src/config.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import type { Lm, PoseFrame } from '../client/src/tracking/frame.ts';
import { KnnModel, kindOf, vector, type Label } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import type { Hand, Punch } from '../shared/types.ts';
import { fixtureReps, loadFixtures, segmentsOf, type Recording } from './eval-core.ts';

/** Per landmark, the jitter sigma of each coordinate: img x, y, z, then world x, y, z. */
export type Jitter = number[][];

/**
 * Frame-to-frame landmark jitter on the still parts of a clip: frames where both hands are
 * slower than the rest speed (classifier features). Jitter is estimated from second differences
 * of the raw landmarks over runs of three still frames (white noise of sigma gives a second
 * difference of variance 6 sigma^2, and a slow drift almost none), with a median-based spread so
 * the odd tracking glitch does not count.
 */
export function measureJitter(rec: Recording): Jitter {
  const c = new Classifier(rec.calibration!);
  const still = rec.frames.map((f) => {
    const o = c.update(f).features!;
    return o.left.speed < CONFIG.punch.restSpeed && o.right.speed < CONFIG.punch.restSpeed;
  });
  const n = rec.frames[0].img.length;
  const out: Jitter = [];
  for (let k = 0; k < n; k++) {
    const per: number[] = [];
    for (const set of ['img', 'world'] as const) {
      for (const ax of ['x', 'y', 'z'] as const) {
        const d: number[] = [];
        for (let i = 1; i < rec.frames.length - 1; i++) {
          if (!(still[i - 1] && still[i] && still[i + 1])) continue;
          const a = rec.frames[i - 1][set][k][ax], b = rec.frames[i][set][k][ax], e = rec.frames[i + 1][set][k][ax];
          d.push(Math.abs(e - 2 * b + a));
        }
        d.sort((x, y) => x - y);
        // Median absolute value of a zero-mean Gaussian is 0.6745 sigma.
        per.push(d.length ? d[Math.floor(d.length / 2)] / 0.6745 / Math.sqrt(6) : 0);
      }
    }
    out.push(per);
  }
  return out;
}

/** Seeded Gaussian noise (mulberry32 and Box-Muller), so every run sees the same jitter. */
function gauss(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
}

/**
 * The clip replayed `factor` times faster in frame rate: frames on an even grid at the clip's mean
 * frame gap over factor, landmarks interpolated linearly, plus the jitter top-up described above
 * (none without jitter).
 */
export function upsample(rec: Recording, factor: number, jitter: Jitter | null, seed = 1): Recording {
  const fr = rec.frames;
  const step = (fr.at(-1)!.t - fr[0].t) / (fr.length - 1) / factor;
  const rnd = gauss(seed);
  const out: PoseFrame[] = [];
  let j = 1;
  for (let t = fr[0].t; t <= fr.at(-1)!.t; t += step) {
    while (j < fr.length - 1 && fr[j].t < t) j++;
    const a = fr[j - 1], b = fr[j];
    const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
    const top = Math.sqrt(2 * u * (1 - u));
    const mix = (p: Lm[], q: Lm[], o: number): Lm[] => p.map((x, k) => {
      const sd = jitter ? jitter[k] : null;
      const n = (i: number) => (sd && top > 0 ? sd[o + i] * top * rnd() : 0);
      return { x: x.x + (q[k].x - x.x) * u + n(0), y: x.y + (q[k].y - x.y) * u + n(1), z: x.z + (q[k].z - x.z) * u + n(2), v: x.v + (q[k].v - x.v) * u };
    });
    out.push({ t, img: mix(a.img, b.img, 0), world: mix(a.world, b.world, 3) });
  }
  return { ...rec, frames: out };
}

const MATCH = 350;
interface Clip { file: string; rec: Recording; hand: Hand | null; label: Label; reps: number[] }
interface Item { clip: string; seg: Segment; label: Label }
interface Tally { hit: number; ok: number; extra: number; delay: number[] }
type Fire = Punch & { at: number; fireT: number };
const tallyOf = (): Tally => ({ hit: 0, ok: 0, extra: 0, delay: [] });
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

function items(c: Clip): Item[] {
  const out = segmentsOf(c.rec).filter(passesGate).map((seg): Item => ({ clip: c.file, seg, label: 'none' }));
  for (const r of c.reps) {
    const m = out.filter((x) => x.seg.hand === c.hand && x.label === 'none' && Math.abs(x.seg.peakT - r) <= MATCH).sort((a, b) => Math.abs(a.seg.peakT - r) - Math.abs(b.seg.peakT - r))[0];
    if (m) m.label = c.label;
  }
  return out;
}

function train(xs: Item[]): (s: Segment) => Punch | null {
  const samples = xs.map((x) => ({ hand: x.seg.hand, label: x.label, v: vector(x.seg) }));
  if (!samples.some((s) => s.label !== 'none')) return () => null;
  const m = new KnnModel(samples);
  return (s) => m.decide(s, 'orthodox');
}

/** Fired punches; with no decide the hand-written rules decide. */
export function fires(rec: Recording, decide?: (s: Segment) => Punch | null): Fire[] {
  const c = new Classifier(rec.calibration!);
  c.stance = rec.stance ?? 'orthodox';
  if (decide) c.model = decide;
  const out: Fire[] = [];
  for (const f of rec.frames) for (const p of c.update(f).punches) out.push({ ...p, fireT: f.t });
  return out;
}

/** Guard, duck and slip onsets in a clip (no punch model). */
function onsets(rec: Recording): Record<'guard' | 'duck' | 'slipLeft' | 'slipRight', number> {
  const c = new Classifier(rec.calibration!);
  const n = { guard: 0, duck: 0, slipLeft: 0, slipRight: 0 };
  let prev = { ...n };
  for (const f of rec.frames) {
    const d = c.update(f).defense;
    const cur = { guard: +d.guard, duck: +d.duck, slipLeft: +(d.slip === 'left'), slipRight: +(d.slip === 'right') };
    for (const k of Object.keys(n) as (keyof typeof n)[]) if (cur[k] && !prev[k]) n[k]++;
    prev = cur;
  }
  return n;
}

/** Scores the fires near one rep: the nearest fire of the rep's hand is the rep, anything else near it is extra. */
function tally(t: Tally, got: Fire[], c: Clip, r: number): void {
  const mine = got.filter((p) => Math.abs(p.at - r) <= MATCH && c.reps.every((o) => Math.abs(p.at - r) <= Math.abs(p.at - o)));
  const win = mine.filter((p) => p.hand === c.hand).sort((a, b) => Math.abs(a.at - r) - Math.abs(b.at - r));
  if (win.length) {
    t.hit++;
    t.delay.push(win[0].fireT - win[0].at);
    if (kindOf(win[0].type) === c.label) t.ok++;
  }
  t.extra += mine.length - (win.length ? 1 : 0);
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const seed = Number(args[args.indexOf('--seed') + 1]) || 1;
  const fixtures = loadFixtures();
  const guard = fixtures.find((f) => f.file.endsWith('-guard.json'));
  const scale = Number(args[args.indexOf('--jitter-scale') + 1]) || 1;
  const jitter = args.includes('--no-jitter') || !guard ? null : measureJitter(guard.rec).map((v) => v.map((x) => x * scale));
  if (jitter && verbose) {
    const names: [string, number][] = [['nose', 0], ['l wrist', 15], ['r wrist', 16], ['l elbow', 13], ['l index', 19]];
    console.log(`jitter (img x/y in frame heights, world x/y/z in m): ${names.map(([n, k]) => `${n} ${jitter[k].filter((_, i) => i !== 2).map((v) => v.toFixed(4)).join('/')}`).join(', ')}`);
  }
  const base: Clip[] = fixtures.map(({ file, rec }) => {
    const type = rec.expected?.[0];
    return { file, rec, hand: type ? handFor(type, rec.stance ?? 'orthodox') : null, label: type ? kindOf(type) : 'none', reps: fixtureReps(file).map((t) => rec.frames[0].t + t * 1000) };
  });
  const nativeItems = base.flatMap(items);
  for (const factor of [1, 2, 2.4]) {
    const clips = factor === 1 ? base : base.map((c, i) => ({ ...c, rec: upsample(c.rec, factor, jitter, seed + i) }));
    const all = factor === 1 ? nativeItems : clips.flatMap(items);
    const same = tallyOf(), native = tallyOf(), rules = tallyOf();
    let reps = 0, found = 0, stray = 0, rulesStray = 0, defense = 0, rulesDefense = 0;
    const per: string[] = [];
    const fps = (c: Clip) => (c.rec.frames.length - 1) / ((c.rec.frames.at(-1)!.t - c.rec.frames[0].t) / 1000);
    const meanFps = clips.reduce((s, c) => s + fps(c), 0) / clips.length;
    for (const c of clips) {
      const ruled = fires(c.rec);
      const away = (got: Fire[]) => got.filter((p) => c.reps.every((r) => Math.abs(p.at - r) > MATCH)).length;
      if (!c.reps.length) {
        defense += fires(c.rec, train(all)).length;
        rulesDefense += ruled.length;
        continue;
      }
      let n = 0;
      for (const r of c.reps) {
        reps++;
        if (all.some((x) => x.clip === c.file && x.label !== 'none' && Math.abs(x.seg.peakT - r) <= MATCH)) {
          found++;
          n++;
        }
        const keep = (x: Item) => !(x.clip === c.file && Math.abs(x.seg.peakT - r) < 600);
        const got = fires(c.rec, train(all.filter(keep)));
        tally(same, got, c, r);
        tally(native, factor === 1 ? got : fires(c.rec, train(nativeItems.filter(keep))), c, r);
        tally(rules, ruled, c, r);
      }
      stray += away(fires(c.rec, train(all)));
      rulesStray += away(ruled);
      per.push(`${c.file.replace(/^orthodox-/, '').replace('.json', '')} ${n}/${c.reps.length}`);
    }
    const p = (x: number) => `${x}/${reps}`;
    const t = (x: Tally) => `fired ${p(x.hit)} right ${p(x.ok)} extra ${x.extra}`;
    console.log(`${`${factor}x (${meanFps.toFixed(0)} fps)`.padEnd(13)} found ${p(found)} | same-rate ${t(same)} | native-taught ${t(native)} | rules ${t(rules)} | stray ${stray}/${rulesStray} | defense fires ${defense}/${rulesDefense}`);
    // Shape of the found reps: top gate speed, rest to peak, peak to the end of the motion; and how long after the peak they fired.
    const found2 = all.filter((x) => x.label !== 'none');
    console.log(`${''.padEnd(13)} gated motions ${all.length}, reps: top speed med ${med(found2.map((x) => x.seg.maxSpeed)).toFixed(2)} sw/s, rest to peak ${med(found2.map((x) => x.seg.peakT - x.seg.startT)).toFixed(0)} ms, peak to end ${med(found2.map((x) => x.seg.endT - x.seg.peakT)).toFixed(0)} ms, fired ${med(same.delay).toFixed(0)} ms after the peak`);
    // Defense onsets: each defense clip's own move, and ducks in the punch clips.
    const own = (id: string, k: keyof ReturnType<typeof onsets>) => {
      const c = clips.find((x) => x.file.endsWith(`-${id}.json`));
      return c ? onsets(c.rec)[k] : NaN;
    };
    const ducks = clips.filter((c) => c.reps.length).reduce((n, c) => n + onsets(c.rec).duck, 0);
    console.log(`${''.padEnd(13)} defense onsets: guard ${own('guard', 'guard')}, duck ${own('duck', 'duck')}, slip left ${own('slip-left', 'slipLeft')}, slip right ${own('slip-right', 'slipRight')}, ducks in punch clips ${ducks}`);
    if (verbose) console.log(`   ${per.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
