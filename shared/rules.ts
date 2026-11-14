import type { PunchType } from './types.ts';

export const RULES = {
  maxHp: 100,
  rounds: 3,
  roundMs: 60_000,
  breakMs: 8_000,
  countdownMs: 3_000,

  damage: { jab: 4, cross: 7, hook: 9, uppercut: 11 } as Record<PunchKind, number>,
  headMultiplier: 1.5,
  gassedDamageMultiplier: 0.6,
  chipFraction: 0.1,
  staggerMinDamage: 12,
  staggerMs: 400,

  defenseWindowBeforeMs: 150,
  defenseWindowAfterMs: 80,
  /** Extra wait past the window so the defender's state changes have time to arrive. */
  resolveGraceMs: 70,
  /** Punch timestamps older than this (relative to receive time) are clamped. */
  maxPunchAgeMs: 400,

  maxStamina: 100,
  punchCost: { jab: 6, cross: 10, hook: 12, uppercut: 14 } as Record<PunchKind, number>,
  blockCost: 4,
  recoverDelayMs: 600,
  recoverPerSec: 15,
  guardRecoverPerSec: 25,
  gassedBelow: 30,
  exhaustedResumeAt: 20,

  countStepMs: 1_000,
  countMax: 10,
  getUpHoldMs: [2_000, 3_500],
  getUpRestoreHp: [30, 20],
  getUpStamina: 50,
  getUpAnimMs: 1_200,
  protectAfterGetUpMs: 1_500,
  tkoKnockdowns: 3,

  rejoinMs: 60_000,
} as const;

export type PunchKind = 'jab' | 'cross' | 'hook' | 'uppercut';

export function punchKind(p: PunchType): PunchKind {
  if (p === 'jab' || p === 'cross') return p;
  return p.endsWith('Hook') ? 'hook' : 'uppercut';
}

export function isStraight(p: PunchType): boolean {
  return p === 'jab' || p === 'cross';
}
