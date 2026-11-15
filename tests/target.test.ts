import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { passesGate, type Segment } from '../client/src/tracking/classifier.ts';
import { KnnModel, TargetModel, vector, type Sample } from '../client/src/tracking/model.ts';
import { handFor, splitFrom } from '../client/src/tracking/teach.ts';
import { loadFixtures, segmentsOf, type Recording } from '../scripts/eval-core.ts';
import { FIXTURE_REPS, TEACH_REPS, TEACH_SESSION, type Rep } from '../scripts/eval-gt.ts';
import type { Target } from '../shared/types.ts';

/**
 * Head or body on the recorded straights, leave one out. In the teach session the camera sat
 * high, so head jabs ended below the shoulders on screen and overlapped the body jabs in height:
 * the height line got them wrong both ways (head read as body, body as head).
 */

interface Straight { seg: Segment; target: Target }

function straights(rec: Recording, reps: Rep[]): Straight[] {
  const segs = segmentsOf(rec).filter(passesGate);
  const t0 = rec.frames[0].t;
  const out: Straight[] = [];
  for (const r of reps.filter((x) => x.type === 'jab' || x.type === 'cross')) {
    const hand = handFor(r.type, 'orthodox');
    const rt = t0 + r.t * 1000;
    const seg = segs.filter((s) => s.hand === hand && Math.abs(s.peakT - rt) < 350).sort((a, b) => Math.abs(a.peakT - rt) - Math.abs(b.peakT - rt))[0];
    if (seg) out.push({ seg, target: r.target });
  }
  return out;
}

function leaveOneOut(xs: Straight[], read: (train: Straight[], x: Straight) => Target): number {
  return xs.filter((x) => read(xs.filter((o) => o !== x), x) === x.target).length;
}

const byModel = (train: Straight[], x: Straight): Target => {
  const samples: Sample[] = train.map((o) => ({ hand: o.seg.hand, label: 'straight', v: vector(o.seg), target: o.target }));
  return new TargetModel(samples).target(x.seg.hand, 'straight', vector(x.seg))!;
};
const byLine = (train: Straight[], x: Straight): Target => {
  const split = splitFrom(train.map((o) => ({ hand: o.seg.hand, y: o.seg.peakY, body: o.target === 'body' })));
  return x.seg.peakY > split[x.seg.hand] ? 'body' : 'head';
};

describe('head or body from the player\'s own reps', () => {
  const sess = JSON.parse(readFileSync(`tests/fixtures/sessions/${TEACH_SESSION}`, 'utf8')) as Recording;
  const session = straights(sess, TEACH_REPS);
  const fixtures = loadFixtures().flatMap(({ file, rec }) => {
    const id = file.replace(/^(orthodox|southpaw)-/, '').replace('.json', '');
    const type = rec.expected?.[0];
    if (type !== 'jab' && type !== 'cross') return [];
    return straights(rec, (FIXTURE_REPS[id] ?? []).map((t) => ({ type, target: rec.expectedTarget ?? 'head', t })));
  });

  it('reads the high-camera teach session right where the height line did not', () => {
    expect(session.length).toBeGreaterThanOrEqual(12);
    const model = leaveOneOut(session, byModel), line = leaveOneOut(session, byLine);
    expect(line).toBeLessThan(session.length - 2);
    expect(model).toBeGreaterThanOrEqual(session.length - 1);
  });

  it('keeps the low-camera fixture clips right', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
    expect(leaveOneOut(fixtures, byModel)).toBe(fixtures.length);
  });

  it('finds the non-punch examples that made a body shot read as no punch', () => {
    // A body jab next to a non-punch taught at exactly its place (an uppercut wind-up, say).
    const body = session.filter((x) => x.target === 'body');
    const probe = body[0];
    const samples: Sample[] = [
      ...session.filter((x) => x !== probe).map((o): Sample => ({ hand: o.seg.hand, label: 'straight', v: vector(o.seg), target: o.target })),
      { hand: probe.seg.hand, label: 'none', v: vector(probe.seg).map((n) => n + 0.01) },
    ];
    const m = new KnnModel(samples);
    expect(m.decide(probe.seg, 'orthodox', { left: 0, right: 0 })).toBeNull();
    expect(m.shadowing(probe.seg.hand, vector(probe.seg), 'straight')).toEqual([samples.length - 1]);
  });

  it('returns null without body reps, so the caller falls back to the line', () => {
    const head = session.filter((x) => x.target === 'head');
    const m = new TargetModel(head.map((o) => ({ hand: o.seg.hand, label: 'straight', v: vector(o.seg), target: o.target })));
    expect(m.target('left', 'straight', vector(head[0].seg))).toBeNull();
    expect(m.target('left', 'hook', vector(head[0].seg))).toBeNull();
  });
});
