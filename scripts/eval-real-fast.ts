// Real fast punches: replays every tests/fixtures/fast/*.json clip that has hand-checked reps in
// FAST_REPS (scripts/eval-gt.ts) through the live Classifier, with a model trained on every
// labelled motion of the root fixtures (oracle labels, outliers pruned, like eval-calibration.ts).
// Reports reps fired, read right (type and head), missed, extra fires and the delay from the
// hand-checked peak to the frame the punch fired, plus the clip's frame gaps.
// Usage: npx tsx scripts/eval-real-fast.ts [--verbose]
import type { Punch } from '../shared/types.ts';
import { Classifier, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, vector } from '../client/src/tracking/model.ts';
import { handFor, pruneOutliers } from '../client/src/tracking/teach.ts';
import { labelledSegments, loadFixtures, type Recording } from './eval-core.ts';
import { FAST_REPS } from './eval-gt.ts';

const verbose = process.argv.includes('--verbose');
const MATCH_MS = 350;

const clips = loadFixtures('tests/fixtures/fast')
  .map(({ file, rec }) => ({ name: file.replace(/\.json$/, ''), rec, reps: FAST_REPS[file.replace(/\.json$/, '')] ?? [] }))
  .filter((c) => c.reps.length);
if (!clips.length) {
  console.log('No labelled fast clips: record them with ?record=1, label them with scripts/label-reps.ts and add them to FAST_REPS in scripts/eval-gt.ts.');
  process.exit(0);
}

const taught = pruneOutliers(loadFixtures().flatMap(({ file, rec }) => labelledSegments(file, rec)));
const samples = taught.map((x) => ({ hand: x.seg.hand, label: x.label, v: vector(x.seg), ...(x.label !== 'none' ? { target: x.target } : {}) }));
const model = new KnnModel(samples);

interface Score { reps: number; fired: number; right: number; extra: number; delay: number[]; gaps: number[] }
const newScore = (): Score => ({ reps: 0, fired: 0, right: 0, extra: 0, delay: [], gaps: [] });
const q = (xs: number[], k: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(k * xs.length))] : NaN);

function run(rec: Recording, reps: { type: Punch['type']; t: number }[], sc: Score): string[] {
  const stance = rec.stance ?? 'orthodox';
  const c = new Classifier(rec.calibration!);
  c.stance = stance;
  c.model = (s: Segment) => model.decide(s, stance);
  const fires: (Punch & { at: number; fireT: number })[] = [];
  for (const f of rec.frames) fires.push(...c.update(f).punches.map((p) => ({ ...p, fireT: f.t })));
  for (let i = 1; i < rec.frames.length; i++) sc.gaps.push(rec.frames[i].t - rec.frames[i - 1].t);
  const t0 = rec.frames[0].t;
  const rs = reps.map((r) => ({ ...r, hand: handFor(r.type, stance), at: t0 + r.t * 1000 }));
  // Closest rep and fire pairs first, so a missed rep in a fast combo cannot take its neighbour's fire.
  const pairs = rs.flatMap((r) => fires.filter((f) => f.hand === r.hand && Math.abs(f.at - r.at) <= MATCH_MS).map((f) => ({ r, f, d: Math.abs(f.at - r.at) })));
  const match = new Map<(typeof rs)[number], (typeof fires)[number]>();
  const used = new Set<(typeof fires)[number]>();
  for (const { r, f } of pairs.sort((a, b) => a.d - b.d)) {
    if (match.has(r) || used.has(f)) continue;
    match.set(r, f);
    used.add(f);
  }
  const lines: string[] = [];
  for (const r of rs) {
    sc.reps++;
    const f = match.get(r);
    if (f) {
      sc.fired++;
      sc.delay.push(f.fireT - r.at);
      if (f.type === r.type && f.target === 'head') sc.right++;
    }
    lines.push(`    ${r.t.toFixed(2).padStart(6)} ${r.type.padEnd(13)} ${f ? `${f.type} ${f.target}${f.type === r.type && f.target === 'head' ? '' : '  WRONG'}, fired ${(f.fireT - r.at).toFixed(0)} ms after the peak` : 'MISSED'}`);
  }
  const extra = fires.filter((f) => !used.has(f));
  sc.extra += extra.length;
  for (const f of extra) lines.push(`    ${((f.at - t0) / 1000).toFixed(2).padStart(6)} extra fire ${f.type} ${f.target}`);
  return lines;
}

function print(name: string, sc: Score): void {
  const gap = q(sc.gaps, 0.5);
  const slow = sc.gaps.filter((g) => g > 60).length;
  const d = sc.delay.length ? `  delay med ${q(sc.delay, 0.5).toFixed(0)} p90 ${q(sc.delay, 0.9).toFixed(0)} ms` : '';
  console.log(`${name.padEnd(34)} fired ${sc.fired}/${sc.reps}  right ${sc.right}/${sc.reps}  missed ${sc.reps - sc.fired}  extra ${sc.extra}${d}  |  ${(1000 / gap).toFixed(0)} fps median, ${sc.gaps.length ? Math.round((100 * slow) / sc.gaps.length) : 0}% gaps > 60 ms`);
}

const total = newScore();
for (const clip of clips) {
  const sc = newScore();
  const lines = run(clip.rec, clip.reps, sc);
  print(clip.name, sc);
  if (verbose) console.log(lines.join('\n'));
  for (const k of ['reps', 'fired', 'right', 'extra'] as const) total[k] += sc[k];
  total.delay.push(...sc.delay);
  total.gaps.push(...sc.gaps);
}
print(`all (${clips.length} clips)`, total);
