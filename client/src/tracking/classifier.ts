import type { DefenseState, Hand, Punch, PunchType, Stance } from '../../../shared/types.ts';
import { CONFIG } from '../config.ts';
import type { Calibration } from './calibration.ts';
import { HAND_IDX, L, angle3, dist2, dist3, type Lm, type PoseFrame } from './frame.ts';
import { targetOf } from './model.ts';

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
  /** Every frame from the rest position to the peak (inclusive), plus up to two frames after (and at least CONFIG.punch.pathAfterMs). */
  path: PathPoint[];
  /** How far the other hand moved over the same time, in sw (both hands moving together is not a punch). */
  other: number;
  /** The other hand's vertical move over the same time, in sw (up is positive). */
  otherRise: number;
  /** Nose drop relative to the shoulders from start to peak, in sw (a model feature). */
  headDrop: number;
  /**
   * Deepest head dip below the neutral head position (the defense headDy, calibrated sw, down
   * positive) from the start of the motion to just past its peak. A crouched punch is a body shot.
   */
  dip: number;
}

interface Sample {
  t: number;
  /** Time since the previous frame (ms), 0 for the first. */
  gap: number;
  /** Time the velocity was measured over (ms, see CONFIG.punch.minSpanMs), 0 for the first frame. */
  span: number;
  p: PathPoint;
  f: HandFeatures;
  z: number;
  nose: P2;
  /** Head dip below neutral this frame (Features.headDy). */
  dip: number;
}

interface Active {
  startIdx: number;
  anchor: P2;
  maxD: number;
  /** A motion straight out of a return: where the hand rested before it (see HandState.pivot). */
  home: P2 | null;
  peakIdx: number;
  maxSpeed: number;
  /** Top speed corrected for the frame gap (see gapBoost). */
  gateSpeed: number;
  maxUp: number;
  stall: number;
  /** When the current stall began (halfway into the first slow frame's gap). */
  stallT: number;
  /** Time of the last peak already read early (each candidate peak is read once). */
  checkedPeakT: number;
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
  /**
   * While returning: the point nearest home along the last motion's line so far (where a partial
   * retraction turned round). A clear new motion away from it is the next punch (doubles, combos).
   */
  pivot: (P2 & { along: number; speed: number; dx: number; dy: number }) | null;
  /** Set when a motion starts from the pivot: the rest position it left from. */
  home: P2 | null;
}

export interface ClassifierOutput {
  punches: (Punch & { at: number })[];
  defense: DefenseState;
  features: Features | null;
  /** Explanation of the last punch decision, for ?debug=1. */
  last: string | null;
}

interface Decision {
  punch: Punch | null;
  /** What decided it: the speed and travel gate, the learned model, or the hand-written rules. */
  by: 'gate' | 'model' | 'rules';
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
  /** Head dip (sw) that makes a punch a body shot for the rules; a taught profile passes its own to the model. */
  bodyDip: number = CONFIG.punch.bodyDip;

  constructor(private cal: Calibration) {
    this.base = { x: cal.noseX, y: cal.noseY };
    this.sw = cal.swImg;
  }

