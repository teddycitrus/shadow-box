import * as THREE from 'three';
import { W, type Punch, type WirePose } from '../../../shared/types.ts';
import type { Corner } from './avatar.ts';
import { outlineMaterial, toonGradient } from './fx.ts';

const GUARD_POS = [new THREE.Vector3(0.11, -0.13, -0.52), new THREE.Vector3(-0.11, -0.13, -0.52)];
const want = new THREE.Vector3();
const off = new THREE.Vector3();
const nose = new THREE.Vector3();
const wrist = new THREE.Vector3();

/** The player's own gloves in the foreground, following their wrists (mirrored). */
export class FirstPersonGloves {
  readonly object = new THREE.Group();
  private gloves: THREE.Mesh[] = [];
  private target = [new THREE.Vector3(0.16, -0.25, -0.45), new THREE.Vector3(-0.16, -0.25, -0.45)];
  private mat = new THREE.MeshToonMaterial({ color: 0xc1121f, gradientMap: toonGradient() });
  private guard = false;
  private guardK = 0;
  private swing: { k: number; punch: Punch; t: number } | null = null;
  private ring: THREE.Mesh;

  constructor() {
    const geo = new THREE.SphereGeometry(1, 24, 16);
    const cuffGeo = new THREE.CylinderGeometry(0.046, 0.052, 0.07, 16);
    const cuffMat = new THREE.MeshToonMaterial({ color: 0xd8d8d8, gradientMap: toonGradient() });
    const line = outlineMaterial(0.0035);
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Mesh(geo, this.mat);
      g.scale.set(0.07, 0.075, 0.09);
      g.position.copy(this.target[i]);
      const gl = new THREE.Mesh(geo, line);
      gl.matrixAutoUpdate = false;
      g.add(gl);
      const cuff = new THREE.Mesh(cuffGeo, cuffMat);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.z = 0.9;
      cuff.scale.set(1 / 0.07, 1 / 0.09, 1 / 0.075);
      cuff.updateMatrix();
      cuff.matrixAutoUpdate = false;
      const cl = new THREE.Mesh(cuffGeo, line);
      cl.matrixAutoUpdate = false;
      cuff.add(cl);
      g.add(cuff);
      this.gloves.push(g);
      this.object.add(g);
    }
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.26, 48),
      new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.ring.position.set(0, -0.12, -0.5);
    this.object.add(this.ring);
  }

  /** Raises both gloves to the face and shows a guard ring, so blocking is obvious. */
  setGuard(on: boolean): void {
    this.guard = on;
  }

  /** Visible punch by type: the glove on that hand (screen side) drives out along its path. */
  punch(p: Punch): void {
    this.swing = { k: p.hand === 'right' ? 0 : 1, punch: p, t: 0 };
  }

  setCorner(c: Corner): void {
    this.mat.color.setHex(c === 'red' ? 0xc1121f : 0x1d4ed8);
  }

  /** Camera space: x right, y up, z toward the scene (negative). */
  setPose(p: WirePose, gassed: boolean): void {
    const g = (i: number, v: THREE.Vector3) => v.set(p.lm[i * 3] / 1000, p.lm[i * 3 + 1] / 1000, p.lm[i * 3 + 2] / 1000);
    g(W.nose, nose);
    for (let k = 0; k < 2; k++) {
      const w = g(k === 0 ? W.rWrist : W.lWrist, wrist).sub(nose);
      const y = Math.max(-0.3, -w.y - 0.13 - (gassed ? 0.06 : 0));
      this.target[k].set(-w.x * 1.6 + (k === 0 ? 0.05 : -0.05), y, Math.min(-0.38, w.z * 1.8 - 0.45));
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 22);
    this.guardK += ((this.guard ? 1 : 0) - this.guardK) * Math.min(1, dt * 12);
    for (let i = 0; i < 2; i++) {
      const g = this.gloves[i];
      want.copy(this.target[i]).lerp(GUARD_POS[i], this.guardK * 0.8);
      const s = this.swing;
      if (s && s.k === i) {
        const u = Math.sin(Math.min(1, s.t / 0.3) * Math.PI);
        const sx = i === 0 ? 1 : -1;
        const body = s.punch.target === 'body' ? -0.14 : 0;
        if (s.punch.type === 'jab' || s.punch.type === 'cross') off.set(-sx * 0.08, 0.05 + body, -0.55);
        else if (s.punch.type.endsWith('Hook')) off.set(-sx * 0.3 * u + sx * 0.15, 0.08 + body, -0.4);
        else off.set(-sx * 0.05, 0.25, -0.35);
        want.addScaledVector(off, u);
      }
      g.position.lerp(want, s && s.k === i ? 0.6 : k);
    }
    if (this.swing && (this.swing.t += dt) > 0.3) this.swing = null;
    const ringOpacity = this.guardK * 0.18;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = ringOpacity;
    // Below this the additive ring adds far less than one 8-bit step, so skip its draw call.
    this.ring.visible = ringOpacity > 1e-4;
  }
}

export { Sparks, type SparkKind, type SparkOptions } from './sparks.ts';
