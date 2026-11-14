import * as THREE from 'three';

export const RING_HALF = 3.2;

/** Night arena: ring with ropes and corner posts, dark tiered crowd, spotlights and fog. */
export function buildArena(scene: THREE.Scene): { update(t: number): void } {
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x05060a, 9, 26);
  scene.add(new THREE.HemisphereLight(0x3a4a70, 0x080808, 0.35));

  const canvas = new THREE.Mesh(
    new THREE.BoxGeometry(RING_HALF * 2 + 0.6, 0.6, RING_HALF * 2 + 0.6),
    new THREE.MeshStandardMaterial({ color: 0x2c3e66, roughness: 0.9 }),
  );
  canvas.position.y = -0.3;
  canvas.receiveShadow = true;
  scene.add(canvas);

  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(RING_HALF * 2 - 0.2, RING_HALF * 2 - 0.2),
    new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.95 }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.position.y = 0.002;
  mat.receiveShadow = true;
  scene.add(mat);

  const logo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 48), new THREE.MeshStandardMaterial({ color: 0x9b2226, roughness: 0.9 }));
  logo.rotation.x = -Math.PI / 2;
  logo.position.y = 0.004;
  scene.add(logo);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x0b0b0e, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  scene.add(floor);

  const corners: [number, number, number][] = [
    [-RING_HALF, -RING_HALF, 0xc1121f], [RING_HALF, RING_HALF, 0x1d4ed8],
    [RING_HALF, -RING_HALF, 0xdddddd], [-RING_HALF, RING_HALF, 0xdddddd],
  ];
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 12);
  for (const [x, z, color] of corners) {
    const post = new THREE.Mesh(postGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
    post.position.set(x, 0.75, z);
    post.castShadow = true;
    scene.add(post);
  }

  const ropeMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.6 });
  const ropeRed = new THREE.MeshStandardMaterial({ color: 0xa4161a, roughness: 0.6 });
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
  scene.add(crowd.mesh);

  const spots: THREE.SpotLight[] = [];
  for (const [x, z, c, k] of [[0, 0, 0xfff1d6, 60], [-4, -3, 0x9db4ff, 25], [4, 3, 0xffc0a0, 25]] as const) {
    const s = new THREE.SpotLight(c, k, 20, Math.PI / 7, 0.5, 1.2);
    s.position.set(x, 9, z);
    s.target.position.set(0, 0, 0);
    s.castShadow = x === 0;
    s.shadow.mapSize.set(1024, 1024);
    scene.add(s, s.target);
    spots.push(s);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(Math.tan(Math.PI / 7) * 9, 9, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    );
    cone.position.set(x * 0.5, 4.5, z * 0.5);
    cone.lookAt(0, 0, 0);
    cone.rotateX(-Math.PI / 2);
    scene.add(cone);
  }

  return {
    update(t: number) {
      crowd.update(t);
      spots[1].position.x = -4 + Math.sin(t * 0.3) * 1.5;
      spots[2].position.z = 3 + Math.cos(t * 0.25) * 1.5;
    },
  };
}

function buildCrowd(): { mesh: THREE.InstancedMesh; update(t: number): void } {
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
  seats.forEach((_, i) => mesh.setColorAt(i, color.setHSL(0.6 + Math.random() * 0.1, 0.15, 0.06 + Math.random() * 0.08)));
  const m = new THREE.Matrix4();
  let excitement = 0;
  const update = (t: number) => {
    excitement *= 0.98;
    seats.forEach((s, i) => {
      const bob = Math.max(0, Math.sin(t * (2 + excitement * 6) + s.phase)) * (0.03 + excitement * 0.25);
      m.makeTranslation(s.x, s.y + bob, s.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  (mesh.userData as { excite?: (k: number) => void }).excite = (k) => (excitement = Math.min(1, excitement + k));
  return { mesh, update };
}

export function exciteCrowd(scene: THREE.Scene, k: number): void {
  scene.traverse((o) => (o.userData as { excite?: (k: number) => void }).excite?.(k));
}
