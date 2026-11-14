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

/** One completed hand motion, measured from its start to its peak extension. */
export interface Segment {
  hand: Hand;
  startT: number;
  peakT: number;
  endT: number;
  /** Displacement start to peak, in sw: toward the midline, upward, toward the camera (world z). */
  dIn: number;
  rise: number;
  fwd: number;
  /** Combined forward evidence: depth, hand growth on screen, distance travelled. */
  forward: number;
  elbow: number;
  startElbow: number;
  startY: number;
  peakY: number;
  chinY: number;
  startHead: number;
  peakHead: number;
  scaleGain: number;
  travel: number;
  maxSpeed: number;
  maxUp: number;
  reach: number;
  startReach: number;
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
  lastMotion: number;
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
  /** Called for every completed motion, punch or not. */
  onSegment?: (s: Segment) => void;
  /** Optional learned decision; returning undefined falls back to the rules. */
  model?: (s: Segment) => Punch | null | undefined;
  private hands: Record<Hand, HandState> = { left: newHand(), right: newHand() };
  private smooth: PoseFrame | null = null;
  private lastDecision: string | null = null;
  /** Neutral head position; follows slow drift so stepping around does not read as a slip. */
  private base: { x: number; y: number };
  private lastT: number | null = null;
  private wasGuard = false;
  /** Head offsets in sw that count as a duck or slip; the guided calibration personalizes them. */
  defenseThresholds: { duck: number; slipLeft: number; slipRight: number } = {
    duck: CONFIG.defense.duckDrop, slipLeft: CONFIG.defense.slipShift, slipRight: CONFIG.defense.slipShift,
  };

