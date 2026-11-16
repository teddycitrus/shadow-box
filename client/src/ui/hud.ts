import { RULES } from '../../../shared/rules.ts';
import type { DefenseState, FighterSnapshot, MatchResult, MatchSnapshot, Punch, Slot, Zone } from '../../../shared/types.ts';
import { clockTick } from './announce.ts';
import { h, setText, setWidth } from './dom.ts';

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Top bar (HP, stamina, round clock), centre banners, referee count and hit feedback. */
export class Hud {
  readonly root = h('div', { class: 'hud' });
  private bars: { hp: HTMLElement; hpGhost: HTMLElement; st: HTMLElement; stNum: HTMLElement; kd: HTMLElement; box: HTMLElement; name: HTMLElement; def: HTMLElement; call: HTMLElement; callTimer: number; lastHp: number; chain: number; lastCall: number }[] = [];
  private names: [string, string];
  private clock = h('div', { class: 'clock' }, '1:00');
  private round = h('div', { class: 'round' }, `Round 1 of ${RULES.rounds}`);
  private pips = h('div', { class: 'pips', 'aria-hidden': 'true' }, ...Array.from({ length: RULES.rounds }, () => h('i')));
  private banner = h('div', { class: 'banner' });
  private count = h('div', { class: 'count' });
  private sub = h('div', { class: 'subline' });
  private caption = h('div', { class: 'caption' });
  private flashL = h('div', { class: 'flash left' });
  private flashR = h('div', { class: 'flash right' });
  private zones = h('div', { class: 'zones' });
  private snap: MatchSnapshot | null = null;
  private snapAt = 0;
  private bannerTimer = 0;
  private captionTimer = 0;

  constructor(names: [string, string]) {
    this.names = [...names];
    const side = (i: 0 | 1) => {
      const hp = h('div', { class: 'fill hp' });
      const hpGhost = h('div', { class: 'fill ghost' });
      const st = h('div', { class: 'fill st' });
      const kd = h('span', { class: 'kd' });
      const name = h('span', {}, names[i]);
      const stNum = h('span', { class: 'stnum' }, '100');
      const def = h('span', { class: 'defchip' });
      const call = h('div', { class: 'callout' });
      const box = h('div', { class: `side ${i ? 'blue' : 'red'}` },
        h('div', { class: 'plate' },
          h('div', { class: 'bar hpbar' }, hpGhost, hp),
        ),
        h('div', { class: 'name' }, h('span', { class: 'plate-name' }, name), kd, def),
        h('div', { class: 'strow' },
          h('div', { class: 'bar stbar' }, st),
          h('div', { class: 'stlabel' }, h('span', {}, 'Stamina'), stNum),
        ),
        call,
      );
      this.bars.push({ hp, hpGhost, st, stNum, kd, box, name, def, call, callTimer: 0, lastHp: RULES.maxHp, chain: 0, lastCall: 0 });
      return box;
    };
    for (const z of ['head-left', 'head-right', 'body-left', 'body-right'] as Zone[]) this.zones.append(h('i', { 'data-zone': z }));
    this.root.append(
      h('div', { class: 'topbar' }, side(0), h('div', { class: 'center' }, h('div', { class: 'kobadge', 'aria-hidden': 'true' }, 'KO'), this.clock, this.round, this.pips), side(1)),
      this.banner, this.count, this.sub, this.caption, this.flashL, this.flashR, this.zones,
    );
  }

  /** Shows GUARD / DUCK / SLIP next to a fighter's name. */
  setDefense(slot: Slot, d: DefenseState): void {
    const parts = [d.guard && 'Guard', d.duck && 'Duck', d.slip !== 'none' && `Slip ${d.slip}`].filter(Boolean) as string[];
    const el = this.bars[slot].def;
    setText(el, parts.join(' + '));
    el.classList.toggle('on', parts.length > 0);
  }

  /** Big punch-type callout under a fighter's bars. */
  callout(slot: Slot, p: Punch): void {
    const b = this.bars[slot];
    const names: Record<string, string> = {
      jab: 'Jab', cross: 'Cross', leftHook: 'Left hook', rightHook: 'Right hook', leftUppercut: 'Left uppercut', rightUppercut: 'Right uppercut',
    };
    const now = performance.now();
    b.chain = now - b.lastCall < 1200 ? b.chain + 1 : 1;
    b.lastCall = now;
    b.call.textContent = `${p.target === 'body' ? 'Body ' : ''}${names[p.type]}!`;
    if (b.chain > 1) b.call.dataset.chain = `x${b.chain}`;
    else delete b.call.dataset.chain;
    b.call.classList.remove('on');
    void b.call.offsetWidth;
    b.call.classList.add('on');
    clearTimeout(b.callTimer);
    b.callTimer = window.setTimeout(() => b.call.classList.remove('on'), 900);
  }

  /** True while the match is paused (late joiners learn this from the snapshot). */
  paused = false;

  hideBanner(): void {
    clearTimeout(this.bannerTimer);
    this.banner.classList.remove('on');
  }

  setNames(names: [string, string]): void {
    this.names = [...names];
    this.bars.forEach((b, i) => (b.name.textContent = names[i]));
  }

