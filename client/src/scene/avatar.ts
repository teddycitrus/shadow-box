import * as THREE from 'three';
import { W, type DefenseState, type Hand, type Punch, type WirePose, type Zone } from '../../../shared/types.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SW_METRES } from '../tracking/input.ts';
import { outlineMaterial, toonGradient } from './fx.ts';

export type Corner = 'red' | 'blue';

export type Reaction =
  | { kind: 'hit'; zone: Zone; heavy: boolean }
  | { kind: 'block'; zone: Zone }
  | { kind: 'stagger' }
  | { kind: 'throw'; punch: Punch }
  | { kind: 'knockdown' }
  | { kind: 'getUp' }
  | { kind: 'reset' };

/**
 * What the game needs from a fighter model. The procedural avatar below implements it; a
 * rigged GLB can replace it by mapping the same joint targets onto bones.
 */
export interface Avatar {
  readonly object: THREE.Object3D;
  setPose(pose: WirePose): void;
  playReaction(r: Reaction): void;
  setCornerColor(c: Corner): void;
  setGassed(gassed: boolean): void;
  setTelegraph(hand: Hand | null, k: number): void;
  /** Shows guard, duck and slip clearly, on top of the live pose. */
  setDefense(def: DefenseState): void;
  /** World position of a hit zone, for sparks and markers. */
  zonePosition(zone: Zone, out: THREE.Vector3): THREE.Vector3;
  update(dt: number): void;
}

const HIP_H = 0.9;
const THIGH = 0.47;
const SHIN = 0.46;
const CORNER_COLORS: Record<Corner, number> = { red: 0xc1121f, blue: 0x1d4ed8 };
const N = 13;

const PART_NAMES = [
  'torso', 'chest', 'trunks', 'neck', 'head',
  ...['l', 'r'].flatMap((s) => ['Shoulder', 'Upper', 'Elbow', 'Fore', 'Glove', 'Thigh', 'Knee', 'Shin', 'Shoe'].map((p) => s + p)),
];
/** Fixed scale of the sphere parts; cylinders get theirs from placeLimb each frame. */
const SPHERE_SCALE: Record<string, [number, number, number]> = {
  chest: [0.2, 0.13, 0.12], trunks: [0.19, 0.17, 0.14], head: [0.105, 0.125, 0.11],
  lShoulder: [0.075, 0.075, 0.075], rShoulder: [0.075, 0.075, 0.075],
  lElbow: [0.048, 0.048, 0.048], rElbow: [0.048, 0.048, 0.048],
  lGlove: [0.085, 0.085, 0.1], rGlove: [0.085, 0.085, 0.1],
  lKnee: [0.058, 0.058, 0.058], rKnee: [0.058, 0.058, 0.058],
  lShoe: [0.06, 0.05, 0.12], rShoe: [0.06, 0.05, 0.12],
};
const SKIN_SPHERES = ['chest', 'head', 'lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lKnee', 'rKnee'] as const;
const SKIN_CYLINDERS = ['torso', 'neck', 'lUpper', 'rUpper', 'lFore', 'rFore', 'lShin', 'rShin'] as const;

const wlA = new THREE.Vector3();
const wlB = new THREE.Vector3();

/** Converts wire landmarks into avatar-local metres: feet at y=0, facing +z. */
export function wireToLocal(p: WirePose, out: THREE.Vector3[]): void {
  const lm = p.lm;
  const g = (i: number, v: THREE.Vector3) => v.set(lm[i * 3] / 1000, lm[i * 3 + 1] / 1000, lm[i * 3 + 2] / 1000);
  const sw = g(W.lShoulder, wlA).distanceTo(g(W.rShoulder, wlB)) || SW_METRES;
  const k = THREE.MathUtils.clamp(SW_METRES / sw, 0.6, 1.6);
  const ox = (p.off[0] / 100) * SW_METRES;
  const oy = (-p.off[1] / 100) * SW_METRES;
  for (let i = 0; i < N; i++) {
    const x = lm[i * 3] / 1000, y = lm[i * 3 + 1] / 1000, z = lm[i * 3 + 2] / 1000;
    out[i].set(x * k + ox, -y * k + HIP_H + oy, -z * k);
  }
}

