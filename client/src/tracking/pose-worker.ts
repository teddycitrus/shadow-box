/**
 * Off-main-thread pose detection for PoseTracker (?worker=1). Runs PoseLandmarker on camera frames
 * that arrive as VideoFrames (a transferred track or MediaStreamTrackProcessor readable) or as
 * ImageBitmaps posted by the page. Latest frame wins: a frame waiting while the model is busy is
 * closed and counted as skipped when a newer one arrives.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { PoseModel } from './pose.ts';

export type ToWorker =
  /** `base` is the absolute app base URL; `origin` is the page's performance.timeOrigin. */
  | { type: 'init'; base: string; model: PoseModel; origin: number }
  | { type: 'model'; model: PoseModel }
  | { type: 'track'; track: MediaStreamTrack }
  | { type: 'readable'; readable: ReadableStream<VideoFrame> }
  /** `t` is already on the page's performance.now() clock. */
  | { type: 'frame'; bitmap: ImageBitmap; t: number; aspect: number }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; mstp: boolean }
  | { type: 'loaded'; ok: true; delegate: 'GPU' | 'CPU' }
  | { type: 'loaded'; ok: false; message: string }
  | { type: 'source'; ok: boolean; message?: string }
  /**
   * `lms` holds image then world landmarks, 4 floats each (x, y, z, visibility), or null when no
   * pose was found. `skipped` counts frames closed unprocessed since the previous result.
   */
  | { type: 'result'; t: number; aspect: number; detectMs: number; skipped: number; lms: Float32Array | null }
  /** A posted bitmap was closed without detection (model loading), so the page may send the next. */
  | { type: 'dropped' }
  | { type: 'error'; message: string };

interface Scope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  importScripts: (...urls: string[]) => void;
  close(): void;
}
type Processor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };

