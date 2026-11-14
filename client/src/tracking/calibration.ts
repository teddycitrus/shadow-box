import { CONFIG } from '../config.ts';
import { HAND_IDX, L, dist2, dist3, mid, type PoseFrame } from './frame.ts';

export interface Calibration {
  /** Shoulder width in image units (frame heights). */
  swImg: number;
  /** Shoulder width in world metres. */
  swWorld: number;
  /** Upper arm plus forearm, world metres. */
  armWorld: number;
  noseX: number;
  noseY: number;
  /** Wrist-to-index distance over shoulder width, per hand, at guard. */
  handSize: { left: number; right: number };
}

const REQUIRED = [L.nose, L.lShoulder, L.rShoulder, L.lElbow, L.rElbow, L.lWrist, L.rWrist];

/** Returns null when framing is good, otherwise the instruction to show. */
export function framingCheck(f: PoseFrame | null): string | null {
  const c = CONFIG.framing;
  if (!f) return 'Step into view';
  const missing = REQUIRED.filter((i) => f.img[i].v < c.minVisibility);
  const sw = dist2(f.img[L.lShoulder], f.img[L.rShoulder]);
  if (f.img[L.nose].v < c.minVisibility || f.img[L.nose].y < c.minNoseY) return 'Raise the camera';
  if (sw > c.maxShoulderWidth) return 'Step back';
  if (missing.length) {
    const wristsOrElbows = missing.every((i) => i >= L.lElbow);
    return wristsOrElbows && sw > c.minShoulderWidth * 1.6 ? 'Step back' : 'Raise the camera';
  }
  if (sw < c.minShoulderWidth) return 'Move closer';
  return null;
}

/** Loose guard check usable before calibration: both wrists up near the face. */
export function looksLikeGuard(f: PoseFrame): boolean {
  const sw = dist2(f.img[L.lShoulder], f.img[L.rShoulder]);
  const shY = mid(f.img[L.lShoulder], f.img[L.rShoulder]).y;
  return (['left', 'right'] as const).every((h) => {
    const w = f.img[HAND_IDX[h].wrist];
    return w.y < shY && dist2(w, f.img[L.nose]) < CONFIG.calibration.guardMaxHeadDist * sw;
  });
}

export type CalibrationStatus =
  | { stage: 'framing'; message: string }
  | { stage: 'hold'; message: string; progress: number }
  | { stage: 'done'; cal: Calibration };

/** Collects 2 s of a still guard and averages body measurements from it. */
export class Calibrator {
  private samples: PoseFrame[] = [];
  private done: Calibration | null = null;

  reset(): void {
    this.samples = [];
    this.done = null;
  }

  update(f: PoseFrame | null): CalibrationStatus {
    if (this.done) return { stage: 'done', cal: this.done };
    const msg = framingCheck(f);
    if (msg || !f) {
      this.samples = [];
      return { stage: 'framing', message: msg ?? 'Step into view' };
    }
    if (!looksLikeGuard(f)) {
      this.samples = [];
      return { stage: 'hold', message: 'Raise your guard and hold still', progress: 0 };
    }
    const first = this.samples[0];
    if (first) {
      const sw = dist2(f.img[L.lShoulder], f.img[L.rShoulder]);
      const moved = Math.max(
        dist2(f.img[L.lWrist], first.img[L.lWrist]),
        dist2(f.img[L.rWrist], first.img[L.rWrist]),
      ) / sw;
      if (moved > CONFIG.calibration.maxWristJitter) this.samples = [];
    }
    this.samples.push(f);
    const progress = Math.min(1, (f.t - this.samples[0].t) / CONFIG.calibration.holdMs);
    if (progress < 1) return { stage: 'hold', message: 'Hold your guard', progress };
    this.done = measure(this.samples);
    return { stage: 'done', cal: this.done };
  }
}

export function measure(frames: PoseFrame[]): Calibration {
  const avg = (fn: (f: PoseFrame) => number) => frames.reduce((s, f) => s + fn(f), 0) / frames.length;
  const swImg = avg((f) => dist2(f.img[L.lShoulder], f.img[L.rShoulder]));
  const arm = (f: PoseFrame, h: 'left' | 'right') =>
    dist3(f.world[HAND_IDX[h].shoulder], f.world[HAND_IDX[h].elbow]) + dist3(f.world[HAND_IDX[h].elbow], f.world[HAND_IDX[h].wrist]);
  const hand = (f: PoseFrame, h: 'left' | 'right') =>
    dist2(f.img[HAND_IDX[h].wrist], f.img[HAND_IDX[h].index]) / dist2(f.img[L.lShoulder], f.img[L.rShoulder]);
  return {
    swImg,
    swWorld: avg((f) => dist3(f.world[L.lShoulder], f.world[L.rShoulder])),
    armWorld: avg((f) => (arm(f, 'left') + arm(f, 'right')) / 2),
    noseX: avg((f) => f.img[L.nose].x),
    noseY: avg((f) => f.img[L.nose].y),
    handSize: { left: avg((f) => hand(f, 'left')), right: avg((f) => hand(f, 'right')) },
  };
}
