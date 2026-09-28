# DRIFTWING

<p align="center">
  <a href="https://kylebuildsai.github.io/driftwing/?seed=D27TEH"><img src="docs/screenshot.jpg" width="49%" alt="A low-poly glider flying between snowy peaks at golden hour, sun and god rays overhead"></a>
  <a href="https://kylebuildsai.github.io/driftwing/?seed=ARCH1&amp;time=0.02"><img src="docs/screenshot-night.jpg" width="49%" alt="The glider at night over snowy spires under green aurora curtains and stars"></a>
</p>

*v1: golden hour over seed D27TEH, and aurora at night over seed ARCH1. Click either shot to fly
that world in your browser.*

> [!NOTE]
> DRIFTWING v1 is a single-shot prompt test of Claude Opus 5.5: it was built from one prompt, with
> no human code edits. v2 is being built in four phases with the same model, one spec prompt per
> phase. This is **v2 Phase 1** (`2.0.0-phase.1`). See [About this project](#about-this-project)
> for how it was made.

DRIFTWING is a calm flying game. You fly over an endless world that is made up as you go:
snowy peaks, pine valleys, deserts, island chains and flower meadows, with a sky that lingers at
golden hour. There is no way to lose, no fuel and no enemies. An AI copilot called WREN rides
along. Talk or type to it, and it can set waypoints, fly for you, change the time of day or set up
a ring course.

## What is new in v2 Phase 1

<p align="center">
  <img src="docs/screenshot-cockpit.jpg" width="49%" alt="Inside the bush plane's cabin at golden hour: a panel of steam gauges below the windshield, mountains ahead">
  <img src="docs/screenshot-jet.jpg" width="49%" alt="The jet from behind, flying between snowy mountains toward a low golden sun, with speed streaks">
  <img src="docs/screenshot-helicopter.jpg" width="49%" alt="The helicopter hovering over a small lake in a meadow valley with orchards and mountains behind it">
  <img src="docs/screenshot-controls.jpg" width="49%" alt="The controls panel showing the T.16000M stick tab with live axis bars, button lights and the binding list">
</p>

*The bush plane's cockpit, the jet at golden hour, the helicopter in a hover, and the controls panel
with a Thrustmaster stick connected.*

- **Two ways to fly.** **CLASSIC** is the v1 game, exactly as it was: forgiving, and it never
  stalls into a spin. **SIM** is a real flight model, with lift, drag, stalls, wind, ground contact
  and landings. An assists slider (0-100 %) decides how much help you get. Switch at any time with
  the pill in the top left or the **V** key, even mid-flight.
- **Six aircraft**, keys **1-6**:
  1. the glider (the v1 plane, a real sailplane in SIM);
  2. a bush plane;
  3. a supersonic jet;
  4. a helicopter;
  5. a wingsuit with a parachute;
  6. an FPV racing drone.
  Every one flies in both modes.
- **Joysticks and HOTAS.** Xbox-style gamepads work out of the box, and so does the Thrustmaster
  T.16000M FCS Flight Pack (stick, throttle and rudder pedals). There is a controls panel to rebind
  anything, and a calibration wizard.
- **Cockpits and instruments.** A cockpit view with a working instrument panel for each craft, plus
  wing, flyby and FPV cameras.
- **Procedural sound.** Engines, rotors, wind, a stall horn, a variometer and touchdowns, all
  generated live, with no audio files.
- **Wind you can use.** Thermals, ridge lift and gusts in SIM, so the glider can climb for real.

## Play it

### On your Windows PC (recommended)

1. **Install Node.js** (the free "LTS" version) from <https://nodejs.org/en/download>. You only do
   this once.
2. **Double-click `start-driftwing.bat`** in this folder. The first time, it downloads what the game
   needs, which takes a minute and needs an internet connection.
3. The game opens in your browser at **<http://127.0.0.1:5199>**. A black window stays open while
   you play; close it to stop the game.

Always play at that exact address. Your settings, key bindings and joystick calibration are saved
in the browser for `http://127.0.0.1:5199` only. The same game at another address (for example
`localhost` or a different port) would start with none of them. That is why the game always uses
port 5199 and refuses to start on another one.

On macOS or Linux, run `npm install` once and then `npm run dev` in this folder, and open
<http://127.0.0.1:5199>.

### Online

The version on GitHub Pages is v1, which is what CLASSIC mode plays:
<https://kylebuildsai.github.io/driftwing/>. Share a world by copying the URL; it always carries
the seed, for example <https://kylebuildsai.github.io/driftwing/?seed=K7Q2ZD>.

## Controls at a glance

The full list, including every gamepad and HOTAS button, is in [docs/controls.md](docs/controls.md).
Everything can be rebound in the controls panel (`.`).

| action | CLASSIC | SIM |
| --- | --- | --- |
| Pitch and bank | mouse (click the view to capture it), arrow keys, A / D | the same; the mouse is a virtual stick that stays where you leave it |
| Rudder | Q / E | Q / E |
| Throttle | W / S, mouse wheel | W / S move the throttle lever, mouse wheel |
| Boost / barrel roll | Space / double-tap A or D | (off in SIM) |
| Craft ability | | Space (water ballast, smoke, afterburner, hover hold, parachute, drone flight mode) |
| Gear / flaps / airbrake | | G / F and Shift+F / hold B |
| Switch CLASSIC / SIM | V | V |
| Pick a craft | 1-6, or [ and ] | 1-6, or [ and ] |
| Change view | Numpad 8 cockpit, Numpad 2 chase | C cycles views; Numpad 8 / 2 as well |
| Waypoint ahead | G | N |
| Relaunch, engine, parachute | Backspace, Z, U | Backspace, Z, U |
| Talk to WREN | M (mic), hold ` (push to talk), Enter or / to type | the same |
| WREN's voice on / off | Shift+V | Shift+V |
| Photo mode, journal, help | P, J, H | P, J, H |
| Settings, controls panel | `,` and `.` | `,` and `.` |

- **Mouse:** right-drag looks around, and a middle click recenters the view.
- **Touch:** the on-screen joystick and throttle slider work in both modes.
- **Gamepad** (Xbox-style): left stick flies, triggers are the throttle, bumpers the rudder, A is
  boost or the craft ability, and the right stick looks around.
- **HOTAS** (T.16000M + TWCS + TFRP):
  - the stick flies, and its twist is the rudder until the pedals move;
  - the throttle lever is the throttle (the collective on the helicopter);
  - the pedals and toe brakes steer and brake;
  - the rocker trims, the antenna slider sets flaps or zoom, and the mini-stick looks around;
  - the trigger is push-to-talk, and the stick hat snaps the view.

## Settings

Open Settings with `,` or the gear icon. There are five tabs:

- **Flight**:
  - the assists slider for the current craft;
  - start on the ground (for take-off practice);
  - units (km/h and metres, or knots and feet);
  - the instrument HUD overlay and landing callouts;
  - the FPV drone's camera tilt (0-40 degrees), stick expo and maximum rotation rate.
- **Graphics**: quality preset, frame target (Auto uses your screen's refresh rate), dynamic
  resolution, FPS display, and the field of view for each camera.
- **Sound**: master volume and a mixer for engine, environment, interface, WREN and music.
- **Controls**:
  - mouse sensitivity and invert pitch;
  - HOTAS options: twist yaw, the afterburner detent, and what to do when a HOTAS connects;
  - buttons that open the controls panel and the calibration wizard.
- **General**:
  - day length and freezing time;
  - WREN's voice, chatter and remote brain;
  - the world seed;
  - developer tools (status badge, wind arrows).

Everything is saved in the browser for `http://127.0.0.1:5199` and survives restarts.

## WREN, the copilot

WREN's default brain is a local keyword grammar and needs no network. Speak with the mic button
(Web Speech API; Chrome and Edge), hold the backquote key or the HOTAS trigger to talk, or type into
the command bar. Things to try:

- "Where am I?", "Find mountains", "Take us there", "Set a waypoint", "Autopilot on", "Head west"
- "Make it night", "Golden hour", "Ring course", "Photo mode", "Journal"
- "Switch to the helicopter", "Sim mode", "Assists down", "Cockpit view", "Deploy chute",
  "Engine off", "Relaunch", "Calibrate controls", "Airspeed", "How was my landing?"

**Remote brain.** `RemoteCopilot` can send each request to your own HTTP endpoint (for example one
backed by a language model) and falls back to the local grammar after 800 ms. A reference server
is included:

```bash
npm run copilot-server
```

In Settings, General, turn on **Remote brain** and keep the endpoint
`http://localhost:3000/copilot`. If port 3000 is reserved on your machine (common on Windows with
Hyper-V or WSL), run the server on another port, for example `PORT=3300 npm run copilot-server`, and
change the endpoint to match.

The server answers from its own rules. If `ANTHROPIC_API_KEY` is set in its environment, it asks
Claude first (model from `COPILOT_MODEL`, default `claude-haiku-4-5`). The key never reaches the
browser, and the server only answers the game's own origins. The full contract is in
[docs/copilot-api.md](docs/copilot-api.md).

## The single-file build

```bash
npm run build:single
npm run serve:single
```

The first command writes one self-contained file, `dist-single/index.html`, with everything
inlined, including the terrain worker. The second serves it at <http://127.0.0.1:5199>, the same
address as the game, so it uses the same saved settings. Stop the dev server first, since both use
port 5199. Serve the file from a local web server rather than opening it directly: the game is
tested that way. It can also be copied to any static web host, but bindings saved there belong to
that site.

## URL parameters

| parameter | example | effect |
| --- | --- | --- |
| `seed` | `?seed=K7Q2ZD` | Fly a specific world. The URL always carries the current seed, so you can share it |
| `time` | `?time=0.02` | Start at a time of day from 0 to 1 (0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset) |
| `renderer` | `?renderer=webgl` | Force the WebGL2 fallback |
| `debug` | `?debug=1` | Show the dev badge and log the backend and every controller's id to the console |
| `touch` | `?touch=1` | Force the on-screen touch controls |

## Troubleshooting

| problem | what to do |
| --- | --- |
| **"Node.js is not installed"** or the window closes at once | Install the LTS version from <https://nodejs.org/en/download>, then double-click `start-driftwing.bat` again. The script opens that page for you when Node is missing or older than version 20 |
| **Port 5199 is already in use** | DRIFTWING is probably already running: open <http://127.0.0.1:5199>, or close the other black DRIFTWING window first. If another program uses port 5199, close it. The game does not move to another port on purpose, because your saved settings belong to this one |
| **No sound** | Browsers only allow sound after you click or press a key. If a "Sound off - click to enable" pill appears (bottom right), click it. Then check the volumes in Settings, Sound |
| **WebGPU or WebGL2?** | The game uses WebGPU when your browser and graphics driver support it (current Chrome and Edge), and switches to WebGL2 by itself otherwise. Both look and play the same. The status badge (Settings, General, or `?debug=1`) shows which one is running. Add `?renderer=webgl` to force WebGL2 if WebGPU misbehaves on your machine. If the game shows "could not start", update the browser |
| **The HOTAS or gamepad is not detected** | Browsers hide controllers until you **press a button** on each one while the game tab is focused. The controls panel (`.`) says "Press any button on your stick and throttle" until both appear. Use Chrome or Edge, and plug the pedals into the throttle before plugging the throttle into USB. `?debug=1` logs each controller's id in the console (F12) |
| **The joystick drifts or feels wrong** | Run the calibration wizard (controls panel, **Calibrate**) with the stick centred and your feet off the pedals, and move every axis to its limits. The steps are in [docs/controls.md](docs/controls.md#calibration-wizard) |
| **Settings or bindings disappeared** | Check that the address bar says exactly `http://127.0.0.1:5199`. Private windows do not keep saved data |
| **The mic does not work** | Voice needs Chrome or Edge and microphone permission. Typing to WREN always works |

## For developers

### Scripts

| command | what |
| --- | --- |
| `npm run dev` | Vite dev server at <http://127.0.0.1:5199> (strict port) |
| `npm run build` | production build into `dist/` |
| `npm run build:single` | one self-contained `dist-single/index.html` |
| `npm run preview` | serves `dist/` at <http://127.0.0.1:5199> |
| `npm run serve:single` | serves `dist-single/` at <http://127.0.0.1:5199> (`tools/serve.mjs`, no dependencies) |
| `npm run copilot-server` | the reference remote brain for WREN |
| `npm test` | builds the single file and runs the headless smoke test on it |

three.js is pinned to exactly `0.184.0` and imported only as `three/webgpu`, `three/tsl` and
`three/addons/...`, so there is one copy. Vite `7.3.6` and `vite-plugin-singlefile` build it.

### Folder layout

```
index.html               page shell, glass UI markup
src/main.js              composition root: boot, systems, frame loop
src/core/                config, storage (IndexedDB), settings, events, fixed-step clock, frame loop, perf
src/render/              renderer boot, post stack, sky, clouds, water, birds, effects
src/world/               world generator (shared height function), terrain worker and chunks, landmarks
src/flight/              flight controller, arcade and SIM models, assists, autopilot, trim, ground contact
src/craft/               craft registry and the six craft modules
src/input/               InputManager, keyboard / mouse / touch, gamepad and HOTAS, bindings, calibration
src/camera/              camera manager, chase rig, cockpit, wing, flyby and FPV views
src/audio/               AudioEngine, mixer, engine synths, cues, callouts
src/env/                 WindField
src/ui/                  glass UI, pill, picker, settings, controls panel, instruments
src/copilot/             WREN: local grammar, remote brain, aircraft actions
src/gameplay/            journal, ring courses, waypoints
src/dev/                 dev badge, wind overlay, debug wind source, mock gamepads, test harnesses
tools/                   smoke test, harness runner, parity proof, flight labs, copilot server, static server
legacy/v1.html           the original single-file v1 game
docs/                    architecture, controls, copilot API, screenshots
start-driftwing.bat      one-click start for Windows
```

### Tests, labs and harnesses

- **Smoke test.**
  `node tools/smoke-test.mjs --file dist-single/index.html [--query "renderer=webgl"] [--steps-file steps.json] [--out dir]`
  loads the game in headless Chrome or Edge (set `CHROME_PATH` if the browser is elsewhere). It
  fails on any console error or warning, runs scripted steps (`wait`, `press`, `down`, `up`,
  `click`, `move`, `eval`, `shot`), and saves screenshots. `window.DRIFTWING` exposes `ready`,
  `ctx`, `state` and `getStats()` for scripted checks.
- **CLASSIC parity.** `node tools/arcade-parity.mjs --suite all` checks that CLASSIC flies
  bit-for-bit like v1.
- **Flight labs.** `node tools/flight-lab.mjs` covers the glider and bush plane, and
  `node tools/lab/jet.mjs` (also `helicopter.mjs`, `wingsuit.mjs`, `fpv.mjs`) the others. They fly
  the SIM models headless and check them against their targets.
- **Test harnesses** (dev server only).
  - `?test=1` flies all six craft in both modes across three seeds and reports fps, frame times,
    NaN events, terrain penetrations, soft crashes and heap growth.
  - `?test=hotas` checks the HOTAS pipeline with mock devices.
  - `node tools/run-harness.mjs --test 1|hotas` runs either one headlessly.

### Documentation

- [docs/architecture.md](docs/architecture.md): the module map, the frame loop, every system
  contract, and where Phases 2-4 plug in.
- [docs/controls.md](docs/controls.md): every default binding, calibration, and a HOTAS hardware
  checklist.
- [docs/copilot-api.md](docs/copilot-api.md): the remote copilot request, response and action
  schema.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

## Known limitations

- The first click or key press unlocks audio. Creating the browser's AudioContext can take around
  0.1 s on some machines, so a single frame may stutter at that moment.
- The WebGL2 fallback takes a few seconds longer to start than WebGPU, because WebGL compiles its
  shaders synchronously.
- The Thrustmaster product ids and button numbers are the published ones and have been tested with
  mock devices. The first session with the real hardware should follow the checklist in
  [docs/controls.md](docs/controls.md#hotas-hardware-checklist). Every binding can be changed in
  the controls panel if a button reports differently.
- Voice input uses the Web Speech API, which works in Chrome and Edge and needs microphone
  permission.

## About this project

DRIFTWING started as a single-shot prompt test of **Claude Opus 5.5**, run to gauge the model's
quality and ability on a large, open-ended build. v1 and its tooling came from one prompt,
reproduced below. Working in Claude Code, Opus 5.5:

- planned the architecture and wrote a module contract;
- researched the pinned three.js r184 WebGPU and TSL APIs against the library source;
- split the work across parallel sub-agents, then reviewed, fixed and polished the result;
- verified it in headless Chrome on both WebGPU and WebGL2.

No person wrote or edited any of v1's code. The session did pause twice at usage limits and resumed
with a plain "continue". Every later message only asked to publish the finished game: this
repository, GitHub Pages, the release, the topics, the v1 screenshots and this note. v1 is tagged
`v1.0.0` and kept as [legacy/v1.html](legacy/v1.html).

**v2** is being built in four phases with the same model, each from one spec prompt:

1. **Phase 1 (this version)**: the sim core, HOTAS, the first six craft, cockpits and procedural
   audio.
2. **Phase 2**: an event director with procedural environment spawns.
3. **Phase 3**: more craft.
4. **Phase 4**: Spotify, WebXR VR, a flight recorder with replay, and a multiplayer wingman.

For Phase 1, Opus 5.5 turned the single file into a Vite project with a proof that CLASSIC still
matches v1 bit for bit. It then built the new systems with parallel sub-agents in separate git
worktrees, one merge per milestone, and reviewed and verified each wave. The Phase 1 screenshots
above were captured from the single-file build with the headless smoke-test tool.

<details>
<summary>The original v1 prompt</summary>

```text
Build a complete, self-contained browser game in a SINGLE index.html file. No build step, no external assets, libraries only via CDN importmap. Use three.js (latest) with WebGPURenderer and automatic WebGL fallback.
THE GAME: "DRIFTWING", an ambient infinite-flight exploration game. You pilot a low-poly glider over an endless procedural world. No fail state, no fuel, no enemies. The fantasy: a golden-hour flight that never has to end, with an AI copilot riding shotgun.
FLIGHT MODEL (arcade with soul):
- Mouse steers pitch and roll (WASD/arrows also work), scroll or W/S for throttle, space for a gentle boost on cooldown
- Banking turns: rolling into a turn induces natural yaw; speed bleeds in climbs and builds in dives
- Soft stall: below minimum speed the nose eases down, never a tumble
- Chase cam with smooth lag that banks with the plane, FOV stretches with speed, subtle shake at max velocity
- Touch support: virtual joystick plus throttle slider
- Double-tap A or D triggers a smooth canned barrel roll
INFINITE TERRAIN (the engineering core):
- Chunked heightmap terrain from seeded simplex noise, multiple octaves, fully deterministic from a seed shown in the UI so worlds are shareable
- Biomes blended by temperature/moisture noise: snow peaks, pine valleys, dunes, archipelago ocean, flower meadows; vertex-colored, flat-shaded low-poly
- Chunk generation in a Web Worker with transferable buffers, ring LOD (high detail near, low far), pooled and recycled chunk meshes, zero frame hitches while streaming
- Stitched LOD edges or skirts so there are never visible cracks
- Procedural landmarks every few km: stone arches, monolith circles, a lighthouse on a lone island, drifting hot air balloons; discoveries log to a journal
LIVING ATMOSPHERE:
- Day/night cycle (6 min loop, settable): sun, moon, star field, dawn/dusk gradients, aurora over snow biomes at night
- Sky: gradient dome with a sun disc and cheap radial god rays near the horizon; fog color always matches the sky
- Clouds: instanced soft puffs in a slow-drifting layer casting faint shadow blobs
- Water: animated vertex waves, sun glint streak, foam band at shorelines
- Boid bird flocks that scatter when you dive through them
- Wingtip contrails when banking hard, wind streak lines at speed
THE COPILOT (critical architecture):
- class Copilot { async respond(flightState, transcript) -> { speech, action } }
- Default brain = local keyword grammar via the Web Speech API: "where am I", "find mountains / ocean / desert", "set waypoint", "autopilot on/off", "make it night / dawn", "barrel roll", "ring course"
- Executable actions: place a glowing waypoint beacon, autopilot to a heading, change time of day, spawn a ring course, describe current biome and altitude
- RemoteCopilot: POSTs { flightState, transcript } to a configurable endpoint (default http://localhost:3000/copilot), expects { speech, action } back, falls back to the local grammar after an 800ms timeout
- Copilot answers via speechSynthesis plus a subtitle line in the glass UI; mic toggle with a pulsing listening indicator; every command also reachable by keyboard/UI so voice is never required
GENTLE OBJECTIVES (optional, never nagging):
- Ring courses on request: fly-through rings with chime feedback, time and best streak
- Discovery journal: biomes visited, landmarks found, distance flown, max altitude
- Photo mode: P pauses, frees the camera, hides UI, adds letterbox and a screenshot button
VISUAL QUALITY BAR (this is the entire point):
- Cohesive 6-color palette per biome, flat shading, soft sun shadows
- Post stack: subtle bloom, vignette, warm color grade, light film grain
- Golden-hour default start: long shadows, warm fog, the screenshot moment inside the first 5 seconds
- Minimal glass UI: altitude, speed, compass strip, waypoint arrow, world seed, mic toggle; auto-hides after 3 seconds of stillness
PERFORMANCE:
- 60fps target on desktop: frustum culling, instancing for trees/rocks/clouds, worker-side terrain, auto-degrade view distance before frame drops
- Guard against: LOD cracks, falling through unloaded chunks (clamp altitude to terrain height plus epsilon), NaN attitude, worker backlog, tab-blur dt spikes
POLISH RULES:
- Every listed system must actually function, zero placeholders
- Opens already airborne at golden hour with a 1-second fade, no menu wall, no console errors
```

</details>

One deliberate departure from the v1 prompt: it asks for the latest three.js, but the project pins
r184. That is the version the author's build standards had verified, and pinning keeps the WebGPU
and TSL APIs from shifting underneath the game. v2 keeps the same pin, now as an npm dependency.

No binary assets: everything, including the aircraft, trees, landmarks and sounds, is generated in
code.