  constructor(private cal: Calibration) {
    this.base = { x: cal.noseX, y: cal.noseY };
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
    const th = this.defenseThresholds;
    const headDx = (nose.x - this.base.x) / this.cal.swImg;
    const headDy = (nose.y - this.base.y) / this.cal.swImg;
    if (this.lastT !== null) {
      const k = 1 - Math.exp(-(f.t - this.lastT) / d.neutralDriftMs);
      if (Math.abs(headDx) < th.slipLeft * 0.5 && Math.abs(headDx) < th.slipRight * 0.5) this.base.x += (nose.x - this.base.x) * k;
      if (Math.abs(headDy) < th.duck * 0.5) this.base.y += (nose.y - this.base.y) * k;
    }
    this.lastT = f.t;
    const gy = this.cal.guardY !== undefined ? Math.max(d.guardMaxY, this.cal.guardY + d.guardSlack) : d.guardMaxY;
    const gh = this.cal.guardHead !== undefined ? Math.max(d.guardMaxHeadDist, this.cal.guardHead + d.guardSlack) : d.guardMaxHeadDist;
    const hold = this.wasGuard ? d.guardHysteresis : 0;
    const inGuard = (h: Hand) =>
      this.hands[h].mode !== 'active' && feats[h].y < gy + hold && feats[h].headDist < gh + hold && feats[h].speed < d.guardMaxSpeed * (this.wasGuard ? 1.6 : 1);
    const punching = (['left', 'right'] as Hand[]).some((h) => f.t - this.hands[h].lastMotion < d.slipAfterPunchMs);
    const defense: DefenseState = {
      guard: inGuard('left') && inGuard('right'),
      duck: headDy > th.duck,
      slip: punching ? 'none' : headDx > th.slipLeft ? 'left' : headDx < -th.slipRight ? 'right' : 'none',
    };
    this.wasGuard = defense.guard;
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
      if (f.speed < c.startSpeed) return null;
      st.mode = 'active';
      st.active = { startT: t, start: f, startImg: { ...img }, startZ: z, maxSpeed: f.speed, maxUp: 0, travel: 0, peakScore: -Infinity, peak: null };
    }
    const a = st.active!;
    st.lastMotion = t;
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
    const punch = this.classify(hand, a, chinY, sw, t);
    if (!punch || !this.canPunch) {
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

  private classify(hand: Hand, a: Active, chinY: number, sw: number, endT: number): Punch | null {
    const p = a.peak;
    if (!p) return null;
    const pf = p.f;
    const dIn = (-sideSign(hand) * (p.img.x - a.startImg.x)) / sw;
    const rise = (a.startImg.y - p.img.y) / sw;
    const fwd = (a.startZ - p.z) / this.cal.swWorld;
    const w = CONFIG.straight.weights;
    const forward = w.z * fwd + w.scale * Math.max(0, pf.scale - a.start.scale) + w.travel * p.travel;
    const fmt = (n: number) => n.toFixed(2);
    const info = `${hand} elbow=${pf.elbow.toFixed(0)} fwd=${fmt(forward)} in=${fmt(dIn)} rise=${fmt(rise)} y=${fmt(pf.y)} travel=${fmt(p.travel)}`;
    const seg: Segment = {
      hand, startT: a.startT, peakT: p.t, endT, dIn, rise, fwd, forward,
      elbow: pf.elbow, startElbow: a.start.elbow, startY: a.start.y, peakY: pf.y, chinY,
      startHead: a.start.headDist, peakHead: pf.headDist, scaleGain: pf.scale - a.start.scale,
      travel: p.travel, maxSpeed: a.maxSpeed, maxUp: a.maxUp, reach: pf.reach, startReach: a.start.reach,
    };
    this.onSegment?.(seg);
    if (!passesGate(seg)) {
      this.lastDecision = `none (${seg.travel < CONFIG.punch.minTravel ? 'short' : 'arm did not extend'}) ${info}`;
      return null;
    }
    if (this.model) {
      const m = this.model(seg);
      if (m !== undefined) {
        this.lastDecision = `${m ? `${m.type} ${m.target}` : 'none'} (model) ${info}`;
        return m;
      }
    }

    const r = ruleDecision(seg, this.stance);
    this.lastDecision = `${r ? `${r.type} ${r.target}` : seg.travel < CONFIG.punch.minTravel ? 'none (short)' : 'none'} ${info}`;
    return r;
  }
}

/** Camera-independent punch gate: enough travel and the arm opens up. */
export function passesGate(seg: Segment): boolean {
  return seg.travel >= CONFIG.punch.minTravel && seg.elbow - seg.startElbow >= CONFIG.gate.minElbowOpen;
}

/** The hand-written rules: decides a punch from one motion segment, or null. */
export function ruleDecision(seg: Segment, stance: Stance): Punch | null {
  if (seg.travel < CONFIG.punch.minTravel) return null;
  const { hand } = seg;
  const u = CONFIG.uppercut;
  const h = CONFIG.hook;
  const s = CONFIG.straight;
  const target: Target = seg.peakY < CONFIG.punch.headBodySplit ? 'head' : 'body';
  let type: PunchType | null = null;
  if (seg.startY > seg.chinY + u.startBelowChin && seg.rise > u.minRise && seg.elbow < u.maxElbow && seg.maxUp > u.minUpSpeed && seg.rise > Math.abs(seg.dIn)) {
    type = hand === 'left' ? 'leftUppercut' : 'rightUppercut';
  } else if (seg.elbow >= h.minElbow && seg.elbow <= h.maxElbow && seg.peakY > h.minY && seg.peakY < h.maxY && seg.dIn > h.minSweep) {
    type = hand === 'left' ? 'leftHook' : 'rightHook';
  } else if ((seg.elbow > s.minElbow && seg.forward > s.minForward) || seg.forward > s.strongForward) {
    const lead: Hand = stance === 'orthodox' ? 'left' : 'right';
    type = hand === lead ? 'jab' : 'cross';
  }
  return type ? { type, hand, target } : null;
}

function newHand(): HandState {
  return { mode: 'ready', active: null, lastFire: -Infinity, lastMotion: -Infinity, prev: null };
}

function clone(f: PoseFrame): PoseFrame {
  return { t: f.t, img: f.img.map((p) => ({ ...p })), world: f.world.map((p) => ({ ...p })) };
}
