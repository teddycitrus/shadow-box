// Optional: pre-generates sound effects and announcer lines into client/public/audio/ with the
// ElevenLabs API. The game never needs this; without the files it synthesizes everything.
//
// Usage: npm run gen:audio [-- --force] [-- --only=bell,announcer_ko] [-- --polish]
// With ffmpeg on PATH, sound effects are trimmed and peak-normalized after download.
// --polish re-runs that step on existing files without calling the API.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOUNCER_LINES } from '../client/src/audio/sound.ts';
import type { SfxName } from '../client/src/audio/synth.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'client', 'public', 'audio');
const API = 'https://api.elevenlabs.io/v1';
// "George", one of the ElevenLabs default voices. Override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

const SFX: Record<SfxName | 'crowd', { text: string; seconds: number; loop?: boolean }> = {
  hit_light: { text: 'Crisp boxing jab connecting, sharp punchy leather glove smack on skin, video game punch sound, close mic, no crowd, no reverb', seconds: 0.5 },
  hit_heavy: { text: 'Heavy boxing hook connecting, loud meaty leather glove smack with a deep thud, video game punch impact, close mic, no crowd', seconds: 0.7 },
  impact_big: { text: 'Massive video game boxing knockout punch impact, loud crunchy leather smack with a huge deep bass boom and short arena reverb tail, no crowd', seconds: 1.2 },
  body_thump: { text: 'Deep low punch to the body, heavy muffled sub bass thud like a fist hitting a heavy bag, very short, no crowd', seconds: 0.5 },
  block: { text: 'Boxing punch blocked by padded gloves, firm muffled leather glove thud, close mic, no crowd', seconds: 0.5 },
  whoosh: { text: 'Fast boxing punch missing, sharp air whoosh past the head, close mic', seconds: 0.5 },
  swoosh: { text: 'Quick soft fist swish through the air, subtle short swoosh, close mic', seconds: 0.5 },
  bell: { text: 'Boxing ring bell, three quick metallic dings', seconds: 2 },
  bell_end: { text: 'Single long boxing ring bell ding ringing out to end a round', seconds: 2.5 },
  hype: { text: 'Boxing arena crowd swelling into a loud excited roar with cheering, whistles and clapping as a round begins', seconds: 3 },
  clapper: { text: 'Boxing timekeeper banging two wooden sticks together three times, sharp loud dry wooden clacks', seconds: 1.2 },
  roar: { text: 'Arena crowd erupting in a loud cheer after a knockout', seconds: 3 },
  cheer: { text: 'Boxing arena crowd cheering and clapping excitedly for a few seconds', seconds: 2.5 },
  ooh: { text: 'Large arena crowd reacting with a loud collective oooh to a big punch', seconds: 1.8 },
  crowd_murmur: { text: 'Boxing arena crowd reacting with a short low murmur, brief collective mmm of appreciation', seconds: 1.5 },
  chant: { text: 'Arena crowd stomping feet and clapping together in a steady rhythm, chanting loudly, one beat per second', seconds: 4 },
  stomp: { text: 'Single loud arena crowd stomp and clap in unison, one deep beat', seconds: 0.6 },
  count_tick: { text: 'Referee slapping his open palm hard on a boxing ring canvas mat once, loud sharp thump, close mic', seconds: 0.5 },
  ko_slam: { text: 'Huge slow-motion knockout impact, heavy body slamming onto a boxing ring canvas, deep boom with ring ropes rattling, dramatic reverb', seconds: 2 },
  ko_stinger: { text: 'Dramatic cinematic knockout stinger, short reverse swell into a huge deep boom hit, then a stadium crowd exploding into a roar', seconds: 3.5 },
  fanfare: { text: 'Short triumphant brass victory fanfare over a cheering boxing arena crowd', seconds: 4 },
  crowd: { text: 'Steady indoor boxing arena crowd murmur, distant chatter, even level, seamless loop', seconds: 10, loop: true },
};

/** Peak level that sound effects are normalized to; the game sets the mix in sound.ts. */
const PEAK_DB = -1;

