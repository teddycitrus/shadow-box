// Speed robustness: replays clips with frames dropped (each punch spans fewer frames, like a faster
// punch) and counts how many reps the segmenter and gate still catch. Usage: npx tsx scripts/eval-speed.ts
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { loadFixtures } from './eval-core.ts';

for (const step of [1, 2, 3]) {
  let caught = 0, wanted = 0;
  const per: string[] = [];
  for (const { file, rec } of loadFixtures()) {
    const type = rec.expected?.[0];
    if (!type) continue;
    const hand = handFor(type, rec.stance ?? 'orthodox');
    const c = new Classifier(rec.calibration!);
    c.model = () => null;
    const segs: Segment[] = [];
    c.onSegment = (s) => segs.push(s);
    rec.frames.filter((_, i) => i % step === 0).forEach((f) => c.update(f));
    const hits = segs.filter((s) => s.hand === hand && passesGate(s)).sort((a, b) => a.peakT - b.peakT);
    const distinct = hits.filter((s, i) => i === 0 || s.peakT - hits[i - 1].peakT > 450).length;
    caught += Math.min(distinct, rec.reps ?? 5);
    wanted += rec.reps ?? 5;
    per.push(`${file.replace('orthodox-', '').replace('.json', '')} ${Math.min(distinct, 5)}`);
  }
  console.log(`every ${step} frame(s): ${caught}/${wanted} reps caught  | ${per.join(', ')}`);
}
