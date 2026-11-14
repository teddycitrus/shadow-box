import * as THREE from 'three';
import { buildArena } from './arena.ts';

/** Renderer, scene, arena and the frame loop shared by every view. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 100);
  private updaters: ((dt: number, t: number) => void)[] = [];
  private arena: { update(t: number): void };
  private last = performance.now();

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.appendChild(this.renderer.domElement);
    this.arena = buildArena(this.scene);
    this.scene.add(this.camera);
    const resize = () => {
      const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize);
    resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onUpdate(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    this.arena.update(t);
    for (const u of this.updaters) u(dt, t);
    this.renderer.render(this.scene, this.camera);
  }
}
