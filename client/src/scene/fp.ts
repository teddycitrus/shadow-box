import * as THREE from 'three';
import { W, type WirePose } from '../../../shared/types.ts';
import type { Corner } from './avatar.ts';

/** The player's own gloves in the foreground, following their wrists (mirrored). */
export class FirstPersonGloves {
  readonly object = new THREE.Group();
  private gloves: THREE.Mesh[] = [];
  private target = [new THREE.Vector3(0.16, -0.25, -0.45), new THREE.Vector3(-0.16, -0.25, -0.45)];
  private mat = new THREE.MeshStandardMaterial({ color: 0xc1121f, roughness: 0.35 });

  constructor() {
    const geo = new THREE.SphereGeometry(1, 24, 16);
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Mesh(geo, this.mat);
      g.scale.set(0.07, 0.075, 0.09);
      g.position.copy(this.target[i]);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.065, 0.1, 16), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }));
      cuff.rotation.x = Math.PI / 2;
      cuff.position.z = 0.9;
      cuff.scale.set(1 / 0.07, 1 / 0.09, 1 / 0.075);
      g.add(cuff);
      this.gloves.push(g);
      this.object.add(g);
    }
  }

  setCorner(c: Corner): void {
    this.mat.color.setHex(c === 'red' ? 0xc1121f : 0x1d4ed8);
  }

  /** Camera space: x right, y up, z toward the scene (negative). */
  setPose(p: WirePose, gassed: boolean): void {
    const g = (i: number) => new THREE.Vector3(p.lm[i * 3] / 1000, p.lm[i * 3 + 1] / 1000, p.lm[i * 3 + 2] / 1000);
    const nose = g(W.nose);
    for (const [k, wi] of [[0, W.rWrist], [1, W.lWrist]] as const) {
      const w = g(wi).sub(nose);
      const y = Math.max(-0.3, -w.y - 0.13 - (gassed ? 0.06 : 0));
      this.target[k].set(-w.x * 1.6 + (k === 0 ? 0.05 : -0.05), y, Math.min(-0.38, w.z * 1.8 - 0.45));
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 22);
    this.gloves.forEach((g, i) => g.position.lerp(this.target[i], k));
  }
}

/** Short-lived additive particle bursts for landed punches. */
export class Sparks {
  readonly object = new THREE.Group();
  private bursts: { pts: THREE.Points; vel: Float32Array; life: number }[] = [];

  spawn(at: THREE.Vector3, color = 0xffd27a, count = 40): void {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos.set([at.x, at.y, at.z], i * 3);
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1.5 + Math.random() * 3);
      vel.set([v.x, v.y, v.z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.045, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    this.object.add(pts);
    this.bursts.push({ pts, vel, life: 0.45 });
  }

  update(dt: number): void {
    for (const b of this.bursts) {
      b.life -= dt;
      const pos = b.pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        b.vel[i * 3 + 1] -= 6 * dt;
        pos.setXYZ(i, pos.getX(i) + b.vel[i * 3] * dt, pos.getY(i) + b.vel[i * 3 + 1] * dt, pos.getZ(i) + b.vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      (b.pts.material as THREE.PointsMaterial).opacity = Math.max(0, b.life / 0.45);
    }
    for (const b of this.bursts.filter((x) => x.life <= 0)) {
      this.object.remove(b.pts);
      b.pts.geometry.dispose();
      (b.pts.material as THREE.Material).dispose();
    }
    this.bursts = this.bursts.filter((x) => x.life > 0);
  }
}
