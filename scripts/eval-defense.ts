// Counts guard, duck and slip onsets per recorded clip. Usage: npx tsx scripts/eval-defense.ts
import { Classifier } from '../client/src/tracking/classifier.ts';
import { loadFixtures } from './eval-core.ts';

for (const { file, rec } of loadFixtures()) {
  const c = new Classifier(rec.calibration!);
  const on = { guard: 0, duck: 0, slipLeft: 0, slipRight: 0 };
  let prev = { guard: false, duck: false, slipLeft: false, slipRight: false };
  let guardFrames = 0;
  for (const f of rec.frames) {
    const d = c.update(f).defense;
    const cur = { guard: d.guard, duck: d.duck, slipLeft: d.slip === 'left', slipRight: d.slip === 'right' };
    for (const k of Object.keys(on) as (keyof typeof on)[]) if (cur[k] && !prev[k]) on[k]++;
    if (d.guard) guardFrames++;
    prev = cur;
  }
  console.log(`${file.padEnd(28)} guard ${on.guard} (${((100 * guardFrames) / rec.frames.length).toFixed(0)}% of frames) duck ${on.duck} slipL ${on.slipLeft} slipR ${on.slipRight}`);
}
