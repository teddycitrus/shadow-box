import { SFX_NAMES, playSynth, startCrowd, type SfxName } from './synth.ts';

export const ANNOUNCER_LINES = {
  welcome: 'Ladies and gentlemen, welcome to Keyboard Warrior!',
  round1: 'Round one!',
  round2: 'Round two!',
  round3: 'Final round!',
  fight: 'Fight!',
  time: 'Time!',
  down_red: 'Down goes red!',
  down_blue: 'Down goes blue!',
  up: 'And we are back up!',
  big_shot: 'What a shot!',
  uppercut: 'Huge uppercut!',
  ko: 'Knockout!',
  tko: 'Technical knockout!',
  decision: 'We go to the scorecards. The winner, by decision!',
  draw: 'It is a draw!',
  forfeit: 'Win by forfeit!',
  red_wins: 'Red corner wins!',
  blue_wins: 'Blue corner wins!',
} as const;

export type LineKey = keyof typeof ANNOUNCER_LINES;

/**
 * Mix level for each mp3 override. gen-audio peak-normalizes files to -1 dBFS, so these set
 * the balance between them. The synth fallbacks are balanced in synth.ts and ignore this table.
 */
const FILE_GAIN: Record<SfxName, number> = {
  hit_light: 0.8, hit_heavy: 0.9, impact_big: 1, body_thump: 0.75, block: 0.7, whoosh: 0.45, swoosh: 0.22,
  bell: 0.7, bell_end: 0.7, hype: 0.7, clapper: 0.8,
  roar: 0.7, cheer: 0.55, ooh: 0.6, crowd_murmur: 0.45, chant: 0.55, stomp: 0.6,
  count_tick: 0.8, ko_slam: 1, ko_stinger: 1, fanfare: 0.75,
};

/** Percussive sounds that get random pitch and level variation by default. */
const VARY = new Set<SfxName>(['hit_light', 'hit_heavy', 'impact_big', 'body_thump', 'block', 'whoosh', 'swoosh', 'stomp', 'count_tick', 'crowd_murmur']);

export type SfxOpts = {
  /** Level multiplier on top of the per-sound mix. */
  gain?: number;
  /** Random playbackRate within +-6% and slight level jitter. Defaults on for percussive sounds. */
  vary?: boolean;
  /** Start this many seconds from now. */
  delay?: number;
  /** Skip if the same sound started less than this many ms ago (stops crowd reactions stacking). */
  cooldownMs?: number;
};

const MASTER = 0.8;
const MUSIC_GAIN = 0.55;
export type MusicName = 'music_break' | 'music_victory';
const MUSIC_NAMES: MusicName[] = ['music_break', 'music_victory'];
const CROWD_FILE_GAIN = 0.2;

