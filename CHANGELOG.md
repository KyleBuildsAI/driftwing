# Changelog

All notable changes to DRIFTWING are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). v2 ships in four phases. Phase 1 is
`2.0.0-phase.1`; Phases 2-4 (the event director and spawns, more craft, then Spotify, VR, replay
and a multiplayer wingman) follow as later pre-releases of 2.0.0.

## [Unreleased]

The structure correction: DRIFTWING is two separate games behind one toggle, V1 (frozen) and V2.

### Removed

- CLASSIC mode from V2: the CLASSIC | SIM pill, the `modeToggle` action and its bindings on every
  device, `src/flight/ArcadeModel.js` (and its hover extension), every craft's `arcadeProfile`,
  the CLASSIC wind drift and mode switching in the flight controller, the `modeChanged` event, the
  `mode` telemetry and copilot fields, and the `setMode` copilot action.
- The CLASSIC boost (Space), the double-tap barrel roll, their touch buttons, HUD ring, sounds,
  camera shake and particle burst, and the `boost` / `barrelRoll` copilot actions.
- The "HOTAS detected - switch to SIM?" prompt and its `hotasPrompt` setting.
- The legacy `ctx.input` struct; the Shift fine-control modifier (CLASSIC only).
- `tools/arcade-parity.mjs` and `tools/parity/`, and the CLASSIC conversion checks in the labs and
  the flight-test harness (which now flies each craft once per seed).

### Changed

- V2 boots straight into the real flight model. The assists slider (0-100 % per craft) is the only
  difficulty control: 100 % by default, and the first HOTAS device sets 50 % on every craft whose
  assists the player never set, once, with a toast.
- One keyboard layer: G gear, N waypoint ahead, C view cycle, V first / third person, Space craft
  ability; Enter and / open the command bar; Shift+V stays WREN's voice.
- The touch virtual stick and throttle slider feed ControlState through `ctx.systems.input.touch`.
- `versionToggle` moved to T.16000M base button 10 (it was TWCS button 8).
- Settings version 4: `mode`, `views` and `hotasPrompt` are dropped (the SIM view becomes `view`),
  and `assistsSetByPlayer` / `hotasAssistsApplied` are added. Stored bindings for the retired
  actions and Phase 1's CLASSIC-only key references are dropped quietly.
