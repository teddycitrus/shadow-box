/** All game sounds synthesized with the Web Audio API. No assets required. */

export type SfxName = 'hit_light' | 'hit_heavy' | 'block' | 'whoosh' | 'bell' | 'roar';

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
