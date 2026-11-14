import { describe, expect, it } from 'vitest';
import { dodgingSlip, heldDuring, rawDamage, resolveHit, zoneFor, type DefenseSample } from '../shared/hit.ts';
import { NO_DEFENSE, type DefenseState, type Punch } from '../shared/types.ts';

const jabHead: Punch = { type: 'jab', hand: 'left', target: 'head' };
const crossHead: Punch = { type: 'cross', hand: 'right', target: 'head' };
const hookBody: Punch = { type: 'leftHook', hand: 'left', target: 'body' };
const upperHead: Punch = { type: 'rightUppercut', hand: 'right', target: 'head' };

function hist(...s: [number, Partial<DefenseState>][]): DefenseSample[] {
  return [{ at: -Infinity, def: NO_DEFENSE }, ...s.map(([at, d]) => ({ at, def: { ...NO_DEFENSE, ...d } }))];
}

describe('zones', () => {
  it('mirrors hands onto the opposite side', () => {
    expect(zoneFor(crossHead)).toBe('head-left');
    expect(zoneFor(jabHead)).toBe('head-right');
    expect(zoneFor(hookBody)).toBe('body-right');
  });
  it('slips away from the landing side', () => {
    expect(dodgingSlip('head-left')).toBe('right');
    expect(dodgingSlip('head-right')).toBe('left');
  });
});

describe('damage', () => {
  it('applies head multiplier and gassed penalty', () => {
    expect(rawDamage(jabHead, false)).toBe(6);
    expect(rawDamage(hookBody, false)).toBe(9);
    expect(rawDamage(upperHead, false)).toBe(16.5);
    expect(rawDamage(crossHead, true)).toBe(6.3);
  });
});

describe('defense window', () => {
  it('counts a state that started before the window and is still held', () => {
    expect(heldDuring(hist([0, { guard: true }]), 500, 700, (d) => d.guard)).toBe(true);
  });
  it('counts a state that starts inside the window', () => {
    expect(heldDuring(hist([650, { guard: true }]), 500, 700, (d) => d.guard)).toBe(true);
  });
  it('ignores a state that ended before the window', () => {
    expect(heldDuring(hist([0, { guard: true }], [400, {}]), 500, 700, (d) => d.guard)).toBe(false);
  });
  it('ignores a state that starts after the window', () => {
    expect(heldDuring(hist([701, { guard: true }]), 500, 700, (d) => d.guard)).toBe(false);
  });
});

describe('resolveHit', () => {
  const peak = 1000;
  it('clean hit with no defense', () => {
    const r = resolveHit({ punch: crossHead, peakAt: peak, attackerGassed: false, defense: hist() });
    expect(r).toMatchObject({ outcome: 'hit', damage: 10.5, stagger: false, zone: 'head-left' });
  });
  it('guard blocks with 10% chip', () => {
    const r = resolveHit({ punch: upperHead, peakAt: peak, attackerGassed: false, defense: hist([900, { guard: true }]) });
    expect(r).toMatchObject({ outcome: 'block', damage: 1.7, blocked: true });
  });
  it('guard raised 150 ms before the peak still counts, 151 ms does not', () => {
    const ok = resolveHit({ punch: jabHead, peakAt: peak, attackerGassed: false, defense: hist([0, { guard: true }], [851, {}]) });
    expect(ok.outcome).toBe('block');
    const late = resolveHit({ punch: jabHead, peakAt: peak, attackerGassed: false, defense: hist([0, { guard: true }], [849, {}]) });
    expect(late.outcome).toBe('hit');
  });
  it('guard raised up to 80 ms after the peak counts', () => {
    expect(resolveHit({ punch: jabHead, peakAt: peak, attackerGassed: false, defense: hist([1080, { guard: true }]) }).outcome).toBe('block');
    expect(resolveHit({ punch: jabHead, peakAt: peak, attackerGassed: false, defense: hist([1081, { guard: true }]) }).outcome).toBe('hit');
  });
  it('duck dodges head punches only', () => {
    const d = hist([950, { duck: true }]);
    expect(resolveHit({ punch: upperHead, peakAt: peak, attackerGassed: false, defense: d }).outcome).toBe('dodge');
    expect(resolveHit({ punch: hookBody, peakAt: peak, attackerGassed: false, defense: d }).outcome).toBe('hit');
  });
  it('slip to the correct side dodges straights only', () => {
    const right = hist([950, { slip: 'right' }]);
    expect(resolveHit({ punch: crossHead, peakAt: peak, attackerGassed: false, defense: right }).outcome).toBe('dodge');
    expect(resolveHit({ punch: jabHead, peakAt: peak, attackerGassed: false, defense: right }).outcome).toBe('hit');
    expect(resolveHit({ punch: upperHead, peakAt: peak, attackerGassed: false, defense: right }).outcome).toBe('hit');
  });
  it('staggers on clean heavy head shots of 12+', () => {
    const hook: Punch = { type: 'rightHook', hand: 'right', target: 'head' };
    expect(resolveHit({ punch: hook, peakAt: peak, attackerGassed: false, defense: hist() }).stagger).toBe(true);
    expect(resolveHit({ punch: hook, peakAt: peak, attackerGassed: true, defense: hist() }).stagger).toBe(false);
    expect(resolveHit({ punch: crossHead, peakAt: peak, attackerGassed: false, defense: hist() }).stagger).toBe(false);
  });
});
