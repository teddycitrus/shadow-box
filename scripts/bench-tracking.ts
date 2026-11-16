// Per-frame cost of the tracking path on the recorded data: Classifier.update (rules, and with a
// model trained from the teach session) and KnnModel.decide, with GC counts as a proxy for
// allocation pressure. Usage: npx tsx scripts/bench-tracking.ts [runs]
import { readdirSync, readFileSync } from 'node:fs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, kindOf, vector, type Sample } from '../client/src/tracking/model.ts';
import { handFor, pickReps } from '../client/src/tracking/teach.ts';
import { loadFixtures, segmentsOf, type Recording } from './eval-core.ts';

const runs = Number(process.argv[2] ?? 7);
const dir = 'tests/fixtures/sessions';
type Session = Recording & { marks: { t: number; kind: string; data?: { kind?: string; type?: never } }[] };
const sessions = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, rec: JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Session }));
const recs: Recording[] = [...loadFixtures().map((x) => x.rec), ...sessions.map((x) => x.rec)].filter((r) => r.calibration && r.frames.length);
const frames = recs.reduce((n, r) => n + r.frames.length, 0);

// The model the live game would use after this teach session (as scripts/eval-session.ts trains it).
const teach = sessions.find((s) => s.file.includes('teach'))!.rec;
const prompts = teach.marks.filter((m) => m.kind === 'teachStep');
const tsegs = segmentsOf(teach).filter(passesGate);
const samples: Sample[] = [];
for (let i = 0; i < prompts.length; i++) {
  const step = prompts[i].data as { kind?: string; type?: Parameters<typeof kindOf>[0] } | undefined;
  const inWin = tsegs.filter((x) => x.peakT >= prompts[i].t && x.peakT < (prompts[i + 1]?.t ?? Infinity));
  if (step?.kind !== 'punch' || !step.type) {
    for (const x of inWin) samples.push({ hand: x.hand, label: 'none', v: vector(x) });
    continue;
  }
  const { reps, rest } = pickReps(inWin, handFor(step.type, 'orthodox'), 5);
  for (const x of rest) samples.push({ hand: x.hand, label: 'none', v: vector(x) });
  for (const x of reps) samples.push({ hand: x.hand, label: kindOf(step.type), v: vector(x) });
}
const allSegs: Segment[] = recs.flatMap((r) => segmentsOf(r)).filter(passesGate);
// A population prior of a few hundred samples, like /api/prior serves.
const labels = ['none', 'straight', 'hook', 'uppercut'] as const;
const prior: Sample[] = [];
for (let k = 0; prior.length < 400; k++) for (const s of allSegs) prior.push({ hand: s.hand, label: labels[(prior.length + k) % 4], v: vector(s).map((x) => x + k * 0.01) });
const model = new KnnModel(samples);
const withPrior = new KnnModel(samples, undefined, undefined, prior);

let gcs = 0;
new PerformanceObserver((l) => (gcs += l.getEntries().length)).observe({ entryTypes: ['gc'] });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function bench(name: string, units: number, unit: string, fn: () => void): Promise<void> {
  for (let i = 0; i < 2; i++) fn();
  const times: number[] = [];
  let g = 0;
  for (let i = 0; i < runs; i++) {
    const g0 = gcs;
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
    await tick();
    g += gcs - g0;
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`${name.padEnd(34)} ${((med * 1000) / units).toFixed(2).padStart(8)} us/${unit}  (median of ${runs}, ${(g / runs).toFixed(1)} GCs per run of ${units} ${unit}s)`);
}

function replay(decide?: (s: Segment) => ReturnType<KnnModel['decide']>): void {
  for (const r of recs) {
    const c = new Classifier(r.calibration!);
    if (decide) c.model = decide;
    for (const f of r.frames) c.update(f);
  }
}

console.log(`${recs.length} recordings, ${frames} frames, ${allSegs.length} gated motions, ${samples.length} taught samples, ${prior.length} prior samples`);
await bench('Classifier.update, rules', frames, 'frame', () => replay());
await bench('Classifier.update, taught model', frames, 'frame', () => replay((s) => model.decide(s, 'orthodox')));
await bench('Classifier.update, model + prior', frames, 'frame', () => replay((s) => withPrior.decide(s, 'orthodox')));
await bench('KnnModel.decide, taught model', allSegs.length * 20, 'call', () => {
  for (let i = 0; i < 20; i++) for (const s of allSegs) model.decide(s, 'orthodox');
});
await bench('KnnModel.decide, model + prior', allSegs.length * 5, 'call', () => {
  for (let i = 0; i < 5; i++) for (const s of allSegs) withPrior.decide(s, 'orthodox');
});
await bench('new KnnModel (teach + prior)', 20, 'build', () => {
  for (let i = 0; i < 20; i++) new KnnModel(samples, undefined, undefined, prior);
});
