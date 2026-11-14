import type { Hand, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import { passesGate, type Features, type Segment } from './classifier.ts';
import { KnnModel, kindOf, vector, type Sample } from './model.ts';

export interface TeachStep {
  id: string;
  prompt: string;
  kind: 'punch' | 'duck' | 'slipLeft' | 'slipRight';
  type?: PunchType;
  target?: Target;
}

export const DEFENSE_STEP_MS = 3_500;

export function teachSteps(): TeachStep[] {
  const p = (type: PunchType, target: Target, prompt: string): TeachStep => ({ id: `${type}-${target}`, prompt, kind: 'punch', type, target });
  return [
    p('jab', 'head', 'Jab'),
    p('cross', 'head', 'Cross'),
    p('leftHook', 'head', 'Left hook'),
    p('rightHook', 'head', 'Right hook'),
    p('leftUppercut', 'head', 'Left uppercut'),
    p('rightUppercut', 'head', 'Right uppercut'),
    p('jab', 'body', 'Jab to the body'),
    p('cross', 'body', 'Cross to the body'),
    { id: 'duck', prompt: 'Duck', kind: 'duck' },
    { id: 'slipLeft', prompt: 'Slip left', kind: 'slipLeft' },
    { id: 'slipRight', prompt: 'Slip right', kind: 'slipRight' },
  ];
}

export function handFor(type: PunchType, stance: Stance): Hand {
  if (type === 'jab') return stance === 'orthodox' ? 'left' : 'right';
  if (type === 'cross') return stance === 'orthodox' ? 'right' : 'left';
  return type.startsWith('left') ? 'left' : 'right';
}

export interface TeachStatus {
  done: boolean;
  index: number;
  total: number;
  step: TeachStep | null;
  reps: number;
  repsNeeded: number;
  /** 0..1 time used on the current step. */
  progress: number;
}

export interface Profile {
  samples: Sample[];
  defense: { duck: number; slipLeft: number; slipRight: number };
  learned: string[];
  /** Wrist height at the peak (sw below the shoulder line) above which a punch is a body shot. */
  bodySplit: number;
}

/**
 * The guided per-player calibration (about 60 s). Prompts each punch a few times and records
 * the motion segments as labelled k-NN samples, then measures how far this player ducks and
 * slips to set their defense thresholds.
 */
export class Teacher {
  readonly steps = teachSteps();
  private i = 0;
  private stepStart: number | null = null;
  private reps = 0;
  private samples: Sample[] = [];
  private learned: string[] = [];
  private extreme = { duck: 0, slipLeft: 0, slipRight: 0 };
  /** Peak heights of the taught straights, to place this player's head/body line. */
  private heights: { head: number[]; body: number[] } = { head: [], body: [] };

  constructor(private stance: Stance) {}

  get done(): boolean {
    return this.i >= this.steps.length;
  }

  /** Feed every motion segment while teaching (classifier.onSegment). */
  segment(seg: Segment): void {
    const s = this.steps[this.i];
    if (!s || s.kind !== 'punch' || !passesGate(seg)) return;
    if (seg.hand === handFor(s.type!, this.stance) && this.reps < CONFIG.model.repsPerMove) {
      this.samples.push({ hand: seg.hand, label: kindOf(s.type!), v: vector(seg) });
      if (kindOf(s.type!) === 'straight') this.heights[s.target!].push(seg.peakY);
      this.reps++;
    } else {
      this.samples.push({ hand: seg.hand, label: 'none', v: vector(seg) });
    }
  }

  /** Feed every frame's features; also advances the steps. */
  update(t: number, f: Features | null): TeachStatus {
    if (this.stepStart === null) this.stepStart = t;
    const s = this.steps[this.i];
    if (s && f) {
      if (s.kind === 'duck') this.extreme.duck = Math.max(this.extreme.duck, f.headDy);
      if (s.kind === 'slipLeft') this.extreme.slipLeft = Math.max(this.extreme.slipLeft, f.headDx);
      if (s.kind === 'slipRight') this.extreme.slipRight = Math.max(this.extreme.slipRight, -f.headDx);
    }
    const limit = s?.kind === 'punch' ? CONFIG.model.moveTimeoutMs : DEFENSE_STEP_MS;
    const elapsed = t - this.stepStart;
    if (s && ((s.kind === 'punch' && this.reps >= CONFIG.model.repsPerMove) || elapsed >= limit)) {
      if (s.kind === 'punch' && this.reps > 0) this.learned.push(s.id);
      this.i++;
      this.reps = 0;
      this.stepStart = t;
    }
    const cur = this.steps[this.i] ?? null;
    return {
      done: this.done, index: this.i, total: this.steps.length, step: cur, reps: this.reps,
      repsNeeded: cur?.kind === 'punch' ? CONFIG.model.repsPerMove : 0,
      progress: cur ? Math.min(1, (t - this.stepStart) / (cur.kind === 'punch' ? CONFIG.model.moveTimeoutMs : DEFENSE_STEP_MS)) : 1,
    };
  }

  profile(): Profile {
    const k = CONFIG.model.defenseFraction;
    const d = CONFIG.defense;
    const pick = (measured: number, fallback: number) => (measured > fallback * 0.6 ? Math.max(fallback * 0.5, measured * k) : fallback);
    return {
      samples: this.samples,
      defense: {
        duck: pick(this.extreme.duck, d.duckDrop),
        slipLeft: pick(this.extreme.slipLeft, d.slipShift),
        slipRight: pick(this.extreme.slipRight, d.slipShift),
      },
      learned: this.learned,
      bodySplit: bodySplit(this.heights.head, this.heights.body),
    };
  }
}

/** Midway between the player's head and body straights; the default when either is missing. */
export function bodySplit(head: number[], body: number[]): number {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  if (!head.length || !body.length || mean(body) <= mean(head)) return CONFIG.punch.headBodySplit;
  return (mean(head) + mean(body)) / 2;
}

export function modelFrom(profile: Profile): KnnModel | null {
  return profile.samples.some((s) => s.label !== 'none') ? new KnnModel(profile.samples, CONFIG.model.k) : null;
}
