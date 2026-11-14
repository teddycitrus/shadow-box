/** All game sounds synthesized with the Web Audio API. No assets required. */

export const SFX_NAMES = [
  'hit_light', 'hit_heavy', 'impact_big', 'body_thump', 'block', 'whoosh', 'swoosh',
  'bell', 'bell_end', 'hype', 'clapper',
  'roar', 'cheer', 'ooh', 'crowd_murmur', 'chant', 'stomp',
  'count_tick', 'ko_slam', 'ko_stinger', 'fanfare',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

/** Pitch multiplier for the sound currently being built (random variation per call). */
let pitch = 1;

/** Short feedback delay for a sense of space on big moments. */
function reverb(ctx: AudioContext, out: AudioNode, wet = 0.35, time = 0.09, feedback = 0.45): AudioNode {
  const input = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = time;
  const fb = ctx.createGain();
  fb.gain.value = feedback;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  const w = ctx.createGain();
  w.gain.value = wet;
  input.connect(out);
  input.connect(delay).connect(lp).connect(fb).connect(delay);
  lp.connect(w).connect(out);
  return input;
}

type Swell = { peak: number; attack: number; hold: number; release: number; from: number; to: number; q: number; at?: number };

/** Crowd voice texture: band-passed noise with a pitch-like formant sweep. */
function crowdSwell(ctx: AudioContext, out: AudioNode, opts: Swell): void {
  const len = opts.attack + opts.hold + opts.release + 0.1;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, len, true);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = opts.q;
  const t = opts.at ?? ctx.currentTime;
  f.frequency.setValueAtTime(opts.from, t);
  f.frequency.exponentialRampToValueAtTime(opts.to, t + opts.attack + opts.hold);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.peak, t + opts.attack);
  g.gain.setValueAtTime(opts.peak, t + opts.attack + opts.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len - 0.1);
  src.connect(f).connect(g).connect(out);
  src.start(t);
}

/** Scattered hand claps; `rising` makes them build instead of fade. */
function claps(ctx: AudioContext, out: AudioNode, seconds: number, density: number, rising = false, start = ctx.currentTime): void {
  for (let i = 0; i < seconds * density; i++) {
    const at = start + Math.random() * seconds;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1200 + Math.random() * 1500;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const p = (at - start) / seconds;
    env(ctx, g, 0.12 * (rising ? p : 1 - p) + 0.03, 0.002, 0.04, at);
    src.connect(f).connect(g).connect(out);
    src.start(at);
  }
}

const noiseCache = new Map<string, AudioBuffer>();

function noiseBuffer(ctx: AudioContext, seconds: number, brown = false): AudioBuffer {
  // Reuse short buffers; they are only ever read, and punches fire them constantly.
  const key = `${brown ? 'b' : 'w'}${Math.round(seconds * 100)}`;
  const hit = noiseCache.get(key);
  if (hit && hit.sampleRate === ctx.sampleRate) return hit;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  noiseCache.set(key, buf);
  return buf;
}

function env(ctx: AudioContext, g: GainNode, peak: number, attack: number, decay: number, t = ctx.currentTime): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

type NoiseHit = { freq: number; q: number; peak: number; decay: number; type?: BiquadFilterType; at?: number };

function noiseHit(ctx: AudioContext, out: AudioNode, opts: NoiseHit): void {
  const t = opts.at ?? ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.decay + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.value = opts.freq * pitch;
  f.Q.value = opts.q;
  const g = ctx.createGain();
  env(ctx, g, opts.peak, 0.003, opts.decay, t);
  src.connect(f).connect(g).connect(out);
  src.start(t);
}

function thump(ctx: AudioContext, out: AudioNode, from: number, to: number, peak: number, decay: number, t = ctx.currentTime): void {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from * pitch, t);
  o.frequency.exponentialRampToValueAtTime(to * pitch, t + decay);
  const g = ctx.createGain();
  env(ctx, g, peak, 0.002, decay, t);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function sweep(ctx: AudioContext, out: AudioNode, from: number, to: number, peak: number, len: number, q = 2.5): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, len + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from * pitch, t);
  f.frequency.exponentialRampToValueAtTime(to * pitch, t + len * 0.7);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + len * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  src.connect(f).connect(g).connect(out);
  src.start(t);
}

/** Inharmonic partials of a ring bell. */
function bellStrike(ctx: AudioContext, out: AudioNode, base: number, peak: number, decay: number, t: number): void {
  for (const [ratio, amp] of [[1, 0.5], [2.76, 0.25], [5.4, 0.12], [8.93, 0.06]] as const) {
    const o = ctx.createOscillator();
    o.frequency.value = base * ratio;
    const g = ctx.createGain();
    env(ctx, g, amp * peak, 0.002, decay, t);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.1);
  }
}

