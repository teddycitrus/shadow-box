export interface Lm {
  x: number;
  y: number;
  z: number;
  v: number;
}

/**
 * One tracked frame. `img` is MediaPipe normalized image space with x multiplied by the frame
 * aspect ratio, so x and y share a unit (the frame height). `world` is MediaPipe world space in
 * metres. Both use the full 33-point Pose topology.
 */
export interface PoseFrame {
  t: number;
  img: Lm[];
  world: Lm[];
}

export const L = {
  nose: 0, lEar: 7, rEar: 8, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14,
  lWrist: 15, rWrist: 16, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24,
} as const;

export const HAND_IDX = {
  left: { shoulder: L.lShoulder, elbow: L.lElbow, wrist: L.lWrist, index: L.lIndex },
  right: { shoulder: L.rShoulder, elbow: L.rElbow, wrist: L.rWrist, index: L.rIndex },
} as const;

export function dist2(a: Lm, b: Lm): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist3(a: Lm, b: Lm): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Interior angle at b in degrees. */
export function angle3(a: Lm, b: Lm, c: Lm): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const vx = c.x - b.x, vy = c.y - b.y, vz = c.z - b.z;
  const d = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  if (d === 0) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / d))) * 180) / Math.PI;
}

export function mid(a: Lm, b: Lm): Lm {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, v: Math.min(a.v, b.v) };
}
