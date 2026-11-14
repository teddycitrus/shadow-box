// Compares the hand-written rules with the per-player k-NN on recorded clips in tests/fixtures/.
// Usage: npx tsx scripts/eval-model.ts [--verbose]
import { readdirSync, readFileSync } from 'node:fs';
import type { Hand, PunchType, Target } from '../shared/types.ts';
import type { Calibration } from '../client/src/tracking/calibration.ts';
import { Classifier, ruleDecision, type Segment } from '../client/src/tracking/classifier.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { KnnModel, labelOf, vector, type Label, type Sample } from '../client/src/tracking/model.ts';

const verbose = process.argv.includes('--verbose');
const REPS = 5;

interface Rec { calibration: Calibration; frames: PoseFrame[]; expected?: PunchType[]; expectedTarget?: Target; defense?: string; stance?: 'orthodox' | 'southpaw' }
interface Seg { clip: string; seg: Segment; label: Label; rep: number }

function handFor(type: PunchType, stance: string): Hand {
  if (type === 'jab') return stance === 'orthodox' ? 'left' : 'right';
  if (type === 'cross') return stance === 'orthodox' ? 'right' : 'left';
  return type.startsWith('left') ? 'left' : 'right';
}

/** Every motion in a clip, with the strongest REPS motions of the expected hand labelled as the move. */
export function labelledSegments(file: string, rec: Rec): Seg[] {
  const c = new Classifier(rec.calibration);
  c.stance = rec.stance ?? 'orthodox';
  const segs: Segment[] = [];
  c.onSegment = (s) => segs.push(s);
  c.model = () => null;
  for (const f of rec.frames) c.update(f);
  const out: Seg[] = segs.map((seg) => ({ clip: file, seg, label: 'none', rep: -1 }));
  const type = rec.expected?.[0];
  if (type && rec.expected!.length) {
    const hand = handFor(type, rec.stance ?? 'orthodox');
    const ranked = out.filter((s) => s.seg.hand === hand && gate(s.seg)).sort((a, b) => b.seg.maxSpeed * b.seg.travel - a.seg.maxSpeed * a.seg.travel);
    const picked: Seg[] = [];
    for (const s of ranked) {
      if (picked.length >= REPS) break;
      if (picked.every((p) => Math.abs(p.seg.peakT - s.seg.peakT) > 450)) picked.push(s);
    }
    picked.sort((a, b) => a.seg.peakT - b.seg.peakT).forEach((s, i) => {
      s.label = `${type}:${rec.expectedTarget ?? 'head'}` as Label;
      s.rep = i;
    });
  }
  return out;
}

/** Camera-independent punch gate: the arm must open up by a clear margin. */
function gate(s: Segment): boolean {
  return s.travel >= 0.45 && s.elbow - s.startElbow >= 15;
}

const all: Seg[] = [];
for (const file of readdirSync('tests/fixtures').filter((f) => f.endsWith('.json'))) {
  const rec = JSON.parse(readFileSync(`tests/fixtures/${file}`, 'utf8')) as Rec;
  const segs = labelledSegments(file, rec);
  all.push(...segs);
  if (verbose) {
    const t0 = rec.frames[0].t;
    console.log(file, segs.filter((s) => s.label !== 'none').map((s) => ((s.seg.peakT - t0) / 1000).toFixed(2)).join(' '));
  }
}

const pos = all.filter((s) => s.label !== 'none');
const neg = all.filter((s) => s.label === 'none' && gate(s.seg));
const gated = all.filter((s) => gate(s.seg));
console.log(`segments: ${all.length}, past the gate: ${gated.length} (${pos.length} punches, ${neg.length} non-punches)`);

function report(name: string, predict: (s: Seg) => Label): void {
  const hit = pos.filter((s) => predict(s) === s.label).length;
  const typeHit = pos.filter((s) => predict(s).split(':')[0] === s.label.split(':')[0]).length;
  const fp = neg.filter((s) => predict(s) !== 'none').length;
  console.log(`${name.padEnd(28)} punch exact ${hit}/${pos.length} (${((100 * hit) / pos.length).toFixed(0)}%)  type ${typeHit}/${pos.length}  false fires ${fp}/${neg.length}`);
  if (verbose) {
    const confusion = new Map<string, number>();
    for (const s of pos) {
      const p = predict(s);
      if (p !== s.label) confusion.set(`${s.label} -> ${p}`, (confusion.get(`${s.label} -> ${p}`) ?? 0) + 1);
    }
    for (const [k, v] of [...confusion].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  }
}

report('rules (current config)', (s) => labelOf(ruleDecision(s.seg, 'orthodox')));

const sample = (s: Seg): Sample => ({ hand: s.seg.hand, label: s.label, v: vector(s.seg) });
for (const k of [1, 3, 5]) {
  report(`knn k=${k} leave-one-out`, (s) => new KnnModel(gated.filter((o) => o !== s).map(sample), k).predict(s.seg.hand, vector(s.seg)).label);
}

// Simulated 60 s calibration: 3 reps of each move as training, the other reps as test.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (const shots of [2, 3]) {
  let hit = 0, total = 0, fp = 0, negTotal = 0;
  for (let trial = 0; trial < 30; trial++) {
    const train: Seg[] = [];
    const test: Seg[] = [];
    for (const clip of new Set(pos.map((s) => s.clip))) {
      const reps = pos.filter((s) => s.clip === clip).sort(() => rand() - 0.5);
      train.push(...reps.slice(0, shots));
      test.push(...reps.slice(shots));
      const trainUntil = Math.max(...reps.slice(0, shots).map((s) => s.seg.endT));
      for (const n of neg.filter((s) => s.clip === clip)) (n.seg.endT <= trainUntil ? train : test).push(n);
    }
    const negs = new Set(neg.map((s) => s.clip));
    for (const clip of negs) if (!pos.some((s) => s.clip === clip)) {
      const ns = neg.filter((s) => s.clip === clip);
      const half = Math.floor(ns.length / 2);
      train.push(...ns.slice(0, half));
      test.push(...ns.slice(half));
    }
    const m = new KnnModel(train.map(sample), 3);
    for (const s of test) {
      const p = m.predict(s.seg.hand, vector(s.seg)).label;
      if (s.label === 'none') {
        negTotal++;
        if (p !== 'none') fp++;
      } else {
        total++;
        if (p === s.label) hit++;
      }
    }
  }
  console.log(`knn k=3 ${shots}-shot calibration     punch exact ${((100 * hit) / total).toFixed(0)}%  false fires ${((100 * fp) / negTotal).toFixed(0)}% of non-punches`);
}

import { labelledSegments as ls2, loadFixtures, scoreCalibration } from './eval-core.ts';
const core = loadFixtures().flatMap(({ file, rec }) => ls2(file, rec));
for (const shots of [2, 3]) {
  const s = scoreCalibration(core, shots);
  console.log(`chronological ${shots}-shot calibration: punch exact ${s.exact}/${s.punches} (${((100 * s.exact) / s.punches).toFixed(0)}%), false fires ${s.falseFires}/${s.nonPunches}`);
}
