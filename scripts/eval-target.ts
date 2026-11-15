// Head or body on the recorded reps. Every recorded rep was thrown standing (the clips predate the
// crouch rule, so even the reps aimed low were thrown upright), so under targetOf each one should
// read as a head shot. Reports the head dip of each rep against the default body dip and against
// the dip the calibration would set from the recorded duck clip.
// Usage: npx tsx scripts/eval-target.ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Target } from '../shared/types.ts';
import { CONFIG } from '../client/src/config.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { bodyDipFrom, kindOf, targetOf, type Kind } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { loadFixtures, segmentsOf, type Recording } from './eval-core.ts';
import { FIXTURE_REPS, TEACH_REPS, TEACH_SESSION, type Rep } from './eval-gt.ts';

/** A recorded rep: its motion, its kind, and the target it was aimed at when it was recorded. */
export interface TargetRep { seg: Segment; kind: Kind; aimed: Target }

/** Each hand-checked rep with the gated motion of its hand whose peak is closest (within 350 ms). */
export function targetReps(rec: Recording, reps: Rep[]): TargetRep[] {
  const segs = segmentsOf(rec).filter(passesGate);
  const t0 = rec.frames[0].t;
  const out: TargetRep[] = [];
  for (const r of reps) {
    const hand = handFor(r.type, rec.stance ?? 'orthodox');
    const rt = t0 + r.t * 1000;
    const seg = segs.filter((s) => s.hand === hand && Math.abs(s.peakT - rt) < 350).sort((a, b) => Math.abs(a.peakT - rt) - Math.abs(b.peakT - rt))[0];
    if (seg) out.push({ seg, kind: kindOf(r.type), aimed: r.target });
  }
  return out;
}

export function fixtureTargetReps(): TargetRep[] {
  return loadFixtures().flatMap(({ file, rec }) => {
    const type = rec.expected?.[0];
    const id = file.replace(/^(orthodox|southpaw)-/, '').replace('.json', '');
    return type ? targetReps(rec, (FIXTURE_REPS[id] ?? []).map((t) => ({ type, target: rec.expectedTarget ?? 'head', t }))) : [];
  });
}

export function sessionTargetReps(): TargetRep[] {
  return targetReps(JSON.parse(readFileSync(`tests/fixtures/sessions/${TEACH_SESSION}`, 'utf8')) as Recording, TEACH_REPS);
}

/** Deepest head dip in a clip (what the calibration's duck step records). */
export function deepestDip(rec: Recording): number {
  const c = new Classifier(rec.calibration!);
  let max = 0;
  for (const f of rec.frames) max = Math.max(max, c.update(f).features?.headDy ?? 0);
  return max;
}

/** The body dip the calibration would set from the recorded duck clip, with no crouch reps. */
export function fixtureBodyDip(): number {
  const duck = loadFixtures().find((f) => f.rec.defense === 'duck');
  return bodyDipFrom([], [], duck ? deepestDip(duck.rec) : null);
}

function report(name: string, xs: TargetRep[], dip: number): void {
  const q = (a: number[], k: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(k * a.length))];
  const head = (b: number) => xs.filter((x) => targetOf(x.seg, b) === 'head').length;
  console.log(`== ${name}: ${xs.length} reps`);
  console.log(`read head with the default dip ${CONFIG.punch.bodyDip}: ${head(CONFIG.punch.bodyDip)}/${xs.length}, with the duck-clip dip ${dip.toFixed(2)}: ${head(dip)}/${xs.length}`);
  const by = new Map<string, number[]>();
  for (const x of xs) by.set(`${x.kind}:${x.aimed}`, [...(by.get(`${x.kind}:${x.aimed}`) ?? []), x.seg.dip]);
  for (const [k, v] of by) console.log(`  ${k.padEnd(16)} dip median ${q(v, 0.5).toFixed(2)} max ${Math.max(...v).toFixed(2)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const duck = loadFixtures().find((f) => f.rec.defense === 'duck');
  if (duck) console.log(`duck clip: deepest dip ${deepestDip(duck.rec).toFixed(2)} sw`);
  const dip = fixtureBodyDip();
  report('fixtures', fixtureTargetReps(), dip);
  report('teach session', sessionTargetReps(), dip);
}
