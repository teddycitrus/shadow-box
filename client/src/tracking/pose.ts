import type { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

/** MediaPipe loads only when the camera starts, so the title screen and keyboard mode skip it. */
const vision = () => import('@mediapipe/tasks-vision');
import type { Lm, PoseFrame } from './frame.ts';

const BASE = import.meta.env.BASE_URL;

export type PoseModel = 'full' | 'lite';

/**
 * Auto model choice: try lite when, for SLOW_MS, the full model is what holds tracking back and it
 * tracks under MIN_FPS or misses more than MAX_MISSED of the camera's frames (fast punches span few
 * frames, so every camera frame counts). Lite is kept only when it tracks at least LITE_GAIN times
 * as many frames per second; otherwise the full model comes back for good.
 */
const MIN_FPS = 28;
const MAX_MISSED = 0.15;
const LITE_GAIN = 1.2;
const SLOW_MS = 2_000;
/** Measuring starts this long after tracking starts (the first frames include GPU warm-up). */
const WARMUP_MS = 1_500;

/**
 * Where tracked frames are lost, over the last second. Skipped frames never reached the model
 * (it or the page was busy); lost frames went through it but no pose was found (blur, framing).
 */
export interface TrackerHealth {
  /** Frame rate the camera reports it is set to, or null when the browser does not say. */
  cameraFps: number | null;
  /** Camera frames delivered (tracked plus skipped). */
  deliveredFps: number;
  trackedFps: number;
  skippedPerSec: number;
  lostPerSec: number;
  detectMs: number;
  backend: 'main' | 'worker';
}

/** Webcam plus MediaPipe Pose Landmarker, all assets served locally. */
export class PoseTracker {
  readonly video = document.createElement('video');
  private landmarker: PoseLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastVideoTime = -1;
  private lastTs = -Infinity;
  private running = false;
  private switching = false;
  private frameTimes: number[] = [];
  /** Recent detection times (ms) and how many camera frames went by unprocessed. */
  private detectMs: number[] = [];
  private presented = -1;
  private skipTimes: number[] = [];
  private lostTimes: number[] = [];
  private startedAt = 0;
  private slowSince: number | null = null;
  /** While trying lite: the full model's tracking rate and when lite started. */
  private trial: { fullFps: number; since: number } | null = null;
  delegate: 'GPU' | 'CPU' | null = null;
  model: PoseModel = 'full';
  /** True when the model was picked with ?model= and must not change. */
  private pinned = false;
  onFrame: (f: PoseFrame | null) => void = () => {};

  /** Tracked frames per second over the last second. */
  get fps(): number {
    const now = performance.now();
    while (this.frameTimes.length && now - this.frameTimes[0] >= 1000) this.frameTimes.shift();
    return this.frameTimes.length;
  }

  /** Mean detection time over the recent frames, in ms. */
  get detectTime(): number {
    return this.detectMs.length ? this.detectMs.reduce((a, b) => a + b, 0) / this.detectMs.length : 0;
  }

  get health(): TrackerHealth {
    const now = performance.now();
    for (const ts of [this.skipTimes, this.lostTimes]) while (ts.length && now - ts[0] >= 1000) ts.shift();
    const tracked = this.fps;
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    return {
      cameraFps: track?.getSettings().frameRate ?? null,
      deliveredFps: tracked + this.skipTimes.length,
      trackedFps: tracked,
      skippedPerSec: this.skipTimes.length,
      lostPerSec: this.lostTimes.length,
      detectMs: this.detectTime,
      backend: 'main',
    };
  }

  async start(): Promise<void> {
    const q = new URLSearchParams(location.search).get('model');
    if (q === 'lite' || q === 'full') {
      this.model = q;
      this.pinned = true;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.fileset = await (await vision()).FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    await this.load(this.model);
    this.running = true;
    this.startedAt = performance.now();
    this.schedule();
  }

  private opts(model: PoseModel, delegate: 'GPU' | 'CPU') {
    return {
      baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate },
      runningMode: 'VIDEO' as const,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
  }

  /** Creates the landmarker for a model, GPU first with a CPU fallback. */
  private async load(model: PoseModel): Promise<void> {
    let lm: PoseLandmarker;
    let delegate: 'GPU' | 'CPU';
    try {
      lm = await (await vision()).PoseLandmarker.createFromOptions(this.fileset!, this.opts(model, 'GPU'));
      delegate = 'GPU';
    } catch {
      lm = await (await vision()).PoseLandmarker.createFromOptions(this.fileset!, this.opts(model, 'CPU'));
      delegate = 'CPU';
    }
    this.landmarker?.close();
    this.landmarker = lm;
    this.delegate = delegate;
    this.model = model;
    this.detectMs = [];
    this.slowSince = null;
  }

  /** One detection per new camera frame: requestVideoFrameCallback when available, else rAF with a currentTime check. */
  private schedule(): void {
    if (!this.running) return;
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback((now, meta) => {
        this.schedule();
        const skipped = this.presented >= 0 ? meta.presentedFrames - this.presented - 1 : 0;
        for (let i = 0; i < Math.min(skipped, 10); i++) this.skipTimes.push(now);
        this.presented = meta.presentedFrames;
        // The camera's capture time is the truest frame time (velocities depend on it); fall back to
        // when the frame was presented if it is missing or not on the performance.now() clock.
        const cap = meta.captureTime;
        const t = cap !== undefined && cap <= now + 5 && cap > now - 500 ? cap : meta.presentationTime;
        this.detect(t);
      });
    } else {
      requestAnimationFrame(() => {
        this.schedule();
        if (v.currentTime === this.lastVideoTime) return;
        this.lastVideoTime = v.currentTime;
        this.detect(performance.now());
      });
    }
  }

  private detect(frameT: number): void {
    const v = this.video;
    if (!this.landmarker || this.switching || v.readyState < 2) return;
    // MediaPipe needs strictly increasing timestamps.
    const t = Math.max(frameT, this.lastTs + 1);
    this.lastTs = t;
    const t0 = performance.now();
    const res = this.landmarker.detectForVideo(v, t);
    const t1 = performance.now();
    this.detectMs.push(t1 - t0);
    if (this.detectMs.length > 30) this.detectMs.shift();
    this.frameTimes.push(t1);
    this.adapt(t1);
    const img = res.landmarks[0];
    const world = res.worldLandmarks[0];
    if (!img || !world) {
      this.lostTimes.push(t1);
      if (this.lostTimes.length > 120) this.lostTimes.shift();
      this.onFrame(null);
      return;
    }
    this.onFrame({ t, img: toLms(img, v.videoWidth / v.videoHeight), world: toLms(world, 1) });
  }

  /**
   * Tries lite once the full model has held tracking back for SLOW_MS (see MIN_FPS), but only when
   * the detector is the bottleneck (camera frames skipped, or detection too slow for the camera).
   * A camera that simply delivers fewer frames keeps the more accurate full model. After a trial
   * of SLOW_MS past warm-up, lite stays only if it tracks LITE_GAIN times as many frames.
   */
  private adapt(now: number): void {
    if (this.pinned || this.switching || now - this.startedAt < WARMUP_MS) return;
    const fps = this.fps;
    while (this.skipTimes.length && now - this.skipTimes[0] >= 1000) this.skipTimes.shift();
    const camFps = fps + this.skipTimes.length;
    if (this.model === 'lite') {
      const tr = this.trial;
      if (!tr || now - tr.since < WARMUP_MS + SLOW_MS) return;
      this.trial = null;
      if (fps >= tr.fullFps * LITE_GAIN) {
        this.pinned = true;
        return;
      }
      this.swap('full');
      this.pinned = true;
      return;
    }
    const bottleneck = this.skipTimes.length >= 3 || this.detectTime > 1000 / Math.max(MIN_FPS, camFps);
    const slow = fps < MIN_FPS || fps < camFps * (1 - MAX_MISSED);
    if (!slow || !bottleneck) {
      this.slowSince = null;
      return;
    }
    this.slowSince ??= now;
    if (now - this.slowSince < SLOW_MS) return;
    this.trial = { fullFps: fps, since: now };
    this.swap('lite');
  }

  private swap(model: PoseModel): void {
    this.switching = true;
    void this.load(model)
      .then(() => {
        // The trial starts once lite is running; frame counts restart for the new model.
        if (this.trial) this.trial.since = performance.now();
        this.frameTimes = [];
        this.skipTimes = [];
      })
      .catch(() => {
        // Keep the current model when the other one cannot be loaded.
        this.trial = null;
        this.pinned = true;
      })
      .finally(() => {
        this.switching = false;
      });
  }

  stop(): void {
    this.running = false;
    this.landmarker?.close();
    (this.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  }
}

/** MediaPipe landmarks as Lm, x scaled by k (the frame aspect ratio for image landmarks). */
function toLms(ps: { x: number; y: number; z: number; visibility?: number }[], k: number): Lm[] {
  const out: Lm[] = [];
  for (const p of ps) out.push({ x: p.x * k, y: p.y, z: p.z, v: p.visibility ?? 1 });
  return out;
}
