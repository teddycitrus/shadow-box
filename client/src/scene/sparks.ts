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
/** Most billboard layers any kind uses (heavy hits). */
const MAX_LAYERS = 4;
/** Most streaks any kind uses (heavy hits). */
const MAX_STREAKS = 16;

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

/** Streak quads for up to MAX_STREAKS rays; only the first n are drawn, via the draw range. */
function streakGeometry(): THREE.BufferGeometry {
  const n = MAX_STREAKS;
  const along = new Float32Array(n * 4);
  const side = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < 4; v++) {
      const k = i * 4 + v;
      along[k] = v < 2 ? 0 : 1;
      side[k] = v % 2 === 0 ? -1 : 1;
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(n * 4 * 2), 2));
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array(n * 4), 1));
  g.setIndex(idx);
  return g;
}

/** Fills the first n streaks with fresh random directions and lengths. */
function fillStreaks(g: THREE.BufferGeometry, n: number, len: number): void {
  const dir = g.getAttribute('aDir') as THREE.BufferAttribute;
  const lens = g.getAttribute('aLen') as THREE.BufferAttribute;
  const d = dir.array as Float32Array;
  const l4 = lens.array as Float32Array;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n);
    const l = len * (0.55 + Math.random() * 0.6);
    const c = Math.cos(a), s = Math.sin(a);
    for (let v = 0; v < 4; v++) {
      const k = i * 4 + v;
      d[k * 2] = c;
      d[k * 2 + 1] = s;
      l4[k] = l;
    }
  }
  dir.needsUpdate = true;
  lens.needsUpdate = true;
  g.setDrawRange(0, n * 6);
}

interface Layer {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** Size and opacity over normalised life t in [0, 1]. */
  size(t: number): number;
  alpha(t: number): number;
  spin: number;
}

/** One reusable spark effect. Pooled so hits do not create and free GPU buffers and materials. */
interface Burst {
  group: THREE.Group;
  slots: Layer[];
  /** Number of slots in use for the current spawn. */
  used: number;
  streak: THREE.ShaderMaterial;
  streakGeo: THREE.BufferGeometry;
  pts: THREE.Points;
  pmat: THREE.PointsMaterial;
  vel: Float32Array;
  /** Particles in use for the current spawn. */
  count: number;
  age: number;
  life: number;
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
const noSize = () => 0;
const WHITE = new THREE.Color(1, 1, 1);
const BLOCK_TINT = new THREE.Color(0x9fd0ff);
const HIT_STAR = new THREE.Color(0xff8a10);
const tint = new THREE.Color();
const starTint = new THREE.Color();
const dirV = new THREE.Vector3();

function particleGeometry(cap: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
  return geo;
}

/**
 * Fighting-game impact sparks: a bright starburst and core flash, a shock ring, radiating
 * streaks and a particle spray. Blocks show a blue guard hexagon instead of a star.
 */
export class Sparks {
  readonly object = new THREE.Group();
  /** When true, spawning also asks the owning Stage for a small camera kick / flash. */
  autoFx = true;
  private bursts: Burst[] = [];
  private free: Burst[] = [];

