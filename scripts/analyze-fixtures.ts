// Replays tests/fixtures/*.json through the classifier and prints every decision, for tuning
// thresholds in client/src/config.ts. Usage: npx tsx scripts/analyze-fixtures.ts [filter] [--trace]
import { readdirSync, readFileSync } from 'node:fs';
import { Classifier } from '../client/src/tracking/classifier.ts';
import type { Calibration } from '../client/src/tracking/calibration.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const trace = process.argv.includes('--trace');
const dir = 'tests/fixtures';

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter))) {
  const rec = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as {
    calibration: Calibration; frames: PoseFrame[]; expected?: string[]; expectedTarget?: string; defense?: string; stance?: 'orthodox' | 'southpaw';
  };
  const c = new Classifier(rec.calibration);
  c.stance = rec.stance ?? 'orthodox';
  const t0 = rec.frames[0]?.t ?? 0;
  const dur = ((rec.frames.at(-1)?.t ?? 0) - t0) / 1000;
  console.log(`\n== ${file}  frames=${rec.frames.length} ${dur.toFixed(1)}s fps=${(rec.frames.length / dur).toFixed(0)}  expected=${rec.expected?.join(',') || rec.defense} ${rec.expectedTarget ?? ''}`);
  console.log(`   cal sw=${rec.calibration.swImg.toFixed(3)} swW=${rec.calibration.swWorld.toFixed(3)} arm=${rec.calibration.armWorld.toFixed(3)} hand=${rec.calibration.handSize.left.toFixed(2)}/${rec.calibration.handSize.right.toFixed(2)}`);
  let last: string | null = null;
  let def = '';
  for (const f of rec.frames) {
    const out = c.update(f);
    const ts = ((f.t - t0) / 1000).toFixed(2);
    if (out.last !== last && out.last) console.log(`   ${ts}s ${out.punches.length ? 'FIRE ' : '     '}${out.last}`);
    last = out.last;
    const d = `${out.defense.guard ? 'G' : '-'}${out.defense.duck ? 'D' : '-'}${out.defense.slip[0]}`;
    if (d !== def) {
      console.log(`   ${ts}s defense ${d}  headDx=${out.features!.headDx.toFixed(2)} headDy=${out.features!.headDy.toFixed(2)}`);
      def = d;
    }
    if (trace) {
      const l = out.features!.left, r = out.features!.right;
      const fm = (x: typeof l) => `spd ${x.speed.toFixed(1).padStart(5)} y ${x.y.toFixed(2).padStart(5)} hd ${x.headDist.toFixed(2)} el ${x.elbow.toFixed(0).padStart(3)} sc ${x.scale.toFixed(2)} z ${x.zAhead.toFixed(2)}`;
      console.log(`   ${ts} L ${fm(l)} | R ${fm(r)} | dx ${out.features!.headDx.toFixed(2)} dy ${out.features!.headDy.toFixed(2)}`);
    }
  }
}
