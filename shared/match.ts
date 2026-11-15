import { rawDamage, resolveHit, zoneFor, type DefenseSample } from './hit.ts';
import { RULES, punchKind } from './rules.ts';
import {
  NO_DEFENSE, other,
  type DefenseState, type FighterSnapshot, type FighterStatus, type MatchEvent, type MatchResult,
  type MatchSnapshot, type Phase, type Punch, type Slot,
} from './types.ts';

interface Fighter {
  hp: number;
  stamina: number;
  exhausted: boolean;
  knockdowns: number;
  status: FighterStatus;
  downAt: number;
  count: number;
  guardStart: number | null;
  getUpAt: number;
  protectedUntil: number;
  lastPunchAt: number;
  defense: DefenseSample[];
}

interface Pending {
  attacker: Slot;
  punch: Punch;
  peakAt: number;
  gassed: boolean;
  resolveAt: number;
}

function newFighter(): Fighter {
  return {
    hp: RULES.maxHp, stamina: RULES.maxStamina, exhausted: false, knockdowns: 0, status: 'up',
    downAt: 0, count: 0, guardStart: null, getUpAt: 0, protectedUntil: 0, lastPunchAt: -Infinity,
    defense: [{ at: -Infinity, def: NO_DEFENSE }],
  };
}

/**
 * Authoritative match simulation. Pure apart from the timestamps passed in, so the server
 * and the local practice mode run the exact same rules. Inputs use the caller's clock; the
 * match converts them to an internal game clock that stops while paused.
 */
export class Match {
  phase: Phase = 'lobby';
  round = 0;
  paused = false;
  result: MatchResult | null = null;
  readonly fighters: [Fighter, Fighter] = [newFighter(), newFighter()];
  private clock = 0;
  private game = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private pending: Pending[] = [];
  private events: MatchEvent[] = [];

  get ended(): boolean {
    return this.phase === 'ended';
  }

  private g(now: number): number {
    return now - this.pausedTotal;
  }

  start(now: number): void {
    if (this.phase !== 'lobby') return;
    this.game = this.g(now);
    this.phase = 'countdown';
    this.clock = RULES.countdownMs;
  }

  pause(now: number, reason: string): void {
    if (this.paused || this.phase === 'ended') return;
    this.tick(now);
    this.paused = true;
    this.pausedAt = now;
    this.events.push({ e: 'paused', reason });
  }

  resume(now: number): void {
    if (!this.paused) return;
    this.pausedTotal += now - this.pausedAt;
    this.paused = false;
    this.events.push({ e: 'resumed' });
  }

  forfeit(loser: Slot): void {
    this.end({ kind: 'forfeit', winner: other(loser) });
  }

  defenseOf(slot: Slot): DefenseState {
    const d = this.fighters[slot].defense;
    return d[d.length - 1].def;
  }

  setDefense(slot: Slot, def: DefenseState, at: number, now: number): void {
    const f = this.fighters[slot];
    // While paused, game time is frozen at the pause, so record the change there; dropping it
    // would leave a stale guard in effect after the resume.
    const g = this.g(this.paused ? this.pausedAt : now);
    const last = f.defense[f.defense.length - 1];
    const t = Math.max(last.at, Math.min(this.g(at), g));
    if (!def.guard) f.guardStart = null;
    else if (!last.def.guard) f.guardStart = t;
    f.defense.push({ at: t, def: { ...def } });
    let keep = 0;
    while (keep < f.defense.length - 1 && f.defense[keep + 1].at < g - 2_000) keep++;
    if (keep > 0) f.defense.splice(0, keep);
  }

  canPunch(slot: Slot): boolean {
    const f = this.fighters[slot];
    return !this.paused && this.phase === 'round' && f.status === 'up' && !f.exhausted;
  }

  /** Returns false if the punch was rejected (wrong phase, down, or exhausted). */
  punch(slot: Slot, punch: Punch, at: number, now: number): boolean {
    this.tick(now);
    if (!this.canPunch(slot)) return false;
    const f = this.fighters[slot];
    const g = this.g(now);
    const peakAt = Math.max(g - RULES.maxPunchAgeMs, Math.min(this.g(at), g));
    const gassed = f.stamina < RULES.gassedBelow;
    f.stamina = Math.max(0, f.stamina - RULES.punchCost[punchKind(punch.type)]);
    if (f.stamina === 0) f.exhausted = true;
    f.lastPunchAt = g;
    this.events.push({ e: 'throw', slot, punch });
    this.pending.push({
      attacker: slot, punch, peakAt, gassed,
      resolveAt: peakAt + RULES.defenseWindowAfterMs + RULES.resolveGraceMs,
    });
    return true;
  }

  tick(now: number): void {
    if (this.paused || this.phase === 'lobby' || this.phase === 'ended') return;
    const g = this.g(now);
    const dt = Math.max(0, g - this.game);
    this.game = g;

    this.pending.sort((a, b) => a.resolveAt - b.resolveAt);
    while (this.pending.length && this.pending[0].resolveAt <= g && !this.ended) {
      this.resolve(this.pending.shift()!);
    }
    if (this.ended) return;

    for (const slot of [0, 1] as Slot[]) this.tickFighter(slot, g, dt);
    if (this.ended) return;

    const someoneDown = this.fighters.some((f) => f.status !== 'up');
    if (this.phase === 'round' && someoneDown) return;
    this.clock -= dt;
    while (this.clock <= 0 && !this.ended) {
      if (this.phase === 'countdown' || this.phase === 'break') {
        this.round++;
        this.phase = 'round';
        this.clock += RULES.roundMs;
        this.events.push({ e: 'roundStart', round: this.round });
      } else {
        this.pending = [];
        this.events.push({ e: 'roundEnd', round: this.round });
        if (this.round >= RULES.rounds) this.end(this.decision());
        else {
          this.phase = 'break';
          this.clock += RULES.breakMs;
        }
      }
    }
  }

