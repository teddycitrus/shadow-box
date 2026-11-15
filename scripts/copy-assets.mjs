// Copies the MediaPipe WASM runtime into client/public so the game never loads it from a CDN, and
// downloads any missing Pose Landmarker model (full and lite, float16) into client/public/models.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'client/public/mediapipe/wasm';
if (!existsSync(src)) throw new Error(`missing ${src}, run npm install`);
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });

mkdirSync('client/public/models', { recursive: true });
for (const variant of ['full', 'lite']) {
  const file = `client/public/models/pose_landmarker_${variant}.task`;
  if (existsSync(file)) continue;
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${variant}/float16/latest/pose_landmarker_${variant}.task`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`downloaded ${file}`);
  } catch (e) {
    console.warn(`warning: ${file} is missing and could not be downloaded (${e.message})`);
  }
}
