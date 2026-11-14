import type { DefenseState, Hand, Punch, PunchType, Stance, Target } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { Calibration } from './calibration.ts';
import { HAND_IDX, L, angle3, dist2, dist3, mid, type Lm, type PoseFrame } from './frame.ts';

export interface HandFeatures {
  /** Shoulder-to-wrist 3D distance over calibrated arm length. */
  reach: number;
  elbow: number;
  /** Wrist z ahead of the shoulder (toward the camera), in sw. */
  zAhead: number;
  /** On-screen hand size relative to calibration (1 = same as at guard). */
  scale: number;
  /** Wrist height relative to the shoulder line in sw (negative is above). */
  y: number;
  /** Wrist distance to the nose in sw. */
  headDist: number;
  /** Velocity in sw/s: toward the camera, toward the body midline, upward. */
  vFwd: number;
  vIn: number;
  vUp: number;
  speed: number;
}

export interface Features {
  left: HandFeatures;
  right: HandFeatures;
  headDx: number;
  headDy: number;
  chinY: number;
}

interface Active {
  startT: number;
  start: HandFeatures;
  startImg: Lm;
  startZ: number;
  maxSpeed: number;
  maxUp: number;
  travel: number;
  peakScore: number;
  peak: { t: number; f: HandFeatures; img: Lm; z: number; travel: number } | null;
}

interface HandState {
  mode: 'ready' | 'active' | 'locked';
  active: Active | null;
  lastFire: number;
  prev: { img: Lm; z: number; t: number } | null;
}

export interface ClassifierOutput {
  punches: (Punch & { at: number })[];
  defense: DefenseState;
  features: Features | null;
  /** Explanation of the last punch decision, for ?debug=1. */
  last: string | null;
}

const sideSign = (h: Hand) => (h === 'left' ? 1 : -1);

/**
 * Rule-based punch and defense classifier. Feed it one tracked frame at a time. A punch fires
 * once, at peak extension, then the hand stays locked until it returns to guard and its
 * cooldown has passed.
 */
export class Classifier {
  stance: Stance = 'orthodox';
  gassed = false;
  canPunch = true;
  private hands: Record<Hand, HandState> = { left: newHand(), right: newHand() };
  private smooth: PoseFrame | null = null;
  private lastDecision: string | null = null;

  constructor(private cal: Calibration) {}

  setCalibration(cal: Calibration): void {
    this.cal = cal;
  }

  update(raw: PoseFrame): ClassifierOutput {
    const f = this.smoothFrame(raw);
    const sw = dist2(f.img[L.lShoulder], f.img[L.rShoulder]) || this.cal.swImg;
    const shoulderY = mid(f.img[L.lShoulder], f.img[L.rShoulder]).y;
    const nose = f.img[L.nose];
    const chinY = (nose.y + (shoulderY - nose.y) * 0.45 - shoulderY) / sw;
    const punches: ClassifierOutput['punches'] = [];
    const feats = {} as Record<Hand, HandFeatures>;

    for (const hand of ['left', 'right'] as Hand[]) {
      const idx = HAND_IDX[hand];
      const st = this.hands[hand];
      const w = f.img[idx.wrist];
      const wz = f.world[idx.wrist].z;
      const dt = st.prev ? (f.t - st.prev.t) / 1000 : 0;
      const s = sideSign(hand);
      let vIn = 0, vUp = 0, vFwd = 0;
      if (st.prev && dt > 0) {
        vIn = (-s * (w.x - st.prev.img.x)) / sw / dt;
        vUp = (-(w.y - st.prev.img.y)) / sw / dt;
        vFwd = (-(wz - st.prev.z)) / this.cal.swWorld / dt;
      }
      st.prev = { img: { ...w }, z: wz, t: f.t };
      const hf: HandFeatures = {
        reach: dist3(f.world[idx.shoulder], f.world[idx.wrist]) / this.cal.armWorld,
        elbow: angle3(f.world[idx.shoulder], f.world[idx.elbow], f.world[idx.wrist]),
        zAhead: (f.world[idx.shoulder].z - wz) / this.cal.swWorld,
        scale: dist2(w, f.img[idx.index]) / sw / this.cal.handSize[hand],
        y: (w.y - shoulderY) / sw,
        headDist: dist2(w, nose) / sw,
        vFwd, vIn, vUp,
        speed: Math.hypot(vIn, vUp, vFwd),
      };
      feats[hand] = hf;
      const p = this.stepHand(hand, st, hf, w, wz, f.t, chinY, sw);
      if (p) punches.push(p);
    }

    const d = CONFIG.defense;
    const headDx = (nose.x - this.cal.noseX) / this.cal.swImg;
    const headDy = (nose.y - this.cal.noseY) / this.cal.swImg;
    const inGuard = (h: Hand) =>
      this.hands[h].mode !== 'active' && feats[h].y < d.guardMaxY && feats[h].headDist < d.guardMaxHeadDist && feats[h].speed < d.guardMaxSpeed;
    const defense: DefenseState = {
      guard: inGuard('left') && inGuard('right'),
      duck: headDy > d.duckDrop,
      slip: headDx > d.slipShift ? 'left' : headDx < -d.slipShift ? 'right' : 'none',
    };
    return { punches, defense, features: { left: feats.left, right: feats.right, headDx, headDy, chinY }, last: this.lastDecision };
  }

