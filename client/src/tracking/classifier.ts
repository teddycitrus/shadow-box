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

/** A 2D point in a hand's own frame: origin between the shoulders, in sw, x toward the body midline (mirrored per hand), y up. */
export interface P2 {
  x: number;
  y: number;
}

/** One frame of a hand's motion, in its own frame. */
export interface PathPoint extends P2 {
  t: number;
  /** Elbow position, same frame. */
  ex: number;
  ey: number;
  /** On-screen hand size relative to calibration. */
  s: number;
}

/**
 * One completed hand motion: an excursion away from where the hand was resting, measured from
 * the rest position to the furthest point (the peak). Retractions move back toward the rest
 * position, so they never form a segment of their own.
 */
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
  /** Furthest on-screen distance from the rest position, in sw. */
  travel: number;
  maxSpeed: number;
  maxUp: number;
  reach: number;
  startReach: number;
  /** Whether the hand started from (near) the player's calibrated guard position. */
  fromGuard: boolean;
  /** Rest position, peak position, and the nose, in the hand's own frame. */
  start: PathPoint;
  peak: PathPoint;
  nose: P2;
  /** Every frame from the rest position to the peak (inclusive), plus up to two frames after. */
  path: PathPoint[];
  /** How far the other hand moved over the same time, in sw (both hands moving together is not a punch). */
  other: number;
  /** The other hand's vertical move over the same time, in sw (up is positive). */
  otherRise: number;
  /** Head drop from start to peak, in sw (body shots often bend the knees). */
  headDrop: number;
}

interface Sample {
  t: number;
  p: PathPoint;
  f: HandFeatures;
  img: Lm;
  z: number;
  nose: P2;
}

interface Active {
  startIdx: number;
  anchor: P2;
  maxD: number;
  peakIdx: number;
  maxSpeed: number;
  maxUp: number;
  maxElbow: number;
  stall: number;
}

interface HandState {
  mode: 'ready' | 'active' | 'returning';
  /** Where the hand is resting; motions are measured from here. */
  anchor: P2 | null;
  buf: Sample[];
  active: Active | null;
  /** Peak distance and direction of the last motion, for the return check. */
  lastMax: number;
  lastDir: P2;
  lastFire: number;
  lastMotion: number;
  lastIgnored: number;
  stillSince: number;
  /** A fired punch locks the hand until it comes back; a non-punch only waits for it to settle. */
  fired: boolean;
}

export interface ClassifierOutput {
  punches: (Punch & { at: number })[];
  defense: DefenseState;
  features: Features | null;
  /** Explanation of the last punch decision, for ?debug=1. */
  last: string | null;
}

const sideSign = (h: Hand) => (h === 'left' ? 1 : -1);
const BUF_MS = 900;

/**
 * Punch and defense classifier. Feed it one tracked frame at a time. Each hand's motion is
 * measured from where the hand was resting; a punch fires once, at the furthest point of the
 * motion, then the hand has to come back (or settle somewhere new) before it can punch again.
 */
export class Classifier {
  stance: Stance = 'orthodox';
  gassed = false;
  canPunch = true;
  /** Called for every completed motion, punch or not. */
  onSegment?: (s: Segment) => void;
  /** Called with every motion and what was decided for it (debug logging). */
  onDecision?: (s: Segment, p: Punch | null, why: string) => void;
  /** Called when a locked hand moves fast and the motion is ignored (debug logging). */
  onIgnored?: (hand: Hand, t: number, why: string) => void;
  /** Optional learned decision; returning undefined falls back to the rules. */
  model?: (s: Segment) => Punch | null | undefined;
  private hands: Record<Hand, HandState> = { left: newHand(), right: newHand() };
  private smooth: PoseFrame | null = null;
  private lastDecision: string | null = null;
  /** Neutral head position; follows slow drift so stepping around does not read as a slip. */
  private base: { x: number; y: number };
  private lastT: number | null = null;
  private wasGuard = false;
  private sw: number;
  /** Defense thresholds in sw that count as a duck or slip; the guided calibration personalizes them. */
  defenseThresholds: { duck: number; slipLeft: number; slipRight: number } = {
    duck: CONFIG.defense.duckDrop, slipLeft: CONFIG.defense.slipShift, slipRight: CONFIG.defense.slipShift,
  };

