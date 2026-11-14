import { describe, expect, it } from 'vitest';
import { Match } from '../shared/match.ts';
import { RULES } from '../shared/rules.ts';
import { NO_DEFENSE, type MatchEvent, type Punch } from '../shared/types.ts';

const upper: Punch = { type: 'rightUppercut', hand: 'right', target: 'head' };
const jab: Punch = { type: 'jab', hand: 'left', target: 'body' };

function started(): { m: Match; t: number } {
  const m = new Match();
  m.start(0);
  m.tick(RULES.countdownMs);
  return { m, t: RULES.countdownMs };
}

/** Throws and resolves a punch, returning the time after resolution. */
function hit(m: Match, t: number, p: Punch = upper, slot: 0 | 1 = 0): number {
  m.punch(slot, p, t, t);
  m.tick(t + 200);
  return t + 200;
}

function events(m: Match, e: MatchEvent['e']): MatchEvent[] {
  return m.drain().filter((x) => x.e === e);
}

describe('match flow', () => {
  it('starts round 1 after the countdown', () => {
    const { m } = started();
    expect(m.phase).toBe('round');
    expect(m.round).toBe(1);
    expect(events(m, 'roundStart')).toHaveLength(1);
  });

  it('rejects punches outside a round', () => {
    const m = new Match();
    m.start(0);
    expect(m.punch(0, jab, 10, 10)).toBe(false);
  });

  it('applies damage after the defense window', () => {
    const { m, t } = started();
    m.punch(0, upper, t, t);
    m.tick(t + 100);
    expect(m.fighters[1].hp).toBe(100);
    m.tick(t + 200);
    expect(m.fighters[1].hp).toBe(83.5);
  });

  it('runs 3 rounds and decides on HP', () => {
    const { m, t } = started();
    hit(m, t);
    let now = t;
    for (let i = 0; i < 3; i++) {
      now += RULES.roundMs;
      m.tick(now);
      if (i < 2) {
        expect(m.phase).toBe('break');
        now += RULES.breakMs;
        m.tick(now);
        expect(m.round).toBe(i + 2);
      }
    }
    expect(m.phase).toBe('ended');
    expect(m.result).toEqual({ kind: 'decision', winner: 0 });
  });

  it('declares a draw on equal HP and knockdowns', () => {
    const { m, t } = started();
    m.tick(t + RULES.roundMs * 3 + RULES.breakMs * 2 + 10);
    expect(m.result).toEqual({ kind: 'draw', winner: null });
  });

  it('pausing freezes the clock', () => {
    const { m, t } = started();
    m.pause(t + 1000, 'disconnect');
    m.tick(t + 50_000);
    m.resume(t + 50_000);
    m.tick(t + 51_000);
    expect(m.snapshot().clockMs).toBe(RULES.roundMs - 2000);
  });

  it('forfeit gives the win to the other player', () => {
    const { m } = started();
    m.forfeit(1);
    expect(m.result).toEqual({ kind: 'forfeit', winner: 0 });
  });
});

