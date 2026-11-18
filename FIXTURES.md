# Recording classifier fixtures

The classifier tests in `tests/classifier.test.ts` use synthetic poses, plus recorded clips of a real player in `tests/fixtures/`. The recorded clips are replayed through the same `Classifier` to check that the per-player k-NN learns real punches from a short calibration and that guard, ducks and slips are detected. The same clips drive the evaluation scripts in `scripts/`.

## Recording

The guided recorder (`client/src/ui/tuner.ts`) walks through every move and saves one clip per move.

1. Run `npm run dev`.
2. Open http://localhost:5173/practice?debug=1&record=1. `record=1` adds the recorder panel; `debug=1` shows the classifier features and the last punch decision live.
3. Pick your stance, then calibrate: hold your guard steady for 2 seconds. Finish the teach step or press **Skip, use defaults**; the recorder only starts once calibration is complete.
4. Follow the 22 steps. For each one, get in your guard, press **Start recording**, do the move 5 times with a return to guard after each, then press **Done, save**. The panel shows what the classifier detected while you record. **Redo** restarts the current step and **Skip** moves on without saving.

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
| 13 | Jab to the head, as fast as you can | `fast-jab-head` |
| 14 | Cross to the head, as fast as you can | `fast-cross-head` |
| 15 | Left hook to the head, as fast as you can | `fast-lhook-head` |
| 16 | Right hook to the head, as fast as you can | `fast-rhook-head` |
| 17 | Left uppercut, as fast as you can | `fast-luppercut` |
| 18 | Right uppercut, as fast as you can | `fast-ruppercut` |
| 19 | Double jab | `double-jab` |
| 20 | Jab, cross (1-2) | `combo-12` |
| 21 | Jab, cross, lead hook (1-2-3) | `combo-123` |
| 22 | Box freely for 15 seconds, as fast and as wildly as in a real fight | `free` |

Steps 1 to 12 save as `tests/fixtures/<stance>-<id>.json`, for example `orthodox-jab-head.json`, replacing any clip with the same name. Steps 13 to 22 save into `tests/fixtures/fast/` instead, because the tests and evals load every JSON in `tests/fixtures/` and expect hand-checked times for it. A combo rep is the whole combo, with a return to guard after it. The free step has no rep count; press **Done** after 15 seconds.

Every step also records the raw camera video (MediaRecorder, webm, VP9 or VP8 at 2.5 Mbps, no audio), so camera, pose model and smoothing changes can be re-run offline. Root clips put it in `tests/fixtures/video/<stance>-<id>.webm`, fast clips next to their JSON as `tests/fixtures/fast/<stance>-<id>.webm`. Videos are git-ignored; the JSON stays tracked. When the browser has no MediaRecorder or webm codec, only the JSON is saved.

Saving goes through a dev-only endpoint (`POST /__fixtures/<name>`, the `fixture-writer` plugin in `vite.config.ts`), so it only works on the Vite dev server. It accepts `<name>.json`, `sessions/<name>.json`, `fast/<name>.json`, `<name>.webm` (written to `video/`) and `fast/<name>.webm`. Anywhere else, for example the production build behind `npm run tunnel`, the browser downloads the JSON and the webm instead and you move them into place yourself.

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
  "video": "video/orthodox-jab-head.webm",
  "videoStartT": 12301.2,
  "camera": {
    "cameraFps": 30, "deliveredFps": 30, "trackedFps": 29, "skippedPerSec": 1, "lostPerSec": 0,
    "detectMs": 18, "backend": "main", "width": 640, "height": 480, "frameRate": 30
  },
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
- `expected` lists the `PunchType` thrown, once per rep, for punch steps, and is `[]` for defense steps and the free step. For combos it is every punch in order over all 5 reps (`combo-123` orthodox: `jab, cross, leftHook` five times; the lead hook of a southpaw is `rightHook`).
- `expectedTarget` is `head` or `body` for punch steps; it is left out of defense clips and the free step.
- `defense` is `guard`, `duck`, `slipLeft` or `slipRight` for defense steps; it is left out of punch clips.
- `reps` is the number of reps prompted (5, or 0 for the free step).
- `video` is the webm's path relative to the JSON's folder. It and `videoStartT` are left out when no video was recorded.
- `videoStartT` is `performance.now()` at the MediaRecorder `start` event, the same clock as frame `t`, so a frame is at `(t - videoStartT) / 1000` seconds into the video. The alignment is approximate, to about a frame.
- `camera` is the tracker health when the step was saved (`TrackerHealth` in `client/src/tracking/pose.ts`), plus the camera track's `width`, `height` and `frameRate` settings. Health fields are missing when the tracker had not started.
- `frames` is every raw `PoseFrame` (`client/src/tracking/frame.ts`) seen while recording:
  - `t` is the `performance.now()` timestamp in milliseconds.
  - `img` holds all 33 MediaPipe Pose landmarks in normalized image space, with `x` multiplied by the frame aspect ratio so `x` and `y` share a unit (the frame height).
  - `world` holds the same 33 landmarks in MediaPipe world space, in metres.
  - Each landmark is `{x, y, z, v}`, where `v` is visibility.

