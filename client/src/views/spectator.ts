import * as THREE from 'three';
import type { MatchEvent, Slot } from '../../../shared/types.ts';
import { other } from '../../../shared/types.ts';
import { sound } from '../audio/sound.ts';
import type { MatchLink } from '../net/link.ts';
import { ProceduralAvatar } from '../scene/avatar.ts';
import { Sparks } from '../scene/fp.ts';
import { Stage } from '../scene/stage.ts';
import { commonEvent } from '../ui/announce.ts';
import { button, h } from '../ui/dom.ts';
import { Hud } from '../ui/hud.ts';

const NAMES: [string, string] = ['Red', 'Blue'];

/** Side view of both fighters with a slow orbiting camera. Spectators send no input. */
export function startSpectator(app: HTMLElement, link: MatchLink, opts: { code?: string; demo?: boolean } = {}): void {
  const host = h('div', { class: 'stage' });
  app.append(host);
  const stage = new Stage(host);
  const hud = new Hud(NAMES);
  if (!opts.demo) app.append(hud.root);

  const avatars = [new ProceduralAvatar('red'), new ProceduralAvatar('blue')];
  avatars[0].object.position.set(-0.75, 0, 0);
  avatars[0].object.rotation.y = Math.PI / 2;
  avatars[1].object.position.set(0.75, 0, 0);
  avatars[1].object.rotation.y = -Math.PI / 2;
  for (const a of avatars) stage.scene.add(a.object);
  const sparks = new Sparks();
  stage.scene.add(sparks.object);
  const tmp = new THREE.Vector3();
  let hitStopUntil = [0, 0];

  if (!opts.demo) {
    const waiting = h('div', { class: 'panel watch' },
      h('h2', {}, `Watching ${opts.code ?? ''}`),
      h('p', { class: 'watch-status' }, 'Waiting for the fighters...'),
      button('Enable sound', () => {
        sound.unlock();
        sound.startCrowd();
        sound.announce('welcome');
      }, 'primary'),
    );
    app.append(waiting);
    document.body.classList.add('spectating');
  }

  link.handlers = {
    lobby(ps, spectators) {
      const el = app.querySelector('.watch-status');
      if (!el) return;
      const ready = ps.filter((p) => p?.ready).length;
      const joined = ps.filter((p) => p?.connected).length;
      el.textContent = `${joined}/2 fighters in the room, ${ready} ready. ${spectators} watching.`;
    },
    state(s) {
      hud.setState(s);
      avatars.forEach((a, i) => a.setGassed(s.fighters[i].gassed));
      document.body.classList.toggle('fighting', s.phase !== 'lobby');
    },
    pose(slot, p) {
      if (performance.now() >= hitStopUntil[slot]) avatars[slot].setPose(p);
    },
    event(ev: MatchEvent) {
      if (!opts.demo) commonEvent(ev, hud, NAMES, stage.scene);
      if (ev.e === 'land' && (ev.outcome === 'hit' || ev.outcome === 'block')) {
        const def = avatars[other(ev.attacker)];
        def.playReaction({ kind: ev.outcome, zone: ev.zone, heavy: ev.damage >= 9 });
        if (ev.stagger) def.playReaction({ kind: 'stagger' });
        sparks.spawn(def.zonePosition(ev.zone, tmp), ev.outcome === 'hit' ? 0xffd27a : 0x9fc6ff, ev.outcome === 'hit' ? 40 : 14);
        if (ev.outcome === 'hit') hitStopUntil = hitStopUntil.map((v, i) => (i === other(ev.attacker) ? performance.now() + 60 : v));
      }
      if (ev.e === 'knockdown') avatars[ev.slot as Slot].playReaction({ kind: 'knockdown' });
      if (ev.e === 'getUp') avatars[ev.slot].playReaction({ kind: 'getUp' });
      if (ev.e === 'roundStart' && opts.demo) avatars.forEach((a) => a.playReaction({ kind: 'reset' }));
    },
  };

  stage.onUpdate((dt, t) => {
    hud.tick();
    avatars.forEach((a, i) => {
      if (performance.now() >= hitStopUntil[i]) a.update(dt);
    });
    sparks.update(dt);
    const ang = t * 0.08;
    const r = opts.demo ? 4.6 : 4.0;
    stage.camera.position.set(Math.sin(ang) * r, 1.9 + Math.sin(t * 0.21) * 0.25, Math.cos(ang) * r);
    stage.camera.lookAt(0, 1.15, 0);
  });
}
