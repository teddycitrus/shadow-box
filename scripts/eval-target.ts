// Head or body on the recorded reps, leave one out, for the current rule (targetOf with the
// player's head line) and the alternatives it was picked over. Scored against the target each rep
// was thrown at (scripts/eval-gt.ts).
// Usage: npx tsx scripts/eval-target.ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Target } from '../shared/types.ts';
import { CONFIG } from '../client/src/config.ts';
import { passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { headHeight, headLineFrom, kindOf, targetOf, type HeadLine, type Kind } from '../client/src/tracking/model.ts';
import { handFor } from '../client/src/tracking/teach.ts';
import { loadFixtures, segmentsOf, type Recording } from './eval-core.ts';
import { FIXTURE_REPS, TEACH_REPS, TEACH_SESSION, type Rep } from './eval-gt.ts';

export interface TargetRep { seg: Segment; kind: Kind; target: Target }
type Read = (train: TargetRep[], x: TargetRep) => Target;

/** Each hand-checked rep with the gated motion of its hand whose peak is closest (within 350 ms). */
export function targetReps(rec: Recording, reps: Rep[]): TargetRep[] {
  const segs = segmentsOf(rec).filter(passesGate);
  const t0 = rec.frames[0].t;
  const out: TargetRep[] = [];
  for (const r of reps) {
    const hand = handFor(r.type, rec.stance ?? 'orthodox');
    const rt = t0 + r.t * 1000;
    const seg = segs.filter((s) => s.hand === hand && Math.abs(s.peakT - rt) < 350).sort((a, b) => Math.abs(a.peakT - rt) - Math.abs(b.peakT - rt))[0];
    if (seg) out.push({ seg, kind: kindOf(r.type), target: r.target });
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

/** The head line the calibration would learn from these reps' straights. */
export function lineOf(train: TargetRep[]): HeadLine {
  return headLineFrom(train.filter((x) => x.kind === 'straight').map((x) => ({ hand: x.seg.hand, h: headHeight(x.seg), target: x.target })));
}

/** The live rule. */
export const headTargets: Read = (train, x) => targetOf(x.seg, x.kind, lineOf(train));

/** Reps of xs read right, each read with every other rep of pool (default xs) as the calibration. */
export function loo(xs: TargetRep[], read: Read, pool: TargetRep[] = xs): number {
  return xs.filter((x) => read(pool.filter((o) => o !== x), x) === x.target).length;
}

const chin = (x: TargetRep) => 0.45 * x.seg.nose.y;
const ALTERNATIVES: Record<string, Read> = {
  'learned line, hooks capped at nose, uppercuts to chin (live)': headTargets,
  'fixed nose line, uppercuts to chin': (_t, x) => (headHeight(x.seg) >= CONFIG.punch.headLine - (x.kind === 'uppercut' ? chin(x) : 0) ? 'head' : 'body'),
  'fixed nose line, uppercuts always head': (_t, x) => (x.kind === 'uppercut' || headHeight(x.seg) >= CONFIG.punch.headLine ? 'head' : 'body'),
  'learned line, hooks at the line too': (t, x) => {
    const l = lineOf(t)[x.seg.hand] - (x.kind === 'uppercut' ? chin(x) : 0);
    return headHeight(x.seg) >= l ? 'head' : 'body';
  },
  'learned line, uppercuts always head': (t, x) => (x.kind === 'uppercut' ? 'head' : headTargets(t, x)),
};

function report(name: string, xs: TargetRep[]): void {
  console.log(`== ${name}`);
  for (const [label, read] of Object.entries(ALTERNATIVES)) {
    const by = new Map<string, [number, number]>();
    for (const x of xs) {
      const k = `${x.kind}:${x.target}`;
      const c = by.get(k) ?? [0, 0];
      c[1]++;
      if (read(xs.filter((o) => o !== x), x) === x.target) c[0]++;
      by.set(k, c);
    }
    const ok = [...by.values()].reduce((n, c) => n + c[0], 0);
    console.log(`${label.padEnd(62)} ${ok}/${xs.length}  ${[...by].map(([k, c]) => `${k} ${c[0]}/${c[1]}`).join('  ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  report('fixtures (low camera, clear targets)', fixtureTargetReps());
  report('teach session (high camera; its "head" straights and hooks ended well below the nose)', sessionTargetReps());
}
