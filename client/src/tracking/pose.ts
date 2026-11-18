import type { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

/** MediaPipe loads only when the camera starts, so the title screen and keyboard mode skip it. */
const vision = () => import('@mediapipe/tasks-vision');
import type { Lm, PoseFrame } from './frame.ts';
import type { FromWorker, ToWorker } from './pose-worker.ts';

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
/** How long the worker may take to answer (init includes wasm and model download). */
const WORKER_TIMEOUT_MS = 30_000;

/**
 * Where tracked frames are lost, over the last second. Skipped frames never reached the model
 * (it or the page was busy); lost frames went through it but no pose was found (blur, framing).
 */
export interface TrackerHealth {
  /** Frame rate the camera reports it is set to, or null when the browser does not say (or for ?replay=). */
  cameraFps: number | null;
  /** Camera frames delivered (tracked plus skipped). */
  deliveredFps: number;
  trackedFps: number;
  skippedPerSec: number;
  lostPerSec: number;
  detectMs: number;
  backend: 'main' | 'worker';
  /** Manual exposure applied with ?exposure=, in ms, or null for the camera's auto exposure. */
  exposureMs: number | null;
}

type Processor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };
/** Media Capture Image exposure fields, which lib.dom does not type. exposureTime is in 100 us units. */
interface ExposureCaps {
  exposureMode?: string[];
  exposureTime?: { min: number; max: number; step?: number };
}

/**
 * Webcam plus MediaPipe Pose Landmarker, all assets served locally. URL flags: ?worker=1 detects
 * in a Web Worker (main thread on failure), ?replay=<url> tracks a video file at ?replayRate=
 * (default 0.5) instead of the camera, ?exposure=<ms> sets a manual camera exposure.
 */
