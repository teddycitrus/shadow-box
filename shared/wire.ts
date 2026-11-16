// Compact encodings for the high-rate server messages (pose relay and state snapshots). The
// server encodes once per broadcast; the client decodes back to the plain types.
import type { DefenseState, FighterStatus, MatchSnapshot, Phase, ResultKind, Slot, WirePose } from './types.ts';

const PHASES: readonly Phase[] = ['lobby', 'countdown', 'round', 'break', 'ended'];
const STATUSES: readonly FighterStatus[] = ['up', 'down', 'gettingUp'];
const RESULTS: readonly ResultKind[] = ['ko', 'tko', 'decision', 'draw', 'forfeit'];
const SLIPS = ['none', 'left', 'right'] as const;

/** Defense as bits: 1 guard, 2 duck, slip in bits 2 and 3 (0 none, 1 left, 2 right). */
export function encodeDefense(d: DefenseState): number {
  return (d.guard ? 1 : 0) | (d.duck ? 2 : 0) | (Math.max(0, SLIPS.indexOf(d.slip)) << 2);
}

export function decodeDefense(n: number): DefenseState {
  return { guard: (n & 1) !== 0, duck: (n & 2) !== 0, slip: SLIPS[(n >> 2) & 3] ?? 'none' };
}

/** A WirePose flattened: the 39 landmark ints, then the two offset ints. */
export const POSE_LEN = 41;

/** Coerces POSE_LEN values to integers (junk becomes 0), so deltas between poses are exact. */
export function cleanPose(a: readonly unknown[]): number[] {
  const out = new Array<number>(POSE_LEN);
  for (let i = 0; i < POSE_LEN; i++) out[i] = Math.round(Number(a[i])) || 0;
  return out;
}

/** Flattens a pose to POSE_LEN integers. */
export function flattenPose(p: WirePose): number[] {
  return cleanPose([...p.lm.slice(0, 39), p.off?.[0], p.off?.[1]]);
}

export function unflattenPose(a: number[]): WirePose {
  return { lm: a.slice(0, 39), off: [a[39], a[40]] };
}

/** Per-value change from `prev` to `cur`; consecutive poses differ by a few mm, so it is short. */
export function poseDelta(cur: number[], prev: number[]): number[] {
  const out = new Array<number>(POSE_LEN);
  for (let i = 0; i < POSE_LEN; i++) out[i] = cur[i] - prev[i];
  return out;
}

export function applyPoseDelta(prev: number[], d: number[]): number[] {
  const out = new Array<number>(POSE_LEN);
  for (let i = 0; i < POSE_LEN; i++) out[i] = prev[i] + (d[i] ?? 0);
  return out;
}

/** Numbers per fighter in a WireSnapshot. */
const FIGHTER_LEN = 8;
/** Offset of the result fields: phase, paused, round, clock, then two fighters. */
const RESULT_AT = 4 + 2 * FIGHTER_LEN;

/**
 * A MatchSnapshot as a flat array: phase, paused, round, clockMs, then per fighter hp, stamina,
 * flags (1 gassed, 2 exhausted), knockdowns, status, count, getUpProgress, protectedMs, then the
 * result kind and winner (-1 when none). Times are whole ms and getUpProgress has two decimals.
 */
export type WireSnapshot = number[];

export function encodeSnapshot(s: MatchSnapshot): WireSnapshot {
  const out = [PHASES.indexOf(s.phase), s.paused ? 1 : 0, s.round, Math.round(s.clockMs)];
  for (const f of s.fighters) {
    out.push(
      f.hp, f.stamina, (f.gassed ? 1 : 0) | (f.exhausted ? 2 : 0), f.knockdowns, STATUSES.indexOf(f.status), f.count,
      Math.round(f.getUpProgress * 100) / 100, Math.round(f.protectedMs),
    );
  }
  out.push(s.result ? RESULTS.indexOf(s.result.kind) : -1, s.result?.winner ?? -1);
  return out;
}

export function decodeSnapshot(w: WireSnapshot): MatchSnapshot {
  const fighter = (o: number) => ({
    hp: w[o], stamina: w[o + 1], gassed: (w[o + 2] & 1) !== 0, exhausted: (w[o + 2] & 2) !== 0, knockdowns: w[o + 3],
    status: STATUSES[w[o + 4]] ?? 'up', count: w[o + 5], getUpProgress: w[o + 6], protectedMs: w[o + 7],
  });
  const kind = RESULTS[w[RESULT_AT]];
  const winner = w[RESULT_AT + 1];
  return {
    phase: PHASES[w[0]] ?? 'lobby', paused: w[1] === 1, round: w[2], clockMs: w[3],
    fighters: [fighter(4), fighter(4 + FIGHTER_LEN)],
    result: kind ? { kind, winner: winner === 0 || winner === 1 ? (winner as Slot) : null } : null,
  };
}

/**
 * What a viewer can see change in a snapshot. The client runs the clock and protection timer
 * locally between updates, so only their whole seconds (and whether protection is on) count.
 */
export function snapshotKey(w: WireSnapshot, rejoinMs: number | null): string {
  const k = w.slice();
  k[3] = Math.ceil(k[3] / 1000);
  for (let o = 4; o < RESULT_AT; o += FIGHTER_LEN) k[o + 7] = k[o + 7] > 0 ? 1 : 0;
  k.push(rejoinMs === null ? -1 : Math.ceil(rejoinMs / 1000));
  return k.join(',');
}