describe('stamina', () => {
  it('charges punch cost even on a miss', () => {
    const { m, t } = started();
    m.setDefense(1, { ...NO_DEFENSE, duck: true }, t, t);
    hit(m, t);
    expect(m.fighters[0].stamina).toBe(86);
    expect(m.fighters[1].hp).toBe(100);
  });

  it('charges the defender for blocking', () => {
    const { m, t } = started();
    m.fighters[1].stamina = 50;
    m.setDefense(1, { ...NO_DEFENSE, guard: true }, t, t);
    hit(m, t);
    expect(m.fighters[1].stamina).toBeCloseTo(46 + 25 * 0.2, 1);
  });

  it('recovers 15/s after 0.6 s idle and 25/s with guard', () => {
    const { m, t } = started();
    m.punch(0, upper, t, t);
    m.tick(t + 600);
    expect(m.fighters[0].stamina).toBe(86);
    m.tick(t + 1600);
    expect(m.fighters[0].stamina).toBeCloseTo(100, 0);
    m.fighters[0].stamina = 50;
    m.setDefense(0, { ...NO_DEFENSE, guard: true }, t + 1600, t + 1600);
    m.tick(t + 2600);
    expect(m.fighters[0].stamina).toBeCloseTo(75, 1);
  });

  it('gassed punches do 0.6x damage', () => {
    const { m, t } = started();
    m.fighters[0].stamina = 29;
    hit(m, t);
    expect(m.fighters[1].hp).toBe(100 - 9.9);
  });

  it('at 0 the fighter cannot punch until back to 20', () => {
    const { m, t } = started();
    m.fighters[0].stamina = 10;
    expect(m.punch(0, upper, t, t)).toBe(true);
    expect(m.fighters[0].exhausted).toBe(true);
    expect(m.punch(0, jab, t + 10, t + 10)).toBe(false);
    m.tick(t + 600 + 1300);
    expect(m.fighters[0].exhausted).toBe(true);
    m.tick(t + 600 + 1400);
    expect(m.fighters[0].exhausted).toBe(false);
  });
});

describe('knockdowns', () => {
  function knock(m: Match, t: number): number {
    m.fighters[1].hp = 5;
    return hit(m, t);
  }

  it('HP 0 knocks down, counts, and KOs at 10', () => {
    const { m, t } = started();
    let now = knock(m, t);
    expect(m.fighters[1].status).toBe('down');
    expect(events(m, 'knockdown')).toHaveLength(1);
    now += 9_900;
    m.tick(now);
    expect(m.snapshot().fighters[1].count).toBe(10);
    m.tick(now + 200);
    expect(m.result).toEqual({ kind: 'ko', winner: 0 });
  });

  it('holding guard 2 s beats the first count and restores 30 HP and 50 stamina', () => {
    const { m, t } = started();
    let now = knock(m, t);
    m.setDefense(1, { ...NO_DEFENSE, guard: true }, now, now);
    m.tick(now + 1000);
    m.tick(now + 2000);
    expect(m.fighters[1].status).toBe('gettingUp');
    expect(m.fighters[1].hp).toBe(30);
    expect(m.fighters[1].stamina).toBe(50);
    now += 2000;
    expect(m.punch(0, jab, now, now)).toBe(true);
    m.tick(now + 200);
    expect(m.fighters[1].hp).toBe(30);
    now += RULES.getUpAnimMs + 10;
    m.tick(now);
    expect(m.fighters[1].status).toBe('up');
    m.setDefense(1, NO_DEFENSE, now, now);
    hit(m, now + 500, jab);
    expect(m.fighters[1].hp).toBe(30);
    hit(m, now + RULES.protectAfterGetUpMs + 50, jab);
    expect(m.fighters[1].hp).toBe(26);
  });

  it('the second knockdown needs 3.5 s and restores 20 HP; the third is a TKO', () => {
    const { m, t } = started();
    let now = t;
    for (let k = 1; k <= 2; k++) {
      now = knock(m, now);
      m.setDefense(1, { ...NO_DEFENSE, guard: true }, now, now);
      const need = RULES.getUpHoldMs[k - 1];
      m.tick(now + need - 100);
      expect(m.fighters[1].status).toBe('down');
      m.tick(now + need);
      expect(m.fighters[1].hp).toBe(RULES.getUpRestoreHp[k - 1]);
      m.setDefense(1, NO_DEFENSE, now + need, now + need);
      now += need + RULES.getUpAnimMs + RULES.protectAfterGetUpMs + 100;
      m.tick(now);
      m.fighters[0].stamina = 100;
    }
    knock(m, now);
    expect(m.result).toEqual({ kind: 'tko', winner: 0 });
  });

  it('round clock stops during a count', () => {
    const { m, t } = started();
    const now = knock(m, t);
    const before = m.snapshot().clockMs;
    m.tick(now + 5000);
    expect(m.snapshot().clockMs).toBe(before);
  });
});
