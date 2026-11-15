# Recording classifier fixtures

The classifier tests in `tests/classifier.test.ts` use synthetic poses, plus recorded clips of a real player in `tests/fixtures/`. The recorded clips are replayed through the same `Classifier` to check that the per-player k-NN learns real punches from a short calibration and that guard, ducks and slips are detected. The same clips drive the evaluation scripts in `scripts/`.

## Recording

The guided recorder (`client/src/ui/tuner.ts`) walks through every move and saves one clip per move.

1. Run `npm run dev`.
2. Open http://localhost:5173/practice?debug=1&record=1. `record=1` adds the recorder panel; `debug=1` shows the classifier features and the last punch decision live.
3. Pick your stance, then calibrate: hold your guard steady for 2 seconds. Finish the teach step or press **Skip, use defaults**; the recorder only starts once calibration is complete.
4. Follow the 12 steps. For each one, get in your guard, press **Start recording**, do the move 5 times with a return to guard after each, then press **Done, save**. The panel shows what the classifier detected while you record. **Redo** restarts the current step and **Skip** moves on without saving.

| Step | Move | File id |
| --- | --- | --- |
| 1 | Jab to the head | `jab-head` |
| 2 | Cross to the head | `cross-head` |
| 3 | Left hook to the head | `lhook-head` |
| 4 | Right hook to the head | `rhook-head` |
| 5 | Left uppercut | `luppercut` |
| 6 | Right uppercut | `ruppercut` |
| 7 | Jab to the body | `jab-body` |
| 8 | Cross to the body | `cross-body` |
| 9 | High guard: drop your hands, then raise both gloves to your face and hold 1 s | `guard` |
| 10 | Duck, then come back up | `duck` |
| 11 | Slip left, then back | `slip-left` |
| 12 | Slip right, then back | `slip-right` |

Each clip saves itself as `tests/fixtures/<stance>-<id>.json`, for example `orthodox-jab-head.json`, replacing any clip with the same name. Saving goes through a dev-only endpoint (`POST /__fixtures/<name>`, the `fixture-writer` plugin in `vite.config.ts`), so it only works on the Vite dev server. Anywhere else, for example the production build behind `npm run tunnel`, the browser downloads the file instead and you move it into `tests/fixtures/` yourself.

Then run `npm test`.

## File format

```json
{
  "move": "jab-head",
  "stance": "orthodox",
  "calibration": {
    "swImg": 0.27,
    "swWorld": 0.38,
    "armWorld": 0.55,
    "noseX": 0.9,
    "noseY": 0.32,
    "handSize": { "left": 0.25, "right": 0.25 },
    "guardY": -0.6,
    "guardHead": 0.7
  },
  "expected": ["jab", "jab", "jab", "jab", "jab"],
  "expectedTarget": "head",
  "reps": 5,
  "frames": [
    {
      "t": 12345.6,
      "img":   [{ "x": 0.91, "y": 0.31, "z": -0.6, "v": 0.99 }],
      "world": [{ "x": 0.01, "y": -0.55, "z": -0.3, "v": 0.99 }]
    }
  ]
}
```

- `move` is the step id from the table above.
- `stance` is the stance selected in the lobby, `orthodox` or `southpaw`.
- `calibration` is the `Calibration` measured during the 2 s guard hold (`client/src/tracking/calibration.ts`): shoulder width in image units and in metres, arm length in metres, the neutral nose position, wrist-to-index hand size per hand, and the guard wrist height and wrist-to-nose distance in shoulder widths.
- `expected` lists the `PunchType` thrown, once per rep, for punch steps, and is `[]` for defense steps.
- `expectedTarget` is `head` or `body` for punch steps; it is left out of defense clips.
- `defense` is `guard`, `duck`, `slipLeft` or `slipRight` for defense steps; it is left out of punch clips.
- `reps` is the number of reps prompted (5).
- `frames` is every raw `PoseFrame` (`client/src/tracking/frame.ts`) seen while recording:
  - `t` is the `performance.now()` timestamp in milliseconds.
  - `img` holds all 33 MediaPipe Pose landmarks in normalized image space, with `x` multiplied by the frame aspect ratio so `x` and `y` share a unit (the frame height).
  - `world` holds the same 33 landmarks in MediaPipe world space, in metres.
  - Each landmark is `{x, y, z, v}`, where `v` is visibility.

