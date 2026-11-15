// End-to-end accuracy of the per-player calibration on the recorded data, scored against the
// hand-checked reps in scripts/eval-gt.ts. Every number replays the live Classifier frame by frame
// with a model trained the way the guided calibration would train it. Every recorded rep was thrown
// standing (even the ones aimed low), so under the crouch rule each one is scored as a head shot.
// Usage: npx tsx scripts/eval-calibration.ts [--verbose]
import { readFileSync } from 'node:fs';
import type { Hand, Punch, PunchType, Target } from '../shared/types.ts';
import { CONFIG } from '../client/src/config.ts';
import { Classifier, passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import type { PoseFrame } from '../client/src/tracking/frame.ts';
import { KnnModel, kindOf, vector, type Label } from '../client/src/tracking/model.ts';
import { handFor, pickReps, pruneOutliers, type TeachStep } from '../client/src/tracking/teach.ts';
import { loadFixtures, segmentsOf, type Recording } from './eval-core.ts';
import { FIXTURE_REPS, TEACH_REPS, TEACH_SESSION } from './eval-gt.ts';

const verbose = process.argv.includes('--verbose');
const MATCH_MS = 350;

interface Clip { name: string; rec: Recording; reps: { hand: Hand; type: PunchType; target: Target; t: number }[] }
interface Fire extends Punch { at: number; /** Frame time the punch was emitted. */ fireT: number }
type Decide = (s: Segment) => Punch | null;
interface Taught { seg: Segment; type: PunchType | null; target: Target }

// ---- pipeline adapter: the only part that knows the model API ----
const prune = !process.argv.includes('--no-prune');
function train(taught: Taught[]): Decide {
  const gated = taught.filter((x) => passesGate(x.seg)).map((x) => ({ ...x, label: x.type ? kindOf(x.type) : ('none' as Label) }));
  const kept = prune ? pruneOutliers(gated) : gated;
  const samples = kept.map((x) => ({ hand: x.seg.hand, label: x.label, v: vector(x.seg), ...(x.type ? { target: x.target } : {}) }));
  if (!samples.some((s) => s.label !== 'none')) return () => null;
  const m = new KnnModel(samples);
  return (s) => m.decide(s, 'orthodox');
}
/** What the live teacher would have taken as reps from one prompt's motions. */
function teacherPick(segs: Segment[], hand: Hand, n: number): Segment[] {
  return pickReps(segs.filter(passesGate), hand, n).reps;
}
// ----

/** Fired punches, plus every gated motion the model turned down (to tell a rejected rep from an unseen one). */
function replay(rec: Recording, decide: Decide, frames: PoseFrame[] = rec.frames): Fire[] & { rejected?: Segment[] } {
  const c = new Classifier(rec.calibration!);
  c.model = decide;
  const out: Fire[] & { rejected?: Segment[] } = [];
  out.rejected = [];
  c.onDecision = (seg, p) => {
    if (!p && passesGate(seg)) out.rejected!.push(seg);
  };
  for (const f of frames) out.push(...c.update(f).punches.map((p) => ({ ...p, fireT: f.t })));
  return out;
}

/** Oracle labels: each real rep gets the motion of its hand whose peak is closest to it. */
function label(segs: Segment[], reps: Clip['reps'], t0: number): Taught[] {
  const out: Taught[] = segs.map((seg) => ({ seg, type: null, target: 'head' }));
  for (const r of reps) {
    let best: Taught | null = null;
    for (const x of out) {
      const d = Math.abs(x.seg.peakT - (t0 + r.t * 1000));
      if (x.seg.hand === r.hand && d <= MATCH_MS && (!best || d < Math.abs(best.seg.peakT - (t0 + r.t * 1000)))) best = x;
    }
    if (best) Object.assign(best, { type: r.type, target: r.target });
  }
  return out;
}

interface Score { reps: number; exact: number; type: number; target: number; missed: number; extra: number; confusion: Map<string, number>; delay: number[] }
const newScore = (): Score => ({ reps: 0, exact: 0, type: 0, target: 0, missed: 0, extra: 0, confusion: new Map(), delay: [] });

function score(sc: Score, fires: Fire[] & { rejected?: Segment[] }, reps: Clip['reps'], t0: number, from: number, to: number): void {
  const inWin = fires.filter((f) => f.at >= from && f.at < to);
  const used = new Set<Fire>();
  for (const r of reps) {
    const rt = t0 + r.t * 1000;
    if (rt < from || rt >= to) continue;
    sc.reps++;
    const m = inWin.filter((f) => !used.has(f) && f.hand === r.hand && Math.abs(f.at - rt) <= MATCH_MS).sort((a, b) => Math.abs(a.at - rt) - Math.abs(b.at - rt))[0];
    if (!m) {
      sc.missed++;
      const why = fires.rejected?.some((s) => s.hand === r.hand && Math.abs(s.peakT - rt) <= MATCH_MS) ? 'rejected as no punch' : 'no motion found';
      sc.confusion.set(`${r.type}:${r.target} -> ${why}`, (sc.confusion.get(`${r.type}:${r.target} -> ${why}`) ?? 0) + 1);
      continue;
    }
    used.add(m);
    sc.delay.push(m.fireT - rt);
    if (m.type === r.type) sc.type++;
    if (m.target === r.target) sc.target++;
    if (m.type === r.type && m.target === r.target) sc.exact++;
    else sc.confusion.set(`${r.type}:${r.target} -> ${m.type}:${m.target}`, (sc.confusion.get(`${r.type}:${r.target} -> ${m.type}:${m.target}`) ?? 0) + 1);
  }
  sc.extra += inWin.filter((f) => !used.has(f)).length;
}

const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
const q = (xs: number[], k: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(k * xs.length))] : NaN);
/** Delay from the hand-checked peak to the frame the punch fired: median and p90, in ms. */
const delay = (sc: Score) => (sc.delay.length ? `  delay med ${q(sc.delay, 0.5).toFixed(0)} p90 ${q(sc.delay, 0.9).toFixed(0)} ms` : '');
function print(name: string, sc: Score, negMin?: number): void {
  console.log(`${name.padEnd(44)} exact ${sc.exact}/${sc.reps} (${pct(sc.exact, sc.reps)})  type ${pct(sc.type, sc.reps)}  target ${pct(sc.target, sc.reps)}  missed ${sc.missed}  extra fires ${sc.extra}${negMin ? ` (${(sc.extra / negMin).toFixed(1)}/min)` : ''}${delay(sc)}`);
  if (verbose) for (const [k, v] of [...sc.confusion].sort((a, b) => b[1] - a[1])) console.log(`      ${k}: ${v}`);
}