  update(raw: PoseFrame): ClassifierOutput {
    const prevT = this.smooth?.t ?? null;
    const f = this.smoothFrame(raw);
    const ls = f.img[L.lShoulder], rs = f.img[L.rShoulder];
    const swNow = dist2(ls, rs) || this.cal.swImg;
    // Shoulder width shrinks when the torso turns into a cross; follow it slowly so punches do not rescale themselves.
    if (prevT !== null) this.sw += (swNow - this.sw) * (1 - Math.exp(-Math.max(0, f.t - prevT) / CONFIG.punch.swFollowMs));
    const sw = this.sw;
    // Midpoint between the shoulders (the origin of each hand's frame).
    const neckX = (ls.x + rs.x) / 2;
    const shoulderY = (ls.y + rs.y) / 2;
    const nose = f.img[L.nose];
    const chinY = (nose.y + (shoulderY - nose.y) * 0.45 - shoulderY) / sw;
    const punches: ClassifierOutput['punches'] = [];
    // Head offset from the neutral position, before this frame moves the neutral (punches read the dip too).
    const headDx = (nose.x - this.base.x) / this.cal.swImg;
    const headDy = (nose.y - this.base.y) / this.cal.swImg;

    // Both samples are taken before either hand steps: a segment reads the other hand's buffer.
    const sl = this.sample('left', f, neckX, shoulderY, sw, headDy);
    const sr = this.sample('right', f, neckX, shoulderY, sw, headDy);
    const pl = this.stepHand('left', sl, chinY);
    if (pl) punches.push(pl);
    const pr = this.stepHand('right', sr, chinY);
    if (pr) punches.push(pr);

    const d = CONFIG.defense;
    const th = this.defenseThresholds;
    if (this.lastT !== null) {
      const k = 1 - Math.exp(-(f.t - this.lastT) / d.neutralDriftMs);
      if (Math.abs(headDx) < th.slipLeft * 0.5 && Math.abs(headDx) < th.slipRight * 0.5) this.base.x += (nose.x - this.base.x) * k;
      if (Math.abs(headDy) < th.duck * 0.5) this.base.y += (nose.y - this.base.y) * k;
    }
    this.lastT = f.t;
    const gy = this.cal.guardY !== undefined ? Math.max(d.guardMaxY, this.cal.guardY + d.guardSlack) : d.guardMaxY;
    const gh = this.cal.guardHead !== undefined ? Math.max(d.guardMaxHeadDist, this.cal.guardHead + d.guardSlack) : d.guardMaxHeadDist;
    const hold = this.wasGuard ? d.guardHysteresis : 0;
    const maxSpeed = d.guardMaxSpeed * (this.wasGuard ? 1.6 : 1);
    const { left, right } = this.hands;
    const inGuard = (st: HandState, hf: HandFeatures) => st.mode !== 'active' && hf.y < gy + hold && hf.headDist < gh + hold && hf.speed < maxSpeed;
    const punching = f.t - left.lastMotion < d.slipAfterPunchMs || f.t - right.lastMotion < d.slipAfterPunchMs;
    const defense: DefenseState = {
      guard: inGuard(left, sl.f) && inGuard(right, sr.f),
      duck: headDy > th.duck,
      slip: punching ? 'none' : headDx > th.slipLeft ? 'left' : headDx < -th.slipRight ? 'right' : 'none',
    };
    this.wasGuard = defense.guard;
    return { punches, defense, features: { left: sl.f, right: sr.f, headDx, headDy, chinY }, last: this.lastDecision };
  }

  /** One hand's features and motion sample for this frame, in its own frame (see P2). */
  private sample(hand: Hand, f: PoseFrame, neckX: number, neckY: number, sw: number, dip: number): Sample {
    const idx = HAND_IDX[hand];
    const buf = this.hands[hand].buf;
    const w = f.img[idx.wrist];
    const e = f.img[idx.elbow];
    const nose = f.img[L.nose];
    const ws = f.world[idx.shoulder], ww = f.world[idx.wrist];
    const wz = ww.z;
    const s = sideSign(hand);
    const prev = spanBack(buf, f.t, buf.length - 1);
    const dt = prev ? (f.t - prev.t) / 1000 : 0;
    let vIn = 0, vUp = 0, vFwd = 0;
    const x = (-s * (w.x - neckX)) / sw, y = -(w.y - neckY) / sw;
    if (prev && dt > 0) {
      vIn = (x - prev.p.x) / dt;
      vUp = (y - prev.p.y) / dt;
      vFwd = (-(wz - prev.z)) / this.cal.swWorld / dt;
    }
    const hf: HandFeatures = {
      reach: dist3(ws, ww) / this.cal.armWorld,
      elbow: angle3(ws, f.world[idx.elbow], ww),
      zAhead: (ws.z - wz) / this.cal.swWorld,
      scale: dist2(w, f.img[idx.index]) / sw / this.cal.handSize[hand],
      y: (w.y - neckY) / sw,
      headDist: dist2(w, nose) / sw,
      vFwd, vIn, vUp,
      speed: Math.hypot(vIn, vUp),
    };
    return {
      t: f.t,
      gap: buf.length ? f.t - buf[buf.length - 1].t : 0,
      span: prev ? f.t - prev.t : 0,
      p: { t: f.t, x, y, ex: (-s * (e.x - neckX)) / sw, ey: -(e.y - neckY) / sw, s: hf.scale },
      f: hf,
      z: wz,
      nose: { x: (-s * (nose.x - neckX)) / sw, y: -(nose.y - neckY) / sw },
      dip,
    };
  }

