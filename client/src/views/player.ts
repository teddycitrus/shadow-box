import * as THREE from 'three';
import { RULES } from '../../../shared/rules.ts';
import { other, type DefenseState, type LobbyPlayer, type MatchEvent, type MatchSnapshot, type Slot, type Stance, type WirePose } from '../../../shared/types.ts';
import { sound } from '../audio/sound.ts';
import { CONFIG } from '../config.ts';
import type { MatchLink } from '../net/link.ts';
import { ProceduralAvatar, type Avatar } from '../scene/avatar.ts';
import { FirstPersonGloves, Sparks } from '../scene/fp.ts';
import { Stage } from '../scene/stage.ts';
import { KEY_HELP, type InputSource } from '../tracking/input.ts';
import { hasPendingUpload, onShareChange, setShareConsent, shareConsent } from '../tracking/share.ts';
import type { TeachStatus } from '../tracking/teach.ts';
import { commonEvent } from '../ui/announce.ts';
import { button, flag, go, h } from '../ui/dom.ts';
import { Hud } from '../ui/hud.ts';
import { tuner } from '../ui/tuner.ts';
import type { SessionLog } from '../tracking/session.ts';
import { WebcamBox } from '../ui/webcam.ts';

const EYE = new THREE.Vector3(0, 1.58, 0.8);
const RESULTS_MS = 8_000;
const OPP_Z = -0.95;

export interface PlayerOptions {
  practice: boolean;
  code?: string;
}

