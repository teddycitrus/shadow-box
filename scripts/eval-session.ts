// Trains the per-player model from a saved teach session the way the live teacher picks reps
// (pickReps on each prompt's motions, everything else a non-punch), then replays the play part of
// saved play sessions through the classifier and reports what fired.
// Usage: npx tsx scripts/eval-session.ts [teachFile] [playFile...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Punch } from '../shared/types.ts';
import { Classifier, passesGate } from '../client/src/tracking/classifier.ts';
import { KnnModel, headHeight, headLineFrom, kindOf, vector, type Sample } from '../client/src/tracking/model.ts';
import { handFor, pickReps, type TeachStep } from '../client/src/tracking/teach.ts';
import { segmentsOf, type Recording } from './eval-core.ts';

const dir = 'tests/fixtures/sessions';
const newest = (k: string) => readdirSync(dir).filter((f) => f.includes(k)).map((f) => `${dir}/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const teachFile = process.argv[2] ?? newest('teach')[0];
const playFiles = process.argv.length > 3 ? process.argv.slice(3) : newest('play').slice(0, 1);

type Session = Recording & { marks: { t: number; kind: string; data?: Partial<TeachStep> }[] };
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Session;

const teach = load(teachFile);
const prompts = teach.marks.filter((m) => m.kind === 'teachStep');
const segs = segmentsOf(teach).filter(passesGate);
const samples: Sample[] = [];
const straights: { hand: 'left' | 'right'; h: number; target: 'head' | 'body' }[] = [];
let taught = 0;
for (let i = 0; i < prompts.length; i++) {
  // The step as recorded: older sessions used other step ids and targets.
  const step = prompts[i].data;
  const inWin = segs.filter((x) => x.peakT >= prompts[i].t && x.peakT < (prompts[i + 1]?.t ?? Infinity));
  if (!step || step.kind !== 'punch') {
    for (const x of inWin) samples.push({ hand: x.hand, label: 'none', v: vector(x) });
    continue;
  }
  const { reps, rest } = pickReps(inWin, handFor(step.type!, teach.stance ?? 'orthodox'), 5);
  taught += reps.length;
  for (const x of rest) samples.push({ hand: x.hand, label: 'none', v: vector(x) });
  for (const x of reps) {
    samples.push({ hand: x.hand, label: kindOf(step.type!), v: vector(x) });
    if (kindOf(step.type!) === 'straight') straights.push({ hand: x.hand, h: headHeight(x), target: step.target! });
  }
}
const model = new KnnModel(samples);
const line = headLineFrom(straights);
console.log(`teach: ${teachFile}\ntaught ${taught} reps, ${samples.length - taught} non-punch samples`);

for (const f of playFiles) {
  const p = load(f);
  const from = p.marks.find((m) => m.kind === 'teachDone')?.t ?? p.frames[0].t;
  const c = new Classifier(p.calibration!);
  c.model = (s) => model.decide(s, 'orthodox', line);
  const fired: Punch[] = [];
  for (const fr of p.frames) {
    const out = c.update(fr);
    if (fr.t >= from) fired.push(...out.punches);
  }
  const min = (p.frames.at(-1)!.t - from) / 60000;
  const counts: Record<string, number> = {};
  for (const x of fired) counts[`${x.type}:${x.target}`] = (counts[`${x.type}:${x.target}`] ?? 0) + 1;
  console.log(`${f.split('/').pop()}: ${(min * 60).toFixed(0)} s of play, ${fired.length} punches (${(fired.length / min).toFixed(0)}/min) ${JSON.stringify(counts)}`);
}
