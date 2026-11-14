import * as THREE from 'three';
import type { MatchEvent, Slot } from '../../../shared/types.ts';
import { h } from '../ui/dom.ts';
import './cameras.css';

export type CamMode = 'auto' | 'broadcast' | 'ringside' | 'overhead' | 'redCorner' | 'blueCorner';

export const CAMS: { id: CamMode; label: string; key: string }[] = [
  { id: 'auto', label: 'Director', key: '1' },
  { id: 'broadcast', label: 'Broadcast', key: '2' },
  { id: 'ringside', label: 'Ringside seat', key: '3' },
  { id: 'overhead', label: 'Overhead', key: '4' },
  { id: 'redCorner', label: 'Behind Red', key: '5' },
  { id: 'blueCorner', label: 'Behind Blue', key: '6' },
];

const STORE = 'shadowbox:cam';
const AUTO_SHOTS: Exclude<CamMode, 'auto'>[] = ['broadcast', 'ringside', 'redCorner', 'blueCorner', 'broadcast', 'overhead'];

/**
 * Per-viewer camera for the spectator view. Each watcher picks a shot (or lets the director cut
 * between them on big moments); the choice is local and remembered in this browser.
 */
export class CameraDirector {
  mode: CamMode;
  private shot: Exclude<CamMode, 'auto'> = 'broadcast';
  private nextCut = 0;
  private pos = new THREE.Vector3(0, 2, 4);
  private look = new THREE.Vector3(0, 1.2, 0);
  private snap = true;
  private buttons = new Map<CamMode, HTMLButtonElement>();
  readonly el: HTMLElement;

  constructor(private camera: THREE.PerspectiveCamera, private fighters: THREE.Object3D[], private picker: boolean) {
    const saved = picker ? (localStorage.getItem(STORE) as CamMode | null) : null;
    this.mode = saved && CAMS.some((c) => c.id === saved) ? saved : 'auto';
    this.el = h('div', { class: 'campicker', role: 'toolbar', 'aria-label': 'Camera' });
    if (picker) {
      for (const c of CAMS) {
        const b = h('button', { type: 'button', 'aria-pressed': 'false' }, h('kbd', {}, c.key), c.label);
        b.addEventListener('click', () => this.set(c.id));
        this.buttons.set(c.id, b);
        this.el.append(b);
      }
      addEventListener('keydown', (e) => {
        const c = CAMS.find((x) => x.key === e.key);
        if (c && !(e.target instanceof HTMLInputElement)) this.set(c.id);
      });
    }
    this.set(this.mode);
  }

  set(mode: CamMode): void {
    this.mode = mode;
    if (this.picker) localStorage.setItem(STORE, mode);
    if (mode !== 'auto') this.shot = mode;
    this.nextCut = 0;
    for (const [id, b] of this.buttons) {
      b.classList.toggle('on', id === mode);
      b.setAttribute('aria-pressed', String(id === mode));
    }
  }

  /** Director mode reacts to the fight: big shots and knockdowns cut to the best angle. */
  event(ev: MatchEvent): void {
    if (this.mode !== 'auto') return;
    const cut = (s: Exclude<CamMode, 'auto'>, hold: number) => {
      if (s !== this.shot) this.snap = true;
      this.shot = s;
      this.nextCut = performance.now() + hold;
    };
    if (ev.e === 'knockdown') cut(ev.slot === 0 ? 'blueCorner' : 'redCorner', 5000);
    else if (ev.e === 'land' && ev.outcome === 'hit' && (ev.stagger || ev.damage >= 12)) cut(ev.attacker === 0 ? 'redCorner' : 'blueCorner', 3500);
    else if (ev.e === 'matchEnd') cut('overhead', 8000);
    else if (ev.e === 'roundStart') cut('broadcast', 4000);
  }

  private head(slot: Slot, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.fighters[slot].position).setY(1.5);
  }

  update(dt: number, t: number): void {
    const now = performance.now();
    if (this.mode === 'auto' && now > this.nextCut) {
      const options = AUTO_SHOTS.filter((s) => s !== this.shot);
      this.shot = options[Math.floor(Math.random() * options.length)];
      this.nextCut = now + 6000 + Math.random() * 4000;
      this.snap = true;
    }
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3(0, 1.2, 0);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    switch (this.shot) {
      case 'broadcast': {
        const ang = t * 0.08;
        pos.set(Math.sin(ang) * 4, 1.9 + Math.sin(t * 0.21) * 0.25, Math.cos(ang) * 4);
        look.set(0, 1.15, 0);
        break;
      }
      case 'ringside':
        pos.set(Math.sin(t * 0.4) * 0.08, 1.55 + Math.sin(t * 0.9) * 0.02, 4.4);
        look.set(0, 1.15, 0);
        break;
      case 'overhead':
        pos.set(0.3, 7.2, 0.6);
        look.set(0, 0.5, 0);
        break;
      case 'redCorner':
      case 'blueCorner': {
        const me: Slot = this.shot === 'redCorner' ? 0 : 1;
        this.head(me, a);
        this.head(me === 0 ? 1 : 0, b);
        const away = a.clone().sub(b).setY(0).normalize();
        const side = new THREE.Vector3(-away.z, 0, away.x);
        pos.copy(a).addScaledVector(away, 1.1).addScaledVector(side, 0.45).setY(1.85);
        look.copy(b).setY(1.35);
        break;
      }
    }
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 5);
    this.snap = false;
    this.pos.lerp(pos, k);
    this.look.lerp(look, k);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.camera.fov = this.shot === 'overhead' ? 50 : this.shot === 'ringside' ? 48 : 62;
    this.camera.updateProjectionMatrix();
  }
}
