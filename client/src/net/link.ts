import type { DefenseState, LobbyPlayer, MatchEvent, MatchSnapshot, Punch, Slot, Stance, WirePose } from '../../../shared/types.ts';

export interface LinkHandlers {
  state(s: MatchSnapshot, rejoinMs: number | null): void;
  event(e: MatchEvent): void;
  pose(slot: Slot, p: WirePose, def: DefenseState): void;
  lobby(players: [LobbyPlayer | null, LobbyPlayer | null], spectators: number): void;
  /** Bot only: wind-up telegraph for the practice opponent. */
  telegraph?(slot: Slot, hand: 'left' | 'right' | null, k: number): void;
}

/** Connection between a view and an authoritative match, local (practice) or remote (server). */
export interface MatchLink {
  readonly slot: Slot | null;
  handlers: LinkHandlers;
  /** `at` is a performance.now() timestamp; the link converts it to match time. */
  punch(p: Punch, at: number): void;
  defense(d: DefenseState, at: number): void;
  pose(p: WirePose): void;
  ready(ready: boolean, calibrated: boolean, stance: Stance): void;
}

export const noopHandlers = (): LinkHandlers => ({ state() {}, event() {}, pose() {}, lobby() {} });
