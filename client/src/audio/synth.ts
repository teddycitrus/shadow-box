/** All game sounds synthesized with the Web Audio API. No assets required. */

export type SfxName =
  | 'hit_light' | 'hit_heavy' | 'block' | 'whoosh' | 'bell' | 'roar'
  | 'impact_big' | 'ko_slam' | 'cheer' | 'ooh' | 'count_tick' | 'bell_end';

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

/** Crowd voice texture: band-passed noise with a pitch-like formant sweep. */
function crowdSwell(ctx: AudioContext, out: AudioNode, opts: { peak: number; attack: number; hold: number; release: number; from: number; to: number; q: number }): void {
  const len = opts.attack + opts.hold + opts.release + 0.1;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, len, true);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = opts.q;
  const t = ctx.currentTime;
  f.frequency.setValueAtTime(opts.from, t);
  f.frequency.exponentialRampToValueAtTime(opts.to, t + opts.attack + opts.hold);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.peak, t + opts.attack);
  g.gain.setValueAtTime(opts.peak, t + opts.attack + opts.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len - 0.1);
  src.connect(f).connect(g).connect(out);
  src.start();
}

function claps(ctx: AudioContext, out: AudioNode, seconds: number, density: number): void {
  for (let i = 0; i < seconds * density; i++) {
    const at = ctx.currentTime + Math.random() * seconds;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1200 + Math.random() * 1500;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const fade = 1 - (at - ctx.currentTime) / seconds;
    env(ctx, g, 0.12 * fade + 0.03, 0.002, 0.04, at);
    src.connect(f).connect(g).connect(out);
    src.start(at);
  }
}

function noiseBuffer(ctx: AudioContext, seconds: number, brown = false): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

function env(ctx: AudioContext, g: GainNode, peak: number, attack: number, decay: number, t = ctx.currentTime): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noiseHit(ctx: AudioContext, out: AudioNode, opts: { freq: number; q: number; peak: number; decay: number; type?: BiquadFilterType }): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, opts.decay + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.value = opts.freq;
  f.Q.value = opts.q;
  const g = ctx.createGain();
  env(ctx, g, opts.peak, 0.003, opts.decay);
  src.connect(f).connect(g).connect(out);
  src.start();
}

function thump(ctx: AudioContext, out: AudioNode, from: number, to: number, peak: number, decay: number): void {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(to, ctx.currentTime + decay);
  const g = ctx.createGain();
  env(ctx, g, peak, 0.002, decay);
  o.connect(g).connect(out);
  o.start();
  o.stop(ctx.currentTime + decay + 0.05);
}

export function playSynth(ctx: AudioContext, out: AudioNode, name: SfxName): void {
  switch (name) {
    case 'hit_light':
      thump(ctx, out, 180, 60, 0.9, 0.12);
      noiseHit(ctx, out, { freq: 1800, q: 0.8, peak: 0.5, decay: 0.07 });
      break;
    case 'hit_heavy':
      thump(ctx, out, 140, 38, 1.2, 0.25);
      noiseHit(ctx, out, { freq: 900, q: 0.6, peak: 0.8, decay: 0.14 });
      noiseHit(ctx, out, { freq: 3500, q: 1.5, peak: 0.25, decay: 0.05 });
      break;
    case 'block':
      thump(ctx, out, 110, 70, 0.7, 0.09);
      noiseHit(ctx, out, { freq: 400, q: 1, peak: 0.6, decay: 0.08, type: 'lowpass' });
      break;
    case 'whoosh': {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.3);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 2.5;
      f.frequency.setValueAtTime(500, ctx.currentTime);
      f.frequency.exponentialRampToValueAtTime(2500, ctx.currentTime + 0.18);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      src.connect(f).connect(g).connect(out);
      src.start();
      break;
    }
    case 'bell': {
      for (let r = 0; r < 3; r++) {
        const t = ctx.currentTime + r * 0.32;
        for (const [ratio, amp] of [[1, 0.5], [2.76, 0.25], [5.4, 0.12], [8.93, 0.06]] as const) {
          const o = ctx.createOscillator();
          o.frequency.value = 880 * ratio;
          const g = ctx.createGain();
          env(ctx, g, amp, 0.002, 1.4, t);
          o.connect(g).connect(out);
          o.start(t);
          o.stop(t + 1.5);
        }
      }
      break;
    }
    case 'impact_big': {
      const r = reverb(ctx, out, 0.4, 0.07, 0.4);
      thump(ctx, r, 160, 30, 1.5, 0.45);
      thump(ctx, r, 70, 28, 1.0, 0.7);
      noiseHit(ctx, r, { freq: 700, q: 0.5, peak: 1.0, decay: 0.18 });
      noiseHit(ctx, r, { freq: 4200, q: 1.2, peak: 0.45, decay: 0.06 });
      break;
    }
    case 'ko_slam': {
      const r = reverb(ctx, out, 0.55, 0.13, 0.55);
      thump(ctx, r, 120, 22, 1.8, 1.2);
      thump(ctx, r, 55, 20, 1.2, 1.6);
      noiseHit(ctx, r, { freq: 300, q: 0.4, peak: 1.2, decay: 0.5, type: 'lowpass' });
      noiseHit(ctx, r, { freq: 2500, q: 0.8, peak: 0.4, decay: 0.15 });
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
    case 'count_tick':
      thump(ctx, out, 140, 60, 1.0, 0.12);
      noiseHit(ctx, out, { freq: 900, q: 0.8, peak: 0.7, decay: 0.06 });
      break;
    case 'bell_end': {
      const t = ctx.currentTime;
      for (const [ratio, amp] of [[1, 0.6], [2.76, 0.3], [5.4, 0.14], [8.93, 0.07]] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = 760 * ratio;
        const g = ctx.createGain();
        env(ctx, g, amp, 0.002, 2.6, t);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 2.8);
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
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(1.4, ctx.currentTime + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 3.3);
      src.connect(f).connect(g).connect(out);
      src.start();
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
  g.gain.value = 0.18;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.13;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.05;
  lfo.connect(lfoGain).connect(g.gain);
  src.connect(f).connect(g).connect(out);
  src.start();
  lfo.start();
  return g;
}
