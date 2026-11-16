import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { apronTexture, bannerTexture, floorLogoTexture, glowTexture } from './fx.ts';

export const RING_HALF = 3.2;

const RED = 0xc1121f;
const BLUE = 0x1d4ed8;

/**
 * Bakes each placement of geo into its own copy and merges them into one geometry, so a set of
 * identical static parts sharing a material costs a single draw call.
 */
function mergePlaced(geo: THREE.BufferGeometry, places: ((o: THREE.Object3D) => void)[]): THREE.BufferGeometry {
  const o = new THREE.Object3D();
  const parts = places.map((place) => {
    o.position.set(0, 0, 0);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, 1, 1);
    place(o);
    o.updateMatrix();
    return geo.clone().applyMatrix4(o.matrix);
  });
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('mergePlaced: incompatible geometries');
  for (const p of parts) p.dispose();
  geo.dispose();
  return merged;
}

/** Reorders a box's six face groups so faces sharing a material draw together. */
function groupBoxFaces(geo: THREE.BoxGeometry, faceMats: number[]): THREE.BoxGeometry {
  const index = geo.index!;
  const src = index.array;
  const out = new (src.constructor as Uint16ArrayConstructor)(src.length);
  const groups = geo.groups.slice();
  geo.clearGroups();
  let n = 0;
  for (const m of [...new Set(faceMats)].sort((a, b) => a - b)) {
    const start = n;
    for (const g of groups) {
      if (faceMats[g.materialIndex ?? 0] !== m) continue;
      out.set(src.subarray(g.start, g.start + g.count), n);
      n += g.count;
    }
    geo.addGroup(start, n - start, m);
  }
  geo.setIndex(new THREE.BufferAttribute(out, 1));
  return geo;
}

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
  // Sides use the apron, top and bottom the dark canvas: two draws instead of six.
  const canvas = new THREE.Mesh(
    groupBoxFaces(new THREE.BoxGeometry(RING_HALF * 2 + 0.6, 0.6, RING_HALF * 2 + 0.6), [0, 0, 1, 1, 0, 0]),
    [apronMat, topMat],
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
  // Corners of the same colour share one material and one merged mesh each for posts and pads.
  const byColor = new Map<number, [number, number][]>();
  for (const [x, z, color] of corners) byColor.set(color, [...(byColor.get(color) ?? []), [x, z]]);
  for (const [color, spots] of byColor) {
    const post = new THREE.Mesh(
      mergePlaced(new THREE.CylinderGeometry(0.07, 0.07, 1.5, 12), spots.map(([x, z]) => (o) => o.position.set(x, 0.75, z))),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 }),
    );
    post.castShadow = true;
    scene.add(post);
    const pad = new THREE.Mesh(
      mergePlaced(new THREE.BoxGeometry(0.22, 0.95, 0.22), spots.map(([x, z]) => (o) => {
        o.position.set(x * 0.985, 0.85, z * 0.985);
        o.rotation.y = Math.PI / 4;
      })),
      new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: 0.25 }),
    );
    scene.add(pad);
  }

  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xf2eee4, roughness: 0.5 });
  const ropeRed = new THREE.MeshStandardMaterial({ color: 0xd0141c, roughness: 0.5, emissive: 0x500006 });
  // All twelve ropes merged into one mesh per material (white top and bottom, red middle).
  const ropePlaces = (h: number) => [0, 1, 2, 3].map((side) => (o: THREE.Object3D) => {
    o.rotation.z = Math.PI / 2;
    if (side >= 2) o.rotation.y = Math.PI / 2;
    const off = side % 2 === 0 ? -RING_HALF : RING_HALF;
    if (side < 2) o.position.set(0, h, off);
    else o.position.set(off, h, 0);
  });
  const ropeGeo = () => new THREE.CylinderGeometry(0.025, 0.025, RING_HALF * 2, 8);
  scene.add(
    new THREE.Mesh(mergePlaced(ropeGeo(), [...ropePlaces(0.45), ...ropePlaces(1.25)]), ropeMat),
    new THREE.Mesh(mergePlaced(ropeGeo(), ropePlaces(0.85)), ropeRed),
  );

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
      // Additive and depth-write free, so drawing both faces in one pass looks the same as two.
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, forceSinglePass: true }),
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

  // Everything built so far is static except the swaying banners and the moving rim lights, so
  // compute those local matrices once instead of recomposing them every frame.
  const moving = new Set<THREE.Object3D>([...banners.moving, ...rims.map((r) => r.light)]);
  for (const child of scene.children) {
    child.traverse((o) => {
      if (moving.has(o)) return;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
  }

  return {
    update(t: number) {
      crowd.update(t);
      led.update(t);
      banners.update(t);
      for (let i = 0; i < rims.length; i++) {
        const r = rims[i];
        r.light.position.set(r.base.x + Math.sin(t * 0.4 + i * 2) * 0.8, r.base.y, r.base.z + Math.cos(t * 0.33 + i) * 0.8);
        r.light.intensity = 30 + Math.sin(t * 1.7 + i * 3) * 4;
      }
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
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    // Only the y translation changes after the first frame, so write it straight into the buffer.
    const im = mesh.instanceMatrix.array;
    const speed = 2 + excitement * 6;
    const amp = 0.03 + excitement * 0.25;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const bob = Math.max(0, Math.sin(t * speed + s.phase)) * amp;
      im[i * 16 + 13] = s.y + bob;
    }
    mesh.instanceMatrix.needsUpdate = true;
    const rate = 0.25 + excitement * 3;
    const decay = Math.exp(-dt * 9);
    for (let i = 0; i < FLASHES; i++) {
      level[i] *= decay;
      if (Math.random() < rate * dt * 0.6) level[i] = 1;
      const v = level[i] * 1.6;
      fcol[i * 3] = v;
      fcol[i * 3 + 1] = v;
      fcol[i * 3 + 2] = v * 0.95;
    }
    fgeo.getAttribute('color').needsUpdate = true;
  };
  seats.forEach((s, i) => mesh.setMatrixAt(i, m.makeTranslation(s.x, s.y, s.z)));
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
function buildBanners(): { group: THREE.Group; moving: THREE.Object3D[]; update(t: number): void } {
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
      // A flat banner never overlaps itself, so one double-sided pass matches the default two-pass draw.
      forceSinglePass: true,
    }));
    const r = 8.2;
    m.position.set(Math.cos(a) * r, 5.5, Math.sin(a) * r);
    m.lookAt(0, 5.5, 0);
    group.add(m);
    items.push({ m, phase: Math.random() * 6 });
  }
  // The hanging bars ride on their swaying banners; one instanced draw covers all ten.
  const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x222222 }), N);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(bars);
  const barLocal = new THREE.Matrix4().makeTranslation(0, 2.2, 0);
  const barM = new THREE.Matrix4();
  const sync = () => {
    for (let i = 0; i < N; i++) {
      const { m } = items[i];
      m.updateMatrix();
      bars.setMatrixAt(i, barM.multiplyMatrices(m.matrix, barLocal));
    }
    bars.instanceMatrix.needsUpdate = true;
  };
  for (const { m } of items) m.matrixAutoUpdate = false;
  sync();
  // The sway moves each bar by a few centimetres at most; pad the bounds so culling stays safe.
  bars.computeBoundingSphere();
  bars.boundingSphere!.radius += 0.25;
  return {
    group,
    moving: items.map((it) => it.m),
    update(t) {
      for (const it of items) it.m.rotation.z = Math.sin(t * 0.6 + it.phase) * 0.015;
      sync();
    },
  };
}