- The variometer audio is `on` or `off` (Phase 1's `auto` reads as `on`).
- Views are remembered per craft (settings version 5: `views` and `thirdPersonViews` per craft,
  seeded from version 4's `view`), a craft change flies the new craft from its own view, and the
  first launch opens in the chase view, the golden-hour opening shot.
- The v1 flight card reads "Airspeed" and follows the Units setting (km/h, m, m/s or kt, ft, fpm).
- On landscape touch screens the compass sits between the flight card and the status chips, and
  the launcher's V1 | V2 pill keeps clear of V2's flight card.
- WREN's "third person" and "outside view" go back to the craft's last outside view (they meant
  the chase view before).

### Added

- WREN: "switch to version one" (also "version one", "v1", "switch to v1", "play the original"),
  the `switchVersion` remote action (`version: 'v1'`, strictly validated) and its rule in
  `tools/copilot-server.mjs`.
- First / third person: the bindable `viewToggle1P3P` action (V, gamepad View, TWCS button 8)
  swaps at once between the cockpit (the drone's FPV camera) and the craft's last third-person
  view. The stick hat keeps its snaps.
- The glass HUD in every third-person view: the airspeed / altitude card and compass, a compact
  attitude indicator, the throttle bar and a stall / AoA warning. It is optional in the cockpit
  (`hud.cockpitGlass`, off by default); the FPV camera and the wingsuit keep it.
- The flight path marker: the velocity-vector symbol where the air-relative velocity points, with a
  nose mark, so sideslip and angle of attack read from outside (`hud.flightPathMarker`, on).
- WREN: "wing view", "flyby view", "third person" / "outside view"; `setView` takes `wing`, `flyby`
  and `outside`.
- `tools/steps/view-physics.json`: flies every craft through the same scripted inputs from the
  cockpit, from chase and while switching views, and needs the same trajectory at every tick. It
  steps frames through the dev-only `DRIFTWING.debug` hooks (`pauseLoop`, `stepFrames`,
  `resetTiming`, `resumeLoop`).
- `tools/lab/settings.mjs` (settings migrations, the HOTAS assist default) and
  `tools/lab/copilot.mjs` (WREN's grammar and the `switchVersion` schema); the HOTAS harness checks
  the assist default across a reload.

## [2.0.0-phase.1] - 2026-09-27

Phase 1 of v2: the sim core, HOTAS support, the six wave-1 craft, the cockpit and procedural audio.
CLASSIC mode is the v1 game, bit for bit. The milestone letters (A-I) follow the Phase 1 plan; the
work landed on branch `v2-phase1` as one merge per milestone or wave.

### Added

#### Platform (Milestone A)

- Vite project with ES modules under `src/` (core, render, world, flight, craft, input, camera,
  audio, env, ui, copilot, gameplay, dev). The v1 game is kept as `legacy/v1.html` and tagged
  `v1-final`.
- `npm run dev` pinned to `http://127.0.0.1:5199` (`strictPort`), because saved settings, bindings
  and calibration live in IndexedDB for that exact origin. Also `npm run build`, and
  `npm run build:single` for one self-contained `dist-single/index.html`, with the terrain worker
  inlined. `npm run serve:single` serves that file on the same address.
- `start-driftwing.bat`. It checks for Node.js 20+ and opens the Node LTS download page if it is
  missing, runs `npm install` on the first run, then starts the game and opens the browser.
- `tools/arcade-parity.mjs`: proves CLASSIC is bit-identical to v1. It compares 296,010 values over
  75 s of mixed frame rates, on two suites and four seeds.

#### Settings, mode toggle and input (Milestone B)

- IndexedDB storage (`driftwing` / `kv`) with versioned migrations and a one-time import of v1's
  localStorage keys. Settings are a validated, versioned schema.
- The CLASSIC | SIM pill (top left), key **V**, and a bindable `modeToggle` action. A switch
  mid-flight keeps the position, velocity, attitude, seed and craft, converts the state between the
  models and blends over 0.5 s.
- The craft picker with low-poly silhouettes, keys **1-6**, and `craftNext` / `craftPrev`.
- "HOTAS detected - switch to SIM?" prompt (Yes / No / Always, remembered).
- The InputManager: one normalized ControlState per physics tick (roll, pitch, yaw, throttle,
  collective, brakes, flaps, trim, free look, antenna), the v1 `ctx.input` struct for CLASSIC, and
  every named action rebindable on every device.
- A SIM keyboard layer (G gear, N waypoint, C view, Space craft ability, W / S throttle lever, Q / E
  rudder, F / Shift+F flaps, B airbrake, Home / End trim). In SIM the mouse is a free virtual stick
  with an on-screen reticle.
- A default profile for standard-mapping (Xbox-style) gamepads.

#### SIM flight model, assists and ground contact (Milestone C)

- Fixed 120 Hz physics with an accumulator and render interpolation, a 0.1 s frame clamp, and a
  NaN / Infinity guard every tick. Air density falls with altitude, and airspeed is relative to the
  wind field.
- `SimFixedWing`, a 6-DOF model built from panels:
  - lift and drag past the stall, induced drag, flaps, gear, spoilers;
  - side force, damping, stability, adverse yaw;
  - prop torque and P-factor, pitch trim;
  - stalls with wing drop, and spins at 0 % assists that are always recoverable.
- Assists, 0-100 % per craft. 50 % gives auto-coordination, auto-trim and a stall warning. 100 %
  adds the AoA and G limiters, auto-level, flight-path hold, and bank, pitch and overspeed
  protection. Active assists are listed in a tooltip.
- A trim solver after every mode switch, spawn and craft switch, so nothing pitches or zooms after
  a conversion.
- A PID autopilot that flies through the controls (heading, altitude and speed hold, waypoint and
  ring following, terrain look-ahead), in SIM for every craft.
- Ground contact on the shared height function, with spring-damper gear, wheel and skid friction,
  toe brakes and ground steering.
- Landing grades (Butter / Smooth / Firm / Hard); the best landing is kept in the journal.
- Soft crash: a 0.4 s fade and a respawn 300 m up, with no penalty.
- "Start on the ground" on flat, clear terrain. Relaunch: aerotow with a tug and rope for the
  glider, a peak launch for the wingsuit, an airstart for the others.
- The glider (a 15 m sailplane with water ballast) and the bush plane (a Super Cub-style
  taildragger with 3 flap notches and a smoke trail).
- `tools/flight-lab.mjs`: headless performance and handling checks for the glider and bush plane.

#### HOTAS (Milestone D)

- Thrustmaster T.16000M FCS Flight Pack support: the stick, and the TWCS throttle with the TFRP
  pedals.
  - Devices are identified by USB vendor / product id or by name, never by slot. `?debug=1` logs
    the real ids.
  - Hats in axis or button form are learned by calibration.
  - The per-axis pipeline is invert, deadzone, saturation, expo and smoothing.
  - The afterburner detent (95 % by default) has a click and a UI cue.
  - Twist yaw hands off to the pedals.
  - Hot-plug: assists hold hands-off in SIM when a flying controller disconnects.
- Default HOTAS bindings as in the Phase 1 plan. The throttle hat is left unbound, reserved for
  music controls.
- The controls panel (`.`):
  - a tab per device with live axis bars, button lights and hat compasses;
  - bind by listening, with conflict warnings;
  - a global profile plus per-craft overrides;
  - per-axis tuning with a live response curve;
  - reset, and JSON export / import.
- The calibration wizard: center, axes lock to lock, throttle, pedals and toe brakes, then each hat
  direction, with the pedal note on screen throughout.
- `src/dev/mockGamepads.js`: scriptable mock devices for tests.

#### Craft (Milestone E)

- **Jet**:
  - an afterburning turbofan with spool lag and a detent, transonic drag rise and wing rock;
  - about 1300 km/h at sea level and Mach 1.6 at altitude, and a 9 g limit;
  - a flight control system, and retractable gear;
  - vapor cones, afterburner flame and wingtip vapour;
  - G effects: gray-out from 6 g, tunnel vision at 9 g sustained, red tint below -2 g.
- **Helicopter**:
  - collective along the disc, cyclic with flapping lag, torque and a tail rotor;
  - translational lift, ground effect, settling with power, retreating blade stall;
  - a governed rotor, and autorotation with the engine off;
  - skids; hover hold as its ability.
- **Wingsuit**: about 2.5:1 glide at 150-220 km/h, a ram-air canopy with toggles and flare,
  proximity warning, and a peak relaunch.
- **FPV drone**: a 5-inch quad with 8:1 thrust to weight, Betaflight rates up to about 670 deg/s,
  angle mode with altitude hold, turtle mode, and a 25 deg uptilt FPV camera with a 120 deg lens.
- The hover extension of the arcade model, so rotorcraft fly v1's forgiving rules in CLASSIC.
- Headless labs: `tools/lab/jet.mjs`, `helicopter.mjs`, `wingsuit.mjs`, `fpv.mjs`.

#### Cameras and cockpit (Milestone F)

- Views: cockpit (a low-poly canopy frame and instrument panel per craft), v1's chase view
  (unchanged), wing, flyby and FPV. SIM defaults to the cockpit and CLASSIC to chase.
- Free look on the mouse (right-drag), the gamepad right stick and the HOTAS mini-stick, with view
  snaps on the stick hat. FOV per view.
- 17 instruments drawn at 30 Hz, on the cockpit panel and in an optional glass HUD overlay:
  airspeed, altitude, attitude, heading, VSI, AoA, G, throttle, flaps / gear, rotor rpm, torque,
  radar altitude, variometer, L/D, drone mode, glide ratio and ground proximity.
- Units: km/h and m, or knots and ft.

#### Procedural audio (Milestone G)

- Web Audio with no audio files. The mixer buses are master, engine, environment, UI, copilot and
  music, and everything ducks while WREN speaks.
- The AudioContext unlocks on the first key, click or gamepad button; otherwise a
  "Sound off - click to enable" pill appears.
- Engine families:
  - prop, jet with afterburner roar, helicopter blade slap, drone motors;
  - wingsuit flutter and wind rush;
  - v1's glider hum.
- Airflow tracking the airspeed, buffet near the stall, and a muffled interior in the cockpit.
  Spatial audio and doppler in external views.
- Cues: stall horn, variometer beeps, gear and flap motors, touchdown thump and tire chirp,
  afterburner detent click.
- Optional radar-altitude landing callouts in a voice distinct from WREN.

#### Wind, copilot, performance and settings (Milestone H)

- The WindField:
  - seeded ambient wind, ridge lift, and thermals marked by cumulus caps;
  - turbulence;
  - an `addSource` / `removeSource` writer API for Phase 2, proven by a dev-only debug updraft
    (key L);
  - a dev wind-arrow overlay.
  CLASSIC feels a gentle share of the field, and SIM all of it.
- WREN's new commands: "switch to [craft]", "sim / classic mode", "assists up / down / full / off",
  "cockpit / chase view", "deploy chute", "engine off / on", "relaunch", "calibrate controls",
  "airspeed" and "how was my landing". Each command also has a key or UI equivalent.
- Hold-to-talk on the HOTAS trigger (or the backquote key); an "Aircraft" quick-chip row in SIM;
  chatter about landings and lift.
- The remote copilot flight state gained the mode, craft, assists, airspeed, AoA, G, AGL, wind at
  the craft, gear, flaps, ground state and landing grades.
- `docs/copilot-api.md`, and the reference server `tools/copilot-server.mjs` updated to match.
- Uncapped rendering with a frame target measured from the display (not a fixed 60). Dynamic
  resolution steps between 0.6x and 1.0x with hysteresis, with v1's view-distance governor as the
  second stage.
- A tabbed settings panel (Flight, Graphics, Sound, Controls, General): graphics preset, frame
  target, units, mixer, FOVs, assists, HUD and the dev badge.
- The dev badge: version, backend, three.js revision, fps, a frame-time graph and the input
  devices.
- Typed events for later phases: `modeChanged`, `craftChanged`, `landed`, `softCrash`, `discovery`,
  `windSourceAdded` (plus `windSourceRemoved`, `viewChanged`, `deviceConnected`,
  `deviceDisconnected` and `relaunched`).

#### Verification and release polish (Milestone I)

- The flight-test harness at `?test=1` (dev builds only). A scripted autopilot flies all six craft
  in both modes across three seeds. It reports fps, p99 frame time, NaN events, terrain
  penetrations, soft crashes, heap growth and console errors, with an on-screen summary and a JSON
  report.
- The HOTAS pipeline test at `?test=hotas`, which uses mock devices to check:
  - bindings and hat decoding;
  - calibration results;
  - twist auto-disable;
  - persistence across a reload.
- `tools/run-harness.mjs`, which runs either harness headlessly and saves the report.
- FPV drone settings in the Flight tab: camera uptilt (0-40 deg), stick expo and maximum rate.
- A parking brake for ground starts with the throttle lever open. It holds until the lever moves or
  the brakes are pressed.
- The version (`2.0.0-phase.1`) in the dev badge.
- Documentation:
  - the README rewritten for v2;
  - `docs/architecture.md` (the module map, the contracts and the Phase 2-4 plug points);
  - `docs/controls.md` (every default binding, and a HOTAS hardware checklist);
  - this changelog.

### Changed

- three.js is the npm package pinned to exactly `0.184.0`, bundled by Vite. It used to load from a
  CDN import map. There is still only one copy, imported as `three/webgpu` with `three/tsl` and
  `three/addons`.
- The game is no longer one hand-written `index.html`. The single-file build reproduces that as a
  build target and runs from a local server.
- **V** now toggles CLASSIC / SIM. WREN's voice toggle moved to **Shift+V**.
- Settings moved from localStorage to IndexedDB. v1's single volume slider became the master bus
  of the mixer (`masterVolume` still works as an alias).
- v1's flight code became `ArcadeModel`, parameterised per craft; the glider's profile is v1's
  constants.
- The help panel's keyboard and shortcut lists are generated from the live bindings for the mode
  being flown. The SIM first-run hint shows the SIM keys. CLASSIC's help and hints are v1's.
- The renderer boot moved to `src/render/renderer.js`, and the frame loop to `src/core/loop.js`.
- The journal gained a Landings section. The v1 content is unchanged.
- The reference copilot server's default model is now the undated alias `claude-haiku-4-5`.
- `npm test` builds the single-file target and smoke-tests it. `npm run serve` became
  `npm run serve:single`.

### Fixed

- WebGPU is chosen only when a real device can be created. After a late fallback to WebGL2, the
  renderer is rebuilt without WebGPU-only options.
- Controllers keep their bindings, calibration and held buttons when the browser moves them to
  another slot.
- A controller input that was just bound no longer fires its new action while it is still held.
  Actions whose binding changes while held are released.
- Implausible start-up refresh readings (a busy boot) no longer set a low frame target. Dynamic
  resolution recovers quickly once the load drops, and ignores lone hitches.
- SIM:
  - conversions, spawns, respawns in wind and tow releases start trimmed at the craft's cruise
    airspeed;
  - hands-off assists stay inside a comfortable load band;
  - switching back to CLASSIC starts above the arcade stall.
- Ring following leads far enough ahead for SIM turn radii.
- Ground starts avoid trees and rocks along the take-off run. The jet gets a longer, smoother
  strip.
- The SIM guard catches sinking into the sea. The autopilot's hold altitude is clamped when
  returning to CLASSIC.
- The wingsuit respawns from a peak after a soft crash. Canopy touchdowns into rising ground are
  graded instead of crashing.
- The quad's ground contact is substepped, so its feet catch a landing before the props do.
- Layout:
  - the pill, picker, toasts, sound pill and dev badge fit and stay clear of the HUD on landscape
    phones and touch screens;
  - the device tabs wrap on phones;
  - Tab inside a panel moves focus instead of toggling the HUD.
- When WREN turns the engine on or off, the confirmation is spoken once, without a duplicate toast.
- `start-driftwing.bat` treats an empty or unreadable Node version as "install Node LTS".

## [1.0.0] - 2026-09-26

The original single-file game, built from one prompt as a test of Claude Opus 5.5.

### Added

- An ambient, infinite-flight exploration game in one `index.html`: three.js r184 with
  `WebGPURenderer` and an automatic WebGL2 fallback, loaded from a CDN import map with SHA-384
  integrity.
- Arcade flight with soul:
  - mouse, keyboard and touch steering;
  - throttle, a boost on cooldown, and a double-tap barrel roll;
  - a soft stall that never tumbles;
  - a chase camera that banks, with an FOV stretch and a subtle shake at speed.
- An infinite deterministic world from a shareable seed:
  - chunked heightmap terrain from Web Workers with ring LOD, skirts and pooled meshes;
  - five blended biomes (snow peaks, pine valleys, dune sea, archipelago, flower meadows);
  - landmarks: stone arches, monolith circles, lighthouses and hot-air balloons.
- Living atmosphere:
  - a day / night cycle that lingers at golden hour;
  - sun, moon, stars, aurora and god rays;
  - fog that matches the sky, drifting clouds with shadows;
  - water with waves, glint and shoreline foam;
  - bird flocks, contrails and wind streaks.
- WREN, the copilot:
  - a local keyword grammar with speech in and out;
  - a remote brain endpoint with an 800 ms fallback, and a reference server;
  - waypoints, autopilot, time of day, ring courses and place descriptions.
- Gentle objectives: ring courses, a discovery journal and photo mode.
- A glass UI that auto-hides, a post stack (bloom, grade, vignette, grain), and an automatic
  quality governor.
- A headless smoke test (`npm test`).

[2.0.0-phase.1]: https://github.com/KyleBuildsAI/driftwing/tree/v2-phase1
[1.0.0]: https://github.com/KyleBuildsAI/driftwing/releases/tag/v1.0.0