// ---- fixtures ----
const fixtures: Clip[] = loadFixtures().map(({ file, rec }) => {
  const id = file.replace(/^(orthodox|southpaw)-/, '').replace('.json', '');
  const type = rec.expected?.[0];
  const times = FIXTURE_REPS[id] ?? [];
  return { name: id, rec, reps: type ? times.map((t) => ({ hand: handFor(type, rec.stance ?? 'orthodox'), type, target: 'head' as Target, t })) : [] };
});
const segCache = new Map<Clip, Segment[]>();
const segsOf = (c: Clip) => segCache.get(c) ?? (segCache.set(c, segmentsOf(c.rec)), segCache.get(c)!);

function fixtureShots(shots: number, policy: 'oracle' | 'teacher'): { sc: Score; neg: Score; negMin: number } {
  const taught: Taught[] = [];
  const cuts = new Map<Clip, number>();
  for (const c of fixtures) {
    const t0 = c.rec.frames[0].t;
    const segs = segsOf(c);
    if (!c.reps.length) {
      const mid = (t0 + c.rec.frames.at(-1)!.t) / 2;
      cuts.set(c, mid);
      taught.push(...segs.filter((s) => s.endT <= mid).map((seg) => ({ seg, type: null, target: 'head' as Target })));
      continue;
    }
    let cut: number;
    let lab: Taught[];
    if (policy === 'oracle') {
      cut = t0 + (c.reps[shots - 1].t * 1000) + 400;
      lab = label(segs, c.reps, t0);
    } else {
      const picked = teacherPick(segs, c.reps[0].hand, shots);
      cut = picked.length === shots ? picked.at(-1)!.endT : t0 + (c.reps[shots - 1].t * 1000) + 400;
      lab = segs.map((seg) => ({ seg, type: picked.includes(seg) ? c.reps[0].type : null, target: c.reps[0].target }));
    }
    cuts.set(c, cut);
    taught.push(...lab.filter((x) => x.seg.endT <= cut));
  }
  const decide = train(taught);
  const sc = newScore(), neg = newScore();
  let negMs = 0;
  for (const c of fixtures) {
    const fires = replay(c.rec, decide);
    const t0 = c.rec.frames[0].t;
    const cut = cuts.get(c)!;
    if (c.reps.length) score(sc, fires, c.reps, t0, cut, Infinity);
    else {
      score(neg, fires, [], t0, cut, Infinity);
      negMs += c.rec.frames.at(-1)!.t - cut;
    }
  }
  return { sc, neg, negMin: negMs / 60000 };
}

