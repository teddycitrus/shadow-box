// Copies the MediaPipe WASM runtime into client/public so the game never loads it from a CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const src = 'node_modules/@mediapipe/tasks-vision/wasm';
const dst = 'client/public/mediapipe/wasm';
if (!existsSync(src)) throw new Error(`missing ${src}, run npm install`);
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
if (!existsSync('client/public/models/pose_landmarker_full.task')) {
  console.warn('warning: client/public/models/pose_landmarker_full.task is missing');
}
