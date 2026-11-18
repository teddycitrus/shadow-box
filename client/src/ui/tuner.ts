import type { PunchType, Stance, Target } from '../../../shared/types.ts';
import type { InputSource, InputTick } from '../tracking/input.ts';
import { button, h } from './dom.ts';

export type DefenseLabel = 'guard' | 'duck' | 'slipLeft' | 'slipRight';

interface Step {
  id: string;
  label: string;
  punch?: PunchType;
  target?: Target;
  defense?: DefenseLabel;
  /** Punches of one combo rep, in order (type names follow the stance, so the lead hook of a southpaw is rightHook). */
  combo?: (s: Stance) => PunchType[];
  /** Free boxing for this many seconds, with no expected punches. */
  free?: number;
  /** Saved under tests/fixtures/fast/, away from the clips the evals and tests load. */
  fast?: boolean;
}

const REPS = 5;

const STEPS: Step[] = [
  { id: 'jab-head', label: 'Jab to the head', punch: 'jab', target: 'head' },
  { id: 'cross-head', label: 'Cross to the head', punch: 'cross', target: 'head' },
  { id: 'lhook-head', label: 'Left hook to the head', punch: 'leftHook', target: 'head' },
  { id: 'rhook-head', label: 'Right hook to the head', punch: 'rightHook', target: 'head' },
  { id: 'luppercut', label: 'Left uppercut', punch: 'leftUppercut', target: 'head' },
  { id: 'ruppercut', label: 'Right uppercut', punch: 'rightUppercut', target: 'head' },
  { id: 'jab-body', label: 'Jab to the body (punch low, at stomach height)', punch: 'jab', target: 'body' },
  { id: 'cross-body', label: 'Cross to the body', punch: 'cross', target: 'body' },
  { id: 'guard', label: 'High guard: drop your hands, then raise both gloves to your face and hold 1 s', defense: 'guard' },
  { id: 'duck', label: 'Duck: drop your head well down, then come back up', defense: 'duck' },
  { id: 'slip-left', label: 'Slip left: move your head to your left, then back', defense: 'slipLeft' },
  { id: 'slip-right', label: 'Slip right: move your head to your right, then back', defense: 'slipRight' },
  { id: 'fast-jab-head', label: 'Jab to the head, as fast as you can', punch: 'jab', target: 'head', fast: true },
  { id: 'fast-cross-head', label: 'Cross to the head, as fast as you can', punch: 'cross', target: 'head', fast: true },
  { id: 'fast-lhook-head', label: 'Left hook to the head, as fast as you can', punch: 'leftHook', target: 'head', fast: true },
  { id: 'fast-rhook-head', label: 'Right hook to the head, as fast as you can', punch: 'rightHook', target: 'head', fast: true },
  { id: 'fast-luppercut', label: 'Left uppercut, as fast as you can', punch: 'leftUppercut', target: 'head', fast: true },
  { id: 'fast-ruppercut', label: 'Right uppercut, as fast as you can', punch: 'rightUppercut', target: 'head', fast: true },
  { id: 'double-jab', label: 'Double jab, as fast as you can', combo: () => ['jab', 'jab'], target: 'head', fast: true },
  { id: 'combo-12', label: 'Jab, cross (1-2), as fast as you can', combo: () => ['jab', 'cross'], target: 'head', fast: true },
  { id: 'combo-123', label: 'Jab, cross, lead hook (1-2-3), as fast as you can', combo: (st) => ['jab', 'cross', st === 'orthodox' ? 'leftHook' : 'rightHook'], target: 'head', fast: true },
  { id: 'free', label: 'Box freely for 15 seconds: punch as fast and as wildly as you would in a real fight', free: 15, fast: true },
];

const VIDEO_BPS = 2_500_000;

/** Raw camera video of one step. */
class VideoClip {
  /** performance.now() at the recorder's start event, the clock of the frame times. */
  startT: number | null = null;
  private chunks: Blob[] = [];
  private constructor(private rec: MediaRecorder) {
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    rec.onstart = () => (this.startT = performance.now());
    rec.start(1000);
  }

  /** Null when MediaRecorder, a webm codec or the camera stream is unavailable. */
  static start(video: HTMLVideoElement | null): VideoClip | null {
    const stream = video?.srcObject;
    if (typeof MediaRecorder === 'undefined' || !(stream instanceof MediaStream) || !stream.getVideoTracks().length) return null;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mimeType) return null;
    try {
      return new VideoClip(new MediaRecorder(new MediaStream(stream.getVideoTracks()), { mimeType, videoBitsPerSecond: VIDEO_BPS }));
    } catch {
      return null;
    }
  }

  /** Stops recording; resolves with the webm, or null if nothing was recorded. */
  stop(): Promise<Blob | null> {
    const done = () => (this.chunks.length ? new Blob(this.chunks, { type: 'video/webm' }) : null);
    if (this.rec.state === 'inactive') return Promise.resolve(done());
    return new Promise((resolve) => {
      this.rec.onstop = () => resolve(done());
      this.rec.stop();
    });
  }
}

/** Posts a file to the dev server's fixture writer, or downloads it when there is none. */
async function save(path: string, body: Blob): Promise<boolean> {
  try {
    const r = await fetch(`/__fixtures/${path}`, { method: 'POST', body });
    if (!r.ok) throw new Error(String(r.status));
    return true;
  } catch {
    h('a', { href: URL.createObjectURL(body), download: path.split('/').pop()! }).click();
    return false;
  }
}