  /**
   * Exponential smoothing of the raw landmarks. The smoothed frame is private to the classifier,
   * so it is updated in place after the first frame instead of being rebuilt every frame.
   */
  private smoothFrame(raw: PoseFrame): PoseFrame {
    const prev = this.smooth;
    if (!prev) return (this.smooth = clone(raw));
    // Per-frame factors are tuned at 30 fps; convert them to time constants so 60 fps cameras match.
    const dt = Math.max(1, raw.t - prev.t);
    const at = (k: number) => 1 - Math.pow(1 - k, dt / (1000 / 30));
    const a = at(CONFIG.smoothing.image), b = at(CONFIG.smoothing.worldZ);
    if (raw.img.length !== prev.img.length || raw.world.length !== prev.world.length) {
      const mix = (p: Lm, r: Lm, k: number, kz: number): Lm => ({
        x: p.x + (r.x - p.x) * k, y: p.y + (r.y - p.y) * k, z: p.z + (r.z - p.z) * kz, v: r.v,
      });
      return (this.smooth = { t: raw.t, img: raw.img.map((r, i) => mix(prev.img[i], r, a, a)), world: raw.world.map((r, i) => mix(prev.world[i], r, a, b)) });
    }
    prev.t = raw.t;
    mixInto(prev.img, raw.img, a, a);
    mixInto(prev.world, raw.world, a, b);
    return prev;
  }

