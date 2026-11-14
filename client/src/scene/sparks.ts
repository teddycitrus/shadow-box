import * as THREE from 'three';
import { billboardMaterial, glowTexture, guardTexture, ringTexture, starburstTexture } from './fx.ts';

export type SparkKind = 'hit' | 'heavy' | 'block';

export interface SparkOptions {
  /** hit (default for warm colours), heavy (big hits, damage >= 9) or block (default for blue colours). */
  kind?: SparkKind;
  /** Extra size multiplier on top of the kind's default. */
  scale?: number;
}

/** Hook a Stage installs on its scene so sparks can trigger camera kick and flash. */
export type HitFxHook = (kind: SparkKind) => void;

const QUAD = new THREE.PlaneGeometry(1, 1);
const MAX_BURSTS = 12;

const STREAK_VERT = /* glsl */ `
  uniform float uT;
  uniform float uScale;
  attribute vec2 aDir;
  attribute float aAlong;
  attribute float aSide;
  attribute float aLen;
  varying float vA;
  void main() {
    vA = aAlong;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float L = aLen * uScale;
    float head = L * (0.22 + 0.9 * uT);
    float tail = L * (0.06 + 0.95 * uT * uT);
    float r = mix(tail, head, aAlong);
    vec2 perp = vec2(-aDir.y, aDir.x);
    float hw = L * 0.05 * (1.0 - aAlong * 0.9) * (1.0 - uT * 0.7);
    mv.xy += aDir * r + perp * aSide * hw;
    gl_Position = projectionMatrix * mv;
  }`;

