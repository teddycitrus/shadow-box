// Copies the MediaPipe WASM runtime into client/public so the game never loads it from a CDN, and
// downloads any missing Pose Landmarker model (full and lite, float16) into client/public/models.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'client/public/mediapipe/wasm';
if (!existsSync(src)) throw new Error(`missing ${src}, run npm install`);
mkdirSync(dst, { recursive: true });
// FilesetResolver.forVisionTasks(path) without useModule loads only vision_wasm_internal.{js,wasm};
// the ES module build (vision_wasm_module_internal.*) is never fetched, so it is not shipped.
const keep = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
for (const f of keep) copyFileSync(`${src}/${f}`, `${dst}/${f}`);
for (const f of readdirSync(dst)) if (!keep.includes(f)) rmSync(`${dst}/${f}`, { recursive: true, force: true });

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
