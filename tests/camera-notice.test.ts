import { describe, expect, it } from 'vitest';
import { NOTICE, initialNotice, noticeCopy, noticeDebug, noticeIssue, stepNotice, type HealthSample, type NoticeState } from '../client/src/ui/camera-notice.ts';

const good: HealthSample = { cameraFps: 30, deliveredFps: 30, skippedPerSec: 0 };
const dim: HealthSample = { cameraFps: 15, deliveredFps: 15, skippedPerSec: 0 };
const busy: HealthSample = { cameraFps: 30, deliveredFps: 30, skippedPerSec: 6 };

/** Feeds one reading per second from `from` (ms) to `to` inclusive. */
function run(s: NoticeState, hl: HealthSample | null, from: number, to: number): NoticeState {
  for (let t = from; t <= to; t += 1000) s = stepNotice(s, hl, t);
  return s;
}
const started = () => run(initialNotice, good, 0, NOTICE.warmupMs);

describe('camera quality notice', () => {
  it('ignores readings during warm-up', () => {
    const s = run(initialNotice, dim, 0, NOTICE.warmupMs - 1000);
    expect(noticeIssue(s)).toBeNull();
    expect(s.low.since).toBeNull();
  });

  it('shows a low camera rate only after 3 s, with the measured number', () => {
    let s = started();
    s = run(s, dim, 4000, 6000);
    expect(noticeIssue(s)).toBeNull();
    s = stepNotice(s, dim, 7000);
    expect(noticeIssue(s)).toEqual({ kind: 'lowFps', fps: 15 });
    const c = noticeCopy(noticeIssue(s)!);
    expect(c.title).toBe('Camera at 15 fps');
    expect(c.line).toContain('Light your face from the front');
  });

  it('uses delivered fps when the camera reports none or claims more than it delivers', () => {
    let s = run(started(), { cameraFps: null, deliveredFps: 22, skippedPerSec: 0 }, 4000, 7000);
    expect(noticeIssue(s)).toEqual({ kind: 'lowFps', fps: 22 });
    s = run(started(), { cameraFps: 30, deliveredFps: 26, skippedPerSec: 0 }, 4000, 7000);
    expect(noticeIssue(s)).toEqual({ kind: 'lowFps', fps: 26 });
    s = run(started(), { cameraFps: 27, deliveredFps: 30, skippedPerSec: 0 }, 4000, 7000);
    expect(noticeIssue(s)).toEqual({ kind: 'lowFps', fps: 27 });
  });

  it('does not trip on brief dips, and clears only after 5 s good', () => {
    let s = run(started(), dim, 4000, 5000);
    s = stepNotice(s, good, 6000);
    s = run(s, dim, 7000, 8000);
    expect(noticeIssue(s)).toBeNull();
    s = run(s, dim, 9000, 11000);
    expect(noticeIssue(s)?.kind).toBe('lowFps');
    s = run(s, good, 12000, 16000);
    expect(noticeIssue(s)).toEqual({ kind: 'lowFps', fps: 15 });
    s = stepNotice(s, dim, 17000);
    s = run(s, good, 18000, 22000);
    expect(noticeIssue(s)?.kind).toBe('lowFps');
    s = stepNotice(s, good, 23000);
    expect(noticeIssue(s)).toBeNull();
  });

  it('shows tracking falling behind at 10% skipped frames', () => {
    let s = run(started(), { cameraFps: 30, deliveredFps: 30, skippedPerSec: 2 }, 4000, 9000);
    expect(noticeIssue(s)).toBeNull();
    s = run(started(), busy, 4000, 7000);
    expect(noticeIssue(s)).toEqual({ kind: 'behind', tracked: 24, delivered: 30 });
    expect(noticeCopy(noticeIssue(s)!).title).toBe('Tracking 24 of 30 fps');
  });

  it('prefers the low camera rate over falling behind', () => {
    const s = run(started(), { cameraFps: 15, deliveredFps: 15, skippedPerSec: 3 }, 4000, 7000);
    expect(s.behind.on).toBe(true);
    expect(noticeIssue(s)?.kind).toBe('lowFps');
  });

  it('resets without a camera', () => {
    const s = run(started(), dim, 4000, 7000);
    expect(stepNotice(s, null, 8000)).toBe(initialNotice);
  });

  it('keeps the copy plain ASCII', () => {
    for (const i of [{ kind: 'lowFps', fps: 15 } as const, { kind: 'behind', tracked: 20, delivered: 30 } as const]) {
      for (const t of Object.values(noticeCopy(i))) expect(t).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(noticeDebug(run(started(), dim, 4000, 7000))).toContain('Camera 15 fps');
  });
});