  private stepHand(hand: Hand, smp: Sample, chinY: number): (Punch & { at: number }) | null {
    const c = CONFIG.punch;
    const st = this.hands[hand];
    const t = smp.t;
    const buf = st.buf;
    buf.push(smp);
    let drop = 0;
    while (buf.length - drop > 2 && t - buf[drop].t > BUF_MS) drop++;
    if (drop) {
      if (drop === 1) buf.shift();
      else buf.splice(0, drop);
      if (st.active) {
        st.active.startIdx = Math.max(0, st.active.startIdx - drop);
        st.active.peakIdx = Math.max(0, st.active.peakIdx - drop);
      }
    }
    const speed = smp.f.speed;
    // Any fast hand movement (punch, retraction, wind-up) moves the head too; slips wait for it.
    if (speed >= c.startSpeed) st.lastMotion = t;
    // The hand stopped somewhere between the previous frame and this one; take the midpoint so slow cameras settle on time.
    if (speed < c.restSpeed) st.stillSince = Math.min(st.stillSince, t - smp.gap / 2);
    else st.stillSince = Infinity;
    if (!st.anchor) st.anchor = { x: smp.p.x, y: smp.p.y };
    const dist = Math.hypot(smp.p.x - st.anchor.x, smp.p.y - st.anchor.y);

    if (st.mode === 'returning') {
      const cooldown = this.gassed ? c.gassedCooldownMs : c.cooldownMs;
      // Back once the hand is home along the line it went out on; a fast swing through rest to the other side also counts.
      const along = (smp.p.x - st.anchor.x) * st.lastDir.x + (smp.p.y - st.anchor.y) * st.lastDir.y;
      const back = along < Math.max(c.returnDist, st.lastMax * c.returnFraction);
      const settled = t - st.stillSince >= (st.fired ? c.settleMs : c.settleIgnoredMs);
      const cool = !st.fired || t - st.lastFire >= cooldown;
      if ((back || settled) && cool) {
        st.mode = 'ready';
        st.home = null;
        if (settled && !back) st.anchor = { x: smp.p.x, y: smp.p.y };
      } else if (this.relaunch(st, smp, along)) {
        // A new motion straight out of a partial return: it is measured from where the hand turned.
        st.mode = 'ready';
        st.home = st.anchor;
        st.anchor = { x: st.pivot!.x, y: st.pivot!.y };
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
        st.home = null;
        return null;
      }
      const prev = spanBack(buf, t, buf.length - 2);
      const prevDist = prev ? Math.hypot(prev.p.x - st.anchor.x, prev.p.y - st.anchor.y) : 0;
      const d0 = Math.hypot(smp.p.x - st.anchor.x, smp.p.y - st.anchor.y);
      if (d0 < c.startDist || d0 <= prevDist) {
        st.home = null;
        return null;
      }
      // The motion starts at the last frame the hand was still near its rest position.
      const ax = st.anchor.x, ay = st.anchor.y;
      // Walking back, a frame no nearer than the last one only ends the search once it is minSpanMs
      // older (a single jittery frame on a fast camera does not cut the motion short).
      let i = buf.length - 1;
      let di = Math.hypot(buf[i].p.x - ax, buf[i].p.y - ay);
      for (let j = i - 1; j >= 0 && t - buf[j].t < c.maxDurationMs; j--) {
        const dq = Math.hypot(buf[j].p.x - ax, buf[j].p.y - ay);
        if (dq < di) {
          i = j;
          di = dq;
        } else if (buf[i].t - buf[j].t >= c.minSpanMs) break;
      }
      st.mode = 'active';
      st.active = { startIdx: i, anchor: { x: ax, y: ay }, maxD: 0, home: st.home, peakIdx: i, maxSpeed: 0, gateSpeed: 0, maxUp: 0, stall: 0, stallT: t, checkedPeakT: -Infinity };
      st.home = null;
      for (let j = i; j < st.buf.length - 1; j++) this.track(st.active, st.buf[j], j);
    }
    const a = st.active!;
    st.lastMotion = t;
    this.track(a, smp, st.buf.length - 1);
    const d = Math.hypot(smp.p.x - a.anchor.x, smp.p.y - a.anchor.y);
    if (speed < a.maxSpeed * c.stopFraction) {
      if (!a.stall++) a.stallT = t - smp.gap / 2;
    } else a.stall = 0;
    const reversed = a.maxD >= c.minTravel * 0.5 && d < a.maxD * c.reverseFraction;
    const travel = this.travel(a, st.buf[a.peakIdx].p);
    const stopped = travel >= c.minTravel && a.stall >= c.stallFrames && t - a.stallT >= c.stallMs;
    const tooLong = t - st.buf[a.startIdx].t > c.maxDurationMs;
    const aborted = travel < c.minTravel && d < c.startDist * 0.5;
    if (aborted) {
      st.mode = 'ready';
      st.active = null;
      return null;
    }
    if (!reversed && !stopped && !tooLong) {
      // Early read: once the hand has stopped getting further from rest, decide from the motion so far
      // and fire right away when it is a punch; otherwise keep following it and decide at the end.
      const pk = st.buf[a.peakIdx];
      const since = st.buf.length - 1 - a.peakIdx;
      if (c.earlyFire && since >= c.peakConfirmFrames && t - pk.t >= c.peakConfirmMs && pk.t !== a.checkedPeakT && travel >= c.minTravel && d <= a.maxD * c.peakConfirmDrop && this.pastPeak(a, pk.p, smp)) {
        a.checkedPeakT = pk.t;
        const seg = this.segment(hand, st, a, chinY, t);
        const r = this.decide(seg);
        if (r.punch && this.cooled(st, t)) return this.finish(hand, st, a, chinY, t, seg, r);
      }
      return null;
    }
    return this.finish(hand, st, a, chinY, t);
  }

