import type { DefenseState, Hand, Punch } from '../../../shared/types.ts';
import { L, type Lm, type PoseFrame } from './frame.ts';

/**
 * Procedural upper-body poses in MediaPipe world space (metres, hip-centred, x toward the
 * player's left, y down, z negative toward the camera). Drives the practice bot, the ?keys=1
 * keyboard mode, and the classifier test fixtures.
 */

type V = [number, number, number];

const UPPER = 0.28;
const FORE = 0.27;
/**
 * synthFrame's camera: a laptop on a low table, about hip height, 1.2 m away. Like most real
 * setups it sees straights move a long way on screen (up, as the fist comes toward it).
 */
const CAM_DIST = 1.2;
const FOCAL = 1.1;
const CAM_Y = 0;
const CENTRE_Y = 0.75;
const SYNTH_ASPECT = 16 / 9;

export interface SynthPunch extends Punch {
  startT: number;
  windupMs: number;
}

export interface SynthState {
  t: number;
  defense: DefenseState;
  punch?: SynthPunch;
  gassed?: boolean;
}

const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => mul(a, 1 / (len(a) || 1));
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: V, b: V, k: number): V => add(a, mul(sub(b, a), k));
const bez = (a: V, c: V, b: V, k: number): V => lerp(lerp(a, c, k), lerp(c, b, k), k);
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k));