/** Square lighting truss over the ring with glowing lamp heads. */
function buildTruss(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2a33, roughness: 0.6, metalness: 0.5 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4dc, toneMapped: false });
  const H = 7.5, S = 4.2;
  const beams: ((o: THREE.Object3D) => void)[] = [];
  const heads: ((o: THREE.Object3D) => void)[] = [];
  for (let i = 0; i < 4; i++) {
    const along = i % 2 === 0;
    const off = i < 2 ? -S : S;
    beams.push((o) => {
      o.position.set(along ? 0 : off, H, along ? off : 0);
      if (!along) o.rotation.y = Math.PI / 2;
    });
    for (let k = -2; k <= 2; k++) heads.push((o) => o.position.set(along ? k * 1.6 : off, H - 0.2, along ? off : k * 1.6));
  }
  // Four beams and twenty lamp heads, merged into one mesh each.
  g.add(
    new THREE.Mesh(mergePlaced(new THREE.BoxGeometry(S * 2 + 0.3, 0.25, 0.25), beams), metal),
    new THREE.Mesh(mergePlaced(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16), heads), lamp),
  );
  return g;
}

export function exciteCrowd(scene: THREE.Scene, k: number): void {
  scene.traverse((o) => (o.userData as { excite?: (k: number) => void }).excite?.(k));
}