/** Leave one rep out: train on every other rep (4 of 5 per move, the closest to a 5-rep teach). */
function fixtureLoo(): Score {
  const sc = newScore();
  const all = fixtures.flatMap((c) => label(segsOf(c), c.reps, c.rec.frames[0].t).map((x) => ({ ...x, clip: c })));
  for (const c of fixtures) {
    const t0 = c.rec.frames[0].t;
    for (const r of c.reps) {
      const rt = t0 + r.t * 1000;
      const decide = train(all.filter((x) => x.clip !== c || Math.abs(x.seg.peakT - rt) > 600));
      const fires = replay(c.rec, decide);
      score(sc, fires, [r], t0, rt - 600, rt + 600);
    }
  }
  return sc;
}

console.log('== fixtures (one player, 5 reps per move, 8 punch clips + 4 defense clips)');
for (const shots of [2, 3]) {
  for (const policy of ['oracle', 'teacher'] as const) {
    const { sc, neg, negMin } = fixtureShots(shots, policy);
    print(`chronological ${shots}-shot, ${policy} labels`, sc);
    print(`   defense clips (any fire is false)`, neg, negMin);
  }
}
print('leave one rep out (4-shot)', fixtureLoo());

// ---- teach session ----
const sessionFile = `tests/fixtures/sessions/${TEACH_SESSION}`;
const sess = JSON.parse(readFileSync(sessionFile, 'utf8')) as Recording & { marks: { t: number; kind: string; data?: Partial<TeachStep> }[] };
const st0 = sess.frames[0].t;
const sreps = TEACH_REPS.map((r) => ({ ...r, target: 'head' as Target, hand: handFor(r.type, 'orthodox') }));
const ssegs = segmentsOf(sess);
const sl = label(ssegs, sreps, st0);
const prompts = sess.marks.filter((m) => m.kind === 'teachStep');
const teachFrom = prompts[0].t, teachTo = prompts.find((m) => m.data?.kind === 'duck')?.t ?? Infinity;
{
  const sc = newScore();
  for (const r of sreps) {
    const rt = st0 + r.t * 1000;
    const decide = train(sl.filter((x) => x.seg.peakT >= teachFrom && Math.abs(x.seg.peakT - rt) > 600 && x.seg.peakT < teachTo + 4000));
    score(sc, replay(sess, decide), [r], st0, rt - 600, rt + 600);
  }
  console.log('\n== teach session (real calibration, 22 reps over 8 prompts)');
  print('leave one rep out, oracle labels', sc);
  // The live teacher's own labels: pickReps on each punch prompt's motions, the rest non-punches.
  const tl: Taught[] = [];
  for (let i = 0; i < prompts.length; i++) {
    // The step as recorded (this session predates the current step list).
    const step = prompts[i].data;
    const inWin = ssegs.filter((x) => passesGate(x) && x.peakT >= prompts[i].t + CONFIG.model.stepGraceMs && x.peakT < (prompts[i + 1]?.t ?? Infinity));
    if (step?.kind !== 'punch') {
      tl.push(...inWin.map((seg) => ({ seg, type: null, target: 'head' as Target })));
      continue;
    }
    const picked = teacherPick(inWin, handFor(step.type!, 'orthodox'), 5);
    tl.push(...inWin.map((seg) => ({ seg, type: picked.includes(seg) ? step.type! : null, target: 'head' as Target })));
  }
  const sc2 = newScore();
  for (const r of sreps) {
    const rt = st0 + r.t * 1000;
    score(sc2, replay(sess, train(tl.filter((x) => Math.abs(x.seg.peakT - rt) > 600))), [r], st0, rt - 600, rt + 600);
  }
  print('leave one rep out, teacher labels', sc2);
}
