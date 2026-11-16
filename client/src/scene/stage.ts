import * as THREE from 'three';
import { buildArena } from './arena.ts';
import type { HitFxHook } from './sparks.ts';

const FLASH_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uK;
  uniform float uAspect;
  uniform float uSeed;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p);
    float a = atan(p.y, p.x);
    float bucket = floor((a + 3.14159) * 30.0);
    float line = step(0.55, hash(bucket + uSeed)) * smoothstep(0.28, 0.75, r) * (0.5 + 0.5 * hash(bucket * 1.7 + uSeed));
    float edge = smoothstep(0.35, 0.95, r);
    float wash = uK * uK * uK * 0.45;
    // Red / cyan fringe toward the edges for a chromatic punch-in feel.
    vec3 fringe = mix(vec3(1.0, 0.25, 0.2), vec3(0.2, 0.7, 1.0), step(0.0, p.x)) * edge * 0.35;
    vec3 c = uColor * (wash + edge * 0.55 * uK + line * 0.6 * uK) + fringe * uK;
    gl_FragColor = vec4(c, 1.0);
  }`;

/** Renderer, scene, arena and the frame loop shared by every view. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 100);
  private updaters: ((dt: number, t: number) => void)[] = [];
  private arena: { update(t: number): void };
  private last = performance.now();
  private kickK = 0;
  private flashK = 0;
  private flashDecay = 6;
  private overlay = new THREE.Scene();
  private overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private flashMat: THREE.ShaderMaterial;
  private saved = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    // The scene root never moves; leaving it static lets unchanged subtrees skip world matrix updates.
    this.scene.matrixAutoUpdate = false;
    this.arena = buildArena(this.scene);
    this.scene.add(this.camera);

    this.flashMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uK: { value: 0 }, uAspect: { value: 1 }, uSeed: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.flashMat);
    quad.frustumCulled = false;
    quad.matrixAutoUpdate = false;
    this.overlay.add(quad);

    // Sparks look this up so landed hits get a small kick and flash without extra wiring.
    const hook: HitFxHook = (kind) => {
      if (kind === 'heavy') {
        this.kick(1);
        this.flash(0xfff0d0, 0.7);
      } else if (kind === 'hit') {
        this.kick(0.4);
        this.flash(0xffe0b0, 0.25);
      } else {
        this.kick(0.15);
      }
    };
    this.scene.userData.hitFx = hook;

    const resize = () => {
      const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.flashMat.uniforms.uAspect.value = w / h;
    };
    addEventListener('resize', resize);
    resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  onUpdate(fn: (dt: number, t: number) => void): void {
    this.updaters.push(fn);
  }

  /**
   * Short camera punch-in and shake, applied at render time on top of whatever the view set.
   * strength 0..1 (light jab about 0.3, big hit 1); repeated calls keep the strongest.
   */
  kick(strength = 0.5): void {
    this.kickK = Math.min(1.5, Math.max(this.kickK, strength));
  }

  /** Full-screen additive flash with speed lines and edge fringe. strength 0..1, fades in ~0.2 s. */
  flash(color: THREE.ColorRepresentation = 0xffffff, strength = 0.6): void {
    if (strength < this.flashK) return;
    this.flashK = Math.min(1, strength);
    this.flashDecay = 5 + (1 - this.flashK) * 6;
    this.flashMat.uniforms.uColor.value.set(color);
    this.flashMat.uniforms.uSeed.value = Math.random() * 100;
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    this.arena.update(t);
    for (const u of this.updaters) u(dt, t);

    const cam = this.camera;
    const k = this.kickK;
    const kicking = k > 0.002;
    if (kicking) {
      this.saved.copy(cam.position);
      // Snap in, then ease back out: zoom peaks immediately and decays.
      cam.zoom = 1 + k * 0.09;
      cam.updateProjectionMatrix();
      const s = k * 0.025;
      cam.translateX((Math.random() - 0.5) * s);
      cam.translateY((Math.random() - 0.5) * s);
      cam.updateMatrixWorld();
    }
    this.renderer.render(this.scene, cam);
    if (kicking) {
      cam.position.copy(this.saved);
      cam.zoom = 1;
      cam.updateProjectionMatrix();
      this.kickK *= Math.exp(-dt * 11);
    } else this.kickK = 0;

    if (this.flashK > 0.01) {
      this.flashMat.uniforms.uK.value = this.flashK;
      const auto = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this.overlay, this.overlayCam);
      this.renderer.autoClear = auto;
      this.flashK *= Math.exp(-dt * this.flashDecay);
    } else this.flashK = 0;
  }
}
