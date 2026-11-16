import type { WireSnapshot } from './wire.ts';

export type Slot = 0 | 1;
export type Hand = 'left' | 'right';
export type Side = 'left' | 'right';
export type Target = 'head' | 'body';
export type Stance = 'orthodox' | 'southpaw';
export type PunchType = 'jab' | 'cross' | 'leftHook' | 'rightHook' | 'leftUppercut' | 'rightUppercut';
export type Zone = 'head-left' | 'head-right' | 'body-left' | 'body-right';

/** Sides are from the player's own point of view (their left, their right). */
export interface DefenseState {
  guard: boolean;
  duck: boolean;
  slip: 'none' | Side;
}

export const NO_DEFENSE: DefenseState = { guard: false, duck: false, slip: 'none' };

export interface Punch {
  type: PunchType;
  hand: Hand;
  target: Target;
}

/** Upper-body landmarks sent over the wire, in MediaPipe Pose indices. */
export const WIRE_LANDMARKS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 19, 20, 23, 24] as const;
export const W = {
  nose: 0, lEar: 1, rEar: 2, lShoulder: 3, rShoulder: 4, lElbow: 5, rElbow: 6,
  lWrist: 7, rWrist: 8, lIndex: 9, rIndex: 10, lHip: 11, rHip: 12,
} as const;

/**
 * One pose sample. `lm` holds WIRE_LANDMARKS world coordinates (MediaPipe world space,
 * metres, hip-centred, y down, z negative toward the camera) flattened and stored in mm.
 * `off` is the whole-body offset from the calibrated neutral position in shoulder widths x100
 * (x positive toward the player's left, y positive down), which world space cannot express.
 */
export interface WirePose {
  lm: number[];
  off: [number, number];
}

export type FighterStatus = 'up' | 'down' | 'gettingUp';
export type Phase = 'lobby' | 'countdown' | 'round' | 'break' | 'ended';
export type ResultKind = 'ko' | 'tko' | 'decision' | 'draw' | 'forfeit';

export interface FighterSnapshot {
  hp: number;
  stamina: number;
  gassed: boolean;
  exhausted: boolean;
  knockdowns: number;
  status: FighterStatus;
  count: number;
  getUpProgress: number;
  protectedMs: number;
}

export interface MatchResult {
  kind: ResultKind;
  winner: Slot | null;
}

export interface MatchSnapshot {
  phase: Phase;
  paused: boolean;
  round: number;
  /** Remaining ms of the current round, break or countdown. */
  clockMs: number;
  fighters: [FighterSnapshot, FighterSnapshot];
  result: MatchResult | null;
}

export type Outcome = 'hit' | 'block' | 'dodge' | 'whiff';

export type MatchEvent =
  | { e: 'throw'; slot: Slot; punch: Punch }
  | { e: 'land'; attacker: Slot; punch: Punch; zone: Zone; outcome: Outcome; damage: number; stagger: boolean }
  | { e: 'knockdown'; slot: Slot; n: number }
  | { e: 'count'; slot: Slot; n: number }
  | { e: 'getUp'; slot: Slot }
  | { e: 'roundStart'; round: number }
  | { e: 'roundEnd'; round: number }
  | { e: 'matchEnd'; result: MatchResult }
  | { e: 'paused'; reason: string }
  | { e: 'resumed' };

export interface LobbyPlayer {
  connected: boolean;
  calibrated: boolean;
  ready: boolean;
  stance: Stance;
}

export type ClientMsg =
  | { t: 'create' }
  | { t: 'join'; code: string; token?: string }
  | { t: 'watch'; code: string }
  | { t: 'ping'; c: number }
  | { t: 'ready'; ready: boolean; calibrated: boolean; stance: Stance }
  /** A pose as `k` (full, flattened; the first after each join) or `dp` (change from the last). `p` is the older plain form. */
  | { t: 'pose'; p?: WirePose; k?: number[]; dp?: number[] }
  | { t: 'punch'; punch: Punch; at: number }
  | { t: 'defense'; def: DefenseState; at: number };

export type ServerMsg =
  | { t: 'joined'; code: string; role: 'player' | 'spectator'; slot: Slot | null; token: string | null }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'lobby'; players: [LobbyPlayer | null, LobbyPlayer | null]; spectators: number }
  /**
   * A relayed pose (shared/wire.ts): `k` is a full flattened pose (sent first and to anyone who
   * joins), `dp` the change from the previous one for that slot. `d` is the packed defense.
   */
  | { t: 'pose'; slot: Slot; d: number; k?: number[]; dp?: number[] }
  /** `s` is packed by encodeSnapshot (shared/wire.ts); `r` is the rejoin countdown in ms while paused. */
  | { t: 'state'; s: WireSnapshot; r?: number }
  /** `at` is the server time of the event and `id` a sequence number, so every client can play the same audio cue at the same moment. */
  | { t: 'event'; ev: MatchEvent; at?: number; id?: number };

export function other(slot: Slot): Slot {
  return slot === 0 ? 1 : 0;
}