  /**
   * Follows the turning point of a hand on its way back (see HandState.pivot) and tells whether a
   * clear new motion has started from it: the hand turned there (came back some way, or nearly
   * stopped) and is now moving fast and further away from it.
   */
  private relaunch(st: HandState, smp: Sample, along: number): boolean {
    const c = CONFIG.punch;
    if (!c.relaunch) return false;
    const p = st.pivot;
    const prev = spanBack(st.buf, smp.t, st.buf.length - 2);
    if (!p || along < p.along) {
      // The direction the hand arrived from, to tell a turn from a sweep that carries on.
      const dx = prev ? smp.p.x - prev.p.x : 0, dy = prev ? smp.p.y - prev.p.y : 0;
      st.pivot = { x: smp.p.x, y: smp.p.y, along, speed: smp.f.speed, dx, dy };
      return false;
    }
    if (smp.f.speed < c.startSpeed) return false;
    if (st.fired && p.along > st.lastMax * c.relaunchBack) return false;
    const mx = smp.p.x - p.x, my = smp.p.y - p.y;
    const d = Math.hypot(mx, my);
    const dPrev = prev ? Math.hypot(prev.p.x - p.x, prev.p.y - p.y) : 0;
    if (d < c.relaunchDist || d <= dPrev) return false;
    // A real turn: the hand nearly stopped there, or now heads off at least relaunchTurnCos away from how it came in.
    const a = Math.hypot(p.dx, p.dy);
    return p.speed <= c.relaunchStillSpeed || (a > 0 && (mx * p.dx + my * p.dy) / (a * d) <= c.relaunchTurnCos);
  }

  /**
   * The hand has really turned at its furthest point: it is heading back toward rest, or has nearly
   * stopped. A hand that only slows or swerves on the way out (a hook bending round) does not count.
   */
  private pastPeak(a: Active, pk: P2, s: Sample): boolean {
    const c = CONFIG.punch;
    if (s.f.speed < a.maxSpeed * c.stopFraction) return true;
    const mx = s.p.x - pk.x, my = s.p.y - pk.y;
    const bx = a.anchor.x - pk.x, by = a.anchor.y - pk.y;
    const m = Math.hypot(mx, my), b = Math.hypot(bx, by);
    return m > 0 && b > 0 && (mx * bx + my * by) / (m * b) >= c.peakReturnCos;
  }

  private track(a: Active, s: Sample, idx: number): void {
    const d = Math.hypot(s.p.x - a.anchor.x, s.p.y - a.anchor.y);
    if (d > a.maxD) {
      a.maxD = d;
      a.peakIdx = idx;
    }
    a.maxSpeed = Math.max(a.maxSpeed, s.f.speed);
    a.gateSpeed = Math.max(a.gateSpeed, s.f.speed * gapBoost(s.span));
    a.maxUp = Math.max(a.maxUp, s.f.vUp);
  }

  /**
   * How far the motion went: from where it started, or for a motion straight out of a return
   * (a double jab) from where the hand rested before, if that is further.
   */
  private travel(a: Active, peak: P2): number {
    return a.home ? Math.max(a.maxD, Math.hypot(peak.x - a.home.x, peak.y - a.home.y)) : a.maxD;
  }

  /** The hand's last punch fired at least the cooldown ago; no punch fires sooner, even one straight out of a return. */
  private cooled(st: HandState, t: number): boolean {
    return t - st.lastFire >= (this.gassed ? CONFIG.punch.gassedCooldownMs : CONFIG.punch.cooldownMs);
  }

  /** Builds the segment, decides it, and moves the hand on to waiting for its return. */
  private finish(hand: Hand, st: HandState, a: Active, chinY: number, t: number, early?: Segment, read?: Decision): (Punch & { at: number }) | null {
    st.active = null;
    st.mode = 'returning';
    st.lastMax = a.maxD;
    const pk = st.buf[a.peakIdx].p;
    const n = Math.hypot(pk.x - a.anchor.x, pk.y - a.anchor.y) || 1;
    st.lastDir = { x: (pk.x - a.anchor.x) / n, y: (pk.y - a.anchor.y) / n };
    st.stillSince = Infinity;
    st.pivot = null;
    const seg = early ?? this.segment(hand, st, a, chinY, t);
    this.onSegment?.(seg);
    const r = read ?? this.decide(seg);
    const punch = r.punch;
    const cooled = this.cooled(st, t);
    this.lastDecision = `${explain(seg, r)}${punch && !this.canPunch ? ' (blocked: cannot punch now)' : punch && !cooled ? ' (blocked: cooldown)' : ''}`;
    this.onDecision?.(seg, punch, this.lastDecision);
    st.fired = !!punch && this.canPunch && cooled;
    if (!st.fired) return null;
    st.lastFire = t;
    return { ...punch!, at: seg.peakT };
  }

