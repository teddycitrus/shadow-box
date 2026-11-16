import type { Calibration } from './calibration.ts';
import type { PoseFrame } from './frame.ts';

export interface SessionMark {
  t: number;
  kind: string;
  data?: unknown;
}

const MAX_FRAMES = 30 * 120;

/**
 * Dev-only (?debug=1) rolling log of raw frames plus everything the classifier decided, so a
 * real play session can be replayed offline to tune detection. Keeps the last ~2 minutes.
 */
export class SessionLog {
  frames: PoseFrame[] = [];
  marks: SessionMark[] = [];
  calibration: Calibration | null = null;

  frame(f: PoseFrame): void {
    this.frames.push(f);
    if (this.frames.length > MAX_FRAMES) {
      this.frames.splice(0, this.frames.length - MAX_FRAMES);
      const t0 = this.frames[0].t;
      if (this.marks.some((m) => m.t < t0)) this.marks = this.marks.filter((m) => m.t >= t0);
    }
  }

  mark(t: number, kind: string, data?: unknown): void {
    this.marks.push({ t, kind, data });
  }

  /** Saves into tests/fixtures/sessions/ through the dev server; returns the file name or null. */
  async save(label: string, extra: Record<string, unknown> = {}): Promise<string | null> {
    if (!this.frames.length) return null;
    const name = `session-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify({ label, calibration: this.calibration, ...extra, marks: this.marks, frames: this.frames });
    try {
      const r = await fetch(`/__fixtures/sessions/${name}`, { method: 'POST', body });
      return r.ok ? `tests/fixtures/sessions/${name}` : null;
    } catch {
      return null;
    }
  }
}
