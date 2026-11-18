<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
<div align="center">

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

</div>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">Keyboard Warrior</h3>
  <p align="center">
    A browser boxing game you play with your body, through your webcam
    <br />
    <a href="https://keyboard-warrior.johnmannul.workers.dev"><strong>Play it live &raquo;</strong></a>
    <br />
    <a href="https://github.com/teddycitrus/shadow-box"><strong>Explore the docs &raquo;</strong></a>
    <br />
    <br />
    <a href="https://github.com/teddycitrus/shadow-box/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/teddycitrus/shadow-box/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#architecture">Architecture</a>
      <ul>
        <li><a href="#move-classification">Move Classification</a></li>
        <li><a href="#accuracy">Accuracy</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#production-build">Production Build</a></li>
        <li><a href="#play-over-the-internet">Play Over The Internet</a></li>
        <li><a href="#deploy-to-cloudflare">Deploy To Cloudflare</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#setup">Setup</a></li>
        <li><a href="#calibration">Calibration</a></li>
        <li><a href="#moves">Moves</a></li>
        <li><a href="#rules">Rules</a></li>
        <li><a href="#urls">URLs</a></li>
        <li><a href="#flags">Flags</a></li>
        <li><a href="#keyboard-mode">Keyboard Mode</a></li>
      </ul>
    </li>
    <li><a href="#audio">Audio</a></li>
    <li>
      <a href="#development">Development</a>
      <ul>
        <li><a href="#checks">Checks</a></li>
        <li><a href="#tuning">Tuning</a></li>
        <li><a href="#project-layout">Project Layout</a></li>
      </ul>
    </li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

Keyboard Warrior is a browser boxing game you play with your body. A webcam and MediaPipe pose tracking turn your punches, guard, ducks and slips into moves in a Three.js arena, for 1v1 matches over WebSocket with spectators, or practice against a bot.

Key capabilities:

* **Webcam control**: MediaPipe Pose Landmarker runs locally in the browser (model and WASM served by the game, no CDN).
* **Six punches**: jab, cross, left/right hook, left/right uppercut. A punch thrown standing is a head shot; crouch (dip your head like a duck) as you punch for a body shot.
* **Four defenses**: high guard, duck, slip left, slip right.
* **Full fight rules**: stamina, knockdowns with a 10 count, get-ups by holding your guard, KO, TKO and decisions.
* **Online 1v1 rooms**: 4-letter codes, an authoritative server, clock-synced punch timing and rejoin after a disconnect.
* **Spectator view**: an orbiting camera at `/watch/CODE`.
* **Practice mode**: a bot that runs the same match rules in the browser.
* **Keyboard mode**: `?keys=1` for playing and testing without a camera.
* **Sound**: synthesized sound effects and crowd, browser speech for the announcer, with optional mp3 overrides.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