/** Brass-like note: detuned saws through a lowpass that opens on the attack. */
function brass(ctx: AudioContext, out: AudioNode, freq: number, t: number, len: number, peak: number): void {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 2;
  f.frequency.setValueAtTime(400, t);
  f.frequency.exponentialRampToValueAtTime(2800, t + 0.06);
  f.frequency.exponentialRampToValueAtTime(1400, t + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
  g.gain.setValueAtTime(peak * 0.8, t + len * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  f.connect(g).connect(out);
  for (const det of [-7, 0, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = det;
    o.connect(f);
    o.start(t);
    o.stop(t + len + 0.05);
  }
}

/** Builds `name` into `out`. `rate` shifts the pitch of percussive parts for variation. */
export function playSynth(ctx: AudioContext, out: AudioNode, name: SfxName, rate = 1): void {
  pitch = rate;
  try {
    build(ctx, out, name);
  } finally {
    pitch = 1;
  }
}

function build(ctx: AudioContext, out: AudioNode, name: SfxName): void {
  const now = ctx.currentTime;
  switch (name) {
    case 'hit_light':
      thump(ctx, out, 200, 70, 0.8, 0.09);
      noiseHit(ctx, out, { freq: 2200, q: 0.9, peak: 0.6, decay: 0.05 });
      noiseHit(ctx, out, { freq: 900, q: 0.7, peak: 0.4, decay: 0.07 });
      break;
    case 'hit_heavy':
      thump(ctx, out, 150, 40, 1.2, 0.22);
      noiseHit(ctx, out, { freq: 1000, q: 0.6, peak: 0.85, decay: 0.12 });
      noiseHit(ctx, out, { freq: 3500, q: 1.5, peak: 0.3, decay: 0.04 });
      break;
    case 'impact_big': {
      const r = reverb(ctx, out, 0.4, 0.07, 0.4);
      thump(ctx, r, 160, 30, 1.5, 0.45);
      thump(ctx, r, 70, 28, 1.0, 0.7);
      noiseHit(ctx, r, { freq: 700, q: 0.5, peak: 1.0, decay: 0.18 });
      noiseHit(ctx, r, { freq: 4200, q: 1.2, peak: 0.45, decay: 0.06 });
      break;
    }
    case 'body_thump':
      thump(ctx, out, 95, 38, 1.1, 0.2);
      noiseHit(ctx, out, { freq: 220, q: 0.7, peak: 0.5, decay: 0.09, type: 'lowpass' });
      break;
    case 'block':
      thump(ctx, out, 120, 70, 0.8, 0.08);
      noiseHit(ctx, out, { freq: 450, q: 1, peak: 0.7, decay: 0.07, type: 'lowpass' });
      noiseHit(ctx, out, { freq: 1500, q: 1.4, peak: 0.18, decay: 0.03 });
      break;
    case 'whoosh':
      sweep(ctx, out, 500, 2500, 0.35, 0.25);
      break;
    case 'swoosh':
      sweep(ctx, out, 700 + Math.random() * 300, 1800 + Math.random() * 900, 0.14, 0.16, 3);
      break;
    case 'bell':
      for (let r = 0; r < 3; r++) bellStrike(ctx, out, 880, 1, 1.4, now + r * 0.32);
      break;
    case 'bell_end':
      bellStrike(ctx, out, 760, 1.2, 2.6, now);
      break;
    case 'hype':
      crowdSwell(ctx, out, { peak: 0.9, attack: 1.1, hold: 0.7, release: 1.2, from: 450, to: 950, q: 0.6 });
      crowdSwell(ctx, out, { peak: 0.35, attack: 1.2, hold: 0.6, release: 1.0, from: 1100, to: 2000, q: 1.2 });
      claps(ctx, out, 2.6, 30, true);
      break;
    case 'clapper': {
      // Timekeeper's wooden sticks: three dry clacks.
      for (let i = 0; i < 3; i++) {
        const t = now + i * 0.22;
        noiseHit(ctx, out, { freq: 2600, q: 5, peak: 0.9, decay: 0.035, at: t });
        noiseHit(ctx, out, { freq: 1200, q: 3, peak: 0.5, decay: 0.05, at: t });
        thump(ctx, out, 900, 600, 0.25, 0.04, t);
      }
      break;
    }
    case 'roar': {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 3.5, true);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 700;
      f.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(1.4, now + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 3.3);
      src.connect(f).connect(g).connect(out);
      src.start();
      break;
    }
    case 'cheer':
      crowdSwell(ctx, out, { peak: 0.9, attack: 0.25, hold: 1.2, release: 1.0, from: 650, to: 900, q: 0.6 });
      crowdSwell(ctx, out, { peak: 0.4, attack: 0.3, hold: 1.0, release: 1.0, from: 1500, to: 1900, q: 1.2 });
      claps(ctx, out, 2.2, 28);
      break;
    case 'ooh':
      crowdSwell(ctx, out, { peak: 1.0, attack: 0.18, hold: 0.5, release: 0.9, from: 380, to: 260, q: 2.2 });
      crowdSwell(ctx, out, { peak: 0.45, attack: 0.2, hold: 0.45, release: 0.8, from: 760, to: 520, q: 3 });
      break;
    case 'crowd_murmur':
      crowdSwell(ctx, out, { peak: 0.45, attack: 0.15, hold: 0.3, release: 0.6, from: 420, to: 360, q: 1.6 });
      break;
    case 'chant':
      // Rhythmic crowd pulses on the beat of the count.
      for (let i = 0; i < 4; i++) {
        crowdSwell(ctx, out, { peak: 0.6, attack: 0.08, hold: 0.15, release: 0.35, from: 520, to: 430, q: 1.4, at: now + i * 0.5 });
        claps(ctx, out, 0.08, 120, false, now + i * 0.5);
      }
      break;
    case 'stomp':
      thump(ctx, out, 85, 40, 1.0, 0.18);
      noiseHit(ctx, out, { freq: 300, q: 0.6, peak: 0.6, decay: 0.1, type: 'lowpass' });
      claps(ctx, out, 0.06, 150);
      break;
    case 'count_tick':
      thump(ctx, out, 140, 60, 1.0, 0.12);
      noiseHit(ctx, out, { freq: 900, q: 0.8, peak: 0.7, decay: 0.06 });
      break;
    case 'ko_slam': {
      const r = reverb(ctx, out, 0.55, 0.13, 0.55);
      thump(ctx, r, 120, 22, 1.8, 1.2);
      thump(ctx, r, 55, 20, 1.2, 1.6);
      noiseHit(ctx, r, { freq: 300, q: 0.4, peak: 1.2, decay: 0.5, type: 'lowpass' });
      noiseHit(ctx, r, { freq: 2500, q: 0.8, peak: 0.4, decay: 0.15 });
      break;
    }
    case 'ko_stinger': {
      const r = reverb(ctx, out, 0.6, 0.17, 0.6);
      // Reverse swell into the boom.
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.6);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 1;
      f.frequency.setValueAtTime(300, now);
      f.frequency.exponentialRampToValueAtTime(3000, now + 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.5, now + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      src.connect(f).connect(g).connect(out);
      src.start(now);
      const t = now + 0.45;
      thump(ctx, r, 110, 18, 2.0, 1.8, t);
      thump(ctx, r, 48, 18, 1.4, 2.2, t);
      noiseHit(ctx, r, { freq: 250, q: 0.4, peak: 1.3, decay: 0.7, type: 'lowpass', at: t });
      noiseHit(ctx, r, { freq: 3000, q: 0.8, peak: 0.5, decay: 0.12, at: t });
      crowdSwell(ctx, out, { peak: 1.2, attack: 0.35, hold: 1.4, release: 1.3, from: 600, to: 1000, q: 0.5, at: t + 0.1 });
      claps(ctx, out, 2.5, 30, false, t + 0.3);
      break;
    }
    case 'fanfare': {
      const notes: [number, number, number][] = [[392, 0, 0.16], [523.25, 0.18, 0.16], [659.25, 0.36, 0.16]];
      for (const [freq, at, len] of notes) brass(ctx, out, freq, now + at, len, 0.16);
      for (const freq of [523.25, 659.25, 783.99]) brass(ctx, out, freq, now + 0.56, 1.4, 0.12);
      crowdSwell(ctx, out, { peak: 0.7, attack: 0.4, hold: 1.6, release: 1.2, from: 650, to: 950, q: 0.6 });
      claps(ctx, out, 3, 30);
      break;
    }
  }
}

/** Looping crowd murmur: brown noise through a band-pass with a slow swell. */
export function startCrowd(ctx: AudioContext, out: AudioNode): GainNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 4, true);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 500;
  f.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.value = 0.13;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.13;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.035;
  lfo.connect(lfoGain).connect(g.gain);
  src.connect(f).connect(g).connect(out);
  src.start();
  lfo.start();
  return g;
}
