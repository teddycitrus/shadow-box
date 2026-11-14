// Writes dist/client/audio-manifest.json (the mp3 list) so a static host or Worker can serve it.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

const dir = 'dist/client/audio';
const out = 'dist/client/audio-manifest.json';
if (!existsSync('dist/client')) throw new Error('dist/client is missing, run vite build first');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort() : [];
writeFileSync(out, JSON.stringify(files));
console.log(`${out}: ${files.length} files`);