| layer | tools |
|---|---|
| language | ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) |
| tracking | ![MediaPipe](https://img.shields.io/badge/MediaPipe-0097A7?style=flat-square&logo=google&logoColor=white) |
| rendering | ![Three.js](https://img.shields.io/badge/Three.js-000000?style=flat-square&logo=threedotjs&logoColor=white) |
| client build | ![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white) |
| server | ![Node.js](https://img.shields.io/badge/Node.js_24-339933?style=flat-square&logo=nodedotjs&logoColor=white) ![ws](https://img.shields.io/badge/ws-1f2937?style=flat-square) |
| hosting | ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white) |
| tests | ![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white) |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ARCHITECTURE -->
## Architecture

The server owns the match. Clients track the pose, classify moves locally, and send only small messages: a downsampled pose for rendering, punch events with a server-time peak timestamp, and defense changes. The server resolves every punch against the defender's defense history and broadcasts events and state to both players and all spectators. Practice mode and the title screen demo run the same `Match` class from `shared/` in the browser.

```mermaid
flowchart LR
  subgraph PA["Player client"]
    Cam(["Webcam"])
    MP["MediaPipe Pose Landmarker<br/><sub>33 landmarks per frame, local WASM,<br/>main thread or ?worker=1</sub>"]
    CL["Classifier<br/><sub>segments, gate, k-NN or rules, guard/duck/slip</sub>"]
    Link["OnlineLink<br/><sub>clock sync, reconnect, rejoin token</sub>"]
    View["Three.js view<br/><sub>first person, HUD, sound</sub>"]
  end
  subgraph SV["Server :3000"]
    HTTP["HTTP static<br/><sub>serves dist/client</sub>"]
    WS["WebSocket /ws<br/><sub>routes messages by room</sub>"]
    Room["Room<br/><sub>2 slots, spectators, lobby</sub>"]
    Match["Match (shared/)<br/><sub>authoritative rules</sub>"]
  end
  PB(["Second player client<br/><sub>same as Player client</sub>"])
  Spec(["Spectator client<br/><sub>/watch/CODE, no input</sub>"])
  Tun(["cloudflared tunnel<br/><sub>HTTPS for the camera</sub>"])
  Bot["PracticeLink + Bot<br/><sub>Match runs in the browser</sub>"]

  Cam -->|"video frames"| MP
  MP -->|"landmarks"| CL
  CL -->|"pose 20 Hz, punch events,<br/>defense changes"| Link
  Link -->|"ws messages"| WS
  WS --> Room
  Room -->|"punch, defense"| Match
  Match -->|"events, snapshot"| Room
  WS -->|"state on change (max 10 Hz), events,<br/>pose deltas"| Link
  Link -->|"handlers"| View
  PB <-->|"same protocol"| WS
  WS -->|"state on change (max 10 Hz), events,<br/>pose deltas"| Spec
  HTTP -->|"page, model, WASM"| View
  Tun -.->|"optional public URL"| HTTP
  CL -.->|"practice mode"| Bot
  Bot -.->|"state, events, bot pose"| View
```

The same `Room` and `Match` code also runs serverless on Cloudflare (`worker/index.ts`, `wrangler.jsonc`). Workers Static Assets serves `dist/client`, and each room is one SQLite-backed Durable Object named by its code. The client connects to `/ws?create=1` or `/ws?code=CODE` so the Worker can route the socket before the first message; the Node server ignores the query and routes by that first create/join/watch message, as before. Both runtimes share the per-socket logic in `server/session.ts`.

```mermaid
flowchart LR
  C(["Browser<br/><sub>player or spectator</sub>"])
  subgraph CF["Cloudflare"]
    W["Worker<br/><sub>worker/index.ts</sub>"]
    A[("Static Assets<br/><sub>dist/client</sub>")]
    DO["RoomDO per code<br/><sub>Room + Match, 60 Hz tick during a match</sub>"]
    DD[("DataDO 'global'<br/><sub>population prior</sub>")]
  end
  C -->|"page, model, WASM, audio"| A
  C -->|"/ws?create=1 or ?code=CODE"| W
  C -->|"/audio-manifest"| W
  C -.->|"/api/calibration, /api/prior"| W
  W -->|"audio-manifest.json"| A
  W -->|"upgrade, idFromName(CODE)"| DO
  W -->|"/api/*, idFromName('global')"| DD
  DO <-->|"same ws protocol"| C
```

One punch, from camera frame to both screens:

```mermaid
sequenceDiagram
  participant Cam as Camera
  participant PT as PoseTracker
  participant CL as Classifier
  participant OL as OnlineLink
  participant R as Room
  participant M as Match
  participant AV as Attacker view
  participant DV as Defender client
  participant SP as Spectators

  Cam->>PT: video frame
  PT->>CL: PoseFrame (img + world landmarks)
  CL->>CL: segment the hand motion, gate it, classify with k-NN or rules
  CL->>OL: punch {type, hand, target, at = peak time}
  Note over OL: at converted to server time with the<br/>clock offset from ping/pong
  OL->>R: punch message {punch, at}
  R->>M: punch(slot, punch, at, now)
  M->>M: clamp at to at most 400 ms old, charge stamina
  M-->>R: throw event
  R-->>AV: event throw
  R-->>DV: event throw
  R-->>SP: event throw
  Note over M: wait until peak + 80 ms window + 70 ms grace
  M->>M: resolveHit against defender defense history in [-150, +80] ms
  M-->>R: land event {zone, outcome, damage, stagger}
  R-->>AV: land event + state
  R-->>DV: land event + state
  R-->>SP: land event + state
  AV->>AV: spark on opponent, 60 ms hit-stop
  DV->>DV: screen edge flash, camera shake, zone marker
  Note over AV,SP: Everyone sees the same outcome, decided once on the server
```

Hit resolution order (`shared/match.ts` and `shared/hit.ts`), first match wins:

1. **Immune:** the defender is down, getting up or still protected after a get-up (or the attacker is no longer up). The punch whiffs.
2. **Duck:** a head shot while the defender ducked at any moment in the window is dodged.
3. **Slip:** a jab or cross while the defender slipped away from the landing side is dodged.
4. **Guard:** a held guard blocks with 15% chip damage and costs the defender 4 stamina plus 0.8 per point of damage.
5. **Clean hit:** full damage, x0.6 if the attacker was gassed when throwing. A head cross, hook or uppercut dealing 12 or more also staggers.

The defense window is 150 ms before to 80 ms after the punch peak. Any defense held at any moment in that window counts.

Hard limits:

- Poses are sent at most 20 times per second, as changes after one full pose. State is broadcast only when it changes (at most 10 Hz, with a 1 s heartbeat) and immediately after any match event.
- Punch timestamps older than 400 ms on arrival are clamped to 400 ms, and timestamps in the future are clamped to now.
- WebSocket messages are capped at 64 KB (`maxPayload`). Pose messages must carry exactly 13 landmarks (39 numbers).
- A disconnect mid-match pauses it; the player has 60 s to rejoin with the token stored in `localStorage`, then forfeits.
- Rooms with nobody connected are dropped after 10 minutes without activity. On Cloudflare a room lives only in its Durable Object's memory, which stops ticking when the last socket closes and can be evicted soon after.
- On Cloudflare, `/ws?create=1` picks a random code in the Worker and retries up to 8 times if that room is in use.

### Move Classification

`client/src/tracking/classifier.ts` turns each tracked frame into punch events and a defense state. Thresholds live in `client/src/config.ts`; distances are in calibrated shoulder widths (sw).

```mermaid
flowchart LR
  F(["PoseFrame"])
  SM["Smoothing<br/><sub>image 0.6, world z 0.45</sub>"]
  SEG["Per-hand segmenter<br/><sub>excursion from rest, peak at furthest point</sub>"]
  G{"Gate<br/><sub>travel, speed, one hand only</sub>"}
  Q{"Profile with<br/>learned punches?"}
  K["Per-player k-NN<br/><sub>k = 1, from the teach step</sub>"]
  R["Hand-written rules<br/><sub>uppercut, hook, straight</sub>"]
  T["Body dip<br/><sub>body if the head dipped, else head</sub>"]
  P(["Punch event<br/><sub>at = peak time</sub>"])
  X["No punch"]
  N["Head offset<br/><sub>from a drifting neutral</sub>"]
  D(["Defense state<br/><sub>guard, duck, slip</sub>"])

  F --> SM --> SEG --> G
  G -->|"pass"| Q
  G -->|"fail"| X
  Q -->|"yes"| K
  Q -->|"no"| R
  K -->|"punch kind"| T
  K -.->|"none"| X
  R -->|"punch kind"| T
  T -->|"head or body"| P
  R -.->|"no match"| X
  SM --> N --> D
```

Punch pipeline, per hand:

0. **Frames:** `PoseTracker` (`client/src/tracking/pose.ts`) runs one detection per new camera frame (`requestVideoFrameCallback`, or `requestAnimationFrame` with a `currentTime` check), GPU first with a CPU fallback. Each frame is stamped with the camera's capture time (falling back to its presentation time), so velocities follow the real frame spacing. With `?worker=1` detection runs in a Web Worker instead, fed camera frames directly (a transferred `MediaStreamTrackProcessor` stream in Chrome and Edge, else bitmaps), newest frame first, with the main thread as fallback. The tracker counts, per second, camera frames delivered, frames tracked, frames skipped (the model or page was busy) and frames with no pose found (blur, framing); the setup screen warns when the camera runs under about 28 fps or tracking skips 10% of frames.
1. **Track:** each hand is followed on screen in its own frame: origin between the shoulders, x toward the body midline (mirrored for the left hand so both hands share one frame), y up, in sw. While the hand is slower than 1.5 sw/s its rest position follows it.
2. **Segment:** a motion starts once the hand moves away from rest past 0.3 sw, measured from the last frame it was near rest. The peak is the furthest point from rest. Once the hand turns back (one frame and 25 ms past the furthest point and heading home, or nearly stopped), the motion so far is read right away and fires if it is a punch. Otherwise it is followed on and read again when it ends: back to 80% of that distance, stalled for two frames and 40 ms, or after 550 ms. Afterwards the hand is free again once it is back home along the line it went out on (a fast swing through rest counts), or has settled for 350 ms (100 ms after a motion that did not fire), so a retraction never becomes a motion of its own. A hand on its way back is also free when it turns round (nearly stops, or leaves at a right angle or more to how it came in) and moves 0.35 sw away from that point at punch speed; after a fired punch it must have come back past 80% of the punch first. That new motion is measured from the turning point, and its travel for the gate from where the hand rested before, so a double jab thrown from a half retraction still counts. A hand fires at most once per 250 ms (450 ms gassed). Every rule that counts frames also has a time floor, so a 50 to 60 fps camera behaves like the 25 to 30 fps one the thresholds were tuned on: velocities and frame-to-frame comparisons span at least 25 ms, a stall lasts 2 frames and 40 ms, the early read waits 1 frame and 25 ms past the peak, and a segment's path runs at least 80 ms past it. At 25 to 30 fps these reduce to the single-frame rules.
3. **Gate:** the motion must travel at least 0.55 sw and reach 4 sw/s (speeds measured over frame gaps longer than 50 ms are scaled up, by at most 1/0.75, since they average over more of the punch). A mostly vertical motion while the other hand moves the same way by at least 60% as much (raising or dropping the guard) is not a punch. This applies whichever classifier is active.
4. **Decide:** with a saved profile, a k-NN (`client/src/tracking/model.ts`) compares a 17-number on-screen shape of the motion (displacement, where the fist ends relative to the nose, forearm direction and elbow travel, hand growth, path bend, wind-up, duration, the other hand's motion, start position, head drop) against the player's own taught samples of the same hand. Features are standardized with a floor so near-constant ones cannot dominate. World depth and the 3D elbow angle are left out: MediaPipe gets them wrong too often on fast punches. Labels are `straight`, `hook`, `uppercut` or `none`; hand and stance give the exact punch, and the head dip against the player's body dip gives the target (see [Moves](#moves)). When the population prior is available its samples join the player's own at 1.3 times their distance. Without a profile the hand-written rules decide, with the default body dip of 0.4 sw.
5. **Fire:** the punch is sent with the peak time, on the frame after the peak in most cases.

Defense, every frame:

- **Neutral:** the head offset is measured from a neutral nose position that starts at the calibrated one and follows slow drift (3 s time constant) while the head is within half a duck or slip threshold, so stepping around does not read as a slip.
- **Duck and slip** fire when the offset passes 0.55 sw down or 0.5 sw sideways. The teach step personalizes each to half of the deepest duck or slip you showed, if it reached at least 60% of the default, and never below half the default. Slips are ignored during a hand motion and for 300 ms after, since punching moves the head. Ducks are not, and never block a punch: a crouched body shot fires as a punch and can read as a duck at the same time.
- **Guard** needs both hands out of a motion, slow and up by the face. The height and head-distance limits are the defaults or, if looser, your calibrated guard position plus 0.3 sw, with 0.2 sw of hysteresis once held.

### Accuracy

Accuracy is measured against hand-checked rep times (`scripts/eval-gt.ts`) on the 12 recorded clips in `tests/fixtures/` (one orthodox player, 39 reps) and on a real teach session (22 reps), replaying the live classifier frame by frame (`scripts/eval-calibration.ts`). Trained on 4 of 5 reps per move, 90% of fixture punches come out exactly right (type and head/body) with 1 extra fire, and the 4 defense clips fire nothing; trained on the first 3 reps, 93% (2 reps, 78%). On the teach session, where most moves only got two real reps and the camera sat high, 77% of types are right. Every recorded rep was thrown standing (including the ones aimed low before the crouch rule), so each is scored as a head shot. Head or body alone (`scripts/eval-target.ts`, `tests/target.test.ts`): all 35 fixture reps and all 21 teach-session reps read as head, with the default body dip and with the 0.55 sw the duck clip would set (the deepest head dip on any of them is 0.28 sw, a low jab). The recorded duck clip fires at most one punch. There is no recorded crouch-punch data yet; body shots are tested with synthetic poses that crouch through the punch. Punches fire a median 67 ms (p90 124 ms) after the hand-checked peak on the fixtures and 48 ms (p90 113 ms) on the teach session, recorded at about 25 fps. The segmenter finds 37 of 39 fixture reps at full frame rate, at half and at a third (`scripts/eval-speed.ts`); trained at full rate, 32 of 37 and 30 of 37 of those are read right. Ducks are detected 5 of 5 with no ducks in the punch clips; slips 4 of 5 left and 3 of 5 right.

Fast punches are measured by replaying the fixture clips sped up (`scripts/eval-fast.ts`, `scripts/fast-sim.ts`): time runs 2 or 3 times faster around each rep while frames still come at the recorded rate, optionally with extra landmark lag and a wrist that trails and loses visibility when it moves fast, or with the whole clip sped up so punches follow each other closely. Each rep is read by a model trained on every other rep. Reps fired (read right), out of 39:

| Replay | Before | Now, normal teach | Now, with the fast pass |
| --- | --- | --- | --- |
| Recorded pace | 35 (34) | 37 (35) | 36 (34) |
| Punches 3x faster | 31 (23) | 34 (26) | 37 (34) |
| 3x, lag and wrist blur | 19 (11) | 19 (12) | 28 (24) |
| Whole clip 2x (doubles) | 16 (14) | 35 (29) | 35 (29) |
| Whole clip 3x, blur | 2 (2) | 19 (11) | 27 (23) |

No replay fires anything in the sped-up defense clips with the fast pass, and none fires away from the reps. The main fix was the return logic: a hand that never paused at guard for 350 ms after a motion stayed locked, so quick punches after the first were lost; the fast pass fixes most of the rest, where the model read a two-frame punch as no punch.

On a faster camera (`scripts/eval-rate.ts`: the clips interpolated to about 52 and 62 fps, with the recorded landmark jitter added back), the same reps fire and read right within one of the native rate, and punches fire a median 39 and 32 ms after the peak against 42 ms native (19 and 16 ms before the time floors, when one jittery frame could end a motion). Frames are lost more in real play than in calibration: in the recorded play sessions 5.5% of frame gaps are over 60 ms against 1.3% in the teach session, so a 5-frame punch has about a 1 in 4 chance of missing a frame. The tracker's skipped and lost counts tell those two causes apart. The fast-punch replays above are simulated from teach-pace clips, and a smoothing change that scored better there scored clearly worse on the real teach session, so real fast clips (`scripts/eval-real-fast.ts`) are the check that counts.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

### Prerequisites

* Node.js 24
* [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) on your PATH, only for `npm run tunnel`

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/teddycitrus/shadow-box.git
   cd shadow-box
   ```

2. Install dependencies
   ```sh
   npm install
   ```

3. Start the dev servers
   ```sh
   npm run dev
   ```

   `npm run dev` copies the MediaPipe WASM into `client/public/mediapipe/wasm`, starts the game server on :3000 (with `tsx watch`) and opens Vite on http://localhost:5173, which proxies `/ws` to the server. Camera access works on `localhost` without HTTPS.

### Production Build

Everything served by the Node server on :3000:

```sh
npm run build && npm start
```

### Play Over The Internet

To play with someone on another machine, run the production build and then:

```sh
npm run tunnel
```

This starts a cloudflared quick tunnel to http://localhost:3000 and prints a public HTTPS URL. Browsers only allow the camera over HTTPS (or on localhost), so share that URL rather than a LAN address.

### Deploy To Cloudflare

The game can run on Cloudflare's free Workers plan with no server of your own. Log in once, then deploy:

```sh
npx wrangler login
npm run deploy
```

`npm run deploy` builds the client, writes `dist/client/audio-manifest.json` and runs `wrangler deploy`, which prints a `https://keyboard-warrior.<your-subdomain>.workers.dev` URL. `npm run cf:dev` runs the same Worker and Durable Objects locally on http://localhost:8787 without a login.

Free plan limits, reset daily at 00:00 UTC: 100,000 Worker requests and 100,000 Durable Object requests (each socket connect is one; incoming WebSocket messages count 20 to 1), and 13,000 GB-s of Durable Object duration, which is about 29 hours of open rooms. Static asset requests are free. Over a limit, new requests fail until the reset. The Node server with `npm run tunnel` remains an option.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

### Setup

1. Put the laptop at chest height and stand 1.5 to 2 m away.
2. Use good light in front of you, not behind you. Turn off low light compensation in your camera settings: in a dim room many webcams drop to 25 or 15 fps and blur fast punches. The webcam preview shows a notice when the camera or tracking runs slow.
3. Keep your head, shoulders, elbows and hands in frame. The lobby tells you to move closer, step back or raise the camera.

### Calibration

1. Pick Orthodox or Southpaw first. Teaching uses your stance to know which hand throws the jab.
2. Hold your guard (both gloves up by your face) steady for 2 seconds. The game measures your shoulder width, arm length, hand size and guard position and scales every threshold to your body.
3. Teach your punches, about three minutes. An overlay on the webcam walks through:
   - **Rest**, 6 s each: guard up and moving without punching, then dropping your hands and bringing them back. These motions are learned as non-punches.
   - **Duck, slip left, slip right**, 3.5 s each. The duck comes first so your crouch depth is known before the punches.
   - **8 punches** in turn: jab, cross, left hook, right hook, left uppercut, right uppercut, aimed at the face standing tall (head shots), then crouch and jab, crouch and cross (dip your head like a duck, then punch: body shots). Throw each one 5 times, back to guard after each (a step moves on after 5 reps or 15 s). Wind-ups and fidgets around each rep are learned as non-punches, and a rep far from the rest of its move is dropped. The crouch reps set how far your head has to dip for a body shot (see [Moves](#moves)).
   - **Fast**: right after each standing punch, the same punch 3 times as fast and sharp as you can. A fast punch crosses the screen in two or three camera frames and looks different from a slow one, so the model learns both.
   - **Combo**: jab, cross, hook, fast, one punch right after the other, 3 times. Each punch of a combo is taught as its own rep, so punches thrown back to back are recognized too.
   - **Check**: random punches from the list are prompted and read back live with your new model. A wrong or missed read is taught on the spot with the right label (a punch read as no punch also drops the two non-punch examples nearest to it that outvoted it, such as an uppercut wind-up that looks like a body jab), and the move comes back until it is read right twice (at most 4 tries). The right punch at the wrong target is called out ("Read as body. Stand tall for a head shot" or "Read as head. Crouch lower for a body shot") and counted per move. The overlay ends with how often each move was read right; the lobby lists any move that stayed unreliable.

   Punches do not reach the match during this step.
4. Press Ready.

The result is a personal profile, saved in the browser (`localStorage` key `shadowbox:profile:v7`; profiles from before the fast steps are not reused) and reused the next time you calibrate, so teaching only runs once. The lobby shows whether you are using your own model or the default rules. **Teach my punches** runs the teaching step again, and **Skip, use defaults** (shown while teaching) deletes the saved profile and switches to the hand-written rules. Use Recalibrate if tracking feels off; it redoes the guard hold and keeps your profile.

### Moves

| Move | How |
| --- | --- |
| Jab | Punch straight at the camera with your lead hand (left for orthodox, right for southpaw). |
| Cross | Punch straight at the camera with your rear hand. |
| Left / right hook | Elbow bent, hand around shoulder height, swing across. |
| Left / right uppercut | Start below your chin and drive the fist up. |
| Head or body | Head by default. Crouch as you punch (dip your head like a duck) for a body shot; this works for every punch, hooks and uppercuts too. A punch is a body shot when your head dipped at least your body dip below its neutral position, in shoulder widths (sw), between the start of the motion and just past its peak. The default is 0.4 sw; teaching sets it 45% of the way from how far your head moves on standing punches to how deep you crouched on the crouch reps (or your duck, with fewer than two crouch reps), kept between 0.3 and 0.8 sw. The head drop reads the same from any camera height, unlike the fist height. A crouched punch may also count as a duck while you are down. |
| High guard | Both gloves up by your face. |
| Duck | Drop your head well down. |
| Slip left / right | Move your head to the side. |

A punch fires once, as soon as the hand turns back from its furthest point (one frame after the peak, not at the end of the retraction). That hand is then free again once it comes back toward where it started, settles somewhere new, or turns round on the way back and drives out again (a double jab or a combo, without going all the way home). Punches from one hand are at least 250 ms apart (450 ms when gassed).

### Rules

All numbers come from `shared/rules.ts`.

- **Format:** 3 rounds of 60 s, 8 s breaks, 3 s countdown. Each fighter has 100 HP. The round clock stops while someone is down.
- **Damage:** jab 4, cross 7, hook 9, uppercut 11. Head shots deal x1.5.
- **Guard** blocks any punch but still takes 15% of its damage off HP, and each block costs the defender 4 stamina plus 0.8 per point of the punch's damage. Stamina recovers more slowly while you hold guard (see Stamina).
- **Duck** dodges head shots.
- **Slip** dodges straights (jab and cross) when you slip away from the side the punch lands on. An attacker's right hand lands on your left, so slip right to dodge it, and vice versa.
- **Stagger:** a clean head shot other than a jab that deals 12 or more staggers the defender.
- **Stamina:** 100 max. Punches cost jab 6, cross 10, hook 12, uppercut 14. Recovery starts 600 ms after your last punch at 15 per second, or 10 per second while you hold guard. (A camera player's hands rest at guard between punches; guard used to drain stamina instead, which left camera players exhausted for good.) Below 30 you are gassed: your punches deal x0.6 and your cooldown is longer. At 0 you are exhausted and cannot punch until you recover to 20.
- **Knockdown:** at 0 HP you go down and the referee counts one per second. Hold a steady guard to get up: 2 s after the first knockdown, 3.5 s after later ones. You come back with 30 HP (20 HP after the second knockdown) and 50 stamina, and are protected for 1.5 s after the 1.2 s get-up.
- **KO:** still down at the 10 count.
- **TKO:** the third knockdown ends the fight.
- **Decision:** after 3 rounds, more HP wins, then fewer knockdowns, otherwise a draw.
- **Forfeit:** a player who disconnects mid-match has 60 s to rejoin before losing.

### URLs

| Path | Page |
| --- | --- |
| `/` | Title screen with a bot vs bot demo behind the menu |
| `/practice` | Practice against the bot |
| `/create` | Create a room, then share the opponent and watch links |
| `/join/CODE` | Invite link for the opponent; joins room `CODE` as a player (opens the spectator view if full) |
| `/play/CODE` | Your own seat in room `CODE`; reloading it rejoins the same corner |
| `/watch/CODE` | Watch room `CODE` |

### Flags

| Flag | Effect |
| --- | --- |
| `?keys=1` | Keyboard mode, no camera. Keys below. |
| `?debug=1` | Shows classifier features, defense state and match numbers, plus the tracker's delegate, pose model, tracked and delivered frame rate, detection time, frames skipped and lost per second, and the camera notice state; debug sessions log these once a second. In a fight it also shows the last punch decision (and whether it was blocked because you could not punch), the last punch sent, whether the match took it, and how it landed. |
| `?model=lite` / `?model=full` | Pins the pose model. By default tracking starts on full and tries lite once, for 2 s, full has tracked under 28 fps or missed more than 15% of the camera's frames because detection is the bottleneck (camera frames skipped or detection slower than the camera). Lite is kept only if it then tracks at least 1.2 times as many frames per second; otherwise full comes back for good. |
| `?worker=1` | Runs pose detection in a Web Worker, off the main thread that renders the game. Falls back to the main thread if the worker cannot start. Off by default until it is measured against the frames skipped during play (see `?debug=1`). |
| `?replay=<url>` | Tracks a video file instead of the camera, for re-running recorded clips through the whole pipeline. Plays at `?replayRate=` (default 0.5) and stamps frames with video time, so results do not depend on machine speed. Pins the pose model. |
| `?exposure=<ms>` | Sets a manual camera exposure (for example `8`) to cut motion blur, if the camera supports it; the image gets darker. Auto exposure is restored when tracking stops or the page closes. |
| `?record=1` | Shows a guided recorder that saves labelled clips of every move into `tests/fixtures/`, then fast punches, doubles, combos and free boxing into `tests/fixtures/fast/`, each with its raw webcam video. See [FIXTURES.md](FIXTURES.md). |

### Keyboard Mode

| Key | Action |
| --- | --- |
| J | Jab |
| K | Cross |
| U / I | Left / right hook |
| N / M | Left / right uppercut |
| Shift + punch | Body shot, crouched (a plain punch is a head shot) |
| Space (hold) | High guard |
| S (hold) | Duck |
| A / D (hold) | Slip left / right |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- AUDIO -->
## Audio

Every sound is synthesized at runtime with the Web Audio API, and the announcer uses the browser's speech synthesis, so no audio files are required.

To override any sound, drop an mp3 with the matching name into `client/public/audio/`. The game loads it on first interaction and falls back to the synthesizer for anything missing.

Sounds are layered per event in `client/src/ui/announce.ts`:

| Event | Sounds |
|---|---|
| Punch thrown | `swoosh` (quiet, louder for hooks and uppercuts) |
| Hit landed | `hit_light`, `hit_heavy` (9+ damage) or `impact_big` (stagger or 12+), always with a `body_thump`; heavy hits add `cheer` or `ooh`, big hits add `ooh` and duck the crowd |
| Blocked | `block`, sometimes `crowd_murmur` |
| Missed or dodged | `whoosh`; a dodged hook or uppercut sometimes gets an `ooh` |
| Round start | `hype` crowd swell, then `bell`, then the "Fight" call |
| 10 seconds left | `clapper` (from `clockTick()` in `announce.ts`) |
| Round end | `bell_end`, `cheer` |
| Knockdown | `ko_slam`, `roar`, crowd ducked then swelled |
| Referee count | `count_tick` plus a crowd `stomp` that grows with the count; `chant` at 2 and 6 |
| Get up | `cheer` |
| Match end | `bell`; KO or TKO adds `ko_stinger` and `roar`, otherwise `cheer`; a winner gets `fanfare` |

Percussive sounds play with a random +-6% playback rate and slight level jitter so repeats differ. Crowd reactions have cooldowns so they do not stack. The crowd loop (`crowd.mp3`) sits low, swells with `sound.excite(k)` on big moments and ducks under knockdowns, big hits and announcer lines. All effects go through a light bus compressor.

- Effects: `hit_light`, `hit_heavy`, `impact_big`, `body_thump`, `block`, `whoosh`, `swoosh`, `bell`, `bell_end`, `hype`, `clapper`, `roar`, `cheer`, `ooh`, `crowd_murmur`, `chant`, `stomp`, `count_tick`, `ko_slam`, `ko_stinger`, `fanfare` (each as `<name>.mp3`, list in `SFX_NAMES` in `client/src/audio/synth.ts`)
- Crowd loop: `crowd.mp3`
- Announcer: `announcer_<key>.mp3`, where `<key>` is one of `welcome`, `round1`, `round2`, `round3`, `fight`, `time`, `down_red`, `down_blue`, `up`, `big_shot`, `uppercut`, `ko`, `tko`, `decision`, `draw`, `forfeit`, `red_wins`, `blue_wins` (lines in `ANNOUNCER_LINES` in `client/src/audio/sound.ts`).

Optionally, `npm run gen:audio` generates all of these with the ElevenLabs API. Put `ELEVENLABS_API_KEY=...` in `.env` at the repo root (see `.env.example`); `ELEVENLABS_VOICE_ID` picks the announcer voice. Existing files are skipped unless you pass `--force`, and `--only=bell,announcer_ko` limits the run. With `ffmpeg` on PATH, effects are trimmed of leading silence and peak-normalized to -1 dBFS after download (`--polish` reruns that on existing files); `FILE_GAIN` in `sound.ts` sets the mix. This is never needed to play.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DEVELOPMENT -->
## Development

### Checks

```sh
npm test          # Vitest: classifier, teach step, recorded fixtures, hit resolution, match rules, rooms
npm run typecheck # tsc for the client, server and shared code, then for worker/ with Workers types
```

### Tuning

These scripts replay the recorded clips in `tests/fixtures/` through the classifier. Recording clips is covered in [FIXTURES.md](FIXTURES.md).

```sh
npx tsx scripts/eval-calibration.ts        # end to end: replayed calibrations scored against hand-checked reps
npx tsx scripts/eval-model.ts --verbose    # k-NN leave-one-out per motion, fixtures and teach session
npx tsx scripts/eval-target.ts             # head or body per rep, the live rule against the alternatives
npx tsx scripts/eval-speed.ts              # reps caught and read with frames dropped
npx tsx scripts/eval-fast.ts               # fast punches and doubles: clips sped up, with lag and wrist blur
npx tsx scripts/eval-rate.ts               # the clips upsampled to 50 to 60 fps with recorded jitter, against native rate
npx tsx scripts/eval-real-fast.ts          # real fast and combo clips in tests/fixtures/fast/ against their hand-checked reps
npx tsx scripts/label-reps.ts tests/fixtures/fast/orthodox-combo-12.json  # candidate rep peaks to check against the clip's video
npx tsx scripts/dump-fast.ts jab-head 2 whole  # every motion decision in one sped-up clip
npx tsx scripts/eval-session.ts            # train on a teach session, replay a play session
npx tsx scripts/eval-defense.ts            # guard, duck and slip onsets per clip
npx tsx scripts/dump-segments.ts jab-head  # every motion segment's features in matching clips
npx tsx scripts/analyze-fixtures.ts jab    # every rule decision and defense change, --trace for per-frame features
```

### Project Layout

```
client/
  index.html
  public/
    audio/            optional mp3 overrides
    fonts/            WOFF2 web fonts and their OFL license
    models/           pose_landmarker_full.task, pose_landmarker_lite.task (downloaded by scripts/copy-assets.mjs if missing)
    mediapipe/wasm/   copied from node_modules by scripts/copy-assets.mjs
  src/
    main.ts           routing: title, practice, create, play, watch
    config.ts         classifier, gate, model, defense, calibration and framing settings
    audio/            sound manager and synthesizer
    net/              MatchLink interface and the WebSocket OnlineLink
    practice/         Bot, PracticeLink and the title screen DemoLink
    scene/            Three.js stage, arena, avatars, first-person gloves
    tracking/         PoseTracker and its Web Worker, calibration, classifier, k-NN model, teach step, data sharing, keyboard input, synthetic poses
    ui/               HUD, announcer events, webcam preview, fixture recorder, DOM helpers
    views/            player (first person) and spectator views
server/
  index.ts            HTTP static server, WebSocket /ws, room registry
  room.ts             one room: players, spectators, authoritative Match
  session.ts          per-socket message handling shared with the Worker
  data-store.ts       /api population prior store, shared with the Worker
worker/
  index.ts            Cloudflare Worker, the RoomDO and DataDO Durable Objects
wrangler.jsonc        Cloudflare config: assets, Durable Object bindings, migrations
shared/
  types.ts            wire protocol and shared types
  calibration-data.ts upload validation and population prior computation
  rules.ts            every game number
  match.ts            match simulation used by server and practice mode
  hit.ts              hit resolution against defense history
scripts/
  copy-assets.mjs     copies MediaPipe WASM into client/public
  audio-manifest.mjs  writes dist/client/audio-manifest.json at build time
  gen-audio.ts        optional ElevenLabs audio generation
  eval-*.ts           classifier evaluation on recorded fixtures (eval-core.ts is shared with the tests)
  fast-sim.ts         replays a recorded clip with faster punches, tracker lag and wrist blur
  label-reps.ts       finds candidate rep peaks in a recorded clip, for hand-checking
  dump-segments.ts    prints motion segment features
  dump-fast.ts        prints every motion decision in a sped-up clip
  analyze-fixtures.ts prints classifier decisions per clip
tests/                Vitest suites, plus recorded fixtures in tests/fixtures/
vite.config.ts        Vite config, with a dev-only endpoint that saves recorder clips
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are welcome. If you have a suggestion, fork the repo and open a pull request, or open an issue with the tag "enhancement". New recorded clips in `tests/fixtures/` (see [FIXTURES.md](FIXTURES.md)) are especially useful.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

teddycitrus

Project Link: [https://github.com/teddycitrus/shadow-box](https://github.com/teddycitrus/shadow-box)

Live: [https://keyboard-warrior.johnmannul.workers.dev](https://keyboard-warrior.johnmannul.workers.dev)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & BADGES -->
[contributors-shield]: https://img.shields.io/github/contributors/teddycitrus/shadow-box.svg?style=for-the-badge&cacheSeconds=60
[contributors-url]: https://github.com/teddycitrus/shadow-box/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/teddycitrus/shadow-box.svg?style=for-the-badge&cacheSeconds=60
[forks-url]: https://github.com/teddycitrus/shadow-box/network/members
[stars-shield]: https://img.shields.io/github/stars/teddycitrus/shadow-box.svg?style=for-the-badge&cacheSeconds=60
[stars-url]: https://github.com/teddycitrus/shadow-box/stargazers
[issues-shield]: https://img.shields.io/github/issues/teddycitrus/shadow-box.svg?style=for-the-badge&cacheSeconds=60
[issues-url]: https://github.com/teddycitrus/shadow-box/issues
[license-shield]: https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge
[license-url]: https://github.com/teddycitrus/shadow-box/blob/master/LICENSE