  constructor(private cal: Calibration) {
    this.base = { x: cal.noseX, y: cal.noseY };
    this.sw = cal.swImg;
  }

  update(raw: PoseFrame): ClassifierOutput {
    const prevT = this.smooth?.t ?? null;
    const f = this.smoothFrame(raw);
    const swNow = dist2(f.img[L.lShoulder], f.img[L.rShoulder]) || this.cal.swImg;
    // Shoulder width shrinks when the torso turns into a cross; follow it slowly so punches do not rescale themselves.
    if (prevT !== null) this.sw += (swNow - this.sw) * (1 - Math.exp(-Math.max(0, f.t - prevT) / CONFIG.punch.swFollowMs));
    const sw = this.sw;
    const neck = mid(f.img[L.lShoulder], f.img[L.rShoulder]);
    const shoulderY = neck.y;
    const nose = f.img[L.nose];
    const chinY = (nose.y + (shoulderY - nose.y) * 0.45 - shoulderY) / sw;
    const punches: ClassifierOutput['punches'] = [];
    const feats = {} as Record<Hand, HandFeatures>;
    const samples = {} as Record<Hand, Sample>;

    for (const hand of ['left', 'right'] as Hand[]) {
      const idx = HAND_IDX[hand];
      const st = this.hands[hand];
      const w = f.img[idx.wrist];
      const e = f.img[idx.elbow];
      const wz = f.world[idx.wrist].z;
      const s = sideSign(hand);
      const loc = (q: Lm): P2 => ({ x: (-s * (q.x - neck.x)) / sw, y: -(q.y - neck.y) / sw });
      const prev = st.buf.at(-1);
      const dt = prev ? (f.t - prev.t) / 1000 : 0;
      let vIn = 0, vUp = 0, vFwd = 0;
      const pw = loc(w);
      if (prev && dt > 0) {
        vIn = (pw.x - prev.p.x) / dt;
        vUp = (pw.y - prev.p.y) / dt;
        vFwd = (-(wz - prev.z)) / this.cal.swWorld / dt;
      }
      const hf: HandFeatures = {
        reach: dist3(f.world[idx.shoulder], f.world[idx.wrist]) / this.cal.armWorld,
        elbow: angle3(f.world[idx.shoulder], f.world[idx.elbow], f.world[idx.wrist]),
        zAhead: (f.world[idx.shoulder].z - wz) / this.cal.swWorld,
        scale: dist2(w, f.img[idx.index]) / sw / this.cal.handSize[hand],
        y: (w.y - shoulderY) / sw,
        headDist: dist2(w, nose) / sw,
        vFwd, vIn, vUp,
        speed: Math.hypot(vIn, vUp),
      };
      feats[hand] = hf;
      const pe = loc(e);
      samples[hand] = { t: f.t, p: { t: f.t, x: pw.x, y: pw.y, ex: pe.x, ey: pe.y, s: hf.scale }, f: hf, img: { ...w }, z: wz, nose: loc(nose) };
    }
    for (const hand of ['left', 'right'] as Hand[]) {
      const p = this.stepHand(hand, samples[hand], chinY);
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
    // Per-frame factors are tuned at 30 fps; convert them to time constants so 60 fps cameras match.
    const dt = Math.max(1, raw.t - prev.t);
    const at = (k: number) => 1 - Math.pow(1 - k, dt / (1000 / 30));
    const a = at(CONFIG.smoothing.image), b = at(CONFIG.smoothing.worldZ);
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

  private stepHand(hand: Hand, smp: Sample, chinY: number): (Punch & { at: number }) | null {
    const c = CONFIG.punch;
    const st = this.hands[hand];
    const t = smp.t;
    st.buf.push(smp);
    while (st.buf.length > 2 && t - st.buf[0].t > BUF_MS) {
      st.buf.shift();
      if (st.active) {
        st.active.startIdx = Math.max(0, st.active.startIdx - 1);
        st.active.peakIdx = Math.max(0, st.active.peakIdx - 1);
      }
    }
    const speed = smp.f.speed;
    // Any fast hand movement (punch, retraction, wind-up) moves the head too; slips wait for it.
    if (speed >= c.startSpeed) st.lastMotion = t;
    if (speed < c.restSpeed) st.stillSince = Math.min(st.stillSince, t);
    else st.stillSince = Infinity;
    if (!st.anchor) st.anchor = { x: smp.p.x, y: smp.p.y };
    const dist = Math.hypot(smp.p.x - st.anchor.x, smp.p.y - st.anchor.y);

    if (st.mode === 'returning') {
      const cooldown = this.gassed ? c.gassedCooldownMs : c.cooldownMs;
      // Back once the hand is home along the line it went out on; a fast swing through rest to the other side also counts.
      const along = (smp.p.x - st.anchor.x) * st.lastDir.x + (smp.p.y - st.anchor.y) * st.lastDir.y;
      const back = along < Math.max(c.returnDist, st.lastMax * c.returnFraction);
      const settled = t - st.stillSince >= c.settleMs;
      if ((back || settled) && (!st.fired || t - st.lastFire >= cooldown)) {
        st.mode = 'ready';
        if (settled && !back) st.anchor = { x: smp.p.x, y: smp.p.y };
      } else {
        if (st.fired && speed >= c.startSpeed && t - st.lastIgnored > 300) {
          st.lastIgnored = t;
          this.onIgnored?.(hand, t, back ? 'cooldown' : `not back yet (${dist.toFixed(2)} sw from rest)`);
        }
        return null;
      }
    }
    if (st.mode === 'ready') {
      const k = 1 - Math.exp(-Math.max(0, t - (st.buf.at(-2)?.t ?? t)) / c.anchorFollowMs);
      if (speed < c.restSpeed) {
        st.anchor.x += (smp.p.x - st.anchor.x) * k;
        st.anchor.y += (smp.p.y - st.anchor.y) * k;
        return null;
      }
      const prev = st.buf.at(-2);
      const prevDist = prev ? Math.hypot(prev.p.x - st.anchor.x, prev.p.y - st.anchor.y) : 0;
      if (dist < c.startDist || dist <= prevDist) return null;
      // The motion starts at the last frame the hand was still near its rest position.
      let i = st.buf.length - 1;
      while (i > 0 && Math.hypot(st.buf[i - 1].p.x - st.anchor.x, st.buf[i - 1].p.y - st.anchor.y) < Math.hypot(st.buf[i].p.x - st.anchor.x, st.buf[i].p.y - st.anchor.y) && t - st.buf[i - 1].t < c.maxDurationMs) i--;
      st.mode = 'active';
      st.active = { startIdx: i, anchor: { ...st.anchor }, maxD: 0, peakIdx: i, maxSpeed: 0, maxUp: 0, maxElbow: 0, stall: 0 };
      for (let j = i; j < st.buf.length - 1; j++) this.track(st.active, st.buf[j], j);
    }
    const a = st.active!;
    st.lastMotion = t;
    this.track(a, smp, st.buf.length - 1);
    const d = Math.hypot(smp.p.x - a.anchor.x, smp.p.y - a.anchor.y);
    a.stall = speed < a.maxSpeed * c.stopFraction ? a.stall + 1 : 0;
    const reversed = a.maxD >= c.minTravel * 0.5 && d < a.maxD * c.reverseFraction;
    const stopped = a.maxD >= c.minTravel && a.stall >= 2;
    const tooLong = t - st.buf[a.startIdx].t > c.maxDurationMs;
    const aborted = a.maxD < c.minTravel && d < c.startDist * 0.5;
    if (aborted) {
      st.mode = 'ready';
      st.active = null;
      return null;
    }
    if (!reversed && !stopped && !tooLong) return null;
    return this.finish(hand, st, a, chinY, t);
  }

  private track(a: Active, s: Sample, idx: number): void {
    const d = Math.hypot(s.p.x - a.anchor.x, s.p.y - a.anchor.y);
    if (d > a.maxD) {
      a.maxD = d;
      a.peakIdx = idx;
    }
    a.maxSpeed = Math.max(a.maxSpeed, s.f.speed);
    a.maxUp = Math.max(a.maxUp, s.f.vUp);
    a.maxElbow = Math.max(a.maxElbow, s.f.elbow);
  }

  /** Builds the segment, decides it, and moves the hand on to waiting for its return. */
  private finish(hand: Hand, st: HandState, a: Active, chinY: number, t: number): (Punch & { at: number }) | null {
    st.active = null;
    st.mode = 'returning';
    st.lastMax = a.maxD;
    const pk = st.buf[a.peakIdx].p;
    const n = Math.hypot(pk.x - a.anchor.x, pk.y - a.anchor.y) || 1;
    st.lastDir = { x: (pk.x - a.anchor.x) / n, y: (pk.y - a.anchor.y) / n };
    st.stillSince = Infinity;
    const seg = this.segment(hand, st, a, chinY, t);
    const punch = this.classify(seg);
    this.onDecision?.(seg, punch, `${this.lastDecision ?? ''}${punch && !this.canPunch ? ' (blocked: cannot punch now)' : ''}`);
    st.fired = !!punch && this.canPunch;
    if (!st.fired) return null;
    st.lastFire = t;
    return { ...punch!, at: seg.peakT };
  }

  private segment(hand: Hand, st: HandState, a: Active, chinY: number, t: number): Segment {
    const s0 = st.buf[a.startIdx];
    const pk = st.buf[a.peakIdx];
    const path = st.buf.slice(a.startIdx, Math.min(st.buf.length, a.peakIdx + 3)).map((x) => x.p);
    const start: PathPoint = { ...s0.p, x: a.anchor.x, y: a.anchor.y };
    path[0] = start;
    const ob = this.hands[hand === 'left' ? 'right' : 'left'].buf;
    const o0 = ob.find((x) => x.t >= s0.t), o1 = [...ob].reverse().find((x) => x.t <= pk.t);
    const other = o0 && o1 ? Math.hypot(o1.p.x - o0.p.x, o1.p.y - o0.p.y) : 0;
    const otherRise = o0 && o1 ? o1.p.y - o0.p.y : 0;
    const fwd = (s0.z - pk.z) / this.cal.swWorld;
    const w = CONFIG.straight.weights;
    let maxElbow = s0.f.elbow;
    for (let i = a.startIdx; i < st.buf.length; i++) maxElbow = Math.max(maxElbow, st.buf[i].f.elbow);
    return {
      hand, startT: s0.t, peakT: pk.t, endT: t,
      dIn: pk.p.x - start.x, rise: pk.p.y - start.y, fwd,
      forward: w.z * fwd + w.scale * Math.max(0, pk.f.scale - s0.f.scale) + w.travel * a.maxD,
      elbow: maxElbow, startElbow: s0.f.elbow, startY: s0.f.y, peakY: pk.f.y, chinY,
      startHead: s0.f.headDist, peakHead: pk.f.headDist, scaleGain: pk.f.scale - s0.f.scale,
      travel: a.maxD, maxSpeed: a.maxSpeed, maxUp: a.maxUp, reach: pk.f.reach, startReach: s0.f.reach,
      fromGuard: this.nearGuard(s0.f),
      start, peak: pk.p, nose: pk.nose, path, other, otherRise,
      headDrop: s0.nose.y - pk.nose.y,
    };
  }

  /** Hand position counts as "at guard" (personalized when the calibration measured the guard). */
  nearGuard(f: HandFeatures): boolean {
    const g = CONFIG.gate;
    const head = (this.cal.guardHead ?? g.defaultGuardHead) + g.guardStartSlack;
    const y = (this.cal.guardY ?? g.defaultGuardY) + g.guardStartSlackY;
    return f.headDist <= head && f.y <= y;
  }

  private classify(seg: Segment): Punch | null {
    const fmt = (n: number) => n.toFixed(2);
    const info = `${seg.hand} in=${fmt(seg.dIn)} rise=${fmt(seg.rise)} y=${fmt(seg.peakY)} travel=${fmt(seg.travel)} elbow=${seg.elbow.toFixed(0)} other=${fmt(seg.other)}`;
    this.onSegment?.(seg);
    if (!passesGate(seg)) {
      this.lastDecision = `none (${seg.travel < CONFIG.punch.minTravel ? 'short' : bothHands(seg) ? 'both hands' : 'slow'}) ${info}`;
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
    this.lastDecision = `${r ? `${r.type} ${r.target}` : 'none'} ${info}`;
    return r;
  }
}

/** Camera-independent punch gate: the hand travelled far enough, fast enough, and on its own. */
export function passesGate(seg: Segment): boolean {
  return seg.travel >= CONFIG.punch.minTravel && seg.maxSpeed >= CONFIG.punch.minPeakSpeed && !bothHands(seg);
}

/** Both hands rising or dropping together (raising the guard, dropping the hands) is not a punch. */
export function bothHands(seg: Segment): boolean {
  const c = CONFIG.punch;
  return Math.abs(seg.rise) > c.bothHandsVertical * Math.abs(seg.dIn) && Math.sign(seg.rise) === Math.sign(seg.otherRise) && Math.abs(seg.otherRise) >= c.bothHandsFraction * Math.abs(seg.rise);
}

/** The hand-written rules (used without a taught profile): decides a punch from one motion segment, or null. */
export function ruleDecision(seg: Segment, stance: Stance): Punch | null {
  if (!passesGate(seg)) return null;
  const { hand } = seg;
  const u = CONFIG.uppercut;
  const h = CONFIG.hook;
  const s = CONFIG.straight;
  const target: Target = seg.peakY < CONFIG.punch.headBodySplit ? 'head' : 'body';
  let type: PunchType | null = null;
  if (seg.rise > u.minRise && seg.elbow < u.maxElbow && seg.maxUp > u.minUpSpeed && seg.rise > Math.abs(seg.dIn)) {
    type = hand === 'left' ? 'leftUppercut' : 'rightUppercut';
  } else if (seg.elbow >= h.minElbow && seg.elbow <= h.maxElbow && seg.dIn > h.minSweep && seg.dIn > Math.abs(seg.rise)) {
    type = hand === 'left' ? 'leftHook' : 'rightHook';
  } else if ((seg.elbow > s.minElbow && seg.forward > s.minForward) || seg.forward > s.strongForward) {
    const lead: Hand = stance === 'orthodox' ? 'left' : 'right';
    type = hand === lead ? 'jab' : 'cross';
  }
  return type ? { type, hand, target } : null;
}

function newHand(): HandState {
  return { mode: 'ready', anchor: null, buf: [], active: null, lastMax: 0, lastDir: { x: 0, y: 1 }, lastFire: -Infinity, lastMotion: -Infinity, lastIgnored: -Infinity, stillSince: Infinity, fired: false };
}

function clone(f: PoseFrame): PoseFrame {
  return { t: f.t, img: f.img.map((p) => ({ ...p })), world: f.world.map((p) => ({ ...p })) };
}
