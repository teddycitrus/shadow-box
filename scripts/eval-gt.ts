// Hand-checked ground truth for the recorded data: the peak time (seconds from the first frame) of
// every real punch rep. Found from the wrist's distance to its guard position and checked frame by
// frame (scripts/dump-segments.ts, scripts/dump-session.ts), so it does not depend on the segmenter.
import type { PunchType, Target } from '../shared/types.ts';

export interface Rep {
  type: PunchType;
  target: Target;
  /** Peak time in seconds from the first frame of the recording. */
  t: number;
}

/** Punch reps per fixture clip (tests/fixtures/orthodox-<id>.json). Defense clips have none. */
export const FIXTURE_REPS: Record<string, number[]> = {
  'cross-body': [2.71, 4.95, 7.38, 10.01, 12.45],
  'cross-head': [2.23, 4.87, 7.32, 9.41, 11.67],
  // Two of the five body jabs are too small to tell apart from noise; only the clear four count.
  'jab-body': [1.66, 4.62, 6.25, 8.45],
  'jab-head': [2.35, 3.08, 3.91, 4.74, 5.7],
  'lhook-head': [1.38, 3.22, 5.02, 7.16, 9.34],
  luppercut: [2.1, 4.59, 7.21, 9.88, 12.72],
  'rhook-head': [1.92, 3.99, 6.16, 8.91, 11.48],
  ruppercut: [1.8, 4.11, 6.46, 8.81, 11.35],
};

/**
 * Reps actually thrown in the recorded teach session (session-teach-2026-11-14T21-04-36-346Z),
 * per prompt. The old teacher moved on after three detections, so most prompts got two real reps.
 */
export const TEACH_SESSION = 'session-teach-2026-11-14T21-04-36-346Z.json';
export const TEACH_REPS: Rep[] = [
  ...[37.18, 38.05, 38.92].map((t) => ({ type: 'jab' as const, target: 'head' as const, t })),
  ...[40.23, 42.15, 43.02].map((t) => ({ type: 'cross' as const, target: 'head' as const, t })),
  ...[44.41, 45.4].map((t) => ({ type: 'leftHook' as const, target: 'head' as const, t })),
  ...[47.58, 48.65, 49.79].map((t) => ({ type: 'rightHook' as const, target: 'head' as const, t })),
  ...[51.28, 52.35].map((t) => ({ type: 'leftUppercut' as const, target: 'head' as const, t })),
  ...[53.5].map((t) => ({ type: 'rightUppercut' as const, target: 'head' as const, t })),
  ...[54.49, 56.69, 57.59, 58.46, 60.14, 61.2].map((t) => ({ type: 'jab' as const, target: 'body' as const, t })),
  ...[63.35, 64.45].map((t) => ({ type: 'cross' as const, target: 'body' as const, t })),
];