const scope = globalThis as unknown as Scope;
const MSTP = (globalThis as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor;

/**
 * tasks-vision loads its classic wasm loader (vision_wasm_internal.js, which declares a global
 * `var ModuleFactory`) with importScripts, which throws in module workers. This stand-in fetches
 * the script synchronously and runs it with indirect eval, so it runs as global code and its
 * globals land on self just as importScripts would leave them.
 */
scope.importScripts = (...urls: string[]) => {
  for (const url of urls) {
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.send();
    if (x.status < 200 || x.status >= 300) throw new Error(`pose worker: ${url} returned ${x.status}`);
    (0, eval)(`${x.responseText}\n//# sourceURL=${url}`);
  }
};

interface Pending {
  img: VideoFrame | ImageBitmap;
  t: number;
  aspect: number;
  bitmap: boolean;
}

let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let base = '/';
let lm: PoseLandmarker | null = null;
let switching = false;
let stopped = false;
let pending: Pending | null = null;
let skipped = 0;
let lastTs = -Infinity;
/** Page clock minus worker clock, in ms. */
let clockOff = 0;
/** Smallest seen (arrival minus frame timestamp), for frames whose timestamps use another clock. */
let capOff = Infinity;
let track: MediaStreamTrack | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
const tick = new MessageChannel();
tick.port1.onmessage = () => process();

const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const pageNow = () => performance.now() + clockOff;

/** Same options as PoseTracker.opts on the page; keep the two in sync. */
function opts(model: PoseModel, delegate: 'GPU' | 'CPU') {
  return {
    baseOptions: { modelAssetPath: `${base}models/pose_landmarker_${model}.task`, delegate },
    runningMode: 'VIDEO' as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    ...(delegate === 'GPU' && typeof OffscreenCanvas !== 'undefined' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
  };
}

/** Creates the landmarker for a model, GPU first with a CPU fallback, and swaps it in. */
async function load(model: PoseModel): Promise<'GPU' | 'CPU'> {
  let next: PoseLandmarker;
  let delegate: 'GPU' | 'CPU';
  try {
    next = await PoseLandmarker.createFromOptions(fileset!, opts(model, 'GPU'));
    delegate = 'GPU';
  } catch {
    next = await PoseLandmarker.createFromOptions(fileset!, opts(model, 'CPU'));
    delegate = 'CPU';
  }
  lm?.close();
  lm = next;
  return delegate;
}

function drop(p: Pending): void {
  p.img.close();
  if (p.bitmap) post({ type: 'dropped' });
}

function offer(p: Pending): void {
  if (stopped || !lm || switching) return drop(p);
  if (pending) {
    drop(pending);
    skipped++;
  }
  pending = p;
  // A message task rather than setTimeout, which clamps to 4 ms once timers nest.
  tick.port2.postMessage(0);
}

function process(): void {
  const p = pending;
  pending = null;
  if (!p) return;
  if (stopped || !lm || switching) return drop(p);
  // MediaPipe needs strictly increasing timestamps.
  const t = Math.max(p.t, lastTs + 1);
  lastTs = t;
  const t0 = performance.now();
  let res: ReturnType<PoseLandmarker['detectForVideo']>;
  try {
    res = lm.detectForVideo(p.img, t);
  } catch (e) {
    post({ type: 'error', message: `detectForVideo: ${String(e)}` });
    return;
  } finally {
    p.img.close();
  }
  const detectMs = performance.now() - t0;
  const img = res.landmarks[0];
  const world = res.worldLandmarks[0];
  let lms: Float32Array | null = null;
  if (img && world) {
    lms = new Float32Array((img.length + world.length) * 4);
    let i = 0;
    for (const q of [...img, ...world]) {
      lms[i++] = q.x;
      lms[i++] = q.y;
      lms[i++] = q.z;
      lms[i++] = q.visibility ?? 1;
    }
  }
  post({ type: 'result', t, aspect: p.aspect, detectMs, skipped, lms }, lms ? [lms.buffer] : []);
  skipped = 0;
}

/**
 * Page-clock time of a VideoFrame. Its timestamp is in microseconds on the capture clock; when that
 * already matches performance.now() (as requestVideoFrameCallback's captureTime does) it is used
 * as is, otherwise it is shifted by the smallest delivery delay seen, which keeps the camera's own
 * frame spacing (velocities depend on it) at the cost of a constant offset of a few ms.
 */
function frameTime(tsUs: number, at: number): number {
  const ts = tsUs / 1000;
  if (ts <= at + 5 && ts > at - 500) return ts;
  capOff = Math.min(capOff, at - ts);
  return ts + capOff;
}

async function pump(readable: ReadableStream<VideoFrame>): Promise<void> {
  const r = readable.getReader();
  reader = r;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done || stopped) {
        value?.close();
        return;
      }
      offer({ img: value, t: frameTime(value.timestamp, pageNow()), aspect: value.displayWidth / value.displayHeight, bitmap: false });
    }
  } catch (e) {
    if (!stopped) post({ type: 'error', message: `frame stream: ${String(e)}` });
  }
}

scope.onmessage = async (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      clockOff = performance.timeOrigin - m.origin;
      base = m.base;
      try {
        fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
        post({ type: 'ready', delegate: await load(m.model), mstp: !!MSTP });
      } catch (err) {
        post({ type: 'error', message: `init: ${String(err)}` });
      }
      return;
    case 'model':
      switching = true;
      try {
        post({ type: 'loaded', ok: true, delegate: await load(m.model) });
      } catch (err) {
        post({ type: 'loaded', ok: false, message: String(err) });
      } finally {
        switching = false;
      }
      return;
    case 'track':
      try {
        const proc = new MSTP!({ track: m.track, maxBufferSize: 8 });
        track = m.track;
        post({ type: 'source', ok: true });
        void pump(proc.readable);
      } catch (err) {
        m.track.stop();
        post({ type: 'source', ok: false, message: String(err) });
      }
      return;
    case 'readable':
      post({ type: 'source', ok: true });
      void pump(m.readable);
      return;
    case 'frame':
      offer({ img: m.bitmap, t: m.t, aspect: m.aspect, bitmap: true });
      return;
    case 'stop':
      stopped = true;
      if (pending) pending.img.close();
      pending = null;
      void reader?.cancel().catch(() => {});
      track?.stop();
      lm?.close();
      lm = null;
      scope.close();
      return;
  }
};
