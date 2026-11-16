// Prints every motion decision of one fixture clip sped up by fast-sim, with the mapped rep times.
// Usage: npx tsx scripts/dump-fast.ts jab-head 2 [whole] [lag] [blur]
import { Classifier } from '../client/src/tracking/classifier.ts';
import { fixtureReps, loadFixtures } from './eval-core.ts';
import { speedUp } from './fast-sim.ts';

const [id, factor = '2', ...flags] = process.argv.slice(2);
const { file, rec } = loadFixtures().find((f) => f.file.includes(id))!;
const t0 = rec.frames[0].t;
const s = speedUp(rec, fixtureReps(file).map((t) => t0 + t * 1000), {
  factor: Number(factor), whole: flags.includes('whole'),
  lag: flags.includes('lag') ? 0.6 : undefined, blurSpeed: flags.includes('blur') ? 8 : undefined, blurLag: 0.4,
});
console.log(`reps at ${s.reps.map((r) => ((r - t0) / 1000).toFixed(2)).join(' ')}`);
const c = new Classifier(rec.calibration!);
c.model = () => null;
c.onDecision = (seg, _p, why) => console.log(`${((seg.peakT - t0) / 1000).toFixed(2)} start ${((seg.startT - t0) / 1000).toFixed(2)} spd ${seg.maxSpeed.toFixed(1)} ${why}`);
c.onIgnored = (hand, t, why) => console.log(`${((t - t0) / 1000).toFixed(2)} ignored ${hand}: ${why}`);
for (const f of s.rec.frames) c.update(f);