/**
 * Sound manager. Uses a file from public/audio/ when one exists (for example hit_heavy.mp3 or
 * announcer_ko.mp3), otherwise falls back to the synthesizer and speechSynthesis.
 *
 * Graph: effects -> master -> compressor -> speakers; crowd loop -> excite -> duck -> master.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private crowd: GainNode | null = null;
  private crowdExcite: GainNode | null = null;
  private crowdDuck: GainNode | null = null;
  private duckDepth = 1;
  private duckUntil = 0;
  private lastPlayed = new Map<SfxName, number>();
  private files = new Map<string, AudioBuffer>();
  private speaking: Promise<void> = Promise.resolve();
  muted = false;
  /** Extra delay (s) applied to every sound started inside cue(), to line up with other viewers. */
  private cueDelay = 0;
  private seedState = (Math.random() * 2 ** 32) >>> 0;

  /** Seeded random, so every client makes the same crowd and variation choices for an event. */
  rand(): number {
    let t = (this.seedState += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Runs fn with all its sounds delayed by delaySec and random choices seeded from the event id. */
  cue(delaySec: number, seed: number | undefined, fn: () => void): void {
    const prevDelay = this.cueDelay;
    if (seed !== undefined) this.seedState = Math.imul(seed, 2654435761) >>> 0;
    this.cueDelay = Math.max(0, delaySec);
    try {
      fn();
    } finally {
      this.cueDelay = prevDelay;
    }
  }
  private loaded: Promise<void> | null = null;
  private listeners: (() => void)[] = [];

  /** True once audio is unlocked by a click and not muted. */
  get on(): boolean {
    return !!this.ctx && !this.muted;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Must be called from a user gesture. Resolves once the audio files have loaded. */
  unlock(): Promise<void> {
    if (this.ctx) {
      void this.ctx.resume();
      return this.loaded!;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    // Light bus compression glues layered hits together and keeps stacked moments from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.out = ctx.createGain();
    this.out.gain.value = this.muted ? 0 : MASTER;
    this.out.connect(comp);
    this.crowdDuck = ctx.createGain();
    this.crowdDuck.connect(this.out);
    this.crowdExcite = ctx.createGain();
    this.crowdExcite.connect(this.crowdDuck);
    this.loaded = this.loadOverrides();
    this.changed();
    return this.loaded;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.out) this.out.gain.value = m ? 0 : MASTER;
    if (m && 'speechSynthesis' in window) speechSynthesis.cancel();
    this.changed();
  }

  private async loadOverrides(): Promise<void> {
    const wanted = [...SFX_NAMES, ...MUSIC_NAMES, 'crowd', ...Object.keys(ANNOUNCER_LINES).map((k) => `announcer_${k}`)];
    let present: string[] = [];
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}audio-manifest`);
      if (r.ok) present = (await r.json()) as string[];
    } catch {
      return;
    }
    const names = wanted.filter((n) => present.includes(`${n}.mp3`));
    await Promise.all(names.map(async (n) => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}audio/${n}.mp3`);
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('audio')) return;
        this.files.set(n, await this.ctx!.decodeAudioData(await r.arrayBuffer()));
      } catch {
        /* missing override: keep the synth */
      }
    }));
  }

  private playBuffer(buf: AudioBuffer, gain = 1, rate = 1, delay = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.out!);
    src.start(ctx.currentTime + delay);
  }

  sfx(name: SfxName, opts: SfxOpts = {}): void {
    if (!this.ctx || this.muted) return;
    const nowMs = performance.now();
    if (opts.cooldownMs && nowMs - (this.lastPlayed.get(name) ?? -Infinity) < opts.cooldownMs) return;
    this.lastPlayed.set(name, nowMs);
    const vary = opts.vary ?? VARY.has(name);
    const rate = vary ? 0.94 + this.rand() * 0.12 : 1;
    const gain = (opts.gain ?? 1) * (vary ? 0.88 + this.rand() * 0.12 : 1);
    const delay = Math.max(0, (opts.delay ?? 0) + this.cueDelay);
    const f = this.files.get(name);
    if (f) {
      this.playBuffer(f, gain * FILE_GAIN[name], rate, delay);
      return;
    }
    const ctx = this.ctx;
    const run = () => {
      if (this.muted) return;
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(this.out!);
      playSynth(ctx, g, name, rate);
      // Drop the per-call gain node once the longest synth tail has finished.
      setTimeout(() => g.disconnect(), 6000);
    };
    if (delay > 0) setTimeout(run, delay * 1000);
    else run();
  }

  private music: { src: AudioBufferSourceNode; g: GainNode } | null = null;

  /** Plays a music file (no synth fallback: music is optional), replacing any music already playing. */
  playMusic(name: MusicName, delay = 0): void {
    const f = this.files.get(name);
    if (!this.ctx || this.muted || !f) return;
    this.stopMusic(0.3);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = f;
    const g = ctx.createGain();
    const t = ctx.currentTime + Math.max(0, delay + this.cueDelay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(MUSIC_GAIN, t + 0.8);
    src.connect(g).connect(this.out!);
    src.start(t);
    const m = { src, g };
    this.music = m;
    src.onended = () => {
      if (this.music === m) this.music = null;
    };
  }

  stopMusic(fade = 0.6): void {
    const m = this.music;
    if (!m || !this.ctx) return;
    this.music = null;
    const t = this.ctx.currentTime;
    m.g.gain.cancelScheduledValues(t);
    m.g.gain.setValueAtTime(m.g.gain.value, t);
    m.g.gain.linearRampToValueAtTime(0, t + fade);
    m.src.stop(t + fade + 0.05);
  }

  startCrowd(): void {
    if (!this.ctx || this.crowd) return;
    const f = this.files.get('crowd');
    if (f) {
      this.crowd = this.ctx.createGain();
      this.crowd.gain.value = CROWD_FILE_GAIN;
      this.crowd.connect(this.crowdExcite!);
      const src = this.ctx.createBufferSource();
      src.buffer = f;
      src.loop = true;
      src.connect(this.crowd);
      src.start();
    } else this.crowd = startCrowd(this.ctx, this.crowdExcite!);
  }

  /**
   * Briefly raise the crowd loop. k in [0, 1]; 1 is a knockdown-sized swell. Overlapping calls
   * keep the louder level, and the swell eases back over a couple of seconds.
   */
  excite(k: number): void {
    const g = this.crowdExcite;
    if (!this.ctx || !g) return;
    k = Math.min(1, Math.max(0, k));
    if (k <= 0) return;
    const t = this.ctx.currentTime;
    const cur = g.gain.value;
    const target = Math.max(cur, 1 + 1.8 * k);
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(cur, t);
    g.gain.linearRampToValueAtTime(target, t + 0.15 + 0.2 * k);
    g.gain.setTargetAtTime(1, t + 0.4 + 0.8 * k, 0.6 + 0.6 * k);
  }

  /**
   * Dip the crowd loop so a big moment cuts through. depth is the gain held during the dip
   * (0.3 is deep); a lighter duck never overrides a deeper one that is still active.
   */
  duck(depth = 0.4, holdMs = 700): void {
    const g = this.crowdDuck;
    if (!this.ctx || !g) return;
    const nowMs = performance.now();
    if (nowMs < this.duckUntil && depth > this.duckDepth) return;
    this.duckDepth = depth;
    this.duckUntil = nowMs + holdMs;
    const t = this.ctx.currentTime;
    const hold = holdMs / 1000;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(depth, t + 0.05);
    g.gain.setValueAtTime(depth, t + hold);
    g.gain.linearRampToValueAtTime(1, t + hold + 0.9);
  }

  announce(key: LineKey): void {
    if (this.muted) return;
    const f = this.files.get(`announcer_${key}`);
    if (f && this.ctx) {
      this.duck(0.6, Math.min(2500, f.duration * 1000));
      this.playBuffer(f, 1.2, 1, this.cueDelay);
      return;
    }
    if (!('speechSynthesis' in window)) return;
    if (this.cueDelay > 0) {
      const wait = this.cueDelay * 1000;
      setTimeout(() => this.cue(0, undefined, () => this.announce(key)), wait);
      return;
    }
    this.speaking = this.speaking.then(() => new Promise<void>((done) => {
      const u = new SpeechSynthesisUtterance(ANNOUNCER_LINES[key]);
      u.rate = 1.05;
      u.pitch = 0.8;
      u.volume = 1;
      const voice = speechSynthesis.getVoices().find((v) => /en[-_](US|GB)/i.test(v.lang) && /male|david|daniel|guy|google uk english male/i.test(v.name));
      if (voice) u.voice = voice;
      u.onend = u.onerror = () => done();
      speechSynthesis.speak(u);
      setTimeout(done, 4000);
    }));
  }
}

export const sound = new Sound();
