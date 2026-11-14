import * as THREE from 'three';
import { apronTexture, bannerTexture, floorLogoTexture, glowTexture } from './fx.ts';

export const RING_HALF = 3.2;

const RED = 0xc1121f;
const BLUE = 0x1d4ed8;

/**
 * Night arena styled like a fighting-game stage: ring with ropes and corner pads, a centre
 * emblem, red and blue corner rim lights, a tiered crowd with camera flashes, hanging banners,
 * an LED ribbon and neon floor ring.
 */
export function buildArena(scene: THREE.Scene): { update(t: number): void } {
  scene.background = new THREE.Color(0x07040f);
  scene.fog = new THREE.Fog(0x07040f, 10, 28);
  scene.add(new THREE.HemisphereLight(0x5b4aa0, 0x140608, 0.4));

  const apron = apronTexture();
  apron.wrapS = THREE.RepeatWrapping;
  const apronMat = new THREE.MeshStandardMaterial({ map: apron, emissiveMap: apron, emissive: 0x555555, roughness: 0.7 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x1b2a55, roughness: 0.9 });
  const canvas = new THREE.Mesh(
    new THREE.BoxGeometry(RING_HALF * 2 + 0.6, 0.6, RING_HALF * 2 + 0.6),
    [apronMat, apronMat, topMat, topMat, apronMat, apronMat],
  );
  canvas.position.y = -0.3;
  canvas.receiveShadow = true;
  scene.add(canvas);

  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(RING_HALF * 2 - 0.2, RING_HALF * 2 - 0.2),
    new THREE.MeshStandardMaterial({ color: 0xd2ccbe, roughness: 0.9 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.y = 0.002;
  mat.receiveShadow = true;
  scene.add(mat);

  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(2.5, 2.5),
    new THREE.MeshStandardMaterial({ map: floorLogoTexture(), transparent: true, roughness: 0.8, depthWrite: false }),
  );
  logo.rotation.x = -Math.PI / 2;
  logo.position.y = 0.004;
  logo.receiveShadow = true;
  scene.add(logo);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x0d0a16, roughness: 0.45 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  scene.add(floor);

  // Neon floor ring: red half on the red corner side, blue half on the blue side.
  for (const [start, color] of [[Math.PI * 0.25, RED], [Math.PI * 1.25, BLUE]] as const) {
    const neon = new THREE.Mesh(
      new THREE.RingGeometry(5.3, 5.45, 64, 1, start, Math.PI),
      new THREE.MeshBasicMaterial({ color, toneMapped: false }),
    );
    neon.material.color.multiplyScalar(2.2);
    neon.rotation.x = -Math.PI / 2;
    neon.position.y = -0.595;
    scene.add(neon);
  }

  const corners: [number, number, number][] = [
    [-RING_HALF, -RING_HALF, RED], [RING_HALF, RING_HALF, BLUE],
    [RING_HALF, -RING_HALF, 0xdddddd], [-RING_HALF, RING_HALF, 0xdddddd],
  ];
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 12);
  const padGeo = new THREE.BoxGeometry(0.22, 0.95, 0.22);
  for (const [x, z, color] of corners) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const post = new THREE.Mesh(postGeo, m);
    post.position.set(x, 0.75, z);
    post.castShadow = true;
    scene.add(post);
    const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: 0.25 }));
    pad.position.set(x * 0.985, 0.85, z * 0.985);
    pad.rotation.y = Math.PI / 4;
    scene.add(pad);
  }

  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xf2eee4, roughness: 0.5 });
  const ropeRed = new THREE.MeshStandardMaterial({ color: 0xd0141c, roughness: 0.5, emissive: 0x500006 });
  for (const [i, h] of [0.45, 0.85, 1.25].entries()) {
    for (let side = 0; side < 4; side++) {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, RING_HALF * 2, 8), i === 1 ? ropeRed : ropeMat);
      rope.rotation.z = Math.PI / 2;
      if (side >= 2) rope.rotation.y = Math.PI / 2;
      const off = side % 2 === 0 ? -RING_HALF : RING_HALF;
      if (side < 2) rope.position.set(0, h, off);
      else rope.position.set(off, h, 0);
      scene.add(rope);
    }
  }

  const crowd = buildCrowd();
  scene.add(crowd.mesh, crowd.flashes);

  const led = buildLedRibbon();
  scene.add(led.mesh);

  const banners = buildBanners();
  scene.add(banners.group);

  scene.add(buildTruss());

  const cone = (x: number, y: number, z: number, angle: number, c: number, op: number, tx = 0, ty = 0, tz = 0) => {
    const len = Math.hypot(x - tx, y - ty, z - tz);
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(Math.tan(angle) * len, len, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    m.position.set((x + tx) / 2, (y + ty) / 2, (z + tz) / 2);
    m.lookAt(tx, ty, tz);
    m.rotateX(-Math.PI / 2);
    scene.add(m);
    return m;
  };

  const key = new THREE.SpotLight(0xfff1d6, 70, 20, Math.PI / 7, 0.5, 1.2);
  key.position.set(0, 9, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key, key.target);
  cone(0, 9, 0, Math.PI / 7, 0xfff1d6, 0.035);

  // Corner rim lights: saturated red and blue from opposite corners, swaying slowly.
  const rims: { light: THREE.SpotLight; base: THREE.Vector3; cone: THREE.Mesh }[] = [];
  for (const [x, z, c] of [[-4.6, -4.6, 0xff2a3c], [4.6, 4.6, 0x2a62ff]] as const) {
    const s = new THREE.SpotLight(c, 32, 18, Math.PI / 6, 0.55, 1.1);
    s.position.set(x, 4.2, z);
    s.target.position.set(0, 1.1, 0);
    scene.add(s, s.target);
    rims.push({ light: s, base: s.position.clone(), cone: cone(x, 4.2, z, Math.PI / 9, c, 0.03, 0, 0.6, 0) });
  }

  return {
    update(t: number) {
      crowd.update(t);
      led.update(t);
      banners.update(t);
      rims.forEach((r, i) => {
        r.light.position.set(r.base.x + Math.sin(t * 0.4 + i * 2) * 0.8, r.base.y, r.base.z + Math.cos(t * 0.33 + i) * 0.8);
        r.light.intensity = 30 + Math.sin(t * 1.7 + i * 3) * 4;
      });
    },
  };
}