/**
 * ?record=1: walks through every move, records each one REPS times and saves a labelled
 * fixture into tests/fixtures/ (via the dev server) for the classifier tests. The fast steps
 * go into tests/fixtures/fast/. Each step also saves the raw camera video as webm: root clips
 * into tests/fixtures/video/, fast clips next to their JSON.
 */
export function tuner(input: InputSource): { el: HTMLElement; push(t: InputTick): void } {
  let i = 0;
  let recording = false;
  let frames: unknown[] = [];
  let detected: string[] = [];
  let defenseEdges = 0;
  let lastDef = false;
  let clip: VideoClip | null = null;
  let startedAt = 0;

  const title = h('div', { class: 'tune-step' });
  const how = h('div', { class: 'tune-how' });
  const live = h('div', { class: 'tune-live' });
  const note = h('div', { class: 'tune-note' });
  const start = button('Start recording', () => begin(), 'primary');
  const done = button('Done, save', () => void finish());
  const redo = button('Redo', () => begin());
  const skip = button('Skip', () => advance());

  function step(): Step {
    return STEPS[i];
  }

  function render(): void {
    const s = step();
    if (!s) {
      title.textContent = 'All moves recorded';
      how.textContent = 'Tell me in chat, and I will tune the thresholds from these clips.';
      live.textContent = '';
      for (const b of [start, done, redo, skip]) b.hidden = true;
      return;
    }
    title.textContent = `Step ${i + 1} of ${STEPS.length}: ${s.label}${s.free ? '' : ` x${REPS}`}`;
    how.textContent = !input.calibrated
      ? 'Calibrate first: stand in frame and hold your guard for 2 seconds.'
      : recording
        ? s.free
          ? `Recording, ${Math.floor((performance.now() - startedAt) / 1000)} s. Press Done after ${s.free} s.`
          : `Recording. Do it ${REPS} times, back to guard after each one, then press Done.`
        : 'Get in your guard, press Start, then do the move.';
    start.hidden = recording;
    done.hidden = redo.hidden = !recording;
    start.disabled = !input.calibrated;
    const want = s.punch ? `${s.punch} ${s.target}` : s.combo ? s.combo(input.stance).join(', ') : s.free ? 'anything' : s.defense;
    const got = s.defense ? `${defenseEdges} detected` : detected.join(', ') || 'nothing yet';
    live.textContent = recording ? `Expecting ${want}. Detected: ${got}` : '';
  }

  function begin(): void {
    void clip?.stop();
    clip = VideoClip.start(input.video);
    startedAt = performance.now();
    recording = true;
    frames = [];
    detected = [];
    defenseEdges = 0;
    note.textContent = '';
    render();
  }

  function advance(): void {
    void clip?.stop();
    clip = null;
    recording = false;
    i++;
    render();
  }

  async function finish(): Promise<void> {
    const s = step();
    recording = false;
    const v = clip;
    clip = null;
    const video = await v?.stop();
    const base = `${input.stance}-${s.id}`;
    const dir = s.fast ? 'fast/' : '';
    // `video` is relative to the JSON's folder. Root videos are posted as <name>.webm and land in tests/fixtures/video/.
    const videoPath = s.fast ? `${base}.webm` : `video/${base}.webm`;
    const set = (input.video?.srcObject as MediaStream | null)?.getVideoTracks?.()[0]?.getSettings();
    const body = JSON.stringify({
      move: s.id,
      stance: input.stance,
      calibration: input.calibration,
      expected: s.punch ? Array(REPS).fill(s.punch) : s.combo ? Array.from({ length: REPS }, () => s.combo!(input.stance)).flat() : [],
      expectedTarget: s.target,
      defense: s.defense,
      reps: s.free ? 0 : REPS,
      ...(video && v?.startT != null ? { video: videoPath, videoStartT: v.startT } : {}),
      camera: { ...input.health, width: set?.width ?? null, height: set?.height ?? null, frameRate: set?.frameRate ?? null },
      frames,
    });
    const ok = await save(`${dir}${base}.json`, new Blob([body], { type: 'application/json' }));
    if (video) await save(`${dir}${base}.webm`, video);
    note.textContent = ok
      ? `Saved tests/fixtures/${dir}${base}.json${video ? ` and ${videoPath}` : ''}`
      : `Downloaded ${base}.json${video ? ` and ${base}.webm` : ''}. Move them into tests/fixtures/${dir}${video && !s.fast ? ' (the webm into tests/fixtures/video/)' : ''}.`;
    advance();
  }

  render();
  setInterval(render, 250);

  return {
    el: h('div', { class: 'panel tuner' }, title, how, live, h('div', { class: 'row' }, start, done, redo, skip), note),
    push(t: InputTick) {
      if (!recording || !input.frame) return;
      frames.push(input.frame);
      for (const p of t.punches) detected.push(`${p.type} ${p.target}`);
      const s = step();
      const d = t.defense;
      const on = s.defense === 'guard' ? d.guard : s.defense === 'duck' ? d.duck : s.defense === 'slipLeft' ? d.slip === 'left' : d.slip === 'right';
      if (on && !lastDef) defenseEdges++;
      lastDef = on;
    },
  };
}
