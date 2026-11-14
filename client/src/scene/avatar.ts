import * as THREE from 'three';
import { W, type Hand, type WirePose, type Zone } from '../../../shared/types.ts';
import { SW_METRES } from '../tracking/input.ts';

export type Corner = 'red' | 'blue';

export type Reaction =
  | { kind: 'hit'; zone: Zone; heavy: boolean }
  | { kind: 'block'; zone: Zone }
  | { kind: 'stagger' }
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
  /** World position of a hit zone, for sparks and markers. */
  zonePosition(zone: Zone, out: THREE.Vector3): THREE.Vector3;
  update(dt: number): void;
}

const HIP_H = 0.9;
const THIGH = 0.47;
const SHIN = 0.46;
const CORNER_COLORS: Record<Corner, number> = { red: 0xc1121f, blue: 0x1d4ed8 };
const N = 13;

/** Converts wire landmarks into avatar-local metres: feet at y=0, facing +z. */
export function wireToLocal(p: WirePose, out: THREE.Vector3[]): void {
  const g = (i: number) => new THREE.Vector3(p.lm[i * 3] / 1000, p.lm[i * 3 + 1] / 1000, p.lm[i * 3 + 2] / 1000);
  const sw = g(W.lShoulder).distanceTo(g(W.rShoulder)) || SW_METRES;
  const k = THREE.MathUtils.clamp(SW_METRES / sw, 0.6, 1.6);
  const ox = (p.off[0] / 100) * SW_METRES;
  const oy = (-p.off[1] / 100) * SW_METRES;
  for (let i = 0; i < N; i++) {
    const v = g(i);
    out[i].set(v.x * k + ox, -v.y * k + HIP_H + oy, -v.z * k);
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
  private skin = new THREE.MeshStandardMaterial({ color: 0xb98a6a, roughness: 0.65 });
  private cornerMat = new THREE.MeshStandardMaterial({ color: CORNER_COLORS.red, roughness: 0.45 });
  private gloveMats: Record<Hand, THREE.MeshStandardMaterial> = {
    left: new THREE.MeshStandardMaterial({ color: CORNER_COLORS.red, roughness: 0.3, emissive: 0x000000 }),
    right: new THREE.MeshStandardMaterial({ color: CORNER_COLORS.red, roughness: 0.3, emissive: 0x000000 }),
  };
  private parts: Record<string, THREE.Mesh> = {};
  private hitOff = new THREE.Vector3();
  private hitVel = new THREE.Vector3();
  private anim: Anim = { kind: 'none' };
  private gassed = false;
  private telegraph: { hand: Hand | null; k: number } = { hand: null, k: 0 };
  private time = 0;

  constructor(corner: Corner = 'red') {
    this.object.add(this.body);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
    const sph = new THREE.SphereGeometry(1, 20, 14);
    const dark = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.8 });
    const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, r: [number, number, number]) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.userData.r = r;
      this.parts[name] = m;
      this.body.add(m);
    };
    add('torso', cyl, this.skin, [0.17, 1, 0.11]);
    add('chest', sph, this.skin, [0.2, 0.13, 0.12]);
    add('trunks', sph, this.cornerMat, [0.19, 0.17, 0.14]);
    add('neck', cyl, this.skin, [0.055, 1, 0.055]);
    add('head', sph, this.skin, [0.105, 0.125, 0.11]);
    for (const s of ['l', 'r']) {
      add(`${s}Shoulder`, sph, this.skin, [0.075, 0.075, 0.075]);
      add(`${s}Upper`, cyl, this.skin, [0.05, 1, 0.05]);
      add(`${s}Elbow`, sph, this.skin, [0.048, 0.048, 0.048]);
      add(`${s}Fore`, cyl, this.skin, [0.044, 1, 0.044]);
      add(`${s}Glove`, sph, this.gloveMats[s === 'l' ? 'left' : 'right'], [0.085, 0.085, 0.1]);
      add(`${s}Thigh`, cyl, this.cornerMat, [0.075, 1, 0.075]);
      add(`${s}Knee`, sph, this.skin, [0.058, 0.058, 0.058]);
      add(`${s}Shin`, cyl, this.skin, [0.055, 1, 0.055]);
      add(`${s}Shoe`, sph, dark, [0.06, 0.05, 0.12]);
    }
    for (const m of Object.values(this.parts)) {
      const [x, y, z] = m.userData.r as number[];
      if (m.geometry === sph) m.scale.set(x, y, z);
    }
    this.setCornerColor(corner);
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
    this.telegraph = { hand, k };
  }

  playReaction(r: Reaction): void {
    switch (r.kind) {
      case 'hit':
      case 'block': {
        const side = r.zone.endsWith('left') ? -1 : 1;
        const k = r.kind === 'block' ? 0.4 : r.heavy ? 1.6 : 1;
        this.hitVel.add(new THREE.Vector3(side * 0.6 * k, r.zone.startsWith('head') ? 0.2 * k : -0.1 * k, -1.4 * k));
        break;
      }
      case 'stagger':
        if (this.anim.kind === 'none') this.anim = { kind: 'stagger', t: 0 };
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
    out.copy(m.position).add(new THREE.Vector3(side * (head ? 0.07 : 0.12), head ? 0 : -0.08, 0.1));
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

    const P = this.cur.map((v) => v.clone());
    for (const i of [W.nose, W.lEar, W.rEar]) P[i].add(this.hitOff).x += sway;
    for (const i of [W.lShoulder, W.rShoulder]) P[i].addScaledVector(this.hitOff, 0.5).x += sway * 0.6;
    if (this.gassed) {
      for (const i of [W.lWrist, W.rWrist, W.lIndex, W.rIndex]) P[i].y -= 0.12;
      for (const i of [W.lElbow, W.rElbow]) P[i].y -= 0.05;
    }
    for (const p of P) p.y -= drop;

    this.pose(P);

    this.body.rotation.x = -fall * (Math.PI / 2 - 0.12);
    this.body.position.y = fall * 0.12;
    this.body.position.z = -fall * 0.25;

    for (const h of ['left', 'right'] as Hand[]) {
      const on = this.telegraph.hand === h ? this.telegraph.k : 0;
      this.gloveMats[h].emissive.setRGB(on * 0.9, on * 0.75, on * 0.2);
    }
  }

  private pose(P: THREE.Vector3[]): void {
    const p = this.parts;
    const hipMid = new THREE.Vector3().addVectors(P[W.lHip], P[W.rHip]).multiplyScalar(0.5);
    const shMid = new THREE.Vector3().addVectors(P[W.lShoulder], P[W.rShoulder]).multiplyScalar(0.5);
    const headC = new THREE.Vector3().addVectors(P[W.lEar], P[W.rEar]).multiplyScalar(0.5);
    headC.lerp(P[W.nose], 0.25);
    headC.y += 0.02;

    const torsoTop = shMid.clone().add(new THREE.Vector3(0, -0.06, 0));
    placeLimb(p.torso, hipMid, torsoTop);
    p.torso.scale.x = 0.15;
    p.torso.scale.z = 0.1;
    const side = new THREE.Vector3().subVectors(P[W.lShoulder], P[W.rShoulder]);
    const yaw = Math.atan2(-side.z, side.x);
    p.torso.rotateY(yaw);
    p.chest.position.copy(shMid).lerp(hipMid, 0.22);
    p.chest.rotation.set(0, yaw, 0);
    p.trunks.position.copy(hipMid).add(new THREE.Vector3(0, -0.02, 0));
    p.trunks.rotation.set(0, yaw, 0);
    placeLimb(p.neck, shMid, headC);
    p.neck.scale.x = p.neck.scale.z = 0.055;
    p.head.position.copy(headC);
    p.head.lookAt(tmpA.copy(P[W.nose]).sub(headC).setY(0).add(headC).add(new THREE.Vector3(0, 0, 0.001)));

    for (const [s, sh, el, wr, ix, hp] of [
      ['l', W.lShoulder, W.lElbow, W.lWrist, W.lIndex, W.lHip],
      ['r', W.rShoulder, W.rElbow, W.rWrist, W.rIndex, W.rHip],
    ] as const) {
      p[`${s}Shoulder`].position.copy(P[sh]);
      placeLimb(p[`${s}Upper`], P[sh], P[el]);
      p[`${s}Upper`].scale.x = p[`${s}Upper`].scale.z = 0.05;
      p[`${s}Elbow`].position.copy(P[el]);
      placeLimb(p[`${s}Fore`], P[el], P[wr]);
      p[`${s}Fore`].scale.x = p[`${s}Fore`].scale.z = 0.044;
      const glove = p[`${s}Glove`];
      glove.position.copy(P[wr]).lerp(P[ix], 0.6);
      glove.lookAt(tmpA.copy(P[ix]).sub(P[wr]).add(glove.position));

      const hip = P[hp].clone();
      const ankle = new THREE.Vector3(s === 'l' ? 0.17 : -0.17, 0.08, s === 'l' ? 0.08 : -0.08);
      const kn = knee(hip, ankle, new THREE.Vector3());
      placeLimb(p[`${s}Thigh`], hip, kn);
      p[`${s}Thigh`].scale.x = p[`${s}Thigh`].scale.z = 0.075;
      p[`${s}Knee`].position.copy(kn);
      placeLimb(p[`${s}Shin`], kn, ankle);
      p[`${s}Shin`].scale.x = p[`${s}Shin`].scale.z = 0.055;
      p[`${s}Shoe`].position.set(ankle.x, 0.05, ankle.z + 0.04);
    }
  }
}
