import type { PunchType, Target } from '../../../shared/types.ts';
import type { InputSource, InputTick } from '../tracking/input.ts';
import { button, h } from './dom.ts';

export type DefenseLabel = 'guard' | 'duck' | 'slipLeft' | 'slipRight';

interface Step {
  id: string;
  label: string;
  punch?: PunchType;
  target?: Target;
  defense?: DefenseLabel;
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
];

/**
 * ?record=1: walks through every move, records each one REPS times and saves a labelled
 * fixture into tests/fixtures/ (via the dev server) for the classifier tests.
 */
export function tuner(input: InputSource): { el: HTMLElement; push(t: InputTick): void } {
  let i = 0;
  let recording = false;
  let frames: unknown[] = [];
  let detected: string[] = [];
  let defenseEdges = 0;
  let lastDef = false;

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
    title.textContent = `Step ${i + 1} of ${STEPS.length}: ${s.label} x${REPS}`;
    how.textContent = !input.calibrated
      ? 'Calibrate first: stand in frame and hold your guard for 2 seconds.'
      : recording
        ? `Recording. Do it ${REPS} times, back to guard after each one, then press Done.`
        : 'Get in your guard, press Start, then do the move.';
    start.hidden = recording;
    done.hidden = redo.hidden = !recording;
    start.disabled = !input.calibrated;
    const want = s.punch ? `${s.punch} ${s.target}` : s.defense;
    const got = s.punch ? detected.join(', ') || 'nothing yet' : `${defenseEdges} detected`;
    live.textContent = recording ? `Expecting ${want}. Detected: ${got}` : '';
  }

  function begin(): void {
    recording = true;
    frames = [];
    detected = [];
    defenseEdges = 0;
    note.textContent = '';
    render();
  }

  function advance(): void {
    recording = false;
    i++;
    render();
  }

  async function finish(): Promise<void> {
    const s = step();
    recording = false;
    const name = `${input.stance}-${s.id}.json`;
    const body = JSON.stringify({
      move: s.id,
      stance: input.stance,
      calibration: input.calibration,
      expected: s.punch ? Array(REPS).fill(s.punch) : [],
      expectedTarget: s.target,
      defense: s.defense,
      reps: REPS,
      frames,
    });
    try {
      const r = await fetch(`/__fixtures/${name}`, { method: 'POST', body });
      if (!r.ok) throw new Error(String(r.status));
      note.textContent = `Saved tests/fixtures/${name}`;
    } catch {
      const a = h('a', { href: URL.createObjectURL(new Blob([body], { type: 'application/json' })), download: name });
      a.click();
      note.textContent = `Downloaded ${name}. Move it into tests/fixtures/.`;
    }
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