  private segment(hand: Hand, st: HandState, a: Active, chinY: number, t: number): Segment {
    const s0 = st.buf[a.startIdx];
    const pk = st.buf[a.peakIdx];
    const buf = st.buf;
    let end = Math.min(buf.length, a.peakIdx + 1 + CONFIG.punch.pathAfterFrames);
    while (end < buf.length && buf[end].t - pk.t <= CONFIG.punch.pathAfterMs) end++;
    const path: PathPoint[] = [];
    for (let i = a.startIdx; i < end; i++) path.push(buf[i].p);
    const start: PathPoint = { ...s0.p, x: a.anchor.x, y: a.anchor.y };
    path[0] = start;
    const ob = this.hands[hand === 'left' ? 'right' : 'left'].buf;
    const o0 = ob.find((x) => x.t >= s0.t);
    let o1: Sample | undefined;
    for (let i = ob.length - 1; i >= 0; i--) {
      if (ob[i].t <= pk.t) {
        o1 = ob[i];
        break;
      }
    }
    const other = o0 && o1 ? Math.hypot(o1.p.x - o0.p.x, o1.p.y - o0.p.y) : 0;
    const otherRise = o0 && o1 ? o1.p.y - o0.p.y : 0;
    const fwd = (s0.z - pk.z) / this.cal.swWorld;
    const w = CONFIG.straight.weights;
    let maxElbow = s0.f.elbow;
    for (let i = a.startIdx; i < buf.length; i++) maxElbow = Math.max(maxElbow, buf[i].f.elbow);
    let dip = -Infinity;
    for (let i = a.startIdx; i < end; i++) dip = Math.max(dip, buf[i].dip);
    return {
      hand, startT: s0.t, peakT: pk.t, endT: t,
      dIn: pk.p.x - start.x, rise: pk.p.y - start.y, fwd,
      forward: w.z * fwd + w.scale * Math.max(0, pk.f.scale - s0.f.scale) + w.travel * a.maxD,
      elbow: maxElbow, startElbow: s0.f.elbow, startY: s0.f.y, peakY: pk.f.y, chinY,
      startHead: s0.f.headDist, peakHead: pk.f.headDist, scaleGain: pk.f.scale - s0.f.scale,
      travel: this.travel(a, pk.p), maxSpeed: a.gateSpeed, maxUp: a.maxUp, reach: pk.f.reach, startReach: s0.f.reach,
      fromGuard: this.nearGuard(s0.f),
      start, peak: pk.p, nose: pk.nose, path, other, otherRise,
      headDrop: s0.nose.y - pk.nose.y,
      dip,
    };
  }

  /** Hand position counts as "at guard" (personalized when the calibration measured the guard). */
  nearGuard(f: HandFeatures): boolean {
    const g = CONFIG.gate;
    const head = (this.cal.guardHead ?? g.defaultGuardHead) + g.guardStartSlack;
    const y = (this.cal.guardY ?? g.defaultGuardY) + g.guardStartSlackY;
    return f.headDist <= head && f.y <= y;
  }

  /** Decides one motion (no side effects); explain() words it for ?debug=1. */
  private decide(seg: Segment): Decision {
    if (!passesGate(seg)) return { punch: null, by: 'gate' };
    if (this.model) {
      const m = this.model(seg);
      if (m !== undefined) return { punch: m, by: 'model' };
    }
    return { punch: ruleDecision(seg, this.stance, this.bodyDip), by: 'rules' };
  }
}

/** The explanation of a decision. Only built for decisions that are kept (an early read that is not a punch is dropped). */
function explain(seg: Segment, r: Decision): string {
  const fmt = (n: number) => n.toFixed(2);
  const info = `${seg.hand} in=${fmt(seg.dIn)} rise=${fmt(seg.rise)} y=${fmt(seg.peakY)} travel=${fmt(seg.travel)} elbow=${seg.elbow.toFixed(0)} other=${fmt(seg.other)} +${(seg.endT - seg.peakT).toFixed(0)}ms`;
  if (r.by === 'gate') return `none (${seg.travel < CONFIG.punch.minTravel ? 'short' : bothHands(seg) ? 'both hands' : 'slow'}) ${info}`;
  const p = r.punch;
  return `${p ? `${p.type} ${p.target}` : 'none'}${r.by === 'model' ? ' (model)' : ''} ${info}`;
}

