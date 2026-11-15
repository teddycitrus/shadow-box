import { NO_DEFENSE, WIRE_LANDMARKS, type DefenseState, type Hand, type Punch, type PunchType, type Stance, type WirePose } from '../../../shared/types.ts';
import { Calibrator, looksLikeGuard, type Calibration, type CalibrationStatus } from './calibration.ts';
import { Classifier, type ClassifierOutput } from './classifier.ts';
import { SessionLog } from './session.ts';
import { Teacher, modelFrom, type MoveScore, type Profile, type TeachStatus } from './teach.ts';
import type { Lm, PoseFrame } from './frame.ts';
import { PoseTracker } from './pose.ts';
import { loadPrior, priorSamples, uploadCalibration } from './share.ts';
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
  readonly stats: string;
  /** Guided punch teaching in progress, or null. */
  readonly teach: TeachStatus | null;
  /** Moves learned for this player, empty when using the default rules. */
  readonly learned: string[];
  /** How well each move was read back in the last calibration's verify phase. */
  readonly scores: MoveScore[];
  onTick: (t: InputTick) => void;
  start(): Promise<void>;
  recalibrate(): void;
  /** Start (or restart) the guided punch teaching. */
  reteach(): void;
  /** Skip teaching and use the hand-written rules. */
  skipTeach(): void;
}

/** Bump when the feature vector changes so old profiles are not reused. */
const PROFILE_KEY = 'shadowbox:profile:v4';

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
  private teacher: Teacher | null = null;
  teach: TeachStatus | null = null;
  learned: string[] = [];
  scores: MoveScore[] = [];
  /** Dev-only session recording, enabled with ?debug=1 on the Vite dev server. */
  readonly log: SessionLog | null = import.meta.env.DEV && new URLSearchParams(location.search).get('debug') === '1' ? new SessionLog() : null;
  private lastTeachIndex = -1;
  private lastTeachKey = '';
  private lastDefenseKey = '';

  get calibrated(): boolean {
    return this.classifier !== null && this.teacher === null;
  }

  get video(): HTMLVideoElement {
    return this.tracker.video;
  }

  get stats(): string {
    const tr = this.tracker;
    return tr.delegate ? `${tr.delegate} ${tr.model} ${tr.fps} fps ${tr.detectTime.toFixed(0)} ms` : 'loading';
  }

  async start(): Promise<void> {
    // Dev server only: lets scripted UI checks feed synthetic poses instead of the webcam.
    if (import.meta.env.DEV) (globalThis as { __input?: CameraInput }).__input = this;
    this.tracker.onFrame = (f) => this.handle(f);
    // The population prior is optional; once it arrives, rebuild an already applied profile with it.
    void loadPrior().then((pr) => {
      const p = pr && this.classifier && !this.teacher ? this.loadProfile() : null;
      if (p) this.apply(p);
    });
    await this.tracker.start();
  }

  recalibrate(): void {
    this.calibrator.reset();
    this.classifier = null;
    this.calibration = null;
    this.teacher = null;
    this.teach = null;
  }

  reteach(): void {
    if (!this.classifier) return;
    const teacher = new Teacher(this.stance);
    this.teacher = teacher;
    this.lastTeachIndex = -1;
    this.lastTeachKey = '';
    this.log?.mark(performance.now(), 'teachStart');
    const c = this.classifier;
    c.model = (seg) => teacher.decide(seg);
    c.onSegment = (seg) => this.teacher?.segment(seg);
  }

  skipTeach(): void {
    localStorage.removeItem(PROFILE_KEY);
    this.teacher = null;
    this.teach = null;
    this.learned = [];
    this.scores = [];
    if (this.classifier) {
      this.classifier.model = undefined;
      this.classifier.onSegment = undefined;
    }
  }

  private apply(p: Profile): void {
    const c = this.classifier!;
    const m = modelFrom(p, priorSamples(this.stance));
    c.model = m ? (seg) => m.decide(seg, this.stance, p.bodySplit) : undefined;
    c.onSegment = undefined;
    c.defenseThresholds = { ...p.defense };
    this.learned = p.learned;
    this.scores = p.scores ?? [];
  }

  private loadProfile(): Profile | null {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as Profile | null;
      return p && p.version === 4 && Array.isArray(p.samples) ? p : null;
    } catch {
      return null;
    }
  }

  private handle(f: PoseFrame | null): void {
    this.frame = f;
    if (f) this.log?.frame(f);
    if (!this.classifier) {
      this.status = this.calibrator.update(f);
      if (this.status.stage === 'done') {
        this.calibration = this.status.cal;
        this.classifier = new Classifier(this.status.cal);
        this.classifier.onDecision = (seg, p, why) => {
          this.teacher?.decision(seg, p);
          this.log?.mark(seg.endT, 'decision', { seg: { ...seg, path: undefined }, punch: p, why });
        };
        if (this.log) {
          this.log.calibration = this.status.cal;
          this.log.mark(f?.t ?? 0, 'calibrated', this.status.cal);
          this.classifier.onIgnored = (hand, t, why) => this.log!.mark(t, 'ignored', { hand, why });
        }
        const saved = this.loadProfile();
        if (saved) this.apply(saved);
        else this.reteach();
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
    if (this.teacher) c.canPunch = true;
    const out = c.update(f);
    this.debug = out;
    const feat = out.features!;
    if (this.teacher) {
      this.teach = this.teacher.update(f.t, feat);
      const key = `${this.teach.index}:${this.teach.phase === 'verify' ? this.teach.step?.id ?? '' : ''}`;
      if (this.teach.index !== this.lastTeachIndex || key !== this.lastTeachKey) {
        this.lastTeachIndex = this.teach.index;
        this.lastTeachKey = key;
        if (this.teach.step) this.log?.mark(f.t, this.teach.phase === 'verify' ? 'verifyStep' : 'teachStep', this.teach.step);
      }
      if (this.teach.done) {
        const p = this.teacher.profile();
        this.log?.mark(f.t, 'teachDone', { learned: p.learned, defense: p.defense, scores: p.scores });
        void this.log?.save('teach', { stance: this.stance, profile: p });
        localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
        void uploadCalibration(p, { stance: this.stance, fps: this.tracker.fps, model: this.tracker.model });
        this.teacher = null;
        this.apply(p);
      }
      this.onTick({ pose: toWire(f.world, [feat.headDx, feat.headDy]), defense: out.defense, punches: [] });
      return;
    }
    if (this.log) {
      for (const p of out.punches) this.log.mark(f.t, 'punch', p);
      const key = JSON.stringify(out.defense);
      if (key !== this.lastDefenseKey) {
        this.lastDefenseKey = key;
        this.log.mark(f.t, 'defense', out.defense);
      }
    }
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
  readonly stats = 'keyboard';
  readonly teach = null;
  readonly learned = [];
  readonly scores = [];
  reteach(): void {}
  skipTeach(): void {}
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