function buildCrowd(): { mesh: THREE.InstancedMesh; flashes: THREE.Points; update(t: number): void } {
  const geo = new THREE.CapsuleGeometry(0.22, 0.5, 4, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1c24, roughness: 1 });
  const seats: { x: number; y: number; z: number; phase: number }[] = [];
  for (let row = 0; row < 7; row++) {
    const r = RING_HALF + 3 + row * 1.1;
    const n = Math.floor(r * 7);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + row * 0.2;
      seats.push({ x: Math.cos(a) * r, y: -0.2 + row * 0.55, z: Math.sin(a) * r, phase: Math.random() * 10 });
    }
  }
  const mesh = new THREE.InstancedMesh(geo, mat, seats.length);
  const color = new THREE.Color();
  // Red-corner side of the crowd leans red, blue-corner side leans blue.
  seats.forEach((s, i) => {
    const side = (s.x + s.z) / Math.hypot(s.x, s.z);
    const hue = side < 0 ? 0.98 + Math.random() * 0.04 : 0.62 + Math.random() * 0.04;
    mesh.setColorAt(i, color.setHSL(hue % 1, 0.35 + Math.abs(side) * 0.15, 0.07 + Math.random() * 0.08));
  });
  const m = new THREE.Matrix4();
  let excitement = 0;

  // Camera flashes and phone lights scattered over the stands.
  const FLASHES = 90;
  const fpos = new Float32Array(FLASHES * 3);
  const fcol = new Float32Array(FLASHES * 3);
  const level = new Float32Array(FLASHES);
  for (let i = 0; i < FLASHES; i++) {
    const s = seats[Math.floor(Math.random() * seats.length)];
    fpos.set([s.x, s.y + 0.55, s.z], i * 3);
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  fgeo.setAttribute('color', new THREE.BufferAttribute(fcol, 3));
  const flashes = new THREE.Points(fgeo, new THREE.PointsMaterial({
    size: 0.5, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  let lastT = 0;

  const update = (t: number) => {
    const dt = Math.min(0.05, Math.max(0, t - lastT));
    lastT = t;
    excitement *= 0.98;
    seats.forEach((s, i) => {
      const bob = Math.max(0, Math.sin(t * (2 + excitement * 6) + s.phase)) * (0.03 + excitement * 0.25);
      m.makeTranslation(s.x, s.y + bob, s.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    const rate = 0.25 + excitement * 3;
    for (let i = 0; i < FLASHES; i++) {
      level[i] *= Math.exp(-dt * 9);
      if (Math.random() < rate * dt * 0.6) level[i] = 1;
      const v = level[i] * 1.6;
      fcol.set([v, v, v * 0.95], i * 3);
    }
    fgeo.getAttribute('color').needsUpdate = true;
  };
  update(0);
  (mesh.userData as { excite?: (k: number) => void }).excite = (k) => (excitement = Math.min(1, excitement + k));
  return { mesh, flashes, update };
}

/** Scrolling LED ribbon ringing the top of the stands. */
function buildLedRibbon(): { mesh: THREE.Mesh; update(t: number): void } {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 32;
  const g = c.getContext('2d')!;
  const cols = ['#c1121f', '#f5c542', '#1d4ed8', '#ffffff'];
  for (let i = 0; i < 16; i++) {
    g.fillStyle = cols[i % 4];
    g.beginPath();
    const x = i * 32;
    g.moveTo(x, 0);
    g.lineTo(x + 20, 0);
    g.lineTo(x + 32, 16);
    g.lineTo(x + 20, 32);
    g.lineTo(x, 32);
    g.lineTo(x + 12, 16);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(10, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, toneMapped: false });
  mat.color.setScalar(0.5);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(13.6, 13.6, 0.4, 96, 1, true), mat);
  mesh.position.y = 3.9;
  return { mesh, update: (t) => (tex.offset.x = (t * 0.08) % 1) };
}

/** Banners hanging from the rafters with original abstract corner art. */
function buildBanners(): { group: THREE.Group; update(t: number): void } {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(1.1, 4.4);
  const styles: [string, string][] = [['#a50f1c', '#f5c542'], ['#173fa8', '#ffffff'], ['#1a1530', '#f5c542'], ['#a50f1c', '#ffffff'], ['#173fa8', '#f5c542']];
  const items: { m: THREE.Mesh; phase: number }[] = [];
  const N = 10;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.PI / N;
    const [base, accent] = styles[i % styles.length];
    const tex = bannerTexture(base, accent, i + 1);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0x666666, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8,
    }));
    const r = 8.2;
    m.position.set(Math.cos(a) * r, 5.5, Math.sin(a) * r);
    m.lookAt(0, 5.5, 0);
    group.add(m);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    bar.position.y = 2.2;
    m.add(bar);
    items.push({ m, phase: Math.random() * 6 });
  }
  return {
    group,
    update(t) {
      for (const it of items) it.m.rotation.z = Math.sin(t * 0.6 + it.phase) * 0.015;
    },
  };
}

/** Square lighting truss over the ring with glowing lamp heads. */
function buildTruss(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.6, metalness: 0.5 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4dc, toneMapped: false });
  const H = 7.5, S = 4.2;
  for (let i = 0; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(S * 2 + 0.3, 0.25, 0.25), metal);
    const along = i % 2 === 0;
    const off = i < 2 ? -S : S;
    beam.position.set(along ? 0 : off, H, along ? off : 0);
    if (!along) beam.rotation.y = Math.PI / 2;
    g.add(beam);
    for (let k = -2; k <= 2; k++) {
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16), lamp);
      head.position.set(along ? k * 1.6 : off, H - 0.2, along ? off : k * 1.6);
      g.add(head);
    }
  }
  return g;
}

export function exciteCrowd(scene: THREE.Scene, k: number): void {
  scene.traverse((o) => (o.userData as { excite?: (k: number) => void }).excite?.(k));
}