  private getUpNeed(f: Fighter): number {
    return RULES.getUpHoldMs[Math.min(Math.max(f.knockdowns, 1), 2) - 1];
  }

  private guardHeld(f: Fighter): number {
    return f.guardStart === null ? 0 : Math.max(0, this.game - Math.max(f.guardStart, f.downAt));
  }

  private tickFighter(slot: Slot, g: number, dt: number): void {
    const f = this.fighters[slot];
    const guard = this.defenseOf(slot).guard;
    if (f.status === 'down') {
      const elapsed = g - f.downAt;
      if (elapsed >= RULES.countMax * RULES.countStepMs) {
        this.end({ kind: 'ko', winner: other(slot) });
        return;
      }
      const n = Math.floor(elapsed / RULES.countStepMs) + 1;
      if (n !== f.count) {
        f.count = n;
        this.events.push({ e: 'count', slot, n });
      }
      if (this.guardHeld(f) >= this.getUpNeed(f)) {
        const restore = RULES.getUpRestoreHp[Math.min(f.knockdowns, 2) - 1];
        f.status = 'gettingUp';
        f.getUpAt = g;
        f.hp = restore;
        f.stamina = RULES.getUpStamina;
        f.exhausted = false;
        this.events.push({ e: 'getUp', slot });
      }
      return;
    }
    if (f.status === 'gettingUp') {
      if (g - f.getUpAt >= RULES.getUpAnimMs) {
        f.status = 'up';
        f.protectedUntil = f.getUpAt + RULES.getUpAnimMs + RULES.protectAfterGetUpMs;
      }
      return;
    }
    const idle = Math.min(dt, g - (f.lastPunchAt + RULES.recoverDelayMs));
    const rate = guard ? RULES.guardRecoverPerSec : RULES.recoverPerSec;
    if (idle > 0) f.stamina = Math.min(RULES.maxStamina, f.stamina + (rate * idle) / 1000);
    if (f.exhausted && f.stamina >= RULES.exhaustedResumeAt) f.exhausted = false;
  }

  private resolve(p: Pending): void {
    if (this.phase !== 'round') return;
    const a = this.fighters[p.attacker];
    const defSlot = other(p.attacker);
    const d = this.fighters[defSlot];
    const immune = d.status !== 'up' || p.peakAt < d.protectedUntil || a.status !== 'up';
    if (immune) {
      this.events.push({ e: 'land', attacker: p.attacker, punch: p.punch, zone: zoneFor(p.punch), outcome: 'whiff', damage: 0, stagger: false });
      return;
    }
    const r = resolveHit({ punch: p.punch, peakAt: p.peakAt, attackerGassed: p.gassed, defense: d.defense });
    if (r.blocked) {
      const raw = rawDamage(p.punch, p.gassed);
      d.stamina = Math.max(0, d.stamina - (RULES.blockCost + raw * RULES.blockStaminaPerDamage));
      if (d.stamina === 0) d.exhausted = true;
    }
    d.hp = Math.max(0, Math.round((d.hp - r.damage) * 10) / 10);
    this.events.push({ e: 'land', attacker: p.attacker, punch: p.punch, zone: r.zone, outcome: r.outcome, damage: r.damage, stagger: r.stagger });
    if (d.hp <= 0) this.knockdown(defSlot);
  }

  private knockdown(slot: Slot): void {
    const f = this.fighters[slot];
    f.knockdowns++;
    this.events.push({ e: 'knockdown', slot, n: f.knockdowns });
    if (f.knockdowns >= RULES.tkoKnockdowns) {
      this.end({ kind: 'tko', winner: other(slot) });
      return;
    }
    f.status = 'down';
    f.downAt = this.game;
    f.count = 0;
    this.pending = this.pending.filter((p) => p.attacker !== slot);
  }

  private decision(): MatchResult {
    const [a, b] = this.fighters;
    if (a.hp !== b.hp) return { kind: 'decision', winner: a.hp > b.hp ? 0 : 1 };
    if (a.knockdowns !== b.knockdowns) return { kind: 'decision', winner: a.knockdowns < b.knockdowns ? 0 : 1 };
    return { kind: 'draw', winner: null };
  }

  private end(result: MatchResult): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.paused = false;
    this.result = result;
    this.pending = [];
    this.events.push({ e: 'matchEnd', result });
  }

  drain(): MatchEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  snapshot(): MatchSnapshot {
    const fs = this.fighters.map((f): FighterSnapshot => {
      return {
        hp: f.hp,
        stamina: Math.round(f.stamina * 10) / 10,
        gassed: f.stamina < RULES.gassedBelow,
        exhausted: f.exhausted,
        knockdowns: f.knockdowns,
        status: f.status,
        count: f.status === 'down' ? f.count : 0,
        getUpProgress: f.status === 'down' ? Math.min(1, this.guardHeld(f) / this.getUpNeed(f)) : 0,
        protectedMs: Math.max(0, f.protectedUntil - this.game),
      };
    }) as [FighterSnapshot, FighterSnapshot];
    return { phase: this.phase, paused: this.paused, round: this.round, clockMs: Math.max(0, this.clock), fighters: fs, result: this.result };
  }
}