  setState(s: MatchSnapshot): void {
    this.snap = s;
    this.snapAt = performance.now();
    s.fighters.forEach((f, i) => this.setFighter(i as Slot, f));
    setText(this.round, s.phase === 'break' ? `Round ${s.round + 1} next` : s.phase === 'countdown' ? 'Get ready' : `Round ${Math.max(1, s.round)} of ${RULES.rounds}`);
    [...this.pips.children].forEach((p, i) => p.classList.toggle('on', s.phase !== 'lobby' && i < Math.max(1, s.round)));
    if (s.paused && !this.paused) this.show('Paused', 0);
    else if (!s.paused && this.paused && this.banner.textContent === 'Paused') this.hideBanner();
    this.paused = s.paused;
    const downIdx = s.phase === 'ended' ? -1 : s.fighters.findIndex((f) => f.status === 'down');
    const down = downIdx >= 0 ? s.fighters[downIdx] : undefined;
    const n = down ? String(down.count) : '';
    if (n && n !== this.count.textContent) this.retrigger(this.count, 'slam');
    setText(this.count, n);
    this.count.classList.toggle('on', !!down);
    this.count.classList.toggle('red', downIdx === 0);
    this.count.classList.toggle('blue', downIdx === 1);
  }

  private setFighter(i: Slot, f: FighterSnapshot): void {
    const b = this.bars[i];
    const hp = (f.hp / RULES.maxHp) * 100;
    setWidth(b.hp, `${hp}%`);
    setWidth(b.hpGhost, `${hp}%`);
    if (f.hp < b.lastHp) this.retrigger(b.box, 'hit');
    b.lastHp = f.hp;
    setWidth(b.st, `${(f.stamina / RULES.maxStamina) * 100}%`);
    setText(b.stNum, f.exhausted ? 'EXHAUSTED' : f.gassed ? `${Math.round(f.stamina)} GASSED` : String(Math.round(f.stamina)));
    b.box.classList.toggle('gassed', f.gassed);
    b.box.classList.toggle('exhausted', f.exhausted);
    b.box.classList.toggle('low', hp <= 25);
    setText(b.kd, f.knockdowns ? 'KD '.repeat(f.knockdowns).trim() : '');
    b.kd.classList.toggle('on', f.knockdowns > 0);
  }

  /** Call every frame to run the clock between server updates. */
  tick(): void {
    const s = this.snap;
    if (!s) return;
    const running = !s.paused && s.phase !== 'ended' && s.phase !== 'lobby' && !(s.phase === 'round' && s.fighters.some((f) => f.status !== 'up'));
    const ms = running ? s.clockMs - (performance.now() - this.snapAt) : s.clockMs;
    setText(this.clock, s.phase === 'lobby' ? fmt(RULES.roundMs) : fmt(Math.max(0, ms)));
    this.clock.classList.toggle('low', s.phase === 'round' && ms < 10_000);
    if (this.audible) clockTick(Math.max(0, ms), s.phase);
  }

  /** Set false for the silent title-screen demo. */
  audible = true;

  show(text: string, ms = 1400, kind = ''): void {
    const kids: HTMLElement[] = [h('span', { class: 'bt', 'data-text': text }, text)];
    let side = '';
    if (kind.startsWith('result')) {
      const [r, b] = this.names;
      side = text.startsWith(`${r} `) ? 'red' : text.startsWith(`${b} `) ? 'blue' : 'draw';
      const winner = side === 'red' ? 0 : side === 'blue' ? 1 : -1;
      const ko = / (ko|tko)\b/.test(kind);
      const perfect = winner >= 0 && (ko || / decision\b/.test(kind)) && this.bars[winner].lastHp >= RULES.maxHp;
      const stamp = perfect ? 'Perfect' : ko ? 'K.O.' : '';
      if (stamp) kids.unshift(h('span', { class: 'stamp', 'data-text': stamp, 'aria-hidden': 'true' }, stamp));
    }
    this.banner.replaceChildren(...kids);
    this.banner.className = 'banner';
    void this.banner.offsetWidth;
    this.banner.className = `banner on ${kind} ${side}`.trim();
    clearTimeout(this.bannerTimer);
    if (ms > 0) this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('on'), ms);
  }

  setSub(text: string): void {
    setText(this.sub, text);
    this.sub.classList.toggle('on', !!text);
  }

  say(text: string): void {
    this.caption.textContent = text;
    this.caption.classList.add('on');
    clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.caption.classList.remove('on'), 2600);
  }

  flash(side: 'left' | 'right', heavy: boolean): void {
    const el = side === 'left' ? this.flashL : this.flashR;
    el.classList.remove('on', 'heavy');
    void el.offsetWidth;
    el.classList.add('on');
    if (heavy) el.classList.add('heavy');
  }

  /** Restarts a one-shot CSS animation class. */
  private retrigger(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  marker(zone: Zone, kind: 'hit' | 'block'): void {
    const el = this.zones.querySelector<HTMLElement>(`[data-zone="${zone}"]`)!;
    el.className = '';
    void el.offsetWidth;
    el.className = kind;
  }
}

export function resultText(r: MatchResult, names: [string, string]): string {
  if (r.winner === null) return 'Draw';
  const how = { ko: 'by knockout', tko: 'by technical knockout', decision: 'on points', forfeit: 'by forfeit', draw: '' }[r.kind];
  const who = names[r.winner];
  return `${who} ${who === 'You' ? 'win' : 'wins'} ${how}`;
}
