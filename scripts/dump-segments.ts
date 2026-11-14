// Prints every motion segment of the fixtures matching a filter. Usage: npx tsx scripts/dump-segments.ts jab-head [minTravel]
import { readdirSync, readFileSync } from 'node:fs';
import { Classifier, type Segment } from '../client/src/tracking/classifier.ts';

const filter = process.argv[2] ?? '';
const min = Number(process.argv[3] ?? 0.45);
for (const file of readdirSync('tests/fixtures').filter((f) => f.endsWith('.json') && f.includes(filter))) {
  const rec = JSON.parse(readFileSync(`tests/fixtures/${file}`, 'utf8'));
  const c = new Classifier(rec.calibration);
  const segs: Segment[] = [];
  c.onSegment = (s) => segs.push(s);
  c.model = () => null;
  for (const f of rec.frames) c.update(f);
  console.log(`== ${file}`);
  const t0 = rec.frames[0].t;
  const f = (n: number) => n.toFixed(2).padStart(6);
  console.log('     t h    dIn   rise    fwd   fwdC elb0>elb    y0>yP     hd0>hdP   r0>rP     scG   trav    spd     up  dur');
  for (const s of segs.filter((x) => x.travel >= min)) {
    console.log(`${f((s.peakT - t0) / 1000)} ${s.hand[0]} ${f(s.dIn)} ${f(s.rise)} ${f(s.fwd)} ${f(s.forward)} ${s.startElbow.toFixed(0).padStart(4)}>${s.elbow.toFixed(0).padEnd(3)} ${f(s.startY)}>${s.peakY.toFixed(2).padEnd(5)} ${s.startHead.toFixed(2)}>${s.peakHead.toFixed(2)} ${s.startReach.toFixed(2)}>${s.reach.toFixed(2)} ${f(s.scaleGain)} ${f(s.travel)} ${f(s.maxSpeed)} ${f(s.maxUp)} ${(s.peakT - s.startT).toFixed(0).padStart(4)}`);
  }
}
