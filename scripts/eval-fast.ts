// Fast punches: replays the fixture clips sped up (scripts/fast-sim.ts) through the live classifier
// and counts the hand-checked reps that fire, read right, and the extra fires. Each rep is read by
// a model trained on every other rep (leave one rep out, its slow and fast versions both left out):
//   slow-taught: trained on the clips at their recorded pace only (the old calibration).
//   fast-taught: also trained on the sped-up reps (the calibration's fast pass).
// Stray: fires in the punch clips away from every rep (model trained on all of it). The defense
// clips are sped up whole; any fire there is false (slow-taught/fast-taught).
// Usage: npx tsx scripts/eval-fast.ts [--verbose]
import { CONFIG } from '../client/src/config.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, kindOf, vector, type Label } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import type { Hand, Punch } from '../shared/types.ts';
import { fixtureReps, loadFixtures, segmentsOf, type Recording } from './eval-core.ts';
import { speedUp, type FastOptions } from './fast-sim.ts';

const verbose = process.argv.includes('--verbose');
const MATCH = 350;

interface Clip { file: string; rec: Recording; hand: Hand | null; label: Label; reps: number[] }
interface Item { clip: Clip; seg: Segment; label: Label }

const base: Clip[] = loadFixtures().map(({ file, rec }) => {
  const type = rec.expected?.[0];
  const reps = fixtureReps(file).map((t) => rec.frames[0].t + t * 1000);
  return { file, rec, hand: type ? handFor(type, rec.stance ?? 'orthodox') : null, label: type ? kindOf(type) : 'none', reps };
});

function items(c: Clip): Item[] {
  const segs = segmentsOf(c.rec).filter(passesGate);
  const out = segs.map((seg): Item => ({ clip: c, seg, label: 'none' }));
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

function fires(rec: Recording, decide: (s: Segment) => Punch | null): (Punch & { at: number })[] {
  const c = new Classifier(rec.calibration!);
  c.model = decide;
  const out: (Punch & { at: number })[] = [];
  for (const f of rec.frames) out.push(...c.update(f).punches);
  return out;
}

const slowItems = base.flatMap(items);

interface Result { stray: number; seen: number; reps: number; slow: { hit: number; ok: number; extra: number }; fast: { hit: number; ok: number; extra: number }; defSlow: number; defFast: number; defMin: number }

function scenario(name: string, o: FastOptions): Result {
  const fastClips: Clip[] = base.map((c) => {
    const s = speedUp(c.rec, c.reps, c.reps.length ? o : { ...o, whole: true });
    return { ...c, rec: s.rec, reps: s.reps };
  });
  const fastItems = fastClips.flatMap(items);
  const res: Result = { stray: 0, seen: 0, reps: 0, slow: { hit: 0, ok: 0, extra: 0 }, fast: { hit: 0, ok: 0, extra: 0 }, defSlow: 0, defFast: 0, defMin: 0 };
  const per: string[] = [];
  base.forEach((c, ci) => {
    const fc = fastClips[ci];
    if (!c.reps.length) {
      res.defSlow += fires(fc.rec, train(slowItems)).length;
      res.defFast += fires(fc.rec, train([...slowItems, ...fastItems])).length;
      res.defMin += (fc.rec.frames.at(-1)!.t - fc.rec.frames[0].t) / 60000;
      return;
    }
    let caught = 0;
    c.reps.forEach((r, ri) => {
      const fr = fc.reps[ri];
      res.reps++;
      if (fastItems.some((x) => x.clip === fc && x.label !== 'none' && Math.abs(x.seg.peakT - fr) <= MATCH)) {
        res.seen++;
        caught++;
      }
      const keepSlow = (x: Item) => !(x.clip === c && Math.abs(x.seg.peakT - r) < 600);
      const keepFast = (x: Item) => !(x.clip === fc && Math.abs(x.seg.peakT - fr) < 600 / o.factor);
      // Like the calibration's fast pass: at most fastReps fast reps of each punch (never the one read).
      const fastTaught = fastClips.flatMap((k) => {
        const mine = fastItems.filter((x) => x.clip === k && keepFast(x));
        return [...mine.filter((x) => x.label === 'none'), ...mine.filter((x) => x.label !== 'none').slice(0, CONFIG.model.fastReps)];
      });
      for (const [key, decide] of [['slow', train(slowItems.filter(keepSlow))], ['fast', train([...slowItems.filter(keepSlow), ...fastTaught])]] as const) {
        const got = fires(fc.rec, decide);
        // Fires that belong to this rep: nearer to it than to any other rep of the clip.
        const mine = got.filter((p) => Math.abs(p.at - fr) <= MATCH && fc.reps.every((o) => Math.abs(p.at - fr) <= Math.abs(p.at - o)));
        const win = mine.filter((p) => p.hand === c.hand).sort((a, b) => Math.abs(a.at - fr) - Math.abs(b.at - fr));
        if (win.length) {
          res[key].hit++;
          if (kindOf(win[0].type) === c.label) res[key].ok++;
        }
        // Anything else near it (either hand) is extra.
        res[key].extra += mine.length - (win.length ? 1 : 0);
      }
    });
    // Stray fires anywhere in the clip, away from every rep (model trained on everything).
    res.stray += fires(fc.rec, train([...slowItems, ...fastItems])).filter((p) => fc.reps.every((r) => Math.abs(p.at - r) > MATCH)).length;
    per.push(`${c.file.replace(/^orthodox-/, '').replace('.json', '')} ${caught}/${c.reps.length}`);
  });
  const p = (n: number) => `${n}/${res.reps}`;
  console.log(`${name.padEnd(30)} gate ${p(res.seen).padEnd(6)} | slow-taught fired ${p(res.slow.hit)} right ${p(res.slow.ok)} extra ${res.slow.extra} | fast-taught fired ${p(res.fast.hit)} right ${p(res.fast.ok)} extra ${res.fast.extra} | stray ${res.stray} | defense fires ${res.defSlow}/${res.defFast} in ${res.defMin.toFixed(1)} min`);
  if (verbose) console.log(`   ${per.join(', ')}`);
  return res;
}

export const SCENARIOS: [string, FastOptions][] = [
  ['recorded pace', { factor: 1 }],
  ['punches 2x faster', { factor: 2 }],
  ['punches 3x faster', { factor: 3 }],
  ['3x + tracker lag', { factor: 3, lag: 0.6 }],
  ['3x + lag + wrist blur', { factor: 3, lag: 0.7, blurSpeed: 8, blurLag: 0.4 }],
  ['whole clip 2x (doubles)', { factor: 2, whole: true }],
  ['whole clip 3x + blur', { factor: 3, whole: true, blurSpeed: 8, blurLag: 0.4 }],
];
for (const [name, o] of SCENARIOS) scenario(name, o);
