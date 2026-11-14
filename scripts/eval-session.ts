// Trains the per-player model from a saved teach session (labels from the prompts) and replays
// saved play sessions through it, comparing punch gates.
// Usage: npx tsx scripts/eval-session.ts [teachFile] [playFile...]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { CONFIG } from '../client/src/config.ts';
import { Classifier, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, vector, type Label, type Sample } from '../client/src/tracking/model.ts';
import { handFor, teachSteps } from '../client/src/tracking/teach.ts';

const dir = 'tests/fixtures/sessions';
const newest = (k: string) => readdirSync(dir).filter((f) => f.includes(k)).map((f) => `${dir}/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const teachFile = process.argv[2] ?? newest('teach')[0];
const playFiles = process.argv.length > 3 ? process.argv.slice(3) : [...newest('play'), ...newest('match')];

interface Session { calibration: any; frames: any[]; marks: { t: number; kind: string; data?: any }[]; stance?: 'orthodox' | 'southpaw' }
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Session;

function segments(s: Session): Segment[] {
  const c = new Classifier(s.calibration);
  const out: Segment[] = [];
  c.onSegment = (x) => out.push(x);
  c.model = () => null;
  for (const f of s.frames) c.update(f);
  return out;
}

const gates: Record<string, (s: Segment) => boolean> = {
  elbow: (s) => s.travel >= CONFIG.punch.minTravel && s.elbow - s.startElbow >= 15,
  guard: (s) => s.travel >= CONFIG.punch.minTravel && s.fromGuard,
};

const teach = load(teachFile);
const steps = teachSteps();
const prompts = teach.marks.filter((m) => m.kind === 'teachStep');
const tsegs = segments(teach);
console.log(`teach: ${teachFile}`);

for (const [gname, gate] of Object.entries(gates)) {
  const samples: Sample[] = [];
  let taught = 0;
  for (let i = 0; i < prompts.length; i++) {
    const step = steps.find((x) => x.prompt === prompts[i].data?.prompt);
    const from = prompts[i].t, to = prompts[i + 1]?.t ?? Infinity;
    const inWin = tsegs.filter((x) => x.peakT >= from && x.peakT < to && gate(x));
    if (!step || step.kind !== 'punch') {
      for (const x of inWin) samples.push({ hand: x.hand, label: 'none', v: vector(x) });
      continue;
    }
    const hand = handFor(step.type!, teach.stance ?? 'orthodox');
    const mine = inWin.filter((x) => x.hand === hand).sort((a, b) => b.maxSpeed * b.travel - a.maxSpeed * a.travel);
    const picked: Segment[] = [];
    for (const x of mine) if (picked.length < 3 && picked.every((p) => Math.abs(p.peakT - x.peakT) > 300)) picked.push(x);
    taught += picked.length;
    for (const x of inWin) samples.push({ hand: x.hand, label: picked.includes(x) ? (`${step.type}:${step.target}` as Label) : 'none', v: vector(x) });
  }
  const pos = samples.filter((x) => x.label !== 'none');
  let loo = 0;
  for (const x of pos) if (new KnnModel(samples.filter((o) => o !== x), 3).predict(x.hand, x.v).label === x.label) loo++;
  const model = new KnnModel(samples, 3);
  const plays = playFiles.map((f) => {
    const p = load(f);
    const segs = segments(p).filter(gate);
    const fires = segs.map((x) => model.predict(x.hand, vector(x)).label).filter((l) => l !== 'none');
    const dur = (p.frames.at(-1).t - p.frames[0].t) / 60000;
    const counts: Record<string, number> = {};
    for (const l of fires) counts[l] = (counts[l] ?? 0) + 1;
    return `${f.split('/').pop()!.slice(8, 13)}: ${segs.length} gated motions, ${fires.length} fires (${(fires.length / dur).toFixed(0)}/min) ${JSON.stringify(counts)}`;
  });
  console.log(`\n[${gname} gate] taught ${taught}/24 reps, ${samples.length - pos.length} non-punch samples, leave-one-out ${loo}/${pos.length}`);
  for (const l of plays) console.log(`  ${l}`);
}
