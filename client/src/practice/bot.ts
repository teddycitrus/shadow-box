import { Match } from '../../../shared/match.ts';
import { RULES, punchKind } from '../../../shared/rules.ts';
import { NO_DEFENSE, type DefenseState, type Punch, type PunchType, type Slot, type Stance, type Target, type WirePose } from '../../../shared/types.ts';
import { SW_METRES, toWire } from '../tracking/input.ts';
import { PUNCH_TIMING, punchDuration, synthPose, type SynthPunch } from '../tracking/synthetic.ts';
import { noopHandlers, type MatchLink } from '../net/link.ts';

const BOT_PUNCHES: PunchType[] = ['jab', 'jab', 'cross', 'leftHook', 'rightHook', 'leftUppercut', 'rightUppercut'];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Practice opponent: slow, telegraphed punches, real stamina, can be knocked down. */
export class Bot {
  defense: DefenseState = NO_DEFENSE;
  current: SynthPunch | null = null;
  private nextAction = 0;
  private guardUntil = 0;
  private getUpAt = 0;
  private fired = false;

  constructor(private match: Match, private slot: Slot) {}

  update(now: number): { pose: WirePose; telegraph: number; defenseChanged: boolean } {
    const me = this.match.fighters[this.slot];
    const prev = this.defense;
    let def: DefenseState = NO_DEFENSE;
    if (me.status === 'down') {
      if (!this.getUpAt) this.getUpAt = now + rand(1500, 4500);
      def = { ...NO_DEFENSE, guard: now > this.getUpAt };
      this.current = null;
    } else {
      this.getUpAt = 0;
      if (now < this.guardUntil && !this.current) def = { ...NO_DEFENSE, guard: true };
      this.think(now);
    }
    this.defense = def;

    const p = this.current;
    let telegraph = 0;
    if (p) {
      const k = now - p.startT;
      if (k < p.windupMs) telegraph = Math.min(1, k / p.windupMs);
      if (!this.fired && k >= p.windupMs + PUNCH_TIMING.extendMs) {
        this.fired = true;
        const punch: Punch = { type: p.type, hand: p.hand, target: p.target };
        this.match.punch(this.slot, punch, now, now);
      }
      if (k > punchDuration(p)) this.current = null;
    }
    const gassed = me.stamina < RULES.gassedBelow;
    const { world, offset } = synthPose({ t: now, defense: def, punch: p ?? undefined, gassed });
    const changed = prev.guard !== def.guard || prev.duck !== def.duck || prev.slip !== def.slip;
    return { pose: toWire(world, [offset[0] / SW_METRES, offset[1] / SW_METRES]), telegraph, defenseChanged: changed };
  }

  private think(now: number): void {
    if (this.current || now < this.nextAction || this.match.phase !== 'round') return;
    const me = this.match.fighters[this.slot];
    const gassed = me.stamina < RULES.gassedBelow;
    this.nextAction = now + rand(900, 2200) * (gassed ? 1.6 : 1);
    if (Math.random() < 0.35) {
      this.guardUntil = now + rand(700, 1800);
      return;
    }
    const type = BOT_PUNCHES[Math.floor(Math.random() * BOT_PUNCHES.length)];
    if (!this.match.canPunch(this.slot) || me.stamina < RULES.punchCost[punchKind(type)] + 4) return;
    const hand = type === 'jab' ? 'left' : type === 'cross' ? 'right' : type.startsWith('left') ? 'left' : 'right';
    const target: Target = Math.random() < 0.7 ? 'head' : 'body';
    this.current = { type, hand, target, startT: now, windupMs: rand(650, 900) };
    this.fired = false;
  }
}

/** Bot vs bot, for the title screen backdrop. Restarts when a match ends. */
export class DemoLink implements MatchLink {
  readonly slot = null;
  handlers = noopHandlers();
  private match = new Match();
  private bots = [new Bot(this.match, 0), new Bot(this.match, 1)];

  constructor() {
    this.match.start(performance.now());
    setInterval(() => this.tick(), 1000 / 30);
  }

  punch(): void {}
  defense(): void {}
  pose(): void {}
  ready(): void {}

  private tick(): void {
    const now = performance.now();
    if (this.match.phase === 'ended') {
      this.match = new Match();
      this.bots = [new Bot(this.match, 0), new Bot(this.match, 1)];
      this.match.start(now);
    }
    this.match.tick(now);
    this.bots.forEach((bot, i) => {
      const b = bot.update(now);
      if (b.defenseChanged) this.match.setDefense(i as Slot, bot.defense, now, now);
      this.handlers.pose(i as Slot, b.pose, bot.defense);
    });
    for (const e of this.match.drain()) this.handlers.event(e);
    this.handlers.state(this.match.snapshot(), null);
  }
}

/** Runs a Match locally in the browser with the bot as the blue corner. */
export class PracticeLink implements MatchLink {
  readonly slot: Slot = 0;
  handlers = noopHandlers();
  private match = new Match();
  private bot = new Bot(this.match, 1);
  private lastState = 0;

  constructor() {
    setInterval(() => this.tick(), 1000 / 60);
  }

  punch(p: Punch, at: number): void {
    this.match.punch(0, p, at, performance.now());
    this.flush();
  }

  defense(d: DefenseState, at: number): void {
    this.match.setDefense(0, d, at, performance.now());
  }

  pose(): void {}

  ready(ready: boolean, calibrated: boolean, stance: Stance): void {
    this.handlers.lobby([{ connected: true, calibrated, ready, stance }, { connected: true, calibrated: true, ready: true, stance: 'orthodox' }], 0);
    if (ready && calibrated && this.match.phase === 'lobby') this.match.start(performance.now());
  }

  private tick(): void {
    const now = performance.now();
    this.match.tick(now);
    const b = this.bot.update(now);
    if (b.defenseChanged) this.match.setDefense(1, this.bot.defense, now, now);
    this.handlers.pose(1, b.pose, this.bot.defense);
    this.handlers.telegraph?.(1, this.bot.current?.hand ?? null, b.telegraph);
    this.flush();
    if (now - this.lastState > 50) {
      this.lastState = now;
      this.handlers.state(this.match.snapshot(), null);
    }
  }

  private flush(): void {
    for (const e of this.match.drain()) this.handlers.event(e);
  }
}