/** A neutral standing guard used before any pose arrives and while down. */
function restPose(): THREE.Vector3[] {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const pts = Array.from({ length: N }, () => v(0, 0, 0));
  pts[W.nose].set(0, HIP_H + 0.65, 0.09);
  pts[W.lEar].set(0.075, HIP_H + 0.64, 0);
  pts[W.rEar].set(-0.075, HIP_H + 0.64, 0);
  pts[W.lShoulder].set(0.19, HIP_H + 0.45, 0);
  pts[W.rShoulder].set(-0.19, HIP_H + 0.45, 0);
  pts[W.lElbow].set(0.24, HIP_H + 0.25, 0.12);
  pts[W.rElbow].set(-0.24, HIP_H + 0.25, 0.12);
  pts[W.lWrist].set(0.09, HIP_H + 0.6, 0.22);
  pts[W.rWrist].set(-0.09, HIP_H + 0.6, 0.22);
  pts[W.lIndex].set(0.09, HIP_H + 0.62, 0.3);
  pts[W.rIndex].set(-0.09, HIP_H + 0.62, 0.3);
  pts[W.lHip].set(0.1, HIP_H, 0);
  pts[W.rHip].set(-0.1, HIP_H, 0);
  return pts;
}

function limpPose(): THREE.Vector3[] {
  const pts = restPose();
  pts[W.lElbow].set(0.38, HIP_H + 0.3, 0);
  pts[W.rElbow].set(-0.38, HIP_H + 0.3, 0);
  pts[W.lWrist].set(0.52, HIP_H + 0.15, 0.05);
  pts[W.rWrist].set(-0.52, HIP_H + 0.15, 0.05);
  pts[W.lIndex].set(0.56, HIP_H + 0.1, 0.05);
  pts[W.rIndex].set(-0.56, HIP_H + 0.1, 0.05);
  return pts;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const HEAD_PTS = [W.nose, W.lEar, W.rEar] as const;
const SHOULDER_PTS = [W.lShoulder, W.rShoulder] as const;
const HAND_PTS = [W.lWrist, W.rWrist, W.lIndex, W.rIndex] as const;
const ELBOW_PTS = [W.lElbow, W.rElbow] as const;
const GUARD_ARMS = [[W.lWrist, W.lIndex, W.lElbow, 1], [W.rWrist, W.rIndex, W.rElbow, -1]] as const;
const HANDS: readonly Hand[] = ['left', 'right'];
const SIDES = [
  { s: 'l', sh: W.lShoulder, el: W.lElbow, wr: W.lWrist, ix: W.lIndex, hp: W.lHip },
  { s: 'r', sh: W.rShoulder, el: W.rElbow, wr: W.rWrist, ix: W.rIndex, hp: W.rHip },
].map((d) => ({
  ...d,
  shoulder: `${d.s}Shoulder`, upper: `${d.s}Upper`, elbow: `${d.s}Elbow`, fore: `${d.s}Fore`, glove: `${d.s}Glove`,
  thigh: `${d.s}Thigh`, knee: `${d.s}Knee`, shin: `${d.s}Shin`, shoe: `${d.s}Shoe`,
  ankleX: d.s === 'l' ? 0.17 : -0.17, ankleZ: d.s === 'l' ? 0.08 : -0.08,
}));

function placeLimb(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  tmpA.subVectors(b, a);
  const len = tmpA.length();
  m.position.addVectors(a, b).multiplyScalar(0.5);
  if (len > 1e-5) m.quaternion.setFromUnitVectors(UP, tmpA.divideScalar(len));
  m.scale.set(1, len, 1);
}

/** Knee position for a hip and ankle, bending forward (+z). */
function knee(hip: THREE.Vector3, ankle: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const d = tmpA.subVectors(ankle, hip);
  const dl = Math.min(d.length(), THIGH + SHIN - 1e-3);
  const dir = d.normalize();
  const a = (THIGH * THIGH - SHIN * SHIN + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
  const pole = tmpB.set(0, 0, 1).addScaledVector(dir, -dir.z).normalize();
  return out.copy(hip).addScaledVector(dir, a).addScaledVector(pole, h);
}

type Anim = { kind: 'none' } | { kind: 'falling' | 'down' | 'rising'; t: number } | { kind: 'stagger'; t: number };

/** Stylized humanoid built from capsules and spheres. */
export class ProceduralAvatar implements Avatar {
  readonly object = new THREE.Group();
  private body = new THREE.Group();
  private target = restPose();
  private cur = restPose();
  private limp = limpPose();
  /** Per-frame working copy of the joints, reused to avoid allocating every frame. */
  private P = restPose();
  private skin = new THREE.MeshToonMaterial({ color: 0xbb8160, gradientMap: toonGradient() });
  private cornerMat = new THREE.MeshToonMaterial({ color: CORNER_COLORS.red, gradientMap: toonGradient() });
  private gloveMats: Record<Hand, THREE.MeshToonMaterial> = {
    left: new THREE.MeshToonMaterial({ color: CORNER_COLORS.red, gradientMap: toonGradient(), emissive: 0x000000 }),
    right: new THREE.MeshToonMaterial({ color: CORNER_COLORS.red, gradientMap: toonGradient(), emissive: 0x000000 }),
  };
  private parts: Record<string, THREE.Object3D> = {};
  private batches: { mesh: THREE.InstancedMesh; parts: THREE.Object3D[] }[] = [];
  private hitOff = new THREE.Vector3();
  private hitVel = new THREE.Vector3();
  private anim: Anim = { kind: 'none' };
  private gassed = false;
  private telegraph: { hand: Hand | null; k: number } = { hand: null, k: 0 };
  private time = 0;
  private guardK = 0;
  private guarding = false;
  private shield: THREE.Mesh;
  /** Active punch flourish: makes the punch type readable even when tracking lags. */
  private swing: { punch: Punch; t: number } | null = null;
  private flash: Record<Hand, number> = { left: 0, right: 0 };
  private hipMid = new THREE.Vector3();
  private shMid = new THREE.Vector3();
  private headC = new THREE.Vector3();
  private hip = new THREE.Vector3();
  private ankle = new THREE.Vector3();
  private kn = new THREE.Vector3();

  constructor(corner: Corner = 'red') {
    this.object.add(this.body);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
    const sph = new THREE.SphereGeometry(1, 20, 14);
    const dark = new THREE.MeshToonMaterial({ color: 0x1c1c24, gradientMap: toonGradient() });
    // Inverted-hull ink outline so the fighters read like fighting-game characters.
    const line = outlineMaterial(0.009);
    const outline = (parent: THREE.Mesh) => {
      const o = new THREE.Mesh(parent.geometry, line);
      o.matrixAutoUpdate = false;
      parent.add(o);
    };

    // Body parts are plain transforms posed every frame. Parts sharing a geometry and material are
    // drawn together as one InstancedMesh (outlines included), so a fighter costs a handful of draws.
    const solo = (mat: THREE.Material) => {
      const m = new THREE.Mesh(sph, mat);
      m.castShadow = true;
      this.body.add(m);
      return m;
    };
    for (const name of PART_NAMES) {
      const part = name === 'trunks' ? solo(this.cornerMat)
        : name === 'lGlove' ? solo(this.gloveMats.left)
          : name === 'rGlove' ? solo(this.gloveMats.right)
            : new THREE.Object3D();
      part.matrixAutoUpdate = false;
      const r = SPHERE_SCALE[name];
      if (r) part.scale.set(r[0], r[1], r[2]);
      this.parts[name] = part;
    }
    const head = this.parts.head;
    this.body.add(head);

    // Corner-coloured headband with trailing tails, in head-local (unit sphere) space.
    const fixed = (m: THREE.Object3D) => {
      m.updateMatrix();
      m.matrixAutoUpdate = false;
    };
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.93, 0.13, 8, 28), this.cornerMat);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.36;
    fixed(band);
    outline(band);
    head.add(band);
    const knot = new THREE.Mesh(sph, this.cornerMat);
    knot.scale.setScalar(0.17);
    knot.position.set(0, 0.36, -0.95);
    fixed(knot);
    outline(knot);
    head.add(knot);
    // Both tails baked into one geometry in head space.
    const tailGeo = new THREE.BoxGeometry(0.15, 0.8, 0.05);
    tailGeo.translate(0, -0.4, 0);
    const place = new THREE.Object3D();
    const tailParts = [-1, 1].map((sx) => {
      place.position.set(sx * 0.06, 0.34, -1.0);
      place.rotation.set(-0.6, 0, sx * 0.22);
      place.updateMatrix();
      return tailGeo.clone().applyMatrix4(place.matrix);
    });
    const tails = new THREE.Mesh(mergeGeometries(tailParts) ?? tailGeo, this.cornerMat);
    for (const g of tailParts) g.dispose();
    tails.matrixAutoUpdate = false;
    outline(tails);
    head.add(tails);

    const batch = (geo: THREE.BufferGeometry, mat: THREE.Material, names: readonly string[], cast: boolean) => {
      const mesh = new THREE.InstancedMesh(geo, mat, names.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move every frame, so a cached bounding sphere would go stale.
      mesh.frustumCulled = false;
      mesh.castShadow = cast;
      mesh.matrixAutoUpdate = false;
      this.body.add(mesh);
      this.batches.push({ mesh, parts: names.map((n) => this.parts[n]) });
    };
    batch(sph, this.skin, SKIN_SPHERES, true);
    batch(cyl, this.skin, SKIN_CYLINDERS, true);
    batch(cyl, this.cornerMat, ['lThigh', 'rThigh'], true);
    batch(sph, dark, ['lShoe', 'rShoe'], true);
    batch(sph, line, [...SKIN_SPHERES, 'trunks', 'lGlove', 'rGlove', 'lShoe', 'rShoe'], false);
    batch(cyl, line, [...SKIN_CYLINDERS, 'lThigh', 'rThigh'], false);

    const shieldMat = new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    // A flat ring never overlaps itself, so one double-sided pass matches the default two-pass draw.
    shieldMat.forceSinglePass = true;
    this.shield = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.2, 40), shieldMat);
    this.body.add(this.shield);
    this.setCornerColor(corner);
    this.sync();
  }

  /** Pushes the posed part transforms into the meshes and instance buffers. */
  private sync(): void {
    for (const name of PART_NAMES) this.parts[name].updateMatrix();
    for (const { mesh, parts } of this.batches) {
      for (let i = 0; i < parts.length; i++) mesh.setMatrixAt(i, parts[i].matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  setDefense(def: DefenseState): void {
    this.guarding = def.guard;
  }

  setCornerColor(c: Corner): void {
    this.cornerMat.color.setHex(CORNER_COLORS[c]);
    this.gloveMats.left.color.setHex(CORNER_COLORS[c]);
    this.gloveMats.right.color.setHex(CORNER_COLORS[c]);
  }

  setPose(p: WirePose): void {
    wireToLocal(p, this.target);
  }

  setGassed(g: boolean): void {
    this.gassed = g;
  }

  setTelegraph(hand: Hand | null, k: number): void {
    this.telegraph.hand = hand;
    this.telegraph.k = k;
  }

  playReaction(r: Reaction): void {
    switch (r.kind) {
      case 'hit':
      case 'block': {
        const side = r.zone.endsWith('left') ? -1 : 1;
        const k = r.kind === 'block' ? 0.4 : r.heavy ? 1.6 : 1;
        this.hitVel.add(tmpC.set(side * 0.6 * k, r.zone.startsWith('head') ? 0.2 * k : -0.1 * k, -1.4 * k));
        break;
      }
      case 'stagger':
        if (this.anim.kind === 'none') this.anim = { kind: 'stagger', t: 0 };
        break;
      case 'throw':
        this.swing = { punch: r.punch, t: 0 };
        this.flash[r.punch.hand] = 1;
        break;
      case 'knockdown':
        this.anim = { kind: 'falling', t: 0 };
        break;
      case 'getUp':
        this.anim = { kind: 'rising', t: 0 };
        break;
      case 'reset':
        this.anim = { kind: 'none' };
        this.body.rotation.set(0, 0, 0);
        this.body.position.set(0, 0, 0);
        break;
    }
  }

  zonePosition(zone: Zone, out: THREE.Vector3): THREE.Vector3 {
    const head = zone.startsWith('head');
    const side = zone.endsWith('left') ? 1 : -1;
    const m = head ? this.parts.head : this.parts.chest;
    out.copy(m.position).add(tmpC.set(side * (head ? 0.07 : 0.12), head ? 0 : -0.08, 0.1));
    return this.body.localToWorld(out);
  }

  update(dt: number): void {
    this.time += dt;
    const a = this.anim;
    let fall = 0;
    let drop = 0;
    if (a.kind !== 'none') {
      a.t += dt;
      if (a.kind === 'falling') {
        drop = Math.min(1, a.t / 0.45) * 0.32;
        fall = THREE.MathUtils.smoothstep(a.t, 0.35, 1.3);
        if (a.t > 1.3) this.anim = { kind: 'down', t: 0 };
      } else if (a.kind === 'down') {
        drop = 0.32;
        fall = 1;
      } else if (a.kind === 'rising') {
        const k = 1 - THREE.MathUtils.smoothstep(a.t, 0, 1.1);
        fall = k;
        drop = 0.32 * k;
        if (a.t > 1.2) this.anim = { kind: 'none' };
      } else if (a.kind === 'stagger') {
        drop = Math.sin((a.t / 0.4) * Math.PI) * 0.08;
        if (a.t > 0.4) this.anim = { kind: 'none' };
      }
    }

    const follow = 1 - Math.exp(-dt * (fall > 0 ? 6 : 16));
    const src = fall > 0.05 ? this.limp : this.target;
    for (let i = 0; i < N; i++) this.cur[i].lerp(src[i], follow);

    this.hitVel.addScaledVector(this.hitOff, -260 * dt).multiplyScalar(Math.exp(-dt * 14));
    this.hitOff.addScaledVector(this.hitVel, dt);
    const sway = this.anim.kind === 'stagger' ? Math.sin(this.time * 30) * 0.05 : 0;

    const P = this.P;
    for (let i = 0; i < N; i++) P[i].copy(this.cur[i]);
    for (const i of HEAD_PTS) P[i].add(this.hitOff).x += sway;
    for (const i of SHOULDER_PTS) P[i].addScaledVector(this.hitOff, 0.5).x += sway * 0.6;
    if (this.gassed) {
      for (const i of HAND_PTS) P[i].y -= 0.12;
      for (const i of ELBOW_PTS) P[i].y -= 0.05;
    }
    // Guard: pull both gloves up in front of the face so blocking reads clearly.
    this.guardK += ((this.guarding && fall < 0.05 ? 1 : 0) - this.guardK) * Math.min(1, dt * 12);
    if (this.guardK > 0.01) {
      const face = P[W.nose];
      for (const [wr, ix, el, sx] of GUARD_ARMS) {
        const delta = tmpC.set(face.x + sx * 0.075, face.y - 0.05, face.z + 0.13).sub(P[wr]).multiplyScalar(this.guardK * 0.85);
        P[wr].add(delta);
        P[ix].add(delta);
        P[el].addScaledVector(delta, 0.4);
      }
    }
    // Punch flourish by type: straights drive forward, hooks arc across, uppercuts rise.
    if (this.swing) {
      this.swing.t += dt;
      const k = Math.sin(Math.min(1, this.swing.t / 0.32) * Math.PI);
      const { punch } = this.swing;
      const sx = punch.hand === 'left' ? 1 : -1;
      const body = punch.target === 'body' ? -0.22 : 0;
      const off = punch.type === 'jab' || punch.type === 'cross'
        ? tmpC.set(-sx * 0.05, body, 0.42)
        : punch.type.endsWith('Hook')
          ? tmpC.set(-sx * 0.28 * k + sx * 0.12 * (1 - k), body + 0.02, 0.28)
          : tmpC.set(-sx * 0.04, 0.28 + body * 0.3, 0.22);
      const left = punch.hand === 'left';
      P[left ? W.lWrist : W.rWrist].addScaledVector(off, k);
      P[left ? W.lIndex : W.rIndex].addScaledVector(off, k);
      P[left ? W.lElbow : W.rElbow].addScaledVector(off, k * 0.45);
      if (this.swing.t > 0.32) this.swing = null;
    }
    for (const p of P) p.y -= drop;

    this.pose(P);
    this.sync();

    const sm = this.shield.material as THREE.MeshBasicMaterial;
    sm.opacity = this.guardK * (0.45 + Math.sin(this.time * 6) * 0.1);
    this.shield.visible = sm.opacity > 0.01;
    this.shield.position.copy(this.parts.head.position).add(tmpC.set(0, -0.04, 0.2));

    this.body.rotation.x = -fall * (Math.PI / 2 - 0.12);
    this.body.position.y = fall * 0.12;
    this.body.position.z = -fall * 0.25;

    for (const h of HANDS) {
      const on = this.telegraph.hand === h ? this.telegraph.k : 0;
      this.flash[h] = Math.max(0, this.flash[h] - dt * 3);
      const f = this.flash[h];
      this.gloveMats[h].emissive.setRGB(on * 0.9 + f, on * 0.75 + f * 0.85, on * 0.2 + f * 0.5);
    }
  }

  private pose(P: THREE.Vector3[]): void {
    const p = this.parts;
    const hipMid = this.hipMid.addVectors(P[W.lHip], P[W.rHip]).multiplyScalar(0.5);
    const shMid = this.shMid.addVectors(P[W.lShoulder], P[W.rShoulder]).multiplyScalar(0.5);
    const headC = this.headC.addVectors(P[W.lEar], P[W.rEar]).multiplyScalar(0.5);
    headC.lerp(P[W.nose], 0.25);
    headC.y += 0.02;

    const torsoTop = tmpC.copy(shMid).add(tmpB.set(0, -0.06, 0));
    placeLimb(p.torso, hipMid, torsoTop);
    p.torso.scale.x = 0.15;
    p.torso.scale.z = 0.1;
    const side = tmpC.subVectors(P[W.lShoulder], P[W.rShoulder]);
    const yaw = Math.atan2(-side.z, side.x);
    p.torso.rotateY(yaw);
    p.chest.position.copy(shMid).lerp(hipMid, 0.22);
    p.chest.rotation.set(0, yaw, 0);
    p.trunks.position.copy(hipMid).add(tmpC.set(0, -0.02, 0));
    p.trunks.rotation.set(0, yaw, 0);
    placeLimb(p.neck, shMid, headC);
    p.neck.scale.x = p.neck.scale.z = 0.055;
    p.head.position.copy(headC);
    // lookAt reads the world position from the matrix, and parts do not auto-update theirs.
    p.head.updateMatrix();
    p.head.lookAt(tmpA.copy(P[W.nose]).sub(headC).setY(0).add(headC).add(tmpC.set(0, 0, 0.001)));

    for (const d of SIDES) {
      p[d.shoulder].position.copy(P[d.sh]);
      placeLimb(p[d.upper], P[d.sh], P[d.el]);
      p[d.upper].scale.x = p[d.upper].scale.z = 0.05;
      p[d.elbow].position.copy(P[d.el]);
      placeLimb(p[d.fore], P[d.el], P[d.wr]);
      p[d.fore].scale.x = p[d.fore].scale.z = 0.044;
      const glove = p[d.glove];
      glove.position.copy(P[d.wr]).lerp(P[d.ix], 0.6);
      glove.updateMatrix();
      glove.lookAt(tmpA.copy(P[d.ix]).sub(P[d.wr]).add(glove.position));

      const hip = this.hip.copy(P[d.hp]);
      const ankle = this.ankle.set(d.ankleX, 0.08, d.ankleZ);
      const kn = knee(hip, ankle, this.kn);
      placeLimb(p[d.thigh], hip, kn);
      p[d.thigh].scale.x = p[d.thigh].scale.z = 0.075;
      p[d.knee].position.copy(kn);
      placeLimb(p[d.shin], kn, ankle);
      p[d.shin].scale.x = p[d.shin].scale.z = 0.055;
      p[d.shoe].position.set(ankle.x, 0.05, ankle.z + 0.04);
    }
  }
}
