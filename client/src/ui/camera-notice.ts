import type { TrackerHealth } from '../tracking/pose.ts';

/**
 * Camera quality notice. Dim rooms make webcams drop their frame rate to expose longer, which also
 * blurs the fist; under about 28 fps a fast punch spans only a few frames and gets missed. Checked
 * about once a second from InputSource.health; a condition turns on after onMs bad and off after
 * offMs good, so the notice does not flicker.
 */
export const NOTICE = {
  /** Samples this soon after tracking starts are ignored (camera and GPU warm-up). */
  warmupMs: 3_000,
  onMs: 3_000,
  offMs: 5_000,
  minCameraFps: 28,
  minDeliveredFps: 27,
  /** Skipped frames as a share of delivered frames above which tracking is falling behind. */
  maxSkipShare: 0.1,
};

export type HealthSample = Pick<TrackerHealth, 'cameraFps' | 'deliveredFps' | 'skippedPerSec'>;

interface Cond {
  on: boolean;
  /** When the raw reading started disagreeing with `on`, or null. */
  since: number | null;
}

export interface NoticeState {
  startedAt: number | null;
  low: Cond;
  behind: Cond;
  /** Last bad readings, so the copy shows the measured number even while it is clearing. */
  fps: number;
  delivered: number;
  tracked: number;
}

export type CameraIssue =
  | { kind: 'lowFps'; fps: number }
  | { kind: 'behind'; tracked: number; delivered: number };

const OFF: Cond = { on: false, since: null };
export const initialNotice: NoticeState = { startedAt: null, low: OFF, behind: OFF, fps: 0, delivered: 0, tracked: 0 };

function hold(c: Cond, bad: boolean, now: number): Cond {
  if (bad === c.on) return c.since === null ? c : { on: c.on, since: null };
  const since = c.since ?? now;
  return now - since >= (bad ? NOTICE.onMs : NOTICE.offMs) ? { on: bad, since: null } : { on: c.on, since };
}

/** Next state from one health reading at `now` (ms). A null reading (no camera) resets it. */
export function stepNotice(s: NoticeState, hl: HealthSample | null, now: number): NoticeState {
  if (!hl) return initialNotice;
  if (s.startedAt === null) return { ...s, startedAt: now };
  if (now - s.startedAt < NOTICE.warmupMs) return s;
  const fps = Math.min(hl.cameraFps ?? Infinity, hl.deliveredFps);
  const lowBad = (hl.cameraFps !== null && hl.cameraFps < NOTICE.minCameraFps) || hl.deliveredFps < NOTICE.minDeliveredFps;
  const behindBad = hl.deliveredFps > 0 && hl.skippedPerSec >= NOTICE.maxSkipShare * hl.deliveredFps;
  return {
    startedAt: s.startedAt,
    low: hold(s.low, lowBad, now),
    behind: hold(s.behind, behindBad, now),
    fps: lowBad ? Math.round(fps) : s.fps,
    delivered: behindBad ? Math.round(hl.deliveredFps) : s.delivered,
    tracked: behindBad ? Math.round(hl.deliveredFps - hl.skippedPerSec) : s.tracked,
  };
}

/** What to show, if anything. A low camera rate wins over tracking falling behind. */
export function noticeIssue(s: NoticeState): CameraIssue | null {
  if (s.low.on) return { kind: 'lowFps', fps: s.fps };
  if (s.behind.on) return { kind: 'behind', tracked: s.tracked, delivered: s.delivered };
  return null;
}

/** Title, detail line and the short in-match label. */
export function noticeCopy(i: CameraIssue): { title: string; line: string; chip: string } {
  if (i.kind === 'lowFps') return {
    title: `Camera at ${i.fps} fps`,
    line: 'Fast punches may be missed. Light your face from the front, or turn off low light compensation in your camera settings.',
    chip: `Camera ${i.fps} fps`,
  };
  return {
    title: `Tracking ${i.tracked} of ${i.delivered} fps`,
    line: 'This device cannot keep up, so punches may be missed. Close other tabs or apps.',
    chip: `Tracking ${i.tracked}/${i.delivered} fps`,
  };
}

/** One line for the ?debug=1 overlay. */
export function noticeDebug(s: NoticeState): string {
  const c = (n: string, k: Cond) => `${n} ${k.on ? 'ON' : 'off'}${k.since !== null ? ' (changing)' : ''}`;
  const i = noticeIssue(s);
  return `camera notice: ${i ? noticeCopy(i).chip : 'none'}  ${c('low', s.low)}  ${c('behind', s.behind)}`;
}
