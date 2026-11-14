// Optional: pre-generates sound effects and announcer lines into client/public/audio/ with the
// ElevenLabs API. The game never needs this; without the files it synthesizes everything.
//
// Usage: npm run gen:audio [-- --force] [-- --only=bell,announcer_ko]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANNOUNCER_LINES } from '../client/src/audio/sound.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'client', 'public', 'audio');
const API = 'https://api.elevenlabs.io/v1';
// "George", one of the ElevenLabs default voices. Override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

const SFX: Record<string, { text: string; seconds: number; loop?: boolean }> = {
  hit_light: { text: 'Single quick boxing glove jab landing on a face, short dry leather slap, no crowd', seconds: 0.6 },
  hit_heavy: { text: 'Single heavy boxing punch landing hard on a body, deep thud with leather impact, no crowd', seconds: 0.9 },
  block: { text: 'Boxing glove punch blocked by another glove, muffled padded leather thump', seconds: 0.6 },
  whoosh: { text: 'Fast single fist swing through air, short whoosh', seconds: 0.5 },
  bell: { text: 'Boxing ring bell, three quick metallic dings', seconds: 2 },
  roar: { text: 'Arena crowd erupting in a loud cheer after a knockout', seconds: 3 },
  impact_big: { text: 'Massive cinematic boxing knockout punch impact, crunchy leather smack with a deep bass boom and short reverb tail, no crowd', seconds: 1.2 },
  ko_slam: { text: 'Huge slow-motion knockout impact, heavy body slamming onto a boxing ring canvas, deep boom with ring ropes rattling, dramatic reverb', seconds: 2 },
  cheer: { text: 'Boxing arena crowd cheering and clapping excitedly for a few seconds', seconds: 2.5 },
  ooh: { text: 'Large arena crowd reacting with a loud collective oooh to a big punch', seconds: 1.8 },
  count_tick: { text: 'Single hard referee hand slap on a boxing ring canvas, sharp thump', seconds: 0.5 },
  bell_end: { text: 'Single long boxing ring bell ding ringing out to end a round', seconds: 2.5 },
  crowd: { text: 'Steady indoor boxing arena crowd murmur, distant chatter, even level, seamless loop', seconds: 10, loop: true },
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
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    console.log('ELEVENLABS_API_KEY is not set, nothing to do.');
    console.log('Add ELEVENLABS_API_KEY=... to .env at the repo root (see .env.example) or set it in the environment.');
    console.log('This is optional; the game synthesizes every sound without these files.');
    return;
  }
  const voice = env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE;
  const force = arg('force') !== undefined;
  const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);

  type Job = { name: string; run: () => Promise<Buffer> };
  const jobs: Job[] = [
    ...Object.entries(SFX).map(([name, s]): Job => ({
      name,
      run: () => post(`${API}/sound-generation`, key, { text: s.text, duration_seconds: s.seconds, ...(s.loop ? { loop: true } : {}) }),
    })),
    ...Object.entries(ANNOUNCER_LINES).map(([k, text]): Job => ({
      name: `announcer_${k}`,
      run: () => post(`${API}/text-to-speech/${encodeURIComponent(voice)}`, key, { text, model_id: 'eleven_multilingual_v2' }),
    })),
  ];

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
