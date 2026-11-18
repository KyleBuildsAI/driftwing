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
> phase. This is **v2 Phase 3**: 14 craft, 100 environment spawns and the systems they need, on top
> of Phase 2 (the event director and the first 30 spawns), Phase 1 and the structure correction (tag
> `v2-structure`), which made V1 and V2 two separate games behind one launcher. See
> [About this project](#about-this-project) for how it was made.

DRIFTWING is a calm flying game. You fly over an endless world that is made up as you go:
snowy peaks, pine valleys, deserts, island chains and flower meadows, with a sky that lingers at
golden hour. There is no way to lose, no fuel and no enemies. An AI copilot called WREN rides
along. Talk or type to it, and it can set waypoints, fly for you, change the time of day or set up
a ring course.

## What V2 offers

<p align="center">
  <img src="docs/screenshot-cockpit.jpg" width="49%" alt="Inside the bush plane's cabin at golden hour: a panel of steam gauges below the windshield, mountains ahead">
  <img src="docs/screenshot-jet.jpg" width="49%" alt="The jet from behind, flying between snowy mountains toward a low golden sun, with speed streaks">
  <img src="docs/screenshot-helicopter.jpg" width="49%" alt="The helicopter hovering over a small lake in a meadow valley with orchards and mountains behind it">
  <img src="docs/screenshot-controls.jpg" width="49%" alt="The controls panel showing the T.16000M stick tab with live axis bars, button lights and the binding list">
</p>

*Phase 1 screenshots: the bush plane's cockpit, the jet at golden hour, the helicopter in a hover,
and the controls panel with a Thrustmaster stick connected.*

- **14 craft, one real flight model.** Lift, drag, stalls, wind, ground contact and landings for
  every one. An assists slider (0-100 % per craft) is the only difficulty setting: 100 % by
  default, and the first HOTAS you connect sets 50 % on every craft you have not set yourself.
  - Planes: the glider (the v1 plane, flown as a real sailplane), a bush plane, an aerobatic plane
    with display smoke in six colours (WREN names and scores the twelve figures you fly), an
    amphibious seaplane that lands on the sea and on lakes, and a supersonic jet.
  - Rotor: a helicopter, a tiltrotor that converts from a hover to airplane mode, and an FPV racing
    drone.
  - Human: a wingsuit with a parachute, and a paraglider that launches from a slope and climbs in
    thermals.
  - Lighter than air: a hot air balloon steered only by finding the wind layer that goes your way,
    and an airship with vectored props, ballonets and a scenic cruise.
  - Creature: an eagle that flaps, soars and lands on tree tops, ledges and peaks by itself, or the
    same bird as a dragon whose fire breath lights lanterns and torches.
  - Space: a spaceplane that climbs past 100 km on its rocket, steers with its RCS jets in vacuum
    and flies a belly-first re-entry.
- **The craft picker.** The craft in six groups, ten favorites on the number keys 1-9 and 0, `[`
  and `]` to cycle them, and the eagle's dragon skin.
- **100 things to find.** 51 places (sites, always in the same spot for the same seed) and 49
  events that come and go: supercells and tornadoes, a volcano that wakes, a calving glacier, sea
  arches, a steam train on a viaduct, a world tree, a portal ring to the next world, a ghost galleon
  over the clouds, bison stampedes, butterfly migrations, a blood moon and a midnight sun, and
  legendary combos such as an aurora over a meteor shower or a volcano's lightning under the aurora.
  Big ones stand on the horizon from 30-60 km away, and many change how you fly: a tornado pulls you
  in, a microburst slams you down, ridge bands and thermal streets lift you. The full list is in
  [docs/spawns.md](docs/spawns.md).
- **Challenges.** Timed gate courses for every craft: the canyon gauntlet, the cave tunnel, the
  waterfall wall, the balloon festival, the kite-string slalom, the five-arch chain and a race
  against a wild dragon. Fly through the start gate (or press **Y** near it) for splits against
  your best, medals and a best time per craft.
- **A world you can touch.** Structures are solid (fly into a castle wall and it is a soft crash;
  land on a bridge deck), perches sit on tree tops, ledges and peaks, and lakes, ice and salt flats
  are real water bodies the seaplane and the balloon can land on. The world keeps working at any
  distance and all the way to space, where the ground curves away below you.
- **The journal and the map.** A chime and a card greet each discovery, and the journal (**J**)
  collects them (found / 100) with your records and achievements, the flight time per craft, the
  aerobatic figures you have flown, the challenges' medals, the worlds you have visited and the
  perches you have landed on. The world map (**M**) shows the terrain, the places you have found,
  your trail and the waypoint.
- **WREN, the copilot.** Ask it to "switch to the seaplane", "find water to land", "find a perch",
  "start the challenge", "take me to space" or "scenic cruise", ask for the "wind at 800 metres",
  or use the Guide chips in the command bar. Every phrase also has a key or a button.
- **Joysticks and HOTAS.** Xbox-style gamepads work out of the box, and so does the Thrustmaster
  T.16000M FCS Flight Pack (stick, throttle and rudder pedals), with a full profile for every craft,
  a controls panel to rebind anything, and a calibration wizard.
- **First or third person.** Fly from the cockpit, with a working instrument panel for each craft
  (the FPV camera on the drone, the basket on the balloon, the rider's view on the eagle), or from
  outside in the chase, wing and flyby views. V swaps between them, and the view never changes how
  the craft flies.
- **Procedural sound.** Engines, rotors, burners, wingbeats, a rocket, wind, a stall horn, a
  variometer and every spawn's voice, all generated live, with no audio files.
- **Share a world.** **Copy link** gives a link that opens your world at your time of day, and a
  seed field in Settings flies any world you type in.

## Two games, one launcher

DRIFTWING is two separate games behind one toggle:

- **V1** is the original game, exactly as it was built from one prompt. It is frozen byte-for-byte
  and never changed.
- **V2** is the new game: real flight physics for every craft, first and third person views, HOTAS
  support and everything the later phases add.

The page you open is a small launcher. The game fills the window, and a small **V1 | V2** pill in
the top-left corner switches between them; it hides after a few seconds and comes back when you
move the pointer to that corner. Only one game runs at a time: switching fades out, closes the
running game completely and loads the other. The launcher remembers the game you played last, and
the very first launch opens V2. `http://127.0.0.1:5199/?v=1` and `/?v=2` open a game directly, and a
link with a seed (`/#seed=K7Q2ZD`) is passed on to the game.

The two games keep separate saved data: V2 stores everything under `driftwing-v2` names, V1 keeps
its original ones, and neither touches the other's. The first time V2 starts, it moves the
settings, bindings, calibration and journals saved by Phase 1 over to its own names, once.

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

GitHub Pages serves the launcher at <https://kylebuildsai.github.io/driftwing/>, with v1 and v2
behind it. Every push to `main` runs `.github/workflows/pages.yml`, which checks the frozen v1,
runs `npm run build:single` and deploys `dist-single/`. Share a world by copying the URL; it
always carries the seed.

## Controls at a glance

The full list, including every gamepad and HOTAS button, is in [docs/controls.md](docs/controls.md).
Everything can be rebound in the controls panel (`.`).

| action | keys |
| --- | --- |
| Pitch and bank | mouse (click the view to capture it: a virtual stick that stays where you leave it), arrow keys, A / D |
| Rudder | Q / E |
| Throttle | W / S move the throttle lever, mouse wheel |
| Craft ability | Space (each craft's own: water ballast, smoke, afterburner, hover hold, parachute, the burner, the eagle's screech or the dragon's fire, auto re-entry, ...) |
| Second craft ability | Shift+Space (the smoke colour, the balloon's vent, the eagle's tuck, the spaceplane's attitude hold) |
| Gear / flaps / airbrake | G / F and Shift+F / hold B |
| Pick a craft | favorites 1-9 and 0, [ and ] to cycle them, or the craft picker |
| Start a challenge | Y near a course's start gate |
| Change view | C cycles chase, cockpit, wing and flyby; V swaps the cockpit and your last outside view |
| Waypoint ahead | N |
| Relaunch, engine, parachute | Backspace, Z, U |
| Switch to V1, the original game | F8 |
| Talk to WREN | Shift+M (mic), hold ` (push to talk), Enter or / to type |
| WREN's voice on / off | Shift+V |
| World map | M |
| Photo mode, journal, help | P, J, H |
| Settings, controls panel | `,` and `.` |

- **Mouse:** right-drag looks around, and a middle click recenters the view.
- **Touch:** the on-screen virtual stick and throttle slider fly every craft.
- **Gamepad** (Xbox-style): left stick flies, triggers are the throttle, bumpers the rudder, A is
  the craft ability, and the right stick looks around.
- **HOTAS** (T.16000M + TWCS + TFRP):
  - the stick flies, and its twist is the rudder until the pedals move;
  - the throttle lever is the throttle, or what the craft has instead (the helicopter's
    collective, the balloon's burner, the paraglider's speed bar, the eagle's flap power, the
    spaceplane's rocket);
  - the pedals and toe brakes steer and brake;
  - the rocker trims, the antenna slider sets flaps or zoom (the nacelles on the tiltrotor, the
    ballonets on the airship), and the mini-stick looks around;
  - the trigger is push-to-talk, the stick hat snaps the view, and base button 10 switches to V1.

## Settings

Open Settings with `,` or the gear icon. There are five tabs:

- **Flight**:
  - the assists slider for the current craft (the only difficulty control);
  - start on the ground (for take-off practice);
  - units (km/h and metres, or knots and feet);
  - the HUD: the glass HUD in the cockpit, the flight path marker, the instrument overlay,
    landing callouts and hiding the HUD when idle;
  - the FPV drone's camera tilt (0-40 degrees), stick expo and maximum rotation rate.
- **Graphics**: quality preset, frame target (Auto uses your screen's refresh rate), dynamic
  resolution, FPS display, the planet radius (how soon the world curves away from high altitude),
  and the field of view for each camera.
- **Sound**: master volume and a mixer for engine, environment, interface, WREN and music.
- **Controls**:
  - mouse sensitivity and invert pitch;
  - HOTAS options: twist yaw and the afterburner detent;
  - buttons that open the controls panel and the calibration wizard.
- **General**:
  - day length and freezing time;
  - WREN's voice, chatter, tour-guide callouts and remote brain;
  - the world: Copy link, and a seed field that flies another world;
  - developer tools (status badge, wind arrows).

Everything is saved in the browser for `http://127.0.0.1:5199` (in V2's own `driftwing-v2`
database) and survives restarts.

## WREN, the copilot

WREN's default brain is a local keyword grammar and needs no network. Speak with the mic button
or Shift+M (Web Speech API; Chrome and Edge), hold the backquote key or the HOTAS trigger to talk,
or type into the command bar. Things to try:

- "Where am I?", "Find mountains", "Take us there", "Set a waypoint", "Autopilot on", "Head west"
- "Make it night", "Golden hour", "Ring course", "Photo mode", "Journal"
- "Switch to the helicopter", "Assists down", "Cockpit view", "Deploy chute", "Engine off",
  "Relaunch", "Calibrate controls", "Airspeed", "How was my landing?", "Switch to version one"
- "What's nearby?", "Take me to the waterfall", "Find a thermal", "Chase the storm", "Next
  discovery", "Guide help", and "yes" when WREN offers a heading; "Callouts off" quiets the
  callouts
- "Switch to the dragon", "Smoke on", "Find water to land", "Find a perch", "Wind at 800 metres",
  "Start the challenge", "Take me to space", "Scenic cruise", and each craft's own commands
  ("nacelles to 60", "burn for 5 seconds", "take off", ...)

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

The first command writes `dist-single/`: the launcher shell as one self-contained `index.html`,
V1 copied byte-for-byte to `v1/index.html` (its SHA-256 is checked against `tests/v1.sha256`), and
V2 as one self-contained `v2/index.html` with everything inlined, including the terrain worker
(`tools/build-single.mjs` runs one build per page). The second serves it at
<http://127.0.0.1:5199>, the same address as the game, so it uses the same saved settings. Stop the
dev server first, since both use port 5199. Serve the files from a local web server rather than
opening them directly: the shell loads the games from /v1/ and /v2/. The folder can also be copied
to any static web host, but bindings saved there belong to that site.

## URL parameters

The launcher reads `v` and passes every other parameter, and any `#hash`, on to the game, so
`/?v=2&renderer=webgl` and `/#seed=K7Q2ZD` work from the launcher too.

| parameter | example | effect |
| --- | --- | --- |
| `v` | `?v=1` | launcher only: open V1 (`1`) or V2 (`2`), and remember it |
| `#seed` | `#seed=K7Q2ZD` | the seed in the hash, as the launcher forwards it and share links carry it (`?seed=` wins when both are given) |
| `#t` | `#seed=K7Q2ZD&t=0.723` | with a seed link: the time of day, as a fraction of the day or `HH:MM` (`?time=` wins when both are given) |
| `seed` | `?seed=K7Q2ZD` | Fly a specific world. The URL always carries the current seed, so you can share it |
| `time` | `?time=0.02` | Start at a time of day from 0 to 1 (0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset) |
| `renderer` | `?renderer=webgl` | Force the WebGL2 fallback |
| `debug` | `?debug=1` | Show the dev badge and log the backend and every controller's id to the console |
| `dev` | `?dev=1` | In a production build: the spawn debugger on F9 (dev builds always have it) |
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
| `npm run build` | production build into `dist/`: the shell `index.html`, `v1/index.html` (copied untouched) and `v2/index.html` |
| `npm run build:single` | `dist-single/`: the shell, `v1/` and `v2/`, each one self-contained file |
| `npm run preview` | serves `dist/` at <http://127.0.0.1:5199> |
| `npm run serve:single` | serves `dist-single/` at <http://127.0.0.1:5199> (`tools/serve.mjs`, no dependencies) |
| `npm run copilot-server` | the reference remote brain for WREN |
| `npm test` | checks the V1 freeze, builds `dist-single/` and runs the headless smoke test on the shell |
| `npm run test:v1` | fails if `public/v1/index.html` differs from `tests/v1.sha256` or from `git show v1-final:index.html` |
| `npm run test:shell` | builds `dist-single/`, then runs the launcher shell test against the dev server and the build (`tools/shell-test.mjs`) |
| `npm run test:flight`, `test:flight:webgl` | the flight-test harness (all 14 craft, first and third person, 3 seeds) on WebGPU or WebGL2 |
| `npm run test:craft`, `test:craft:webgl` | the craft test: every craft's general flight test in both views, then its scenarios (a loop and a roll recognised, seaplane takeoffs and landings on the sea and a lake, a full tiltrotor conversion, a paraglider thermal climb, a balloon reaching a wind layer, the airship's scenic cruise, an eagle perch and takeoff, the spaceplane to 100 km and back) |
| `npm run test:collision`, `test:collision:webgl` | the collision test: every collider type, the landmarks and the structures struck at 60, 250 and 1500 m/s (a soft crash, never a pass-through), the tunnel centreline and the kite strings |
| `npm run test:hotas`, `test:hotas:webgl` | the HOTAS pipeline harness |
| `npm run test:terrain`, `test:terrain:webgl` | the terrain stamps in the running game: no cracks at any LOD, worker meshes equal to main-thread builds, collision within 0.5 m |
| `npm run test:terrain:real`, `test:terrain:real:webgl` | the same terrain test on the game's own stamped sites (seed `TERRAIN-REAL-8`) |
| `npm run test:spawns`, `test:spawns:webgl` | the spawns test: each of the 100 presets force-spawned ahead of the craft, photographed, and disposed back to its GPU memory, wind source, collider and heap baselines |
| `npm run test:determinism`, `test:determinism:webgl` | the determinism test: the same seed and path in two page loads, with identical site lists and director logs |
| `npm run test:soak`, `test:soak:webgl` | the soak: 5 seeds, first and third person, the event director live |
| `npm run lab:terrain` | site placement and terrain stamps headless, including the height-sampling cost against Phase 1 |
| `npm run lab:colliders` | the collider service headless: every shape, tunnelling at up to 2000 m/s, perches, zero allocation |
| `npm run lab:craft` | the craft framework headless through the real flight controller |

three.js is pinned to exactly `0.184.0` and imported only as `three/webgpu`, `three/tsl` and
`three/addons/...`, so there is one copy. Vite `7.3.6` and `vite-plugin-singlefile` build it.

### Folder layout

```
index.html               the launcher shell: the game iframe and the V1 | V2 pill
v2/index.html            V2's page: glass UI markup
public/v1/index.html     V1, the original single-file game, frozen byte-for-byte
src/shell/               the launcher shell's script, and V2's bridge to it (versionToggle)
src/main.js              V2's composition root: boot, systems, frame loop
src/core/                config, storage (IndexedDB), settings, events, fixed-step clock, frame loop, perf, the floating origin
src/render/              renderer boot, post stack, sky, clouds, water, curvature, birds, effects
src/world/               world generator, site placement and terrain stamps, terrain and map-tile workers, landmarks, colliders, the water query, region overlays and vegetation, the PathFollower, the far field
src/flight/              flight controller, the flight models of every kind, assists, autopilots, trim, ground and water contact
src/craft/               the craft registry and the 14 craft modules
src/input/               InputManager, keyboard / mouse / touch, gamepad and HOTAS, bindings, calibration
src/camera/              camera manager, chase rig, cockpit, wing, flyby and FPV views
src/audio/               AudioEngine, mixer, engine synths, cues, callouts, spawn voices and their recipes
src/env/                 WindField, the atmosphere
src/spawns/              the spawn manager, event director, regional weather, the ten engines and the 100 presets
src/ui/                  glass UI, craft picker, settings, controls panel, instruments, journal, world map, challenge HUD, discovery card
src/copilot/             WREN: local grammar, remote brain, flight actions, tour guide
src/gameplay/            journal, ring courses, challenges, portals, ignition, waypoints
src/dev/                 dev badge, wind overlay, spawn debugger (F9), mock gamepads, test harnesses and kits
tools/                   smoke test, shell test, harness runner, flight, engine and system labs, docs check, builds, copilot server, static server
tests/                   the V1 freeze test and its SHA-256
docs/                    architecture, spawns, the engine pages, controls, copilot API, V1's known issues, the owner specs, screenshots
start-driftwing.bat      one-click start for Windows
```

### Tests, labs and harnesses

- **Smoke test.**
  `node tools/smoke-test.mjs --file dist-single/index.html [--url <dev server>/v2/] [--query "renderer=webgl"] [--steps-file steps.json] [--out dir]`
  loads the game in headless Chrome or Edge (set `CHROME_PATH` if the browser is elsewhere). It
  fails on any console error or warning, runs scripted steps (`wait`, `press`, `down`, `up`,
  `click`, `move`, `eval`, `shot`), and saves screenshots. `window.DRIFTWING` exposes `ready`,
  `ctx`, `state` and `getStats()` for scripted checks. The step files in `tools/steps/` check the
  engines, every batch of presets, the craft picker, challenges, the floating origin, high
  altitude, water bodies and more on a dev server.
- **Harnesses.** `node tools/run-harness.mjs --test 1|soak|hotas|terrain|determinism|spawns|collision|craft [--backend webgl]`
  starts its own dev server on a free port, runs the harness (`?test=...`, dev builds only) in
  headless Chrome and saves its report; the npm scripts above are its common runs.
- **Labs.** `node tools/flight-lab.mjs` and `node tools/lab/<name>.mjs` run headless in node: a lab
  per craft (`jet`, `helicopter`, `wingsuit`, `fpv`, `aerobatic`, `seaplane`, `tiltrotor`,
  `paraglider`, `balloon`, `airship`, `eagle`, `spaceplane`), the floating origin, colliders, water,
  atmosphere, challenges and the PathFollower, the spawn framework, the director, the engines and
  the presets, audio, discovery, settings, input, storage and WREN's grammar. Some need
  `node --expose-gc` for their allocation checks.
- **Docs check.** `node tools/docs-check.mjs` checks the docs against the code: every relative
  link and anchor, every row and section of `docs/spawns.md` against its preset file, the preset
  templates, the engine pages against the engines and the presets' params, the craft tables of
  `docs/architecture.md` and `docs/controls.md` against the craft modules, and every npm script
  named here.

[docs/architecture.md](docs/architecture.md#testing) lists every test, lab and step file with what
it proves.

### Documentation

- [docs/architecture.md](docs/architecture.md): the module map, the frame loop, every system
  contract (the craft framework, the floating origin, colliders, water, challenges, the spawn
  engines and the director included), and where Phase 4 plugs in.
- [docs/spawns.md](docs/spawns.md): the 100 spawn presets with their engines, filters, rarity and
  wind, and templates for adding a new one.
- [docs/engines/](docs/engines/): one reference page per spawn engine, with every param.
- [docs/controls.md](docs/controls.md): every default binding, the full HOTAS profile of every
  craft, the copilot phrases with their keyboard equivalents, calibration, and a HOTAS hardware
  checklist.
- [docs/copilot-api.md](docs/copilot-api.md): the remote copilot request, response and action
  schema.
- [docs/v1-known-issues.md](docs/v1-known-issues.md): what the frozen V1 prints, recorded instead
  of fixed.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

## Known limitations

- The first click or key press unlocks audio. Creating the browser's AudioContext can take around
  0.1 s on some machines, so a single frame may stutter at that moment.
- The WebGL2 fallback takes a few seconds longer to start than WebGPU, because WebGL compiles its
  shaders synchronously.
- When the auto-hidden HUD fades back in (a toast, the autopilot switching, the chute opening),
  Chrome rasterizes it on its GPU process's main thread, the thread that also runs WebGPU: about
  20-40 ms of work spread over a few frames. On an idle machine the slowest of those frames
  measured 18-38 ms; on a machine busy with other programs one of them can pass 50 ms.
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
`v1.0.0` and kept, frozen byte-for-byte, as [public/v1/index.html](public/v1/index.html).

**v2** is being built in four phases with the same model, each from one spec prompt:

1. **Phase 1**: the sim core, HOTAS, the first six craft, cockpits and procedural audio.
2. **Phase 2**: an event director with ten spawn engines, the first 30 environment spawns, and the
   discovery loop (journal, tour guide, world map, seed links).
3. **Phase 3 (this version)**: eight more craft (14 in all), 70 more spawns (100 in all), and the
   systems they need: the floating origin, structure collision and perches, lakes and region
   overlays, challenges, high-altitude rendering, legendary combos, and the journal and copilot
   additions.
4. **Phase 4**: Spotify, WebXR VR, a flight recorder with replay, and a multiplayer wingman.

For Phase 1, Opus 5.5 turned the single file into a Vite project and built the new systems with
parallel sub-agents in separate git worktrees, one merge per milestone, and reviewed and verified
each wave. A structure correction then made DRIFTWING two separate games behind one toggle: V1
frozen byte-for-byte, and V2 flying only the real flight model (Phase 1's CLASSIC mode, a port of
v1's arcade flight inside V2, was removed). The Phase 1 screenshots
above were captured from the single-file build with the headless smoke-test tool. Phase 2 was
built the same way: placement, the engine framework, the director and the spawn audio first, then
the ten engines, the 30 presets in three verified batches, and the discovery loop, each wave on
its own worktrees and merged per milestone. Phase 3 followed the same pattern in four waves: the
systems first, then the craft framework and the eight craft, the 70 presets in seven batches of
ten, and the journal, copilot and docs, each wave integrated and reviewed before the next.

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