## Ground truth

Labels do not come from the classifier. `scripts/eval-gt.ts` lists the peak time of every real rep in each punch clip (and in the recorded teach session in `tests/fixtures/sessions/`), found from the wrist's distance to its guard position and checked frame by frame. When you record new clips, add their rep times there; a clip without an entry is scored as having no reps.

## What the tests assert

The "recorded fixtures" block in `tests/classifier.test.ts` loads every `.json` file in `tests/fixtures/` that has a calibration and at least one frame (`loadFixtures` in `scripts/eval-core.ts`). It skips itself when there are none.

Labelling: each clip is replayed with the classifier's `onSegment` hook to collect every motion that passes the gate. Each hand-checked rep labels the motion of the punching hand whose peak is closest to it (within 350 ms) with its punch kind (`straight`, `hook` or `uppercut`) and target; every other gated motion is a non-punch.

- **Motions:** at least 85% of the hand-checked reps are found as gated motions.
- **Model:** simulates the teach step chronologically. In each clip, the first 3 labelled reps and every motion before the third one ends train the k-NN; the rest is the test set (clips without punches split in half). The test requires at least 85% of test punches exactly right (type and head/body) and at most 10% of test non-punch motions firing. With 2 reps it requires 70% and 10%.
- **Defense:** replays the `guard`, `duck`, `slip-left` and `slip-right` clips (found by file name) and counts onsets. It needs at least 4 guards, 4 ducks, 3 left slips and 3 right slips.
- **Accidental ducks:** across all punch clips, the total number of duck onsets must be at most a quarter of the number of punch clips.

## Evaluating and tuning

```sh
npx tsx scripts/eval-calibration.ts --verbose
npx tsx scripts/eval-model.ts --verbose
npx tsx scripts/eval-speed.ts
npx tsx scripts/eval-session.ts
npx tsx scripts/eval-defense.ts
npx tsx scripts/dump-segments.ts jab-head
```

- `eval-calibration.ts` is the end-to-end score: it replays the live classifier frame by frame with a model trained the way the guided calibration trains it, and scores every fired punch against the hand-checked reps. It reports chronological 2-rep and 3-rep calibrations (with oracle labels and with the teacher's own rep picking), leave one rep out (4 of 5 reps per move), false fires in the defense clips, and leave one rep out on the recorded teach session, each with the median and p90 delay from the hand-checked peak to the frame the punch fired. `--verbose` lists every confusion, and whether a missed rep was never seen as a motion or rejected as a non-punch. `--no-prune` turns off the outlier rejection of taught reps.
- `eval-model.ts` classifies every gated motion leave-one-out (fast, for tuning features and model settings).
- `eval-speed.ts` drops frames (every 2nd, every 3rd) and reports how many reps are still found and read right, both trained at that rate and trained at full rate (taught at a normal pace, thrown fast).
- `eval-session.ts` trains on a saved teach session and replays the play part of a saved play session, listing what fired.
- `eval-defense.ts` prints guard, duck, left slip and right slip onsets per clip, and the share of frames in guard.
- `dump-segments.ts <filter> [minTravel]` prints the features of every motion segment in clips whose name contains `<filter>`, for segments travelling at least `minTravel` shoulder widths (default 0.45).
- `analyze-fixtures.ts [filter] [--trace]` prints every decision and defense change per clip; `--trace` adds per-frame hand features.

Thresholds for smoothing, segmentation, the gate, the rules, the model and defense live in `client/src/config.ts`. After changing them, run `npm test` to make sure the synthetic cases and every fixture still pass.