function hasFfmpeg(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

/**
 * Trims leading silence (so punches land on time) and peak-normalizes to PEAK_DB. Loops keep
 * their start untouched so they still loop cleanly. LAME VBR (-q:a 5) keeps the level intact and
 * comes out smaller than 128k CBR, which drops about 0.4 dB on these clips.
 */
function polish(file: string, loop: boolean): void {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr ?? '');
  if (!m) return;
  const gain = PEAK_DB - Number(m[1]);
  const filters = [...(loop ? [] : ['silenceremove=start_periods=1:start_threshold=-45dB']), `volume=${gain.toFixed(2)}dB`];
  const tmp = `${file}.tmp.mp3`;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', filters.join(','), '-c:a', 'libmp3lame', '-q:a', '5', tmp]);
  if (r.status === 0) renameSync(tmp, file);
}

/** Instrumental music for the round break and the end of a match. */
const MUSIC: Record<string, { prompt: string; ms: number }> = {
  music_break: { prompt: 'Short high-energy fight night intermission instrumental, hard hip hop drums, punchy brass stabs, arena hype, no vocals', ms: 10_000 },
  music_victory: { prompt: 'Triumphant boxing victory anthem instrumental, big stadium drums, heroic brass and synth, celebratory hype, no vocals', ms: 28_000 },
};

/** Minimal .env parser: KEY=value lines, optional quotes, # comments. */
function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

async function post(url: string, key: string, body: unknown): Promise<Buffer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const env = { ...readDotEnv(join(ROOT, '.env')), ...process.env };
  const ffmpeg = hasFfmpeg();
  const sfxOnly = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (arg('polish') !== undefined) {
    if (!ffmpeg) throw new Error('--polish needs ffmpeg on PATH');
    for (const [name, s] of Object.entries(SFX)) {
      const file = join(OUT, `${name}.mp3`);
      if ((sfxOnly && !sfxOnly.includes(name)) || !existsSync(file)) continue;
      polish(file, !!s.loop);
      console.log(`polished ${name}.mp3`);
    }
    return;
  }
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    console.log('ELEVENLABS_API_KEY is not set, nothing to do.');
    console.log('Add ELEVENLABS_API_KEY=... to .env at the repo root (see .env.example) or set it in the environment.');
    console.log('This is optional; the game synthesizes every sound without these files.');
    return;
  }
  const voice = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE;
  const force = arg('force') !== undefined;
  const only = sfxOnly;

  type Job = { name: string; run: () => Promise<Buffer>; sfx?: { loop: boolean } };
  const jobs: Job[] = [
    ...Object.entries(SFX).map(([name, s]): Job => ({
      name,
      sfx: { loop: !!s.loop },
      run: () => post(`${API}/sound-generation`, key, { text: s.text, duration_seconds: s.seconds, ...(s.loop ? { loop: true } : {}) }),
    })),
    ...Object.entries(MUSIC).map(([name, m]): Job => ({
      name,
      run: () => post(`${API}/music`, key, { prompt: m.prompt, music_length_ms: m.ms }),
    })),
    ...Object.entries(ANNOUNCER_LINES).map(([k, text]): Job => ({
      name: `announcer_${k}`,
      run: () => post(`${API}/text-to-speech/${encodeURIComponent(voice)}`, key, { text, model_id: 'eleven_multilingual_v2' }),
    })),
  ];

  if (!ffmpeg) console.log('ffmpeg not found; sound effects are saved without trimming or normalizing.');
  mkdirSync(OUT, { recursive: true });
  let made = 0;
  let failed = 0;
  for (const job of jobs) {
    if (only && !only.includes(job.name)) continue;
    const file = join(OUT, `${job.name}.mp3`);
    if (existsSync(file) && !force) {
      console.log(`skip ${job.name}.mp3 (exists, use --force to replace)`);
      continue;
    }
    try {
      writeFileSync(file, await job.run());
      if (job.sfx && ffmpeg) polish(file, job.sfx.loop);
      made++;
      console.log(`wrote ${job.name}.mp3`);
    } catch (err) {
      failed++;
      console.error(`failed ${job.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`done: ${made} written, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

await main();
