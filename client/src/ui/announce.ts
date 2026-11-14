import { punchKind } from '../../../shared/rules.ts';
import type { MatchEvent, Phase } from '../../../shared/types.ts';
import { ANNOUNCER_LINES, sound, type LineKey } from '../audio/sound.ts';
import { exciteCrowd } from '../scene/arena.ts';
import type { Hud } from './hud.ts';
import { resultText } from './hud.ts';
import type * as THREE from 'three';

/** Swoosh level per punch kind, so jabs whisper and hooks cut the air. */
const THROW_GAIN = { jab: 0.65, cross: 0.85, hook: 1, uppercut: 1 } as const;

/** Sounds, crowd, announcer and banners shared by player and spectator views. */
export function commonEvent(ev: MatchEvent, hud: Hud, names: [string, string], scene: THREE.Scene): void {
  const say = (k: LineKey) => {
    sound.announce(k);
    hud.say(ANNOUNCER_LINES[k]);
  };
  const excite = (k: number) => {
    exciteCrowd(scene, k);
    sound.excite(k);
  };
  switch (ev.e) {
    case 'roundStart':
      sound.sfx('hype');
      sound.sfx('bell', { delay: 0.25 });
      excite(ev.round === 3 ? 0.8 : 0.5);
      say(ev.round === 1 ? 'round1' : ev.round === 2 ? 'round2' : 'round3');
      hud.show(ev.round === 3 ? 'Final round' : `Round ${ev.round}`, 1500, 'round');
      setTimeout(() => {
        if (hud.paused) return;
        hud.show('Fight', 700, 'fight');
        sound.announce('fight');
      }, 1500);
      break;
    case 'roundEnd':
      sound.sfx('bell_end');
      sound.sfx('cheer', { delay: 0.2 });
      excite(0.5);
      say('time');
      hud.show('Time', 1500);
      break;
    case 'throw':
      sound.sfx('swoosh', { gain: THROW_GAIN[punchKind(ev.punch.type)] });
      break;
    case 'land': {
      const kind = punchKind(ev.punch.type);
      if (ev.outcome === 'hit') {
        const big = ev.stagger || ev.damage >= 12;
        const heavy = !big && ev.damage >= 9;
        const body = ev.zone.startsWith('body');
        sound.sfx(big ? 'impact_big' : heavy ? 'hit_heavy' : 'hit_light');
        sound.sfx('body_thump', { gain: big ? 1 : heavy ? 0.8 : body ? 0.7 : 0.45 });
        if (big) {
          sound.duck(0.35, 700);
          sound.sfx('ooh', { cooldownMs: 900 });
        } else if (heavy) sound.sfx(Math.random() < 0.5 ? 'cheer' : 'ooh', { gain: 0.6, cooldownMs: 1500 });
        excite(ev.damage / (big ? 15 : 40));
        if (ev.stagger) say(kind === 'uppercut' ? 'uppercut' : 'big_shot');
      } else if (ev.outcome === 'block') {
        sound.sfx('block');
        if (Math.random() < 0.35) sound.sfx('crowd_murmur', { cooldownMs: 2500 });
        excite(0.05);
      } else {
        const dodge = ev.outcome === 'dodge';
        sound.sfx('whoosh', { gain: dodge ? 1 : 0.7 });
        if (dodge && (kind === 'hook' || kind === 'uppercut') && Math.random() < 0.45) {
          sound.sfx('ooh', { gain: 0.55, delay: 0.1, cooldownMs: 2000 });
          excite(0.2);
        }
      }
      break;
    }
    case 'knockdown':
      sound.duck(0.25, 1100);
      sound.sfx('ko_slam');
      sound.sfx('roar', { delay: 0.15 });
      excite(1);
      say(ev.slot === 0 ? 'down_red' : 'down_blue');
      hud.show('Down', 1200, 'down');
      break;
    case 'count':
      if (ev.n > 1) {
        sound.sfx('count_tick');
        // The crowd stomps along with the referee, louder as the count climbs.
        sound.sfx('stomp', { gain: 0.45 + 0.05 * ev.n, delay: 0.05 });
        if (ev.n === 2 || ev.n === 6) sound.sfx('chant', { gain: 0.6 + 0.04 * ev.n });
        excite(0.2 + 0.05 * ev.n);
      }
      break;
    case 'getUp':
      say('up');
      sound.sfx('cheer');
      excite(0.7);
      break;
    case 'matchEnd': {
      const r = ev.result;
      sound.sfx('bell');
      if (r.kind === 'ko' || r.kind === 'tko') {
        sound.duck(0.2, 1500);
        sound.sfx('ko_stinger');
        sound.sfx('roar', { delay: 0.5 });
        excite(1);
      } else {
        sound.sfx('cheer');
        excite(0.7);
      }
      if (r.winner !== null) sound.sfx('fanfare', { delay: r.kind === 'ko' || r.kind === 'tko' ? 1.6 : 0.8 });
      say(r.kind === 'draw' ? 'draw' : r.kind);
      if (r.winner !== null) setTimeout(() => say(r.winner === 0 ? 'red_wins' : 'blue_wins'), 300);
      hud.show(resultText(r, names), 0, 'result');
      break;
    }
    case 'paused':
      hud.show('Paused', 0);
      break;
    case 'resumed':
      hud.show('Resume', 900);
      break;
  }
}

let lastClockMs = Infinity;
let lastPhase: Phase | null = null;
let clapArmed = true;

/**
 * Plays the timekeeper's clapper once when the round clock crosses 10 seconds. Call it every
 * frame (or on each clock update) with the displayed remaining time and the current phase.
 */
export function clockTick(remainingMs: number, phase: Phase): void {
  const prevMs = lastClockMs;
  const prevPhase = lastPhase;
  lastClockMs = remainingMs;
  lastPhase = phase;
  if (phase !== 'round' || prevPhase !== 'round') {
    clapArmed = true;
    return;
  }
  // Re-arm only on a fresh round clock, so snapshot jitter around 10 s cannot clap twice.
  if (remainingMs > 20_000) clapArmed = true;
  if (clapArmed && prevMs > 10_000 && remainingMs <= 10_000 && remainingMs > 0) {
    clapArmed = false;
    sound.sfx('clapper');
    sound.excite(0.35);
  }
}