const STREAK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    vec3 c = mix(vec3(1.0), uColor, smoothstep(0.0, 0.8, vA));
    gl_FragColor = vec4(c * uOpacity * (1.0 - vA * 0.5), 1.0);
    #include <colorspace_fragment>
  }`;

function streakGeometry(n: number, len: number): THREE.BufferGeometry {
  const dir = new Float32Array(n * 4 * 2);
  const along = new Float32Array(n * 4);
  const side = new Float32Array(n * 4);
  const lens = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n);
    const l = len * (0.55 + Math.random() * 0.6);
    for (let v = 0; v < 4; v++) {
      const k = i * 4 + v;
      dir.set([Math.cos(a), Math.sin(a)], k * 2);
      along[k] = v < 2 ? 0 : 1;
      side[k] = v % 2 === 0 ? -1 : 1;
      lens[k] = l;
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 2));
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aLen', new THREE.BufferAttribute(lens, 1));
  g.setIndex(idx);
  return g;
}

interface Layer {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Size and opacity over normalised life t in [0, 1]. */
  size(t: number): number;
  alpha(t: number): number;
  spin: number;
}

interface Burst {
  group: THREE.Group;
  layers: Layer[];
  streak: THREE.ShaderMaterial;
  pts: THREE.Points;
  vel: Float32Array;
  age: number;
  life: number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);

/**
 * Fighting-game impact sparks: a bright starburst and core flash, a shock ring, radiating
 * streaks and a particle spray. Blocks show a blue guard hexagon instead of a star.
 */
export class Sparks {
  readonly object = new THREE.Group();
  /** When true, spawning also asks the owning Stage for a small camera kick / flash. */
  autoFx = true;
  private bursts: Burst[] = [];

  spawn(at: THREE.Vector3, color = 0xffd27a, count = 40, opts: SparkOptions = {}): void {
    const c = new THREE.Color(color);
    const kind: SparkKind = opts.kind ?? (c.b > c.r ? 'block' : 'hit');
    const heavy = kind === 'heavy';
    const block = kind === 'block';
    const S = (heavy ? 1.55 : block ? 0.8 : 1) * (opts.scale ?? 1);
    const life = heavy ? 0.5 : block ? 0.3 : 0.36;
    const group = new THREE.Group();
    group.position.copy(at);
    const layers: Layer[] = [];
    const rot0 = Math.random() * Math.PI * 2;
    const add = (map: THREE.Texture, col: THREE.ColorRepresentation, size: Layer['size'], alpha: Layer['alpha'], spin = 0, order = 0) => {
      const mat = billboardMaterial(map, 0xffffff);
      mat.uniforms.uColor.value.set(col);
      mat.uniforms.uRot.value = rot0 + (order % 2) * 0.5;
      const mesh = new THREE.Mesh(QUAD, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 20 + order;
      group.add(mesh);
      layers.push({ mesh, mat, size, alpha, spin });
    };

    if (block) {
      add(guardTexture(), 0x7fb8ff, (t) => S * (0.38 + 0.18 * easeOut(Math.min(1, t * 3))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.3, 1), 0.6, 1);
      add(glowTexture(), 0xdff0ff, (t) => S * 0.32 * (1 - t * 0.6), (t) => Math.max(0, 1 - t * 2.2), 0, 2);
      add(ringTexture(), 0x9fd0ff, (t) => S * (0.2 + 0.7 * easeOut(t)), (t) => (1 - t) * (1 - t), 0, 0);
    } else {
      if (heavy) {
        add(starburstTexture(), 0xff3d12, (t) => S * (0.7 + 0.45 * easeOut(Math.min(1, t * 3.5))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.15, 0.6), -0.8, 0);
      }
      add(starburstTexture(), heavy ? 0xffb020 : c.clone().lerp(new THREE.Color(0xff8a10), 0.55), (t) => S * (0.42 + 0.3 * easeOut(Math.min(1, t * 4))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.1, 0.55), 0.9, 1);
      add(glowTexture(), 0xffffff, (t) => S * 0.26 * (1.2 - t), (t) => Math.max(0, 1 - t * 2.6), 0, 2);
      add(ringTexture(), heavy ? 0xffe2a0 : 0xfff0c8, (t) => S * (0.15 + 1.1 * easeOut(t)), (t) => 0.9 * Math.pow(1 - t, 3), 0, 3);
    }

    const streak = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 },
        uScale: { value: S },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(block ? 0x8fc4ff : heavy ? 0xffa030 : color) },
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const streaks = new THREE.Mesh(streakGeometry(heavy ? 16 : block ? 7 : 11, block ? 0.32 : 0.5), streak);
    streaks.frustumCulled = false;
    streaks.renderOrder = 19;
    group.add(streaks);

    const n = Math.round(count * (heavy ? 1.6 : 1));
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const white = new THREE.Color(1, 1, 1);
    const tint = new THREE.Color();
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar((2 + Math.random() * 4.5) * (heavy ? 1.3 : block ? 0.6 : 1));
      vel.set([v.x, v.y, v.z], i * 3);
      tint.copy(block ? new THREE.Color(0x9fd0ff) : c).lerp(white, Math.random() * 0.6);
      col.set([tint.r, tint.g, tint.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pmat = new THREE.PointsMaterial({
      size: heavy ? 0.075 : 0.055, map: glowTexture(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(geo, pmat);
    pts.frustumCulled = false;
    pts.renderOrder = 18;
    group.add(pts);

    this.object.add(group);
    this.bursts.push({ group, layers, streak, pts, vel, age: 0, life });
    while (this.bursts.length > MAX_BURSTS) this.remove(this.bursts.shift()!);
    this.apply(this.bursts[this.bursts.length - 1], 0);

    if (this.autoFx) {
      let root: THREE.Object3D = this.object;
      while (root.parent) root = root.parent;
      (root.userData.hitFx as HitFxHook | undefined)?.(kind);
    }
  }

  update(dt: number): void {
    for (const b of this.bursts) {
      b.age += dt;
      this.apply(b, dt);
    }
    for (const b of this.bursts) if (b.age >= b.life) this.remove(b);
    this.bursts = this.bursts.filter((b) => b.age < b.life);
  }

  private apply(b: Burst, dt: number): void {
    const t = Math.min(1, b.age / b.life);
    for (const l of b.layers) {
      l.mat.uniforms.uScale.value = l.size(t);
      l.mat.uniforms.uOpacity.value = Math.max(0, l.alpha(t));
      l.mat.uniforms.uRot.value += l.spin * dt;
    }
    b.streak.uniforms.uT.value = easeOut(t);
    b.streak.uniforms.uOpacity.value = Math.max(0, 1 - Math.pow(t, 1.4));
    const pos = b.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const drag = Math.exp(-dt * 4);
    for (let i = 0; i < pos.count; i++) {
      const k = i * 3;
      b.vel[k] *= drag;
      b.vel[k + 1] = b.vel[k + 1] * drag - 5 * dt;
      b.vel[k + 2] *= drag;
      pos.setXYZ(i, pos.getX(i) + b.vel[k] * dt, pos.getY(i) + b.vel[k + 1] * dt, pos.getZ(i) + b.vel[k + 2] * dt);
    }
    pos.needsUpdate = true;
    (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - t * t);
  }

  private remove(b: Burst): void {
    this.object.remove(b.group);
    for (const l of b.layers) l.mat.dispose();
    b.streak.dispose();
    const streaks = b.group.children.find((o) => (o as THREE.Mesh).material === b.streak) as THREE.Mesh | undefined;
    streaks?.geometry.dispose();
    b.pts.geometry.dispose();
    (b.pts.material as THREE.Material).dispose();
  }
}