## Ground truth

Labels do not come from the classifier. `scripts/eval-gt.ts` lists the peak time of every real rep in each punch clip (and in the recorded teach session in `tests/fixtures/sessions/`), found from the wrist's distance to its guard position and checked frame by frame. When you record new clips, add their rep times there; a clip without an entry is scored as having no reps.

The fast clips have their own labels, `FAST_REPS` in `scripts/eval-gt.ts`, keyed by file name without `.json` (for example `orthodox-combo-12`), each rep a punch type and a peak time in seconds from the first frame. To label a clip:

1. Run `npx tsx scripts/label-reps.ts tests/fixtures/fast/<file>.json [minTravel]`. It lists candidate peaks per hand, found without the classifier: local maxima of each wrist's on-screen distance from its rest position (relative to the shoulder midpoint, in shoulder widths, with the rest position the rolling 3 s median of the wrist), at least `minTravel` sw out (default 0.5), at least 0.3 sw above the dips on both sides, and at least 150 ms apart. Each one shows its clip time and its video time.
2. Scrub the webm to each video time and keep only the real punches. Wind-ups and pull-backs, mostly around uppercuts, show up as extra candidates.
3. Paste the printed entry into `FAST_REPS` and delete the candidates that are not punches. For single-move clips it lists every candidate of the punching hand. For combos it assigns the expected punches in order to candidates of the right hand; entries it could not assign are marked `// extra?`, and for the free step every type is a guess marked `// check type`.

On the 8 root punch clips the candidates of the punching hand land within 45 ms of 35 of the 38 hand-checked reps, and two more at 86 ms (a left hook) and 111 ms (a left uppercut); one small body jab (1.66 s) is not found.

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
npx tsx scripts/eval-real-fast.ts --verbose
npx tsx scripts/dump-segments.ts jab-head
```

- `eval-calibration.ts` is the end-to-end score: it replays the live classifier frame by frame with a model trained the way the guided calibration trains it, and scores every fired punch against the hand-checked reps. It reports chronological 2-rep and 3-rep calibrations (with oracle labels and with the teacher's own rep picking), leave one rep out (4 of 5 reps per move), false fires in the defense clips, and leave one rep out on the recorded teach session, each with the median and p90 delay from the hand-checked peak to the frame the punch fired. `--verbose` lists every confusion, and whether a missed rep was never seen as a motion or rejected as a non-punch. `--no-prune` turns off the outlier rejection of taught reps.
- `eval-model.ts` classifies every gated motion leave-one-out (fast, for tuning features and model settings).
- `eval-speed.ts` drops frames (every 2nd, every 3rd) and reports how many reps are still found and read right, both trained at that rate and trained at full rate (taught at a normal pace, thrown fast).
- `eval-session.ts` trains on a saved teach session and replays the play part of a saved play session, listing what fired.
- `eval-defense.ts` prints guard, duck, left slip and right slip onsets per clip, and the share of frames in guard.
- `eval-real-fast.ts` replays every clip in `tests/fixtures/fast/` with an entry in `FAST_REPS` through the live classifier, with a model trained on every labelled motion of the root clips (oracle labels, outliers pruned). Per clip and overall it reports reps fired, read right (type and head), missed, extra fires, the median and p90 delay from the hand-checked peak to the fire, the median frame rate and the share of frame gaps over 60 ms. `--verbose` lists every rep and extra fire. With no labelled fast clips it says so and exits. Unlike `eval-speed.ts` and `eval-fast.ts`, which simulate speed by dropping frames or time-warping the root clips, this scores real fast punches.
- `dump-segments.ts <filter> [minTravel]` prints the features of every motion segment in clips whose name contains `<filter>`, for segments travelling at least `minTravel` shoulder widths (default 0.45).
- `analyze-fixtures.ts [filter] [--trace]` prints every decision and defense change per clip; `--trace` adds per-frame hand features.

Thresholds for smoothing, segmentation, the gate, the rules, the model and defense live in `client/src/config.ts`. After changing them, run `npm test` to make sure the synthetic cases and every fixture still pass.
