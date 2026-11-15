import { describe, expect, it } from 'vitest';
import { CONFIG } from '../client/src/config.ts';
import { Classifier } from '../client/src/tracking/classifier.ts';
import { KnnModel, bodyDipFrom, targetOf, vector, type Sample } from '../client/src/tracking/model.ts';
import { labelledSegments, loadFixtures } from '../scripts/eval-core.ts';
import { fixtureBodyDip, fixtureTargetReps, sessionTargetReps } from '../scripts/eval-target.ts';

/**
 * Head or body comes from the head dip: a crouched punch is a body shot, a standing one a head
 * shot. Every recorded rep was thrown standing (including the ones aimed low before the crouch
 * rule), so every one must read as a head shot.
 */
describe('body shots are thrown crouched', () => {
  const fixtures = fixtureTargetReps();
  const session = sessionTargetReps();
  const p = CONFIG.punch;

  it('reads every standing fixture and teach-session rep as a head shot', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(35);
    expect(session.length).toBeGreaterThanOrEqual(20);
    const dip = fixtureBodyDip();
    for (const b of [p.bodyDip, dip, p.bodyDipMin]) {
      for (const xs of [fixtures, session]) expect(xs.filter((x) => targetOf(x.seg, b) === 'head').length).toBe(xs.length);
    }
  });

  it('sets the body dip from the crouch reps, the standing reps and the duck, within limits', () => {
    expect(bodyDipFrom([], [], null)).toBe(p.bodyDip);
    // Crouch reps at 1.0, standing at 0: the fraction of the way down.
    expect(bodyDipFrom([1, 1, 1], [0, 0], 2)).toBeCloseTo(p.bodyDipFraction);
    // Standing reps move the head a little: the line starts from there.
    expect(bodyDipFrom([1, 1], [0.2, 0.2], null)).toBeCloseTo(0.2 + 0.8 * p.bodyDipFraction);
    // Fewer than two crouch reps: the duck depth stands in.
    expect(bodyDipFrom([0.1], [], 1.2)).toBeCloseTo(1.2 * p.bodyDipFraction);
    // A barely dipped crouch never pulls it under the floor, a very deep one never over the cap.
    expect(bodyDipFrom([0.2, 0.2], [], null)).toBe(p.bodyDipMin);
    expect(bodyDipFrom([4, 4], [], null)).toBe(p.bodyDipMax);
  });

  it('ducking in the recorded duck clip fires almost no punches', () => {
    const all = loadFixtures();
    const duck = all.find((f) => f.rec.defense === 'duck')!;
    const segs = all.filter((f) => f !== duck).flatMap(({ file, rec }) => labelledSegments(file, rec));
    const m = new KnnModel(segs.map((s) => ({ hand: s.seg.hand, label: s.label, v: vector(s.seg) })));
    const c = new Classifier(duck.rec.calibration!);
    c.model = (seg) => m.decide(seg, 'orthodox', fixtureBodyDip());
    let fired = 0, ducks = 0, prev = false;
    for (const f of duck.rec.frames) {
      const out = c.update(f);
      fired += out.punches.length;
      if (out.defense.duck && !prev) ducks++;
      prev = out.defense.duck;
    }
    expect(ducks).toBeGreaterThanOrEqual(4);
    expect(fired).toBeLessThanOrEqual(1);
  });

  it('finds the non-punch examples that made a punch read as no punch', () => {
    // A jab next to a non-punch taught at exactly its place (an uppercut wind-up, say).
    const straights = session.filter((x) => x.kind === 'straight');
    const probe = straights[0];
    const samples: Sample[] = [
      ...straights.filter((x) => x !== probe).map((o): Sample => ({ hand: o.seg.hand, label: 'straight', v: vector(o.seg), target: 'head' })),
      { hand: probe.seg.hand, label: 'none', v: vector(probe.seg).map((n) => n + 0.01) },
    ];
    const m = new KnnModel(samples);
    expect(m.decide(probe.seg, 'orthodox')).toBeNull();
    expect(m.shadowing(probe.seg.hand, vector(probe.seg), 'straight')).toEqual([samples.length - 1]);
  });
});
