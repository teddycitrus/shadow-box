# Recording classifier fixtures

The classifier tests in `tests/classifier.test.ts` use synthetic poses by default. Recorded clips of real people in `tests/fixtures/` are replayed through the same `Classifier` to check that real punches are detected with the right type, once each.

## Recording a clip

1. Run `npm run dev`.
2. Open http://localhost:5173/practice?record=1&debug=1 (or the `npm run tunnel` URL with the same query, when recording on another device). `record=1` adds the recorder panel; `debug=1` shows the classifier features and the last punch decision live.
3. Calibrate: hold your guard steady for 2 seconds until the lobby says Calibrated.
4. Press **Record**.
5. Throw one move about 5 times, returning to guard between each one.
6. Press **Stop**, then **Save JSON**. The browser downloads `pose-<timestamp>.json`.
7. Move the file into `tests/fixtures/` (create the folder if needed) and give it a descriptive name, for example `orthodox-jab-head-x5.json`.
8. Edit its `"expected"` array to list the punch types you threw, in order. Values: `jab`, `cross`, `leftHook`, `rightHook`, `leftUppercut`, `rightUppercut`. For five jabs:

   ```json
   "expected": ["jab", "jab", "jab", "jab", "jab"]
   ```

9. Run `npm test`.

The recorder captures every tracked frame while Record is on, and pressing Record again clears the previous take. Calibrate before you save: the file stores the current calibration, which is `null` before calibration finishes, and the test cannot replay a clip without it.

## File format

The recorder in `client/src/views/player.ts` writes:

```json
{
  "calibration": {
    "swImg": 0.27,
    "swWorld": 0.38,
    "armWorld": 0.55,
    "noseX": 0.9,
    "noseY": 0.32,
    "handSize": { "left": 0.25, "right": 0.25 }
  },
  "frames": [
    {
      "t": 12345.6,
      "img":   [{ "x": 0.91, "y": 0.31, "z": -0.6, "v": 0.99 }],
      "world": [{ "x": 0.01, "y": -0.55, "z": -0.3, "v": 0.99 }]
    }
  ],
  "expected": []
}
```

- `calibration` is the `Calibration` measured during the 2 s guard hold (`client/src/tracking/calibration.ts`): shoulder width in image units and in metres, arm length in metres, the neutral nose position, and wrist-to-index hand size per hand.
- `frames` is every `PoseFrame` (`client/src/tracking/frame.ts`) seen while recording:
  - `t` is the `performance.now()` timestamp in milliseconds.
  - `img` holds all 33 MediaPipe Pose landmarks in normalized image space, with `x` multiplied by the frame aspect ratio so `x` and `y` share a unit (the frame height).
  - `world` holds the same 33 landmarks in MediaPipe world space, in metres.
  - Each landmark is `{x, y, z, v}`, where `v` is visibility.
- `expected` is saved empty; you fill it in. It lists the `PunchType` values the classifier should emit for the whole clip, in order.

The "recorded fixtures" test reads every `.json` file in `tests/fixtures/`, builds a `new Classifier(calibration)`, feeds it every frame in order, and compares the emitted punch types with `expected`. The test always uses the classifier's default orthodox stance, so record fixtures in orthodox stance (left jab, right cross).

A file without an `"expected"` key is skipped. An empty `"expected": []` is not skipped: it asserts that no punch fires, which is useful for clips of guard, ducks, slips or idle movement.

## When a fixture fails

Replay the same moves with `?debug=1` and read the `last:` line, which explains why the classifier accepted or rejected the last punch. Thresholds for punch detection, punch types, head/body split, defense and framing live in `client/src/config.ts`. After changing them, run `npm test` to make sure both the synthetic cases and every fixture still pass.
