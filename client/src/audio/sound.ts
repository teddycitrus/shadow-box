import { playSynth, startCrowd, type SfxName } from './synth.ts';

export const ANNOUNCER_LINES = {
  welcome: 'Ladies and gentlemen, welcome to Shadow Box!',
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

const SFX: SfxName[] = ['hit_light', 'hit_heavy', 'block', 'whoosh', 'bell', 'roar', 'impact_big', 'ko_slam', 'cheer', 'ooh', 'count_tick', 'bell_end'];

/**
 * Sound manager. Uses a file from public/audio/ when one exists (for example hit_heavy.mp3 or
 * announcer_ko.mp3), otherwise falls back to the synthesizer and speechSynthesis.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private crowd: GainNode | null = null;
  private files = new Map<string, AudioBuffer>();
  private speaking: Promise<void> = Promise.resolve();
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(this.ctx.destination);
    void this.loadOverrides();
  }

  private async loadOverrides(): Promise<void> {
    const wanted = [...SFX, 'crowd', ...Object.keys(ANNOUNCER_LINES).map((k) => `announcer_${k}`)];
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

  private playBuffer(buf: AudioBuffer, loop = false, gain = 1): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const g = this.ctx!.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.out!);
    src.start();
    return src;
  }

  sfx(name: SfxName): void {
    if (!this.ctx || this.muted) return;
    const f = this.files.get(name);
    if (f) this.playBuffer(f);
    else playSynth(this.ctx, this.out!, name);
  }

  startCrowd(): void {
    if (!this.ctx || this.crowd) return;
    const f = this.files.get('crowd');
    if (f) {
      this.crowd = this.ctx.createGain();
      this.crowd.gain.value = 0.4;
      this.crowd.connect(this.out!);
      const src = this.ctx.createBufferSource();
      src.buffer = f;
      src.loop = true;
      src.connect(this.crowd);
      src.start();
    } else this.crowd = startCrowd(this.ctx, this.out!);
  }

  announce(key: LineKey): void {
    if (this.muted) return;
    const f = this.files.get(`announcer_${key}`);
    if (f && this.ctx) {
      this.playBuffer(f, false, 1.2);
      return;
    }
    if (!('speechSynthesis' in window)) return;
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
