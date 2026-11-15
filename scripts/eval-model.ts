// Segment-level accuracy of the per-player k-NN on the recorded data: every hand-checked rep and
// every other gated motion, classified leave-one-out (motions within 600 ms of it held out too).
// Fast to run, so it is the one to use when tuning features or model settings.
// Usage: npx tsx scripts/eval-model.ts [--verbose]
import { readFileSync } from 'node:fs';
import { CONFIG } from '../client/src/config.ts';
import { passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, confident, kindOf, vector, type Label } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { labelledSegments, loadFixtures, segmentsOf, type Recording } from './eval-core.ts';
import { TEACH_REPS, TEACH_SESSION } from './eval-gt.ts';

const verbose = process.argv.includes('--verbose');

interface Item { set: string; clip: string; seg: Segment; label: Label; v: number[] }

const items: Item[] = loadFixtures().flatMap(({ file, rec }) =>
  labelledSegments(file, rec).map((x) => ({ set: 'fixtures', clip: file, seg: x.seg, label: x.label, v: vector(x.seg) })));

const sess = JSON.parse(readFileSync(`tests/fixtures/sessions/${TEACH_SESSION}`, 'utf8')) as Recording & { marks: { t: number; kind: string; data?: { kind?: string } }[] };
const prompts = sess.marks.filter((m) => m.kind === 'teachStep');
const from = prompts[0].t - 1500, to = (prompts.find((m) => m.data?.kind === 'duck')?.t ?? Infinity) + 4000;
const t0 = sess.frames[0].t;
const teach: Item[] = segmentsOf(sess).filter((s) => passesGate(s) && s.peakT >= from && s.peakT < to).map((seg) => ({ set: 'teach session', clip: 'teach', seg, label: 'none', v: vector(seg) }));
for (const r of TEACH_REPS) {
  const at = t0 + r.t * 1000;
  const best = teach.filter((x) => x.seg.hand === handFor(r.type, 'orthodox') && Math.abs(x.seg.peakT - at) <= 350).sort((a, b) => Math.abs(a.seg.peakT - at) - Math.abs(b.seg.peakT - at))[0];
  if (best) best.label = kindOf(r.type);
}
items.push(...teach);

function run(name: string, k: number, margin: number): void {
  const m0 = CONFIG.model.straightMargin;
  (CONFIG.model as { straightMargin: number }).straightMargin = margin;
  const parts: string[] = [];
  const details: string[] = [];
  for (const set of ['fixtures', 'teach session']) {
    const mine = items.filter((x) => x.set === set);
    let reps = 0, ok = 0, negs = 0, ff = 0;
    const conf = new Map<string, number>();
    for (const x of mine) {
      const train = mine.filter((o) => o !== x && !(o.clip === x.clip && Math.abs(o.seg.peakT - x.seg.peakT) < 600));
      const p = confident(new KnnModel(train.map((o) => ({ hand: o.seg.hand, label: o.label, v: o.v })), k).predict(x.seg.hand, x.v));
      if (x.label === 'none') {
        negs++;
        if (p !== 'none') ff++;
      } else {
        reps++;
        if (p === x.label) ok++;
        else conf.set(`${x.label} (${x.seg.hand}) -> ${p}`, (conf.get(`${x.label} (${x.seg.hand}) -> ${p}`) ?? 0) + 1);
      }
    }
    parts.push(`${set}: punch type ${ok}/${reps} (${Math.round((100 * ok) / reps)}%), false fires ${ff}/${negs}`);
    if (verbose) for (const [c, n] of [...conf].sort((a, b) => b[1] - a[1])) parts.push(`\n      ${c}: ${n}`);
  }
  (CONFIG.model as { straightMargin: number }).straightMargin = m0;
  console.log(`${name.padEnd(30)} ${parts.join('  |  ')}`);
  for (const d of details) console.log(d);
}

console.log(`gated motions: ${items.length}, labelled reps: ${items.filter((x) => x.label !== 'none').length}`);
for (const k of [1, 3]) for (const margin of [1, 1.15]) run(`k=${k}, straight margin ${margin}`, k, margin);