/** First-person fight view for a player, used by both practice and online matches. */
export function startPlayer(app: HTMLElement, link: MatchLink, input: InputSource, opts: PlayerOptions): { setSlot(s: Slot | null): void } {
  let mySlot: Slot = link.slot ?? 0;
  const names = (): [string, string] => {
    const n: [string, string] = ['Red', 'Blue'];
    n[mySlot] = 'You';
    n[other(mySlot)] = opts.practice ? 'Bot' : 'Opponent';
    return n;
  };

  const host = h('div', { class: 'stage' });
  app.append(host);
  const stage = new Stage(host);
  const hud = new Hud(names());
  app.append(hud.root);

  const opp: Avatar = new ProceduralAvatar('blue');
  opp.object.position.set(0, 0, OPP_Z);
  stage.scene.add(opp.object);
  const gloves = new FirstPersonGloves();
  stage.camera.add(gloves.object);
  const sparks = new Sparks();
  stage.scene.add(sparks.object);
  stage.camera.position.copy(EYE);
  stage.camera.lookAt(0, 1.4, OPP_Z);

  const keysHelp = h('div', { class: 'keyhelp' }, ...KEY_HELP.map(([k, v]) => h('div', {}, h('kbd', {}, k), ' ', v)));
  const webcam = new WebcamBox(input.video, input.kind === 'keys' ? keysHelp : undefined);
  app.append(webcam.root);

  // Lobby / setup panel.
  let stance: Stance = 'orthodox';
  let ready = false;
  const status = h('div', { class: 'calib-msg' }, 'Starting camera...');
  const progress = h('div', { class: 'progress' }, h('i'));
  const readyBtn = button('Ready', () => {
    ready = !ready;
    if (!sound.muted) void sound.unlock().then(() => sound.startCrowd());
    sendReady();
  }, 'primary');
  const stanceBtn = button('Stance: Orthodox', () => {
    stance = stance === 'orthodox' ? 'southpaw' : 'orthodox';
    stanceBtn.textContent = `Stance: ${stance === 'orthodox' ? 'Orthodox' : 'Southpaw'}`;
    input.stance = stance;
    sendReady();
  });
  const recal = button('Recalibrate', () => {
    input.recalibrate();
    ready = false;
    sendReady();
  });
  const reteach = button('Teach my punches', () => {
    input.reteach();
    ready = false;
    sendReady();
  });
  const skipTeach = button('Skip, use defaults', () => input.skipTeach(), 'ghost');
  const learnedNote = h('div', { class: 'learned' });
  const weakNote = h('div', { class: 'learned weak' });
  const teachBox = h('div', { class: 'teach' });
  webcam.root.append(teachBox);
  const players = h('div', { class: 'players' });
  const share = h('div', { class: 'share' });
  if (opts.code) {
    const copyRow = (label: string, path: string) => {
      const url = `${location.origin}${path}`;
      const copy = button('Copy', () => {
        void navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
      return h('div', { class: 'copyrow' }, h('span', {}, label), h('code', { class: 'linkpath', title: url }, path), copy);
    };
    share.append(
      h('div', { class: 'code' }, opts.code),
      copyRow('Send to opponent', `/join/${opts.code}`),
      copyRow('Send to viewers', `/watch/${opts.code}`),
    );
  }
  const shareBox = h('input', { type: 'checkbox' });
  shareBox.addEventListener('change', () => setShareConsent(shareBox.checked));
  const shareData = h('label', { class: 'share-data' }, shareBox,
    h('span', {}, h('b', {}, 'Share my calibration data to improve tracking'), h('small', {}, 'Only motion measurements are sent, never video.')));
  const syncShare = () => (shareBox.checked = shareConsent() === true);
  syncShare();
  onShareChange(syncShare);
  const lobby = h('div', { class: 'panel lobby' },
    h('h2', {}, opts.practice ? 'Practice' : 'Fight lobby'),
    share,
    h('div', { class: 'calib' }, status, progress, learnedNote, weakNote),
    players,
    h('div', { class: 'row' }, stanceBtn, input.kind === 'camera' ? recal : null),
    input.kind === 'camera' ? h('div', { class: 'row' }, reteach, skipTeach) : null,
    input.kind === 'camera' ? shareData : null,
    h('div', { class: 'row ready-row' }, readyBtn),
    h('p', { class: 'hint' }, input.kind === 'keys'
      ? 'Keyboard mode. Press Ready to start.'
      : 'Laptop at chest height, 1.5 to 2 m away, light in front of you. Hold your guard for 2 seconds to calibrate.'),
    button('Back to title', () => go('/'), 'ghost'),
  );
  app.append(lobby);

  const endPanel = h('div', { class: 'panel end' });
  app.append(endPanel);

  const debug = flag('debug') ? h('pre', { class: 'debug' }) : null;
  if (debug) app.append(debug);
  const log = 'log' in input ? (input as { log: SessionLog | null }).log : null;
  const saveNote = h('span', { class: 'save-note' });
  const saveSession = async (label: string) => {
    saveNote.textContent = 'Saving...';
    const name = await log?.save(label, { stance: input.stance, learned: input.learned });
    saveNote.textContent = name ? `Saved ${name}` : 'Save failed';
  };
  if (log) app.append(h('div', { class: 'panel sessionbar' }, button('Save session', () => void saveSession('play')), saveNote));
  const rec = flag('record') ? tuner(input) : null;
  if (rec) {
    app.append(rec.el);
    document.body.classList.add('tuning');
  }

  function sendReady(): void {
    link.ready(ready, input.calibrated, stance);
    readyBtn.textContent = ready ? 'Waiting...' : 'Ready';
    readyBtn.classList.toggle('on', ready);
  }

  // Input to link.
  let lastDef: DefenseState | null = null;
  let lastPoseAt = 0;
  input.onTick = (t) => {
    const now = performance.now();
    if (t.pose) {
      gloves.setPose(t.pose, input.gassed);
      if (now - lastPoseAt >= 1000 / CONFIG.network.poseHz) {
        lastPoseAt = now;
        link.pose(t.pose);
      }
    }
    if (!lastDef || lastDef.guard !== t.defense.guard || lastDef.duck !== t.defense.duck || lastDef.slip !== t.defense.slip) {
      hud.setDefense(mySlot, t.defense);
      gloves.setGuard(t.defense.guard);
      lastDef = t.defense;
      link.defense(t.defense, now);
    }
    for (const p of t.punches) {
      link.punch({ type: p.type, hand: p.hand, target: p.target }, p.at);
      if (debug) sentPunch = { name: `${p.type} ${p.target}`, at: now, age: now - p.at, accepted: null, land: null };
    }
    rec?.push(t);
  };

  // Link to view.
  let snap: MatchSnapshot | null = null;
  /** ?debug=1: the last punch sent to the match, whether it was taken, and how it landed. */
  let sentPunch: SentPunch | null = null;
  let hitStopUntil = 0;
  let pendingPose: WirePose | null = null;
  let shake = 0;
  let downK = 0;
  let wasCalibrated = false;
  let wasTeaching = false;
  let resultsUntil = 0;
  const tmp = new THREE.Vector3();

  let teachKey = '';
  function renderTeach(ts: TeachStatus): void {
    // Rebuild only when something but the timer changed, so the result pop animation can play.
    const key = JSON.stringify([ts.phase, ts.index, ts.step?.id, ts.reps, ts.verify, ts.scores]);
    if (key === teachKey) {
      const bar = teachBox.querySelector<HTMLElement>('.teach-time i');
      if (bar) bar.style.width = `${(1 - ts.progress) * 100}%`;
      return;
    }
    teachKey = key;
    const timer = h('div', { class: 'teach-time' }, h('i', { style: `width:${(1 - ts.progress) * 100}%` }));
    if (ts.phase === 'verify' && ts.verify) {
      const v = ts.verify;
      status.textContent = `Check ${v.passed} of ${v.moves}`;
      (progress.firstChild as HTMLElement).style.width = `${v.moves ? (v.passed / v.moves) * 100 : 0}%`;
      const chips = ts.scores.map((m) => h('i', { class: m.ok >= CONFIG.model.verifyPasses ? 'ok' : m.tries > m.ok ? 'bad' : '', title: m.prompt }));
      const head = h('div', { class: 'teach-step' }, `Check ${v.passed} / ${v.moves}`);
      const chipRow = h('div', { class: 'teach-chips' }, ...chips);
      if (v.result) teachBox.replaceChildren(head, h('div', { class: `teach-result ${v.result.ok ? 'ok' : 'bad'}` }, v.result.text), chipRow, h('div', { class: 'teach-time' }));
      else teachBox.replaceChildren(head, h('div', { class: 'teach-move' }, v.prompt || 'Ready'), h('div', { class: 'teach-how' }, v.prompt ? 'Throw it once, then back to guard' : 'Get in your guard'), chipRow, timer);
      return;
    }
    if (!ts.step) return;
    status.textContent = `Teaching ${ts.index + 1} of ${ts.total}`;
    (progress.firstChild as HTMLElement).style.width = `${(ts.index / ts.total) * 100}%`;
    const dots = ts.repsNeeded ? Array.from({ length: ts.repsNeeded }, (_, i) => h('i', { class: i < ts.reps ? 'on' : '' })) : [];
    teachBox.replaceChildren(
      h('div', { class: 'teach-step' }, `${ts.index + 1} / ${ts.total}`),
      h('div', { class: 'teach-move' }, ts.step.prompt),
      h('div', { class: 'teach-how' }, ts.step.how),
      h('div', { class: 'teach-dots' }, ...dots),
      timer,
    );
  }

  function renderResults(): void {
    teachKey = '';
    const right = input.scores.reduce((n, m) => n + m.ok, 0);
    const tries = input.scores.reduce((n, m) => n + m.tries, 0);
    teachBox.replaceChildren(
      h('div', { class: 'teach-step' }, `${right} / ${tries} read right`),
      h('div', { class: 'teach-move' }, 'Calibrated'),
      h('div', { class: 'teach-scores' }, ...input.scores.map((m) =>
        h('div', { class: m.ok >= CONFIG.model.verifyPasses ? 'ok' : 'bad' },
          h('span', {}, m.wrongTarget ? `${m.prompt} (${m.wrongTarget} at the wrong height)` : m.prompt), h('b', {}, `${m.ok}/${m.tries}`)))),
    );
    if (shareConsent() === null && hasPendingUpload()) {
      // Asked once, after the first finished calibration; the lobby checkbox changes it later.
      resultsUntil = performance.now() + RESULTS_MS * 2;
      const answer = (on: boolean) => {
        setShareConsent(on);
        ask.replaceChildren(on ? 'Thanks. Calibration shared.' : 'Not shared.');
        resultsUntil = performance.now() + 1_500;
      };
      const ask = h('div', { class: 'share-ask' },
        h('div', {}, 'Share this calibration to improve tracking for everyone? Only motion measurements are sent, never video.'),
        h('div', { class: 'row' }, button('Share', () => answer(true), 'primary'), button('No thanks', () => answer(false), 'ghost')));
      teachBox.append(ask);
    }
  }

  link.handlers = {
    lobby(ps: [LobbyPlayer | null, LobbyPlayer | null], spectators: number) {
      players.replaceChildren(...ps.map((p, i) => {
        const who = i === mySlot ? 'You' : opts.practice ? 'Bot' : 'Opponent';
        const st = !p ? 'waiting to join' : !p.connected ? 'disconnected' : p.ready ? 'ready' : p.calibrated ? 'set, not ready' : 'calibrating';
        return h('div', { class: `pl ${i ? 'blue' : 'red'} ${p?.ready ? 'ok' : ''}` }, h('i', { class: 'corner' }, i ? 'Blue' : 'Red'), h('b', {}, who), h('span', {}, st));
      }), spectators ? h('div', { class: 'spec' }, `${spectators} watching`) : '');
    },
    state(s, rejoinMs) {
      const first = !snap || snap.phase === 'lobby' || snap.phase === 'ended';
      snap = s;
      hud.setState(s);
      const me = s.fighters[mySlot];
      const oppF = s.fighters[other(mySlot)];
      input.gassed = me.gassed;
      input.canPunch = s.phase === 'round' && !s.paused && me.status === 'up' && !me.exhausted;
      opp.setGassed(oppF.gassed);
      const fighting = s.phase !== 'lobby' && s.phase !== 'ended';
      document.body.classList.toggle('fighting', fighting || s.phase === 'ended');
      if (fighting && first) {
        endPanel.classList.remove('on');
        hud.hideBanner();
      }
      if (me.status === 'down' && s.phase !== 'ended') hud.setSub(`Hold your guard to get up  ${Math.round(me.getUpProgress * 100)}%`);
      else if (s.paused) hud.setSub(`Opponent disconnected. Waiting ${Math.ceil((rejoinMs ?? 0) / 1000)} s for them to rejoin.`);
      else if (me.exhausted && s.phase === 'round') hud.setSub('Exhausted. Breathe and hold your guard.');
      else if (s.phase === 'break') hud.setSub(`Rest. Round ${s.round + 1} in ${Math.ceil(s.clockMs / 1000)}`);
      else hud.setSub('');
    },
    pose(slot, p, def) {
      if (slot === mySlot) return;
      opp.setDefense(def);
      hud.setDefense(slot, def);
      if (performance.now() < hitStopUntil) pendingPose = p;
      else opp.setPose(p);
    },
    event(ev: MatchEvent) {
      onEvent(ev);
    },
    telegraph(slot, hand, k) {
      if (slot !== mySlot) opp.setTelegraph(hand, k);
    },
  };

  function onEvent(ev: MatchEvent): void {
    commonEvent(ev, hud, names(), stage.scene);
    const oppSlot = other(mySlot);
    switch (ev.e) {
      case 'throw':
        if (sentPunch && ev.slot === mySlot && sentPunch.accepted === null) sentPunch.accepted = true;
        hud.callout(ev.slot, ev.punch);
        if (ev.slot === mySlot) gloves.punch(ev.punch);
        else opp.playReaction({ kind: 'throw', punch: ev.punch });
        break;
      case 'land':
        if (sentPunch?.accepted && ev.attacker === mySlot && !sentPunch.land) sentPunch.land = `${ev.outcome}${ev.damage ? ` ${ev.damage}` : ''}`;
        if (ev.attacker === mySlot) {
          if (ev.outcome === 'hit' || ev.outcome === 'block') {
            opp.playReaction({ kind: ev.outcome, zone: ev.zone, heavy: ev.damage >= 9 });
            sparks.spawn(opp.zonePosition(ev.zone, tmp), ev.outcome === 'hit' ? 0xffd27a : 0x9fc6ff, ev.outcome === 'hit' ? 45 : 15, { kind: ev.outcome === 'block' ? 'block' : ev.damage >= 9 ? 'heavy' : 'hit' });
            if (ev.outcome === 'hit') hitStopUntil = performance.now() + 60;
          }
          if (ev.stagger) opp.playReaction({ kind: 'stagger' });
        } else if (ev.outcome === 'hit' || ev.outcome === 'block') {
          const heavy = ev.outcome === 'hit' && ev.damage >= 9;
          if (ev.outcome === 'hit') hud.flash(ev.zone.endsWith('left') ? 'left' : 'right', heavy);
          hud.marker(ev.zone, ev.outcome);
          shake = Math.max(shake, ev.outcome === 'hit' ? (heavy ? 0.06 : 0.035) : 0.012);
          if (ev.stagger) shake = 0.1;
        }
        break;
      case 'knockdown':
        if (ev.slot === oppSlot) opp.playReaction({ kind: 'knockdown' });
        break;
      case 'roundStart':
        opp.playReaction({ kind: 'reset' });
        break;
      case 'getUp':
        if (ev.slot === oppSlot) opp.playReaction({ kind: 'getUp' });
        break;
      case 'matchEnd': {
        if (log) void saveSession('match');
        const won = ev.result.winner === mySlot;
        endPanel.className = `panel end ${ev.result.winner === null ? 'draw' : won ? 'win' : 'lose'}`;
        endPanel.replaceChildren(
          h('h2', {}, ev.result.winner === null ? 'Draw' : won ? 'You win' : 'You lose'),
          h('div', { class: 'row' },
            opts.practice ? button('Fight again', () => location.reload(), 'primary') : button('Rematch', () => {
              ready = true;
              sendReady();
              endPanel.querySelector('h2')!.textContent = 'Waiting for opponent...';
            }, 'primary'),
            button('Title', () => go('/'), 'ghost')),
        );
        endPanel.classList.add('on');
        break;
      }
    }
  }

  stage.onUpdate((dt, t) => {
    hud.tick();
    if (performance.now() >= hitStopUntil) {
      if (pendingPose) {
        opp.setPose(pendingPose);
        pendingPose = null;
      }
      opp.update(dt);
    }
    gloves.update(dt);
    sparks.update(dt);

    const me = snap?.fighters[mySlot];
    const down = me?.status === 'down' ? 1 : 0;
    downK += (down - downK) * Math.min(1, dt * (down ? 2.5 : 1.5));
    shake *= Math.exp(-dt * 9);
    const cam = stage.camera;
    cam.position.set(
      EYE.x + (Math.random() - 0.5) * shake + Math.sin(t * 1.3) * 0.01,
      EYE.y - downK * 1.1 + (Math.random() - 0.5) * shake + Math.sin(t * 2.1) * 0.006,
      EYE.z + downK * 0.4,
    );
    cam.lookAt(0, 1.32 + downK * 1.6, OPP_Z);
    gloves.object.visible = downK < 0.5;

    if (input.kind === 'camera') {
      const s = input.status;
      const good = input.calibrated;
      webcam.draw(input.frame, input.video, good);
      const ts = input.teach;
      const teaching = !!ts && !ts.done && !good;
      if (teaching) {
        renderTeach(ts);
      } else if (!good && s) {
        status.textContent = s.stage === 'framing' ? s.message : s.stage === 'hold' ? s.message : 'Calibrated';
        (progress.firstChild as HTMLElement).style.width = `${s.stage === 'hold' ? s.progress * 100 : 0}%`;
      } else if (good) {
        status.textContent = 'Calibrated. Throw a few punches to check tracking.';
        (progress.firstChild as HTMLElement).style.width = '100%';
      }
      if (wasTeaching && !teaching && good && input.scores.length) {
        resultsUntil = performance.now() + RESULTS_MS;
        renderResults();
      }
      wasTeaching = teaching;
      const showResults = !teaching && performance.now() < resultsUntil;
      teachBox.classList.toggle('on', teaching || showResults);
      teachBox.classList.toggle('results', showResults);
      learnedNote.textContent = good ? (input.learned.length ? `Using your own model: ${input.learned.length} punches learned` : 'Using the default rules') : '';
      const weak = good ? input.scores.filter((m) => m.ok < CONFIG.model.verifyPasses) : [];
      weakNote.textContent = weak.length ? `Read back less reliably: ${weak.map((m) => `${m.prompt} ${m.ok}/${m.tries}`).join(', ')}` : '';
      reteach.toggleAttribute('disabled', !good);
      skipTeach.hidden = !teaching;
      if (good !== wasCalibrated) {
        wasCalibrated = good;
        if (!good) ready = false;
        sendReady();
      }
    } else if (!wasCalibrated) {
      wasCalibrated = true;
      status.textContent = 'Keyboard mode';
      sendReady();
    }
    readyBtn.toggleAttribute('disabled', !input.calibrated);
    if (debug) {
      // No throw event within a moment of sending means the match turned the punch down.
      if (sentPunch && sentPunch.accepted === null && performance.now() - sentPunch.at > 600) sentPunch.accepted = false;
      debug.textContent = `${debugText(input, snap)}
${sentText(sentPunch, snap?.fighters[mySlot] ?? null)}`;
    }
  });

  function setSlot(s: Slot | null): void {
    if (s === null) return;
    mySlot = s;
    opp.setCornerColor(s === 0 ? 'blue' : 'red');
    gloves.setCorner(s === 0 ? 'red' : 'blue');
    hud.setNames(names());
  }
  setSlot(mySlot);
  return { setSlot };
}

interface SentPunch {
  name: string;
  at: number;
  /** How old the punch's peak time was when it was sent, in ms. */
  age: number;
  accepted: boolean | null;
  land: string | null;
}

function sentText(p: SentPunch | null, me: MatchSnapshot['fighters'][number] | null): string {
  if (!p) return 'sent: -';
  const ago = ((performance.now() - p.at) / 1000).toFixed(1);
  const why = me?.exhausted ? 'exhausted' : me && me.status !== 'up' ? me.status : 'not in a round?';
  const match = p.accepted === null ? 'waiting' : p.accepted ? `taken, ${p.land ?? 'resolving'}` : `REJECTED (${why})`;
  return `sent: ${p.name} ${ago}s ago, peak ${p.age.toFixed(0)} ms old  match: ${match}`;
}

function debugText(input: InputSource, snap: MatchSnapshot | null): string {
  const d = input.debug;
  const r = (n: number) => n.toFixed(2);
  const lines = [`input: ${input.kind} (${input.stats})  calibrated: ${input.calibrated}  stance: ${input.stance}  canPunch: ${input.canPunch}  gassed: ${input.gassed}`];
  if (!input.calibrated && input.status) lines.push(`calibration: ${input.status.stage} ${'message' in input.status ? input.status.message : ''}`);
  if (d?.features) {
    for (const hand of ['left', 'right'] as const) {
      const f = d.features[hand];
      lines.push(`${hand.padEnd(5)} reach ${r(f.reach)} elbow ${f.elbow.toFixed(0).padStart(3)} z ${r(f.zAhead)} scale ${r(f.scale)} y ${r(f.y)} head ${r(f.headDist)} v(f/in/up) ${r(f.vFwd)} ${r(f.vIn)} ${r(f.vUp)}`);
    }
    lines.push(`head dx ${r(d.features.headDx)} dy ${r(d.features.headDy)}  defense ${JSON.stringify(d.defense)}`);
    lines.push(`last: ${d.last ?? '-'}`);
  }
  if (snap) lines.push(`phase ${snap.phase} round ${snap.round} hp ${snap.fighters.map((f) => f.hp).join('/')} st ${snap.fighters.map((f) => f.stamina.toFixed(0)).join('/')} max ${RULES.maxHp}`);
  return lines.join('\n');
}
