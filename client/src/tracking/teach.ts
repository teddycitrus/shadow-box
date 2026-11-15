import type { Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import { passesGate, type Features, type Segment } from './classifier.ts';
import { KnnModel, bodyDipFrom, kindOf, vector, type Label, type Sample } from './model.ts';

export type StepKind = 'rest' | 'punch' | 'duck' | 'slipLeft' | 'slipRight';

export interface TeachStep {
  id: string;
  prompt: string;
  /** How to do it, shown under the prompt. */
  how: string;
  kind: StepKind;
  type?: PunchType;
  target?: Target;
}

export const DEFENSE_STEP_MS = 3_500;
export const REST_STEP_MS = 6_000;

export function teachSteps(): TeachStep[] {
  const reps = CONFIG.model.repsPerMove;
  const p = (type: PunchType, target: Target, prompt: string): TeachStep => ({
    id: `${type}-${target}`, prompt, kind: 'punch', type, target,
    how: `${target === 'head' ? 'Aim at the face, standing tall' : 'Dip your head like a duck, then punch'}. ${reps} times, back to guard after each`,
  });
  // A standing punch is a head shot and a crouched one a body shot. The duck comes first so the
  // crouch depth is known, and the crouch steps show how deep this player dips on a body shot.
  return [
    { id: 'rest', prompt: 'Guard up', how: 'Bounce, shift your feet, adjust your gloves. No punches.', kind: 'rest' },
    { id: 'drop', prompt: 'Drop your hands', how: 'Lower both gloves, then bring them back up. Twice.', kind: 'rest' },
    { id: 'duck', prompt: 'Duck', how: 'Do it once or twice, then come back', kind: 'duck' },
    { id: 'slipLeft', prompt: 'Slip left', how: 'Do it once or twice, then come back', kind: 'slipLeft' },
    { id: 'slipRight', prompt: 'Slip right', how: 'Do it once or twice, then come back', kind: 'slipRight' },
    p('jab', 'head', 'Jab'),
    p('cross', 'head', 'Cross'),
    p('leftHook', 'head', 'Left hook'),
    p('rightHook', 'head', 'Right hook'),
    p('leftUppercut', 'head', 'Left uppercut'),
    p('rightUppercut', 'head', 'Right uppercut'),
    p('jab', 'body', 'Crouch and jab'),
    p('cross', 'body', 'Crouch and cross'),
  ];
}

export function handFor(type: PunchType, stance: Stance): Hand {
  if (type === 'jab') return stance === 'orthodox' ? 'left' : 'right';
  if (type === 'cross') return stance === 'orthodox' ? 'right' : 'left';
  return type.startsWith('left') ? 'left' : 'right';
}

/** Per-move result of the verify phase. */
export interface MoveScore {
  id: string;
  prompt: string;
  ok: number;
  tries: number;
  /** Attempts read as the right punch at the wrong height (head for body or body for head). */
  wrongTarget?: number;
}

export interface TeachStatus {
  done: boolean;
  phase: 'learn' | 'verify';
  index: number;
  total: number;
  step: TeachStep | null;
  reps: number;
  repsNeeded: number;
  /** 0..1 time used on the current step (learn) or prompt (verify). */
  progress: number;
  /** Verify phase: the punch to throw, what was read for the last attempt, and the score so far. */
  verify: {
    prompt: string;
    passed: number;
    moves: number;
    result: { text: string; ok: boolean } | null;
  } | null;
  scores: MoveScore[];
}

export interface Profile {
  version: 6;
  samples: Sample[];
  defense: { duck: number; slipLeft: number; slipRight: number };
  learned: string[];
  /** Head dip (sw below neutral) that makes a punch a body shot (bodyDipFrom). */
  bodyDip: number;
  scores: MoveScore[];
}

interface Verify {
  queue: TeachStep[];
  current: TeachStep | null;
  promptAt: number;
  /** Segments of the attempt in progress, the punch it fired (if any), and when it is complete. */
  attempt: { segs: Segment[]; fired: Punch | null; firedSeg: Segment | null; closeAt: number } | null;
  /** Feedback on the last attempt and when the next prompt starts. */
  result: { text: string; ok: boolean } | null;
  nextAt: number;
  last: string | null;
}

interface Taught {
  seg: Segment;
  label: Label;
  step: TeachStep | null;
}

/**
 * The guided per-player calibration (about two and a half minutes):
 *  1. Rest: guard up and moving, then dropping and raising the hands. Every motion here is a
 *     taught non-punch.
 *  2. Duck and slips, to set this player's thresholds.
 *  3. Each punch standing (a head shot), then jab and cross crouched (body shots), repsPerMove
 *     times each. The crouch reps and the duck set how far the head must dip for a body shot.
 *     The real reps are picked out of the motions (wind-ups and fidgets become non-punch
 *     examples), and reps far from the rest of their move are dropped.
 *  4. Verify: random punches are prompted and read back live with the player's own model. A
 *     wrong or missed read is taught with the right label on the spot and the move comes back
 *     until it is read right verifyPasses times (or runs out of tries).
 */
export class Teacher {
  readonly steps = teachSteps();
  private i = 0;
  private stepStart: number | null = null;
  private stepSegs: Segment[] = [];
  private lastSegEnd = 0;
  private taught: Taught[] = [];
  private learned: string[] = [];
  private extreme = { duck: 0, slipLeft: 0, slipRight: 0 };
  private verifyState: Verify | null = null;
  private scores = new Map<string, MoveScore>();
  private cached: { model: KnnModel | null; bodyDip: number; kept: Taught[] } | null = null;
  private finished = false;

  constructor(private stance: Stance) {}

  get done(): boolean {
    return this.finished;
  }

  get phase(): 'learn' | 'verify' {
    return this.i >= this.steps.length ? 'verify' : 'learn';
  }

  /** Feed every motion segment while teaching (classifier.onSegment). */
  segment(seg: Segment): void {
    if (!passesGate(seg) || this.finished) return;
    const s = this.steps[this.i];
    if (!s) {
      this.verifySegment(seg);
      return;
    }
    if (this.stepStart !== null && seg.peakT < this.stepStart + CONFIG.model.stepGraceMs) return;
    if (s.kind === 'punch') {
      this.stepSegs.push(seg);
      if (seg.hand === handFor(s.type!, this.stance)) this.lastSegEnd = seg.endT;
    } else {
      this.add(seg, 'none', s);
    }
  }

  /** Feed every classifier decision while verifying (classifier.onDecision). */
  decision(seg: Segment, punch: Punch | null): void {
    const v = this.verifyState;
    if (!v?.attempt || !punch || !v.current) return;
    if (seg.hand === handFor(v.current.type!, this.stance) && !v.attempt.fired) {
      v.attempt.fired = punch;
      v.attempt.firedSeg = seg;
    }
  }

  /** The model to read punches with during the verify phase (null while learning: nothing fires). */
  decide(seg: Segment): Punch | null {
    if (this.phase !== 'verify' || this.finished) return null;
    const { model, bodyDip } = this.trained();
    return model ? model.decide(seg, this.stance, bodyDip) : null;
  }

  /** Feed every frame's features; also advances the steps. */
  update(t: number, f: Features | null): TeachStatus {
    if (this.stepStart === null) this.stepStart = t;
    const s = this.steps[this.i];
    if (s) this.learnStep(s, t, f);
    else if (!this.finished) this.verifyStep(t);
    return this.status(t);
  }

  private learnStep(s: TeachStep, t: number, f: Features | null): void {
    if (f) {
      if (s.kind === 'duck') this.extreme.duck = Math.max(this.extreme.duck, f.headDy);
      if (s.kind === 'slipLeft') this.extreme.slipLeft = Math.max(this.extreme.slipLeft, f.headDx);
      if (s.kind === 'slipRight') this.extreme.slipRight = Math.max(this.extreme.slipRight, -f.headDx);
    }
    const elapsed = t - this.stepStart!;
    let next = false;
    if (s.kind === 'punch') {
      const reps = this.reps(s).length;
      next = (reps >= CONFIG.model.repsPerMove && t - this.lastSegEnd >= CONFIG.model.settleAfterRepMs) || elapsed >= CONFIG.model.moveTimeoutMs;
    } else {
      next = elapsed >= (s.kind === 'rest' ? REST_STEP_MS : DEFENSE_STEP_MS);
    }
    if (!next) return;
    if (s.kind === 'punch') this.finishPunchStep(s);
    this.i++;
    this.stepSegs = [];
    this.stepStart = t;
    if (this.i === this.steps.length) this.startVerify(t);
  }

  private reps(s: TeachStep): Segment[] {
    return pickReps(this.stepSegs, handFor(s.type!, this.stance), CONFIG.model.repsPerMove).reps;
  }

  private finishPunchStep(s: TeachStep): void {
    const { reps, rest } = pickReps(this.stepSegs, handFor(s.type!, this.stance), CONFIG.model.repsPerMove);
    for (const seg of rest) this.add(seg, 'none', s);
    for (const seg of reps) this.add(seg, kindOf(s.type!), s);
    if (reps.length) this.learned.push(s.id);
  }

  private add(seg: Segment, label: Label, step: TeachStep | null): void {
    this.taught.push({ seg, label, step });
    this.cached = null;
  }

  private trained(): { model: KnnModel | null; bodyDip: number; kept: Taught[] } {
    if (!this.cached) {
      const kept = pruneOutliers(this.taught);
      const samples = kept.map(toSample);
      const dips = (target: Target) => kept.filter((x) => x.label !== 'none' && x.step?.target === target).map((x) => x.seg.dip);
      this.cached = {
        model: samples.some((x) => x.label !== 'none') ? new KnnModel(samples) : null,
        bodyDip: bodyDipFrom(dips('body'), dips('head'), this.extreme.duck > 0 ? this.extreme.duck : null),
        kept,
      };
    }
    return this.cached;
  }

  // ---- verify ----

  private startVerify(t: number): void {
    const moves = this.steps.filter((s) => s.kind === 'punch' && this.learned.includes(s.id));
    for (const m of moves) this.scores.set(m.id, { id: m.id, prompt: m.prompt, ok: 0, tries: 0 });
    this.verifyState = { queue: shuffle(moves), current: null, promptAt: t, attempt: null, result: null, nextAt: t + 600, last: null };
    if (!moves.length) this.finished = true;
  }

  private verifySegment(seg: Segment): void {
    const v = this.verifyState;
    if (!v?.current || v.result) return;
    if (seg.hand !== handFor(v.current.type!, this.stance)) {
      // A punch fired by the other hand was a false read: teach that motion as a non-punch.
      if (this.decide(seg)) this.add(seg, 'none', null);
      return;
    }
    if (!v.attempt) v.attempt = { segs: [], fired: null, firedSeg: null, closeAt: 0 };
    v.attempt.segs.push(seg);
    v.attempt.closeAt = seg.endT + CONFIG.model.attemptGapMs;
  }

  private verifyStep(t: number): void {
    const v = this.verifyState!;
    if (v.result) {
      if (t < v.nextAt) return;
      v.result = null;
      v.current = null;
    }
    if (!v.current) {
      const left = v.queue.filter((m) => this.needs(m));
      if (!left.length || t < v.nextAt) {
        if (!left.length) this.finished = true;
        return;
      }
      const pool = left.length > 1 ? left.filter((m) => m.id !== v.last) : left;
      v.current = pool[Math.floor(Math.random() * pool.length)];
      v.last = v.current.id;
      v.promptAt = t;
      v.attempt = null;
      return;
    }
    const a = v.attempt;
    if (a && t >= a.closeAt) {
      this.judge(v, a, t);
      return;
    }
    if (!a && t - v.promptAt >= CONFIG.model.verifyPromptMs) {
      this.score(v.current.id, false);
      v.result = { text: 'Nothing seen', ok: false };
      v.nextAt = t + CONFIG.model.verifyFeedbackMs;
    }
  }

  private judge(v: Verify, a: NonNullable<Verify['attempt']>, t: number): void {
    const m = v.current!;
    const ok = !!a.fired && a.fired.type === m.type && a.fired.target === m.target;
    const best = a.firedSeg ?? attemptRep(a.segs);
    if (!a.fired) {
      // Read as no punch: the non-punch examples nearer to it than any rep of this punch were
      // taught wrong for this player (a body jab looks like an uppercut wind-up or a duck), so they go.
      const { model, kept } = this.trained();
      const drop = new Set(model?.shadowing(best.hand, vector(best), kindOf(m.type!)).map((i) => kept[i]));
      this.taught = this.taught.filter((x) => !drop.has(x));
    }
    // Every attempt becomes a taught rep with the label that was asked for: a wrong read is
    // corrected on the spot, a right one adds another example.
    this.add(best, kindOf(m.type!), m);
    this.score(m.id, ok, !!a.fired && a.fired.type === m.type && a.fired.target !== m.target);
    v.result = { text: ok ? `${m.prompt}. Correct` : a.fired ? readAs(a.fired, m) : 'Missed', ok };
    v.nextAt = t + CONFIG.model.verifyFeedbackMs;
    v.attempt = null;
  }

  private score(id: string, ok: boolean, wrongTarget = false): void {
    const s = this.scores.get(id)!;
    s.tries++;
    if (ok) s.ok++;
    if (wrongTarget) s.wrongTarget = (s.wrongTarget ?? 0) + 1;
  }

  private needs(m: TeachStep): boolean {
    const s = this.scores.get(m.id)!;
    return s.ok < CONFIG.model.verifyPasses && s.tries < CONFIG.model.verifyMaxTries;
  }

  private status(t: number): TeachStatus {
    const cur = this.steps[this.i] ?? null;
    const scores = [...this.scores.values()];
    if (!cur) {
      const v = this.verifyState;
      const prompt = v?.current?.prompt ?? '';
      return {
        done: this.finished, phase: 'verify', index: this.steps.length, total: this.steps.length, step: v?.current ?? null,
        reps: 0, repsNeeded: 0,
        progress: v?.current && !v.result ? Math.min(1, (t - v.promptAt) / CONFIG.model.verifyPromptMs) : 0,
        verify: { prompt, passed: scores.filter((s) => s.ok >= CONFIG.model.verifyPasses).length, moves: scores.length, result: v?.result ?? null },
        scores,
      };
    }
    const limit = cur.kind === 'punch' ? CONFIG.model.moveTimeoutMs : cur.kind === 'rest' ? REST_STEP_MS : DEFENSE_STEP_MS;
    return {
      done: false, phase: 'learn', index: this.i, total: this.steps.length, step: cur,
      reps: cur.kind === 'punch' ? Math.min(CONFIG.model.repsPerMove, this.reps(cur).length) : 0,
      repsNeeded: cur.kind === 'punch' ? CONFIG.model.repsPerMove : 0,
      progress: Math.min(1, (t - this.stepStart!) / limit),
      verify: null,
      scores,
    };
  }

  profile(): Profile {
    const k = CONFIG.model.defenseFraction;
    const d = CONFIG.defense;
    const pick = (measured: number, fallback: number) => (measured > fallback * 0.6 ? Math.max(fallback * 0.5, measured * k) : fallback);
    const kept = pruneOutliers(this.taught);
    return {
      version: 6,
      samples: kept.map(toSample),
      defense: {
        duck: pick(this.extreme.duck, d.duckDrop),
        slipLeft: pick(this.extreme.slipLeft, d.slipShift),
        slipRight: pick(this.extreme.slipRight, d.slipShift),
      },
      learned: this.learned,
      bodyDip: this.trained().bodyDip,
      scores: [...this.scores.values()],
    };
  }
}

/** A taught motion as a model sample; punch reps keep the target they were taught as. */
function toSample(x: Taught): Sample {
  const target = x.label !== 'none' ? x.step?.target : undefined;
  return { hand: x.seg.hand, label: x.label, v: vector(x.seg), ...(target ? { target } : {}) };
}

function punchName(p: Punch): string {
  const names: Record<PunchType, string> = {
    jab: 'Jab', cross: 'Cross', leftHook: 'Left hook', rightHook: 'Right hook', leftUppercut: 'Left uppercut', rightUppercut: 'Right uppercut',
  };
  return `${names[p.type]}${p.target === 'body' ? ' to the body' : ''}`;
}

/** Verify feedback on a wrong read; a right punch at the wrong target says whether to stand or crouch. */
export function readAs(p: Punch, asked: TeachStep): string {
  if (p.type !== asked.type) return `Read as ${punchName(p)}`;
  return p.target === 'body' ? 'Read as body. Stand tall for a head shot' : 'Read as head. Crouch lower for a body shot';
}

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Picks the real reps out of the motions seen while one punch was prompted. Motions of the
 * prompted hand that follow each other within a moment (a wind-up, then the punch) are one
 * attempt, and its rep is the last motion that travels nearly as far as the biggest one (the
 * wind-up comes first). Attempts much smaller than the typical one (fidgeting, adjusting the
 * guard) do not count. Returns at most n reps, in time order.
 */
export function pickReps(segs: Segment[], hand: Hand, n: number): { reps: Segment[]; rest: Segment[] } {
  const mine = segs.filter((s) => s.hand === hand).sort((a, b) => a.peakT - b.peakT);
  const groups: Segment[][] = [];
  for (const s of mine) {
    const g = groups.at(-1);
    if (g && s.startT - g.at(-1)!.endT <= CONFIG.model.attemptGapMs) g.push(s);
    else groups.push([s]);
  }
  const best = groups.map(attemptRep);
  const sorted = best.map((s) => s.travel).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const reps = best.filter((s) => s.travel >= typical * CONFIG.model.minRepFraction).slice(0, n);
  return { reps, rest: segs.filter((s) => !reps.includes(s)) };
}

/** The punch in one attempt: the last motion travelling at least attemptRepFraction of the biggest. */
export function attemptRep(g: Segment[]): Segment {
  const max = Math.max(...g.map((s) => s.travel));
  return [...g].reverse().find((s) => s.travel >= max * CONFIG.model.attemptRepFraction)!;
}

/**
 * Drops taught reps that sit far from every other rep of their own move (a mistimed or
 * half-thrown rep would otherwise pull the model off). Moves keep at least two reps.
 */
export function pruneOutliers<T extends { seg: Segment; label: Label }>(taught: T[]): T[] {
  const reps = taught.filter((x) => x.label !== 'none');
  if (reps.length < 4) return taught;
  const vs = taught.map((x) => vector(x.seg));
  const n = vs[0].length;
  const sd = Array.from({ length: n }, (_, i) => {
    const col = vs.map((v) => v[i]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    return Math.max(CONFIG.model.minStd, Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length));
  });
  const d = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + ((x - b[i]) / sd[i]) ** 2, 0));
  const near = new Map<T, number>();
  for (const x of reps) {
    const vx = vs[taught.indexOf(x)];
    const same = reps.filter((o) => o !== x && o.label === x.label && o.seg.hand === x.seg.hand);
    if (same.length < 2) continue;
    near.set(x, Math.min(...same.map((o) => d(vx, vs[taught.indexOf(o)]))));
  }
  const all = [...near.values()].sort((a, b) => a - b);
  if (!all.length) return taught;
  const typical = all[Math.floor(all.length / 2)];
  const drop = new Set<T>();
  const limit = Math.max(CONFIG.model.outlierMinDist, typical * CONFIG.model.outlierScale);
  for (const [x, v] of near) if (v > limit) drop.add(x);
  return taught.filter((x) => !drop.has(x));
}

/** `prior`: optional population samples that fill gaps in the player's own (see share.ts). */
export function modelFrom(profile: Profile, prior?: Sample[]): KnnModel | null {
  return profile.samples.some((s) => s.label !== 'none') ? new KnnModel(profile.samples, undefined, undefined, prior) : null;
}
