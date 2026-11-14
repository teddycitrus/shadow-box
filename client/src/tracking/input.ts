import { NO_DEFENSE, WIRE_LANDMARKS, type DefenseState, type Hand, type Punch, type PunchType, type Stance, type WirePose } from '../../../shared/types.ts';
import { Calibrator, looksLikeGuard, type Calibration, type CalibrationStatus } from './calibration.ts';
import { Classifier, type ClassifierOutput } from './classifier.ts';
import type { Lm, PoseFrame } from './frame.ts';
import { PoseTracker } from './pose.ts';
import { PUNCH_TIMING, punchDuration, synthPose, type SynthPunch } from './synthetic.ts';

export interface InputTick {
  pose: WirePose | null;
  defense: DefenseState;
  /** `at` is the peak time in performance.now() milliseconds. */
  punches: (Punch & { at: number })[];
}

export interface InputSource {
  readonly kind: 'camera' | 'keys';
  stance: Stance;
  gassed: boolean;
  canPunch: boolean;
  readonly calibrated: boolean;
  readonly status: CalibrationStatus | null;
  readonly frame: PoseFrame | null;
  readonly debug: ClassifierOutput | null;
  readonly calibration: Calibration | null;
  readonly video: HTMLVideoElement | null;
  onTick: (t: InputTick) => void;
  start(): Promise<void>;
  recalibrate(): void;
}

export const SW_METRES = 0.38;

export function toWire(world: Lm[], off: [number, number]): WirePose {
  const lm: number[] = [];
  for (const i of WIRE_LANDMARKS) lm.push(Math.round(world[i].x * 1000), Math.round(world[i].y * 1000), Math.round(world[i].z * 1000));
  return { lm, off: [Math.round(off[0] * 100), Math.round(off[1] * 100)] };
}

export class CameraInput implements InputSource {
  readonly kind = 'camera';
  stance: Stance = 'orthodox';
  gassed = false;
  canPunch = true;
  status: CalibrationStatus | null = null;
  frame: PoseFrame | null = null;
  debug: ClassifierOutput | null = null;
  calibration: Calibration | null = null;
  onTick: (t: InputTick) => void = () => {};
  private tracker = new PoseTracker();
  private calibrator = new Calibrator();
  private classifier: Classifier | null = null;

  get calibrated(): boolean {
    return this.classifier !== null;
  }

  get video(): HTMLVideoElement {
    return this.tracker.video;
  }

  async start(): Promise<void> {
    this.tracker.onFrame = (f) => this.handle(f);
    await this.tracker.start();
  }

  recalibrate(): void {
    this.calibrator.reset();
    this.classifier = null;
    this.calibration = null;
  }

  private handle(f: PoseFrame | null): void {
    this.frame = f;
    if (!this.classifier) {
      this.status = this.calibrator.update(f);
      if (this.status.stage === 'done') {
        this.calibration = this.status.cal;
        this.classifier = new Classifier(this.status.cal);
      }
      if (f) this.onTick({ pose: toWire(f.world, [0, 0]), defense: { ...NO_DEFENSE, guard: looksLikeGuard(f) }, punches: [] });
      return;
    }
    if (!f) {
      this.onTick({ pose: null, defense: NO_DEFENSE, punches: [] });
      return;
    }
    const c = this.classifier;
    c.stance = this.stance;
    c.gassed = this.gassed;
    c.canPunch = this.canPunch;
    const out = c.update(f);
    this.debug = out;
    const feat = out.features!;
    this.onTick({ pose: toWire(f.world, [feat.headDx, feat.headDy]), defense: out.defense, punches: out.punches });
  }
}

const PUNCH_KEYS: Record<string, PunchType> = {
  KeyJ: 'jab', KeyK: 'cross', KeyU: 'leftHook', KeyI: 'rightHook', KeyN: 'leftUppercut', KeyM: 'rightUppercut',
};

export const KEY_HELP = [
  ['J', 'Jab'], ['K', 'Cross'], ['U / I', 'Left / right hook'], ['N / M', 'Left / right uppercut'],
  ['Shift + punch', 'Body shot'], ['Space (hold)', 'High guard'], ['S (hold)', 'Duck'], ['A / D (hold)', 'Slip left / right'],
] as const;

/** ?keys=1: keyboard simulation of every punch and defense, with a procedural pose. */
export class KeyInput implements InputSource {
  readonly kind = 'keys';
  stance: Stance = 'orthodox';
  gassed = false;
  canPunch = true;
  readonly calibrated = true;
  readonly status = null;
  readonly frame = null;
  readonly debug = null;
  readonly calibration = null;
  readonly video = null;
  onTick: (t: InputTick) => void = () => {};
  private held = new Set<string>();
  private punches: Record<Hand, SynthPunch | null> = { left: null, right: null };
  private queued: (Punch & { at: number })[] = [];
  private lastDefense = NO_DEFENSE;

  async start(): Promise<void> {
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
      const type = PUNCH_KEYS[e.code];
      if (type) this.throw(type, e.shiftKey ? 'body' : 'head');
    });
    addEventListener('keyup', (e) => this.held.delete(e.code));
    addEventListener('blur', () => this.held.clear());
    setInterval(() => this.tick(), 1000 / 30);
  }

  recalibrate(): void {}

  private handFor(type: PunchType): Hand {
    if (type === 'jab') return this.stance === 'orthodox' ? 'left' : 'right';
    if (type === 'cross') return this.stance === 'orthodox' ? 'right' : 'left';
    return type.startsWith('left') ? 'left' : 'right';
  }

  private throw(type: PunchType, target: 'head' | 'body'): void {
    const hand = this.handFor(type);
    const now = performance.now();
    const busy = this.punches[hand];
    const cooldown = this.gassed ? 450 : 250;
    if (!this.canPunch || (busy && now < busy.startT + punchDuration(busy) + cooldown - PUNCH_TIMING.retractMs)) return;
    const p: SynthPunch = { type, hand, target, startT: now, windupMs: 0 };
    this.punches[hand] = p;
    this.queued.push({ type, hand, target, at: now + PUNCH_TIMING.extendMs });
  }

  private defense(): DefenseState {
    const h = this.held;
    const slip = h.has('KeyA') ? 'left' : h.has('KeyD') ? 'right' : 'none';
    return { guard: h.has('Space'), duck: h.has('KeyS') || h.has('ArrowDown'), slip };
  }

  private tick(): void {
    const now = performance.now();
    const defense = this.defense();
    const due = this.queued.filter((p) => p.at <= now);
    this.queued = this.queued.filter((p) => p.at > now);
    const active = [this.punches.left, this.punches.right].find((p) => p && now < p.startT + punchDuration(p)) ?? undefined;
    const { world, offset } = synthPose({ t: now, defense, punch: active, gassed: this.gassed });
    this.lastDefense = defense;
    this.onTick({ pose: toWire(world, [offset[0] / SW_METRES, offset[1] / SW_METRES]), defense: this.lastDefense, punches: due });
  }
}