  private smoothFrame(raw: PoseFrame): PoseFrame {
    const prev = this.smooth;
    if (!prev) return (this.smooth = clone(raw));
    const a = CONFIG.smoothing.image, b = CONFIG.smoothing.worldZ;
    const mix = (p: Lm, r: Lm, k: number, kz: number): Lm => ({
      x: p.x + (r.x - p.x) * k, y: p.y + (r.y - p.y) * k, z: p.z + (r.z - p.z) * kz, v: r.v,
    });
    this.smooth = {
      t: raw.t,
      img: raw.img.map((r, i) => mix(prev.img[i], r, a, a)),
      world: raw.world.map((r, i) => mix(prev.world[i], r, a, b)),
    };
    return this.smooth;
  }

  private stepHand(hand: Hand, st: HandState, f: HandFeatures, img: Lm, z: number, t: number, chinY: number, sw: number): (Punch & { at: number }) | null {
    const c = CONFIG.punch;
    const cooldown = this.gassed ? c.gassedCooldownMs : c.cooldownMs;
    if (st.mode === 'locked') {
      const home = f.headDist < c.returnHeadDist && f.y < c.returnMaxY;
      if (home && t - st.lastFire >= cooldown) st.mode = 'ready';
      return null;
    }
    if (st.mode === 'ready') {
      if (f.speed < c.startSpeed || !this.canPunch) return null;
      st.mode = 'active';
      st.active = { startT: t, start: f, startImg: { ...img }, startZ: z, maxSpeed: f.speed, maxUp: 0, travel: 0, peakScore: -Infinity, peak: null };
    }
    const a = st.active!;
    a.maxSpeed = Math.max(a.maxSpeed, f.speed);
    a.maxUp = Math.max(a.maxUp, f.vUp);
    a.travel = Math.max(a.travel, Math.hypot(img.x - a.startImg.x, img.y - a.startImg.y) / sw + Math.max(0, a.startZ - z) / this.cal.swWorld);
    const score = this.extensionScore(f, a, img, z, sw);
    if (score > a.peakScore) {
      a.peakScore = score;
      a.peak = { t, f, img: { ...img }, z, travel: a.travel };
    }
    const stopped = f.speed < a.maxSpeed * c.stopFraction;
    const tooLong = t - a.startT > c.maxDurationMs;
    if (!stopped && !tooLong) return null;

    st.active = null;
    const punch = this.classify(hand, a, chinY, sw);
    if (!punch) {
      st.mode = 'ready';
      return null;
    }
    st.mode = 'locked';
    st.lastFire = t;
    return { ...punch, at: a.peak!.t };
  }

  /** Peak detection metric: how far out the hand is, counting depth and on-screen growth. */
  private extensionScore(f: HandFeatures, a: Active, img: Lm, z: number, sw: number): number {
    const flat = Math.hypot(img.x - a.startImg.x, img.y - a.startImg.y) / sw;
    return f.reach + (a.startZ - z) / this.cal.swWorld + Math.max(0, f.scale - 1) + flat * 0.5;
  }

  private classify(hand: Hand, a: Active, chinY: number, sw: number): Punch | null {
    const p = a.peak;
    if (!p) return null;
    const pf = p.f;
    const dIn = (-sideSign(hand) * (p.img.x - a.startImg.x)) / sw;
    const rise = (a.startImg.y - p.img.y) / sw;
    const fwd = (a.startZ - p.z) / this.cal.swWorld;
    const w = CONFIG.straight.weights;
    const forward = w.z * fwd + w.scale * Math.max(0, pf.scale - a.start.scale) + w.travel * p.travel;
    const target: Target = pf.y < CONFIG.punch.headBodySplit ? 'head' : 'body';
    const fmt = (n: number) => n.toFixed(2);
    const info = `${hand} elbow=${pf.elbow.toFixed(0)} fwd=${fmt(forward)} in=${fmt(dIn)} rise=${fmt(rise)} y=${fmt(pf.y)} travel=${fmt(p.travel)}`;

    if (p.travel < CONFIG.punch.minTravel) {
      this.lastDecision = `none (short) ${info}`;
      return null;
    }
    const u = CONFIG.uppercut;
    const h = CONFIG.hook;
    const s = CONFIG.straight;
    let type: PunchType | null = null;
    if (a.start.y > chinY + u.startBelowChin && rise > u.minRise && pf.elbow < u.maxElbow && a.maxUp > u.minUpSpeed && rise > Math.abs(dIn)) {
      type = hand === 'left' ? 'leftUppercut' : 'rightUppercut';
    } else if (pf.elbow >= h.minElbow && pf.elbow <= h.maxElbow && pf.y > h.minY && pf.y < h.maxY && dIn > h.minSweep) {
      type = hand === 'left' ? 'leftHook' : 'rightHook';
    } else if ((pf.elbow > s.minElbow && forward > s.minForward) || forward > s.strongForward) {
      const lead: Hand = this.stance === 'orthodox' ? 'left' : 'right';
      type = hand === lead ? 'jab' : 'cross';
    }
    this.lastDecision = `${type ?? 'none'} ${type ? target : ''} ${info}`;
    return type ? { type, hand, target } : null;
  }
}

function newHand(): HandState {
  return { mode: 'ready', active: null, lastFire: -Infinity, prev: null };
}

function clone(f: PoseFrame): PoseFrame {
  return { t: f.t, img: f.img.map((p) => ({ ...p })), world: f.world.map((p) => ({ ...p })) };
}