/** Two-bone IK: elbow position for a shoulder and wrist, bending toward `pole`. */
function solveElbow(s: V, w: V, pole: V): V {
  let d = sub(w, s);
  let dl = len(d);
  const maxL = UPPER + FORE - 1e-3;
  if (dl > maxL) {
    d = mul(norm(d), maxL);
    dl = maxL;
  }
  const dir = norm(d);
  const a = (UPPER * UPPER - FORE * FORE + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
  const p = norm(sub(pole, mul(dir, dot(pole, dir))));
  return add(add(s, mul(dir, a)), mul(p, h));
}

export const PUNCH_TIMING = { extendMs: 140, holdMs: 60, retractMs: 220 };

export function punchDuration(p: SynthPunch): number {
  return p.windupMs + PUNCH_TIMING.extendMs + PUNCH_TIMING.holdMs + PUNCH_TIMING.retractMs;
}

function guardWrist(s: number, def: DefenseState, gassed: boolean): V {
  if (def.guard) return [s * 0.065, -0.63, -0.16];
  return [s * 0.11, gassed ? -0.38 : -0.5, -0.24];
}

interface ArmPose {
  wrist: V;
  pole: V;
}

function armPose(hand: Hand, st: SynthState): ArmPose {
  const s = hand === 'left' ? 1 : -1;
  const rest = guardWrist(s, st.defense, !!st.gassed);
  const restPole: V = [s, 1, 0.2];
  const p = st.punch;
  if (!p || p.hand !== hand) return { wrist: rest, pole: restPole };
  const k = st.t - p.startT;
  if (k < 0 || k > punchDuration(p)) return { wrist: rest, pole: restPole };

  const shoulder: V = [s * 0.19, -0.45, 0];
  // A body shot is the same arm motion thrown from a crouch (crouchOf lowers the whole body).
  const kind = p.type === 'jab' || p.type === 'cross' ? 'straight' : p.type.endsWith('Hook') ? 'hook' : 'uppercut';

  let wind: V;
  let path: (u: number) => V;
  let pole: V;
  if (kind === 'straight') {
    wind = add(rest, [s * 0.02, 0.03, 0.1]);
    const end = add(shoulder, mul(norm([-0.14 * s, -0.08, -0.53]), 0.545));
    path = (u) => lerp(wind, end, easeOut(u));
    pole = [s, 1, 0];
  } else if (kind === 'hook') {
    wind = add(rest, [s * 0.12, 0.04, 0.05]);
    const ctrl: V = [s * 0.42, -0.55, -0.34];
    const end: V = [-s * 0.1, -0.57, -0.3];
    path = (u) => bez(wind, ctrl, end, easeOut(u));
    pole = [s, -0.15, 0.4];
  } else {
    wind = [s * 0.12, -0.22, -0.16];
    const end: V = [s * 0.02, -0.66, -0.3];
    path = (u) => lerp(wind, end, easeOut(u));
    pole = [s * 0.4, 1, 0.3];
  }

  const { extendMs, holdMs, retractMs } = PUNCH_TIMING;
  let wrist: V;
  if (k < p.windupMs) wrist = lerp(rest, wind, easeInOut(Math.min(1, k / Math.max(1, p.windupMs * 0.6))));
  else if (k < p.windupMs + extendMs) wrist = path((k - p.windupMs) / extendMs);
  else if (k < p.windupMs + extendMs + holdMs) wrist = path(1);
  else wrist = lerp(path(1), rest, easeInOut((k - p.windupMs - extendMs - holdMs) / retractMs));
  return { wrist, pole };
}

export interface SynthPose {
  world: Lm[];
  /** Whole-body offset in metres (x toward the player's left, y down) for ducks, crouched punches and slips. */
  offset: [number, number];
}

/** How deep a body punch crouches, as a fraction of a full duck. */
const BODY_CROUCH = 0.85;

/**
 * 0 to 1 crouch at this moment: a full duck, or a body punch, which dips the head over the
 * wind-up and the first part of the extension, holds it to the peak, and comes back up on the
 * retraction.
 */
function crouchOf(st: SynthState): number {
  const duck = st.defense.duck ? 1 : 0;
  const p = st.punch;
  if (!p || p.target !== 'body') return duck;
  const k = st.t - p.startT;
  if (k < 0 || k > punchDuration(p)) return duck;
  const down = Math.max(80, p.windupMs + PUNCH_TIMING.extendMs * 0.5);
  const up = punchDuration(p) - PUNCH_TIMING.retractMs;
  const c = k < down ? easeInOut(k / down) : k < up ? 1 : 1 - easeInOut((k - up) / PUNCH_TIMING.retractMs);
  return Math.max(duck, BODY_CROUCH * c);
}

export function synthPose(st: SynthState): SynthPose {
  const pts: V[] = Array.from({ length: 33 }, () => [0, 0, 0]);
  const crouch = crouchOf(st);
  const slip = st.defense.slip === 'left' ? 1 : st.defense.slip === 'right' ? -1 : 0;
  const lean = 0.1 * crouch;
  const headX = slip * 0.06;

  pts[L.lHip] = [0.1, 0, 0];
  pts[L.rHip] = [-0.1, 0, 0];
  pts[L.lShoulder] = [0.19 + headX * 0.4, -0.45 + lean * 0.3, -lean];
  pts[L.rShoulder] = [-0.19 + headX * 0.4, -0.45 + lean * 0.3, -lean];
  pts[L.nose] = [headX, -0.65 + lean * 0.5, -0.08 - lean * 1.3];
  pts[9] = [headX + 0.03, -0.61 + lean * 0.5, -0.07 - lean * 1.3];
  pts[10] = [headX - 0.03, -0.61 + lean * 0.5, -0.07 - lean * 1.3];
  pts[L.lEar] = [headX + 0.075, -0.64 + lean * 0.5, -lean * 1.3];
  pts[L.rEar] = [headX - 0.075, -0.64 + lean * 0.5, -lean * 1.3];

  for (const hand of ['left', 'right'] as Hand[]) {
    const s = hand === 'left' ? 1 : -1;
    const sh = hand === 'left' ? L.lShoulder : L.rShoulder;
    const { wrist, pole } = armPose(hand, st);
    const w = add(wrist, [headX * 0.5, lean * 0.3, -lean]);
    const e = solveElbow(pts[sh], w, pole);
    const fwd = norm(sub(w, e));
    pts[hand === 'left' ? L.lElbow : L.rElbow] = e;
    pts[hand === 'left' ? L.lWrist : L.rWrist] = w;
    pts[hand === 'left' ? L.lIndex : L.rIndex] = add(w, mul(fwd, 0.08));
    pts[hand === 'left' ? 17 : 18] = add(w, add(mul(fwd, 0.07), [s * 0.02, 0, 0]));
    pts[hand === 'left' ? 21 : 22] = add(w, mul(fwd, 0.04));
  }
  for (const [i, hip] of [[25, L.lHip], [26, L.rHip], [27, L.lHip], [28, L.rHip]] as const) {
    pts[i] = add(pts[hip], [0, i < 27 ? 0.45 : 0.9, 0]);
  }
  const world = pts.map(([x, y, z]) => ({ x, y, z, v: 1 }));
  return { world, offset: [slip * 0.2, 0.3 * crouch] };
}

/** Projects a synthetic pose through a pinhole camera to build a full PoseFrame. */
export function synthFrame(st: SynthState): PoseFrame {
  const { world, offset } = synthPose(st);
  // The whole-body offset moves every point by the same amount on screen (as seen at body depth),
  // so a crouch lowers an extended fist as much as the shoulders and keeps the punch shape.
  const img = world.map((p, i) => {
    const headish = i <= 10;
    const ox = offset[0] * (headish ? 1 : 0.5);
    const d = CAM_DIST + p.z;
    return { x: SYNTH_ASPECT / 2 + (FOCAL * p.x) / d + (FOCAL * ox) / CAM_DIST, y: CENTRE_Y + (FOCAL * (p.y - CAM_Y)) / d + (FOCAL * offset[1]) / CAM_DIST, z: p.z, v: 1 };
  });
  return { t: st.t, img, world };
}
