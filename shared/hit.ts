import { RULES, isStraight, punchKind } from './rules.ts';
import type { DefenseState, Outcome, Punch, Side, Zone } from './types.ts';

export interface DefenseSample {
  at: number;
  def: DefenseState;
}

/** The attacker's right hand lands on the defender's left side, and vice versa. */
export function zoneFor(punch: Punch): Zone {
  const side: Side = punch.hand === 'right' ? 'left' : 'right';
  return `${punch.target}-${side}` as Zone;
}

/** Slipping away from the side a straight lands on dodges it. */
export function dodgingSlip(zone: Zone): Side {
  return zone.endsWith('left') ? 'right' : 'left';
}

/** True if `pred` held at any moment in [from, to]. History must be sorted by `at`. */
export function heldDuring(history: DefenseSample[], from: number, to: number, pred: (d: DefenseState) => boolean): boolean {
  let before: DefenseSample | undefined;
  for (const s of history) {
    if (s.at <= from) before = s;
    else if (s.at <= to && pred(s.def)) return true;
  }
  return before !== undefined && pred(before.def);
}

export interface HitInput {
  punch: Punch;
  peakAt: number;
  attackerGassed: boolean;
  defense: DefenseSample[];
}

export interface HitResult {
  zone: Zone;
  outcome: Outcome;
  damage: number;
  stagger: boolean;
  blocked: boolean;
}

export function rawDamage(punch: Punch, gassed: boolean): number {
  let d = RULES.damage[punchKind(punch.type)];
  if (punch.target === 'head') d *= RULES.headMultiplier;
  if (gassed) d *= RULES.gassedDamageMultiplier;
  return round1(d);
}

export function resolveHit({ punch, peakAt, attackerGassed, defense }: HitInput): HitResult {
  const zone = zoneFor(punch);
  const from = peakAt - RULES.defenseWindowBeforeMs;
  const to = peakAt + RULES.defenseWindowAfterMs;
  const held = (pred: (d: DefenseState) => boolean) => heldDuring(defense, from, to, pred);
  const dmg = rawDamage(punch, attackerGassed);

  const ducked = punch.target === 'head' && held((d) => d.duck);
  const slipped = isStraight(punch.type) && held((d) => d.slip === dodgingSlip(zone));
  if (ducked || slipped) return { zone, outcome: 'dodge', damage: 0, stagger: false, blocked: false };
  if (held((d) => d.guard)) {
    return { zone, outcome: 'block', damage: round1(dmg * RULES.chipFraction), stagger: false, blocked: true };
  }
  const kind = punchKind(punch.type);
  const stagger = punch.target === 'head' && kind !== 'jab' && dmg >= RULES.staggerMinDamage;
  return { zone, outcome: 'hit', damage: dmg, stagger, blocked: false };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
