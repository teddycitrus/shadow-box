import { punchKind } from '../../../shared/rules.ts';
import type { MatchEvent } from '../../../shared/types.ts';
import { ANNOUNCER_LINES, sound, type LineKey } from '../audio/sound.ts';
import { exciteCrowd } from '../scene/arena.ts';
import type { Hud } from './hud.ts';
import { resultText } from './hud.ts';
import type * as THREE from 'three';

/** Sounds, crowd, announcer and banners shared by player and spectator views. */
export function commonEvent(ev: MatchEvent, hud: Hud, names: [string, string], scene: THREE.Scene): void {
  const say = (k: LineKey) => {
    sound.announce(k);
    hud.say(ANNOUNCER_LINES[k]);
  };
  switch (ev.e) {
    case 'roundStart':
      sound.sfx('bell');
      say(ev.round === 1 ? 'round1' : ev.round === 2 ? 'round2' : 'round3');
      hud.show(ev.round === 3 ? 'Final round' : `Round ${ev.round}`, 1500, 'round');
      setTimeout(() => hud.show('Fight', 700, 'fight'), 1500);
      break;
    case 'roundEnd':
      sound.sfx('bell_end');
      sound.sfx('cheer');
      say('time');
      hud.show('Time', 1500);
      break;
    case 'land':
      if (ev.outcome === 'hit') {
        const big = ev.stagger || ev.damage >= 12;
        sound.sfx(big ? 'impact_big' : ev.damage >= 9 ? 'hit_heavy' : 'hit_light');
        if (big) sound.sfx('ooh');
        else if (ev.damage >= 9 && Math.random() < 0.5) sound.sfx('cheer');
        exciteCrowd(scene, ev.damage / (big ? 15 : 40));
        if (ev.stagger) say(punchKind(ev.punch.type) === 'uppercut' ? 'uppercut' : 'big_shot');
      } else if (ev.outcome === 'block') sound.sfx('block');
      else sound.sfx('whoosh');
      break;
    case 'knockdown':
      sound.sfx('ko_slam');
      sound.sfx('roar');
      exciteCrowd(scene, 1);
      say(ev.slot === 0 ? 'down_red' : 'down_blue');
      hud.show('Down', 1200, 'down');
      break;
    case 'count':
      if (ev.n > 1) sound.sfx('count_tick');
      break;
    case 'getUp':
      say('up');
      sound.sfx('cheer');
      break;
    case 'matchEnd': {
      sound.sfx('bell');
      const r = ev.result;
      sound.sfx('cheer');
      if (r.kind === 'ko' || r.kind === 'tko') {
        sound.sfx('ko_slam');
        sound.sfx('roar');
        exciteCrowd(scene, 1);
      }
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
