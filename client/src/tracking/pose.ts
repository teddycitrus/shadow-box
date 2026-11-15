import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Lm, PoseFrame } from './frame.ts';

const BASE = import.meta.env.BASE_URL;

export type PoseModel = 'full' | 'lite';

/** Auto model choice: drop from full to lite when tracking stays under MIN_FPS for SLOW_MS because detection is the bottleneck. */
const MIN_FPS = 28;
const SLOW_MS = 2_000;
/** Measuring starts this long after tracking starts (the first frames include GPU warm-up). */
const WARMUP_MS = 1_500;

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
  private startedAt = 0;
  private slowSince: number | null = null;
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
    this.fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
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
      lm = await PoseLandmarker.createFromOptions(this.fileset!, this.opts(model, 'GPU'));
      delegate = 'GPU';
    } catch {
      lm = await PoseLandmarker.createFromOptions(this.fileset!, this.opts(model, 'CPU'));
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
      this.onFrame(null);
      return;
    }
    const aspect = v.videoWidth / v.videoHeight;
    const conv = (p: { x: number; y: number; z: number; visibility?: number }, k: number): Lm => ({
      x: p.x * k, y: p.y, z: p.z, v: p.visibility ?? 1,
    });
    this.onFrame({ t, img: img.map((p) => conv(p, aspect)), world: world.map((p) => conv(p, 1)) });
  }

  /**
   * Switches full to lite once tracking has stayed under MIN_FPS for SLOW_MS, but only when the
   * detector is what holds it back (camera frames skipped, or detection too slow for MIN_FPS).
   * A camera that simply delivers fewer frames keeps the more accurate full model.
   */
  private adapt(now: number): void {
    if (this.pinned || this.model === 'lite' || now - this.startedAt < WARMUP_MS) return;
    const fps = this.fps;
    while (this.skipTimes.length && now - this.skipTimes[0] >= 1000) this.skipTimes.shift();
    const bottleneck = this.skipTimes.length >= 3 || this.detectTime > 1000 / MIN_FPS;
    if (fps >= MIN_FPS || !bottleneck) {
      this.slowSince = null;
      return;
    }
    this.slowSince ??= now;
    if (now - this.slowSince < SLOW_MS) return;
    this.switching = true;
    void this.load('lite')
      .catch(() => {
        // Keep the full model when lite cannot be loaded.
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
