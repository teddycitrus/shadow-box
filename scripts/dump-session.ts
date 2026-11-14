// Replays a saved session through the current classifier and lists every motion segment with
// the prompt that was showing. Usage: npx tsx scripts/dump-session.ts [file] [minTravel]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';

const dir = 'tests/fixtures/sessions';
const file = process.argv[2] ?? readdirSync(dir).filter((f) => f.includes('teach')).map((f) => `${dir}/${f}`).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const min = Number(process.argv[3] ?? 0.45);
const s = JSON.parse(readFileSync(file, 'utf8'));
const prompts = (s.marks as { t: number; kind: string; data?: { prompt?: string } }[]).filter((m) => m.kind === 'teachStep');
const promptAt = (t: number) => [...prompts].reverse().find((p) => p.t <= t)?.data?.prompt ?? '-';
const c = new Classifier(s.calibration);
const segs: Segment[] = [];
c.onSegment = (x) => segs.push(x);
c.model = () => null;
for (const f of s.frames) c.update(f);
const t0 = s.frames[0].t;
const f = (n: number) => n.toFixed(2).padStart(6);
console.log(`${file}  guardY=${s.calibration.guardY?.toFixed(2)} guardHead=${s.calibration.guardHead?.toFixed(2)}`);
console.log('      t prompt           h  gate   dIn   rise    fwd elb0>elb     y0>yP    hd0>hdP   r0>rP    trav    spd');
for (const x of segs.filter((x) => x.travel >= min)) {
  console.log(`${f((x.peakT - t0) / 1000)} ${promptAt(x.peakT).padEnd(16)} ${x.hand[0]} ${passesGate(x) ? ' ok ' : ' -- '} ${f(x.dIn)} ${f(x.rise)} ${f(x.fwd)} ${x.startElbow.toFixed(0).padStart(4)}>${x.elbow.toFixed(0).padEnd(3)} ${f(x.startY)}>${x.peakY.toFixed(2).padEnd(5)} ${x.startHead.toFixed(2)}>${x.peakHead.toFixed(2)} ${x.startReach.toFixed(2)}>${x.reach.toFixed(2)} ${f(x.travel)} ${f(x.maxSpeed)}`);
}
