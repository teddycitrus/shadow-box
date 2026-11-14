import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Lm, PoseFrame } from './frame.ts';

const BASE = import.meta.env.BASE_URL;

/** Webcam plus MediaPipe Pose Landmarker, all assets served locally. */
export class PoseTracker {
  readonly video = document.createElement('video');
  private landmarker: PoseLandmarker | null = null;
  private lastVideoTime = -1;
  private running = false;
  private frameTimes: number[] = [];
  delegate: 'GPU' | 'CPU' | null = null;
  onFrame: (f: PoseFrame | null) => void = () => {};

  /** Tracked frames per second over the last second. */
  get fps(): number {
    const now = performance.now();
    this.frameTimes = this.frameTimes.filter((t) => now - t < 1000);
    return this.frameTimes.length;
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_full.task`, delegate },
      runningMode: 'VIDEO' as const,
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
    this.running = true;
    this.loop();
  }

  private loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const t = performance.now();
    this.frameTimes.push(t);
    const res = this.landmarker.detectForVideo(v, t);
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
  };

  stop(): void {
    this.running = false;
    this.landmarker?.close();
    (this.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  }
}