/** Camera-independent punch gate: the hand travelled far enough, fast enough, and on its own. */
export function passesGate(seg: Segment): boolean {
  return seg.travel >= CONFIG.punch.minTravel && seg.maxSpeed >= CONFIG.punch.minPeakSpeed && !bothHands(seg);
}

/** Both hands rising or dropping together (raising the guard, dropping the hands) is not a punch. */
function bothHands(seg: Segment): boolean {
  const c = CONFIG.punch;
  return Math.abs(seg.rise) > c.bothHandsVertical * Math.abs(seg.dIn) && Math.sign(seg.rise) === Math.sign(seg.otherRise) && Math.abs(seg.otherRise) >= c.bothHandsFraction * Math.abs(seg.rise);
}

/** The hand-written rules (used without a taught profile): decides a punch from one motion segment, or null. */
function ruleDecision(seg: Segment, stance: Stance, bodyDip: number = CONFIG.punch.bodyDip): Punch | null {
  if (!passesGate(seg)) return null;
  const { hand } = seg;
  const u = CONFIG.uppercut;
  const h = CONFIG.hook;
  const s = CONFIG.straight;
  let type: PunchType | null = null;
  if (seg.rise > u.minRise && seg.elbow < u.maxElbow && seg.maxUp > u.minUpSpeed && seg.rise > Math.abs(seg.dIn)) {
    type = hand === 'left' ? 'leftUppercut' : 'rightUppercut';
  } else if (seg.elbow >= h.minElbow && seg.elbow <= h.maxElbow && seg.dIn > h.minSweep && seg.dIn > Math.abs(seg.rise)) {
    type = hand === 'left' ? 'leftHook' : 'rightHook';
  } else if ((seg.elbow > s.minElbow && seg.forward > s.minForward) || seg.forward > s.strongForward) {
    const lead: Hand = stance === 'orthodox' ? 'left' : 'right';
    type = hand === lead ? 'jab' : 'cross';
  }
  return type ? { type, hand, target: targetOf(seg, bodyDip) } : null;
}

/**
 * Speed is measured between frames, so with long frame gaps it averages over more of the punch and
 * reads low. Scales it back up for gaps past the rate the gate was tuned at (about 25 fps).
 */
function gapBoost(gapMs: number): number {
  const c = CONFIG.punch;
  return 1 / Math.max(c.gapBoostMin, 1 - Math.max(0, gapMs - c.gapBoostFromMs) / c.gapBoostSpanMs);
}

/**
 * The sample velocities and frame-to-frame comparisons measure against: the latest of buf[0..from]
 * at least minSpanMs before t (the previous frame at normal frame rates), else the oldest.
 */
function spanBack(buf: Sample[], t: number, from: number): Sample | undefined {
  const ms = CONFIG.punch.minSpanMs;
  let i = from;
  while (i > 0 && t - buf[i].t < ms) i--;
  return i >= 0 ? buf[i] : undefined;
}

function newHand(): HandState {
  return { mode: 'ready', anchor: null, buf: [], active: null, lastMax: 0, lastDir: { x: 0, y: 1 }, lastFire: -Infinity, lastMotion: -Infinity, lastIgnored: -Infinity, stillSince: Infinity, fired: false, pivot: null, home: null };
}

/** p += (r - p) * k per landmark (z by kz), v taken from r. */
function mixInto(prev: Lm[], raw: Lm[], k: number, kz: number): void {
  for (let i = 0; i < raw.length; i++) {
    const p = prev[i], r = raw[i];
    p.x = p.x + (r.x - p.x) * k;
    p.y = p.y + (r.y - p.y) * k;
    p.z = p.z + (r.z - p.z) * kz;
    p.v = r.v;
  }
}

function clone(f: PoseFrame): PoseFrame {
  return { t: f.t, img: f.img.map((p) => ({ ...p })), world: f.world.map((p) => ({ ...p })) };
}
