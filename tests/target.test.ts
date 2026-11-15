import { describe, expect, it } from 'vitest';
import { CONFIG } from '../client/src/config.ts';
import { KnnModel, headLineFrom, vector, type Sample } from '../client/src/tracking/model.ts';
import { fixtureTargetReps, headTargets, loo, sessionTargetReps } from '../scripts/eval-target.ts';

/**
 * Head or body on the recorded reps, leave one out. Every punch is a body shot unless the fist
 * clearly went high (see targetOf). The fixture clips were shot from a low camera with clear
 * targets; in the teach session the camera sat high and the "head" straights and hooks ended far
 * below the nose, so under the rule they are body shots.
 */
describe('head only when the fist clearly goes high', () => {
  const session = sessionTargetReps();
  const fixtures = fixtureTargetReps();

  it('reads every low-camera fixture rep right: straights, hooks and uppercuts', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(35);
    expect(loo(fixtures, headTargets)).toBe(fixtures.length);
  });

  it('never reads a body shot as a head shot', () => {
    for (const xs of [fixtures, session]) {
      const body = xs.filter((x) => x.target === 'body');
      expect(body.length).toBeGreaterThanOrEqual(6);
      expect(loo(body, headTargets, xs)).toBe(body.length);
    }
  });

  it('calls the high-camera session\'s low "head" straights body shots, and keeps its uppercuts', () => {
    const low = session.filter((x) => x.kind === 'straight' && x.target === 'head');
    expect(low.length).toBeGreaterThanOrEqual(4);
    for (const x of low) expect(headTargets(session.filter((o) => o !== x), x)).toBe('body');
    const up = session.filter((x) => x.kind === 'uppercut');
    expect(loo(up, headTargets, session)).toBe(up.length);
  });

  it('learns the line between the player\'s head and body straights, within limits', () => {
    const p = CONFIG.punch;
    expect(headLineFrom([])).toEqual({ left: p.headLine, right: p.headLine });
    const line = headLineFrom([
      { hand: 'left', h: 1, target: 'head' }, { hand: 'left', h: -0.6, target: 'body' },
      { hand: 'right', h: 3, target: 'head' }, { hand: 'right', h: 1.5, target: 'body' },
    ]);
    expect(line.left).toBeCloseTo(0.2);
    expect(line.right).toBe(p.headLineMax);
    // Head reps no higher than the body reps: nothing to learn, so nose level.
    expect(headLineFrom([{ hand: 'left', h: -1, target: 'head' }, { hand: 'left', h: -0.5, target: 'body' }]).left).toBe(p.headLine);
    // Head reps far below the nose (a high camera) never pull the line below about chin level.
    expect(headLineFrom([{ hand: 'left', h: -0.9, target: 'head' }, { hand: 'left', h: -1.5, target: 'body' }]).left).toBe(p.headLineMin);
  });

  it('finds the non-punch examples that made a body shot read as no punch', () => {
    // A body jab next to a non-punch taught at exactly its place (an uppercut wind-up, say).
    const straights = session.filter((x) => x.kind === 'straight');
    const probe = straights.find((x) => x.target === 'body')!;
    const samples: Sample[] = [
      ...straights.filter((x) => x !== probe).map((o): Sample => ({ hand: o.seg.hand, label: 'straight', v: vector(o.seg), target: o.target })),
      { hand: probe.seg.hand, label: 'none', v: vector(probe.seg).map((n) => n + 0.01) },
    ];
    const m = new KnnModel(samples);
    expect(m.decide(probe.seg, 'orthodox')).toBeNull();
    expect(m.shadowing(probe.seg.hand, vector(probe.seg), 'straight')).toEqual([samples.length - 1]);
  });
});