  private makeBurst(): Burst {
    const group = new THREE.Group();
    const slots: Layer[] = [];
    for (let i = 0; i < MAX_LAYERS; i++) {
      const mat = billboardMaterial(glowTexture(), 0xffffff);
      const mesh = new THREE.Mesh(QUAD, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      slots.push({ mesh, mat, size: noSize, alpha: noSize, spin: 0 });
    }
    const streak = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: 0 },
        uScale: { value: 1 },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color() },
      },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const streakGeo = streakGeometry();
    const streaks = new THREE.Mesh(streakGeo, streak);
    streaks.frustumCulled = false;
    streaks.renderOrder = 19;
    streaks.matrixAutoUpdate = false;
    group.add(streaks);
    const pmat = new THREE.PointsMaterial({
      size: 0.055, map: glowTexture(), vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(particleGeometry(0), pmat);
    pts.frustumCulled = false;
    pts.renderOrder = 18;
    pts.matrixAutoUpdate = false;
    group.add(pts);
    return { group, slots, used: 0, streak, streakGeo, pts, pmat, vel: new Float32Array(0), count: 0, age: 0, life: 1 };
  }

  spawn(at: THREE.Vector3, color = 0xffd27a, count = 40, opts: SparkOptions = {}): void {
    const c = new THREE.Color(color);
    const kind: SparkKind = opts.kind ?? (c.b > c.r ? 'block' : 'hit');
    const heavy = kind === 'heavy';
    const block = kind === 'block';
    const S = (heavy ? 1.55 : block ? 0.8 : 1) * (opts.scale ?? 1);
    const life = heavy ? 0.5 : block ? 0.3 : 0.36;
    const b = this.free.pop() ?? this.makeBurst();
    b.group.position.copy(at);
    b.used = 0;
    b.age = 0;
    b.life = life;
    const rot0 = Math.random() * Math.PI * 2;
    const add = (map: THREE.Texture, col: THREE.ColorRepresentation, size: Layer['size'], alpha: Layer['alpha'], spin = 0, order = 0) => {
      const l = b.slots[b.used++];
      l.mat.uniforms.uMap.value = map;
      l.mat.uniforms.uColor.value.set(col);
      l.mat.uniforms.uRot.value = rot0 + (order % 2) * 0.5;
      l.mesh.renderOrder = 20 + order;
      l.mesh.visible = true;
      l.size = size;
      l.alpha = alpha;
      l.spin = spin;
    };

    if (block) {
      add(guardTexture(), 0x7fb8ff, (t) => S * (0.38 + 0.18 * easeOut(Math.min(1, t * 3))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.3, 1), 0.6, 1);
      add(glowTexture(), 0xdff0ff, (t) => S * 0.32 * (1 - t * 0.6), (t) => Math.max(0, 1 - t * 2.2), 0, 2);
      add(ringTexture(), 0x9fd0ff, (t) => S * (0.2 + 0.7 * easeOut(t)), (t) => (1 - t) * (1 - t), 0, 0);
    } else {
      if (heavy) {
        add(starburstTexture(), 0xff3d12, (t) => S * (0.7 + 0.45 * easeOut(Math.min(1, t * 3.5))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.15, 0.6), -0.8, 0);
      }
      add(starburstTexture(), heavy ? 0xffb020 : starTint.copy(c).lerp(HIT_STAR, 0.55), (t) => S * (0.42 + 0.3 * easeOut(Math.min(1, t * 4))), (t) => 1 - THREE.MathUtils.smoothstep(t, 0.1, 0.55), 0.9, 1);
      add(glowTexture(), 0xffffff, (t) => S * 0.26 * (1.2 - t), (t) => Math.max(0, 1 - t * 2.6), 0, 2);
      add(ringTexture(), heavy ? 0xffe2a0 : 0xfff0c8, (t) => S * (0.15 + 1.1 * easeOut(t)), (t) => 0.9 * Math.pow(1 - t, 3), 0, 3);
    }
    for (let i = b.used; i < MAX_LAYERS; i++) b.slots[i].mesh.visible = false;

    b.streak.uniforms.uScale.value = S;
    b.streak.uniforms.uColor.value.set(block ? 0x8fc4ff : heavy ? 0xffa030 : color);
    fillStreaks(b.streakGeo, heavy ? 16 : block ? 7 : 11, block ? 0.32 : 0.5);

    const n = Math.round(count * (heavy ? 1.6 : 1));
    let geo = b.pts.geometry;
    if ((geo.getAttribute('position') as THREE.BufferAttribute).count < n) {
      geo.dispose();
      geo = b.pts.geometry = particleGeometry(Math.max(n, 72));
      b.vel = new Float32Array(Math.max(n, 72) * 3);
    }
    const posA = geo.getAttribute('position') as THREE.BufferAttribute;
    const colA = geo.getAttribute('color') as THREE.BufferAttribute;
    const pos = posA.array as Float32Array;
    const col = colA.array as Float32Array;
    const vel = b.vel;
    pos.fill(0, 0, n * 3);
    for (let i = 0; i < n; i++) {
      dirV.randomDirection().multiplyScalar((2 + Math.random() * 4.5) * (heavy ? 1.3 : block ? 0.6 : 1));
      vel[i * 3] = dirV.x;
      vel[i * 3 + 1] = dirV.y;
      vel[i * 3 + 2] = dirV.z;
      tint.copy(block ? BLOCK_TINT : c).lerp(WHITE, Math.random() * 0.6);
      col[i * 3] = tint.r;
      col[i * 3 + 1] = tint.g;
      col[i * 3 + 2] = tint.b;
    }
    colA.needsUpdate = true;
    geo.setDrawRange(0, n);
    b.count = n;
    b.pmat.size = heavy ? 0.075 : 0.055;

    this.object.add(b.group);
    this.bursts.push(b);
    while (this.bursts.length > MAX_BURSTS) this.remove(this.bursts.shift()!);
    this.apply(b, 0);

    if (this.autoFx) {
      let root: THREE.Object3D = this.object;
      while (root.parent) root = root.parent;
      (root.userData.hitFx as HitFxHook | undefined)?.(kind);
    }
  }

  update(dt: number): void {
    const list = this.bursts;
    for (const b of list) {
      b.age += dt;
      this.apply(b, dt);
    }
    let keep = 0;
    for (const b of list) {
      if (b.age >= b.life) this.remove(b);
      else list[keep++] = b;
    }
    list.length = keep;
  }

  private apply(b: Burst, dt: number): void {
    const t = Math.min(1, b.age / b.life);
    for (let i = 0; i < b.used; i++) {
      const l = b.slots[i];
      l.mat.uniforms.uScale.value = l.size(t);
      l.mat.uniforms.uOpacity.value = Math.max(0, l.alpha(t));
      l.mat.uniforms.uRot.value += l.spin * dt;
    }
    b.streak.uniforms.uT.value = easeOut(t);
    b.streak.uniforms.uOpacity.value = Math.max(0, 1 - Math.pow(t, 1.4));
    const posA = b.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = posA.array as Float32Array;
    const vel = b.vel;
    const drag = Math.exp(-dt * 4);
    for (let i = 0; i < b.count; i++) {
      const k = i * 3;
      vel[k] *= drag;
      vel[k + 1] = vel[k + 1] * drag - 5 * dt;
      vel[k + 2] *= drag;
      pos[k] += vel[k] * dt;
      pos[k + 1] += vel[k + 1] * dt;
      pos[k + 2] += vel[k + 2] * dt;
    }
    posA.clearUpdateRanges();
    posA.addUpdateRange(0, b.count * 3);
    posA.needsUpdate = true;
    b.pmat.opacity = Math.max(0, 1 - t * t);
  }

  /** Detaches a finished burst and keeps it for the next spawn. */
  private remove(b: Burst): void {
    this.object.remove(b.group);
    this.free.push(b);
  }
}
