// Speed robustness: replays the fixture clips with frames dropped (each punch spans fewer frames,
// like a faster punch or a slower camera) and counts how many hand-checked reps the segmenter and
// gate still catch, and how well the k-NN reads them (leave one rep out, at that frame rate).
// Usage: npx tsx scripts/eval-speed.ts
import { passesGate } from '../client/src/tracking/classifier.ts';
import { KnnModel, kindOf, vector } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { fixtureReps, loadFixtures, segmentsOf } from './eval-core.ts';

const fixtures = loadFixtures();
for (const step of [1, 2, 3]) {
  let caught = 0, wanted = 0;
  const per: string[] = [];
  const items: { clip: string; seg: ReturnType<typeof segmentsOf>[number]; label: ReturnType<typeof kindOf> | 'none' }[] = [];
  for (const { file, rec } of fixtures) {
    const segs = segmentsOf(rec, rec.frames.filter((_, i) => i % step === 0)).filter(passesGate);
    const mine = segs.map((seg) => ({ clip: file, seg, label: 'none' as ReturnType<typeof kindOf> | 'none' }));
    items.push(...mine);
    const type = rec.expected?.[0];
    if (!type) continue;
    const hand = handFor(type, rec.stance ?? 'orthodox');
    let n = 0;
    for (const t of fixtureReps(file)) {
      const at = rec.frames[0].t + t * 1000;
      const m = mine.filter((x) => x.seg.hand === hand && x.label === 'none' && Math.abs(x.seg.peakT - at) <= 350).sort((a, b) => Math.abs(a.seg.peakT - at) - Math.abs(b.seg.peakT - at))[0];
      if (m) {
        m.label = kindOf(type);
        n++;
      }
      wanted++;
    }
    caught += n;
    per.push(`${file.replace(/^orthodox-/, '').replace('.json', '')} ${n}/${fixtureReps(file).length}`);
  }
  let ok = 0, reps = 0;
  for (const x of items.filter((i) => i.label !== 'none')) {
    const train = items.filter((o) => o !== x && !(o.clip === x.clip && Math.abs(o.seg.peakT - x.seg.peakT) < 600));
    const p = new KnnModel(train.map((o) => ({ hand: o.seg.hand, label: o.label, v: vector(o.seg) }))).predict(x.seg.hand, vector(x.seg)).label;
    reps++;
    if (p === x.label) ok++;
  }
  console.log(`every ${step} frame(s): ${caught}/${wanted} reps caught, ${ok}/${reps} read right  | ${per.join(', ')}`);
}