export class PoseTracker {
  readonly video = document.createElement('video');
  private landmarker: PoseLandmarker | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
  private lastVideoTime = -1;
  private lastTs = -Infinity;
  private running = false;
  private stopped = false;
  private switching = false;
  private looping = false;
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
  /** ?worker=1: the detection worker, and whether frames reach it as VideoFrames or posted bitmaps. */
  private worker: Worker | null = null;
  private feed: 'stream' | 'bitmap' | null = null;
  /** A bitmap is with the worker; frames until it answers are skipped (latest frame wins). */
  private workerBusy = false;
  /** Called when the worker answers a bitmap (used to warm up before a replay plays). */
  private idle: (() => void) | null = null;
  private waiters = new Map<FromWorker['type'], { ok: (m: FromWorker) => void; fail: (e: Error) => void }>();
  /** ?replay=: frame times are video time plus this offset, fixed at the first frame. */
  private replay = false;
  private replayOff: number | null = null;
  private exposureMs: number | null = null;
  /** The track whose exposure was set manually, restored to continuous on stop and pagehide. */
  private exposureTrack: MediaStreamTrack | null = null;

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
      cameraFps: this.replay ? null : track?.getSettings().frameRate ?? null,
      deliveredFps: tracked + this.skipTimes.length,
      trackedFps: tracked,
      skippedPerSec: this.skipTimes.length,
      lostPerSec: this.lostTimes.length,
      detectMs: this.detectTime,
      backend: this.worker ? 'worker' : 'main',
      exposureMs: this.exposureMs,
    };
  }

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const q = params.get('model');
    if (q === 'lite' || q === 'full') {
      this.model = q;
      this.pinned = true;
    }
    const replay = params.get('replay');
    this.video.muted = true;
    this.video.playsInline = true;
    if (replay) {
      // Dev evaluation: a recorded video stands in for the camera, slowed so detection keeps up.
      const rate = Number(params.get('replayRate') ?? 0.5);
      this.replay = true;
      // Runs compare upstream changes, so the model must not depend on machine speed.
      this.pinned = true;
      this.video.src = replay;
      this.video.defaultPlaybackRate = this.video.playbackRate = rate > 0 && rate <= 16 ? rate : 0.5;
      this.video.preload = 'auto';
      await new Promise<void>((ok, fail) => {
        this.video.addEventListener('loadeddata', () => ok(), { once: true });
        this.video.addEventListener('error', () => fail(new Error(`?replay= could not load ${replay}`)), { once: true });
      });
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
        audio: false,
      });
      this.video.srcObject = stream;
      const exposure = Number(params.get('exposure'));
      if (params.has('exposure') && exposure > 0) await this.setExposure(stream.getVideoTracks()[0], exposure);
      await this.video.play();
    }
    if (params.get('worker') === '1') {
      try {
        await this.startWorker();
      } catch (e) {
        this.killWorker();
        if (this.stopped) return;
        console.warn(`pose worker unavailable, tracking on the main thread: ${String(e)}`);
      }
    }
    if (!this.worker && !this.stopped) await this.startMain();
    // A replay plays only once the model is ready and warmed up on the first frame (which is already
    // on screen, so frame callbacks would not report it), so slow first detections skip nothing.
    if (this.replay && !this.stopped) {
      const now = performance.now();
      const warm = this.feed === 'bitmap' ? new Promise<void>((ok) => (this.idle = ok)) : null;
      this.frame(this.replayTime(this.video.currentTime, now), now);
      if (warm) await Promise.race([warm, new Promise((ok) => setTimeout(ok, WORKER_TIMEOUT_MS))]);
      this.idle = null;
      await this.video.play();
    }
  }

  private async startMain(): Promise<void> {
    this.fileset = await (await vision()).FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    await this.load(this.model);
    if (this.stopped) return this.landmarker?.close();
    this.running = true;
    this.startedAt = performance.now();
    this.loop();
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

  /** Creates the landmarker for a model, GPU first with a CPU fallback (in the worker when there is one). */
  private async load(model: PoseModel): Promise<void> {
    if (this.worker) {
      const m = await this.ask('loaded', { type: 'model', model });
      if (!m.ok) throw new Error(m.message);
      this.delegate = m.delegate;
    } else {
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
    }
    this.model = model;
    this.detectMs = [];
    this.slowSince = null;
  }

  /**
   * Starts the detection worker and picks how frames reach it, best first: the camera track itself
   * (worker-side MediaStreamTrackProcessor, no page involvement per frame), a page-side
   * processor's readable stream (detection still off the page), or bitmaps of the video element.
   */
  private async startWorker(): Promise<void> {
    const w = new Worker(new URL('./pose-worker.ts', import.meta.url), { type: 'module' });
    this.worker = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    w.onerror = (e) => {
      e.preventDefault();
      this.workerError(e.message || 'worker script error');
    };
    const base = new URL(BASE, location.href).href;
    const ready = await this.ask('ready', { type: 'init', base, model: this.model, origin: performance.timeOrigin });
    this.delegate = ready.delegate;
    this.running = true;
    this.startedAt = performance.now();
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (track && ready.mstp) {
      const clone = track.clone();
      try {
        const m = await this.ask('source', { type: 'track', track: clone }, [clone]);
        if (m.ok) this.feed = 'stream';
      } catch {
        // MediaStreamTrack is not transferable in this browser.
        clone.stop();
      }
    }
    const MSTP = (globalThis as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor;
    if (track && !this.feed && MSTP) {
      try {
        const { readable } = new MSTP({ track, maxBufferSize: 8 });
        const m = await this.ask('source', { type: 'readable', readable }, [readable as unknown as Transferable]);
        if (m.ok) this.feed = 'stream';
      } catch {
        // Readable streams are not transferable here; bitmaps below.
      }
    }
    if (!this.feed) {
      this.feed = 'bitmap';
      this.loop();
    }
  }

  /** Posts a message to the worker and waits for its reply of the given type. */
  private ask<T extends FromWorker['type']>(type: T, msg: ToWorker, transfer: Transferable[] = []): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.waiters.delete(type);
        fail(new Error(`no ${type} reply within ${WORKER_TIMEOUT_MS} ms`));
      }, WORKER_TIMEOUT_MS);
      this.waiters.set(type, {
        ok: (m) => {
          clearTimeout(timer);
          ok(m as Extract<FromWorker, { type: T }>);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      try {
        this.worker!.postMessage(msg, transfer);
      } catch (e) {
        this.waiters.get(type)?.fail(e as Error);
        this.waiters.delete(type);
      }
    });
  }

  private onWorker(m: FromWorker): void {
    if (m.type === 'result' || m.type === 'dropped') {
      this.workerBusy = false;
      if (m.type === 'result') this.workerResult(m);
      this.idle?.();
    } else if (m.type === 'error') {
      this.workerError(m.message);
    } else {
      const w = this.waiters.get(m.type);
      this.waiters.delete(m.type);
      w?.ok(m);
    }
  }

  /** Before tracking runs the caller of ask() handles it; afterwards tracking moves to the main thread. */
  private workerError(why: string): void {
    if (this.waiters.size) {
      for (const w of this.waiters.values()) w.fail(new Error(why));
      this.waiters.clear();
      return;
    }
    if (!this.worker || !this.running) return;
    console.warn(`pose worker failed, tracking on the main thread: ${why}`);
    this.killWorker();
    this.startMain().catch((e) => console.error('pose tracking could not restart on the main thread', e));
  }

  private killWorker(): void {
    const w = this.worker;
    this.worker = null;
    this.feed = null;
    this.workerBusy = false;
    this.idle?.();
    for (const x of this.waiters.values()) x.fail(new Error('worker stopped'));
    this.waiters.clear();
    if (!w) return;
    w.onmessage = w.onerror = null;
    try {
      w.postMessage({ type: 'stop' } satisfies ToWorker);
    } catch {
      // Already gone.
    }
    // The worker closes itself on stop; terminate in case it is stuck.
    setTimeout(() => w.terminate(), 1_000);
  }

  private workerResult(m: Extract<FromWorker, { type: 'result' }>): void {
    if (!this.running) return;
    const now = performance.now();
    for (let i = 0; i < Math.min(m.skipped, 10); i++) this.skipTimes.push(now);
    this.detectMs.push(m.detectMs);
    if (this.detectMs.length > 30) this.detectMs.shift();
    this.frameTimes.push(now);
    this.adapt(now);
    if (!m.lms) {
      this.lostTimes.push(now);
      if (this.lostTimes.length > 120) this.lostTimes.shift();
      this.onFrame(null);
      return;
    }
    const n = m.lms.length / 8;
    this.onFrame({ t: m.t, img: fromArray(m.lms, 0, n, m.aspect), world: fromArray(m.lms, n, n, 1) });
  }

  /** Starts the per-frame loop once (main-thread detection, or bitmaps for the worker). */
  private loop(): void {
    if (this.looping) return;
    this.looping = true;
    this.schedule();
  }

  /** One detection per new camera frame: requestVideoFrameCallback when available, else rAF with a currentTime check. */
  private schedule(): void {
    if (!this.running) {
      this.looping = false;
      return;
    }
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback((now, meta) => {
        this.schedule();
        const skipped = this.presented >= 0 ? meta.presentedFrames - this.presented - 1 : 0;
        for (let i = 0; i < Math.min(skipped, 10); i++) this.skipTimes.push(now);
        this.presented = meta.presentedFrames;
        if (this.replay) {
          this.frame(this.replayTime(meta.mediaTime, now), now);
          return;
        }
        // The camera's capture time is the truest frame time (velocities depend on it); fall back to
        // when the frame was presented if it is missing or not on the performance.now() clock.
        const cap = meta.captureTime;
        const t = cap !== undefined && cap <= now + 5 && cap > now - 500 ? cap : meta.presentationTime;
        this.frame(t, now);
      });
    } else {
      requestAnimationFrame((now) => {
        this.schedule();
        if (v.currentTime === this.lastVideoTime) return;
        this.lastVideoTime = v.currentTime;
        this.frame(this.replay ? this.replayTime(v.currentTime, now) : performance.now(), now);
      });
    }
  }

  /** Replay frame time: video time in ms plus an offset fixed at the first frame, so it does not depend on machine speed. */
  private replayTime(mediaTime: number, now: number): number {
    this.replayOff ??= now - mediaTime * 1000;
    return this.replayOff + mediaTime * 1000;
  }

  private frame(t: number, now: number): void {
    if (this.feed === 'bitmap') this.postBitmap(t, now);
    else if (!this.worker) this.detect(t);
  }

  /** Worker without a VideoFrame stream: copy the frame to a bitmap and transfer it, unless one is in flight. */
  private postBitmap(t: number, now: number): void {
    const v = this.video;
    const w = this.worker;
    if (!w || this.switching || v.readyState < 2) return;
    if (this.workerBusy) {
      this.skipTimes.push(now);
      return;
    }
    this.workerBusy = true;
    const aspect = v.videoWidth / v.videoHeight;
    createImageBitmap(v).then(
      (bitmap) => {
        if (this.worker !== w) return bitmap.close();
        w.postMessage({ type: 'frame', bitmap, t, aspect } satisfies ToWorker, [bitmap]);
      },
      () => {
        this.workerBusy = false;
      },
    );
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

  /**
   * ?exposure=<ms>: a short manual exposure cuts motion blur on fast punches (the image gets darker).
   * Media Capture Image exposureTime is in 100 us units, clamped to what the camera reports.
   */
  private async setExposure(track: MediaStreamTrack | undefined, ms: number): Promise<void> {
    const caps = (track?.getCapabilities?.() ?? {}) as ExposureCaps;
    const range = caps.exposureTime;
    if (!track || !caps.exposureMode?.includes('manual') || !range) {
      console.info('?exposure= ignored: this camera or browser has no manual exposure control');
      return;
    }
    const units = Math.min(range.max, Math.max(range.min, ms * 10));
    try {
      await track.applyConstraints(exposure({ exposureMode: 'manual', exposureTime: units }));
    } catch (e) {
      console.info(`?exposure= ignored: the camera refused it (${String(e)})`);
      return;
    }
    // Unsatisfiable advanced constraints are dropped silently, so check what the camera took.
    const set = track.getSettings() as { exposureMode?: string; exposureTime?: number };
    if (set.exposureMode !== 'manual') {
      console.info('?exposure= ignored: the camera kept its auto exposure');
      return;
    }
    this.exposureMs = (set.exposureTime ?? units) / 10;
    this.exposureTrack = track;
    addEventListener('pagehide', this.restoreExposure);
  }

  /** Puts auto exposure back, since some cameras keep a manual setting for other apps. */
  private restoreExposure = (): Promise<void> | null => {
    const track = this.exposureTrack;
    this.exposureTrack = null;
    this.exposureMs = null;
    removeEventListener('pagehide', this.restoreExposure);
    if (!track || track.readyState === 'ended') return null;
    return track
      .applyConstraints(exposure({ exposureMode: 'continuous' }))
      .catch(() => {});
  };

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.killWorker();
    this.landmarker?.close();
    this.landmarker = null;
    const stream = this.video.srcObject as MediaStream | null;
    const end = () => stream?.getTracks().forEach((t) => t.stop());
    const restoring = this.restoreExposure();
    if (restoring) void restoring.finally(end);
    else end();
    if (this.replay) this.video.pause();
  }
}

function exposure(set: { exposureMode: string; exposureTime?: number }): MediaTrackConstraints {
  return { advanced: [set] } as unknown as MediaTrackConstraints;
}

/** MediaPipe landmarks as Lm, x scaled by k (the frame aspect ratio for image landmarks). */
function toLms(ps: { x: number; y: number; z: number; visibility?: number }[], k: number): Lm[] {
  const out: Lm[] = [];
  for (const p of ps) out.push({ x: p.x * k, y: p.y, z: p.z, v: p.visibility ?? 1 });
  return out;
}

/** Landmarks packed by the worker (x, y, z, visibility per point) as Lm, like toLms. */
function fromArray(a: Float32Array, from: number, n: number, k: number): Lm[] {
  const out: Lm[] = [];
  for (let i = from * 4; i < (from + n) * 4; i += 4) out.push({ x: a[i] * k, y: a[i + 1], z: a[i + 2], v: a[i + 3] });
  return out;
}
