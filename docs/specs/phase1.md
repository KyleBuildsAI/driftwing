DRIFTWING v2 - PHASE 1 of 4: SIM CORE, HOTAS, WAVE-1 CRAFT, COCKPIT, AUDIO

CONTEXT
DRIFTWING v1 (single index.html, three.js WebGPU, infinite procedural flight, copilot, journal, photo mode) exists in this folder. v2 ships in 4 phases:
  Phase 1 (THIS PROMPT): module refactor, CLASSIC|SIM toggle, sim flight model, assists, ground contact, HOTAS + bindings UI, 6 craft, cockpit view + instruments, procedural audio, minimal wind field, perf upgrades.
  Phase 2: event director + 100 procedural environment spawns writing into the wind field.
  Phase 3: 8 more craft + remaining spawns.
  Phase 4: Spotify, WebXR VR, flight recorder/replay, multiplayer wingman.
Build ONLY Phase 1, but shape the architecture so Phases 2-4 plug in without rewrites. Do not implement spawns, Spotify, VR, replay, or multiplayer. Do not create fake/placeholder versions of them.

GROUND RULES
- Follow the webgpu-build-standards skill if available (pinned three.js, WebGPU-first boot with WebGL2 fallback, post stack in try/catch, polish bar, mandatory verify loop). OVERRIDE: this is now a multi-file Vite project, not a single HTML file. Single-file export is a build target (see below).
- three.js pinned to exactly 0.184.0 in package.json (no ^ or ~). If v1 used another version, migrate and note API changes.
- Every system in this prompt must fully work. Zero placeholders, zero TODO stubs, zero console errors AND zero warnings.
- Preserve v1's look, feel, and every v1 feature. CLASSIC mode must play identically to v1.
- Commit to git at the end of every milestone below.

MILESTONE A - SAFETY SNAPSHOT + REFACTOR TO PARITY
1. If this folder is not a git repo: git init. Commit v1 as-is, tag v1-final, copy index.html to legacy/v1.html. Create branch v2-phase1.
2. Convert to Vite + ES modules:
   - vite.config: server.host "127.0.0.1", server.port 5199, strictPort true. Reason: saved bindings/settings live in IndexedDB, which is tied to origin INCLUDING port; a drifting port silently "loses" the user's HOTAS setup. Phase 4 Spotify auth also requires 127.0.0.1.
   - Terrain generation stays in a Web Worker (Vite worker import; must inline correctly in single-file build).
   - Scripts: npm run dev, npm run build, npm run build:single (vite-plugin-singlefile -> one self-contained dist-single/index.html that still runs from a local server).
   - start-driftwing.bat in project root: checks for Node (friendly message with the Node LTS download link if missing), runs npm install if node_modules is missing, starts the dev server, opens http://127.0.0.1:5199 in the default browser.
3. Folder layout:
   src/main.js
   src/core/      loop, fixed-step clock, event bus, settings, storage (IndexedDB wrapper with versioned schema + migrations)
   src/render/    renderer boot, post stack, sky, clouds, water
   src/world/     chunk manager, terrain worker, biomes, landmarks, SHARED height function (importable by worker AND main thread)
   src/flight/    FlightModel interface, ArcadeModel (v1 port), SimFixedWing, SimHelicopter, SimWingsuit, SimQuad, aero helpers, assists, ground contact, autopilot
   src/craft/     registry + glider, bushplane, jet, helicopter, wingsuit, fpv (one file each)
   src/input/     InputManager, keyboard/mouse/touch (v1), gamepad/HOTAS, bindings, calibration
   src/camera/    chase, cockpit, wing, flyby, free-look
   src/audio/     AudioEngine, mixer, procedural synth modules
   src/env/       WindField
   src/ui/        glass UI, mode toggle, craft picker, controls panel, settings, instruments, toasts
   src/copilot/   Copilot, RemoteCopilot, grammar
   src/dev/       status badge, flight-test harness
4. Port v1 into this structure with NO behavior changes. Run the verify loop. v1 parity must pass before any new feature. Commit.

MILESTONE B - SETTINGS, MODE TOGGLE, INPUT ABSTRACTION
- Settings store (IndexedDB, persists across reloads, browser restarts, reboots): mode, craft, assists per craft, bindings, calibration, graphics, audio mixer, units, FOVs, HUD prefs.
- Top-left glass pill toggle: CLASSIC | SIM. Also key V and a bindable HOTAS action.
  - Switching mid-flight keeps position, velocity vector, attitude, seed, and craft. Convert state between models (arcade speed scalar <-> sim velocity vector), blend over 0.5s, no pops.
  - CLASSIC: v1 arcade rules (soft stall, never tumbles, space boost, double-tap A/D barrel roll), v1 HUD, chase cam default.
  - SIM: real flight model, assists slider, cockpit view default, instruments. Barrel-roll macro and space boost disabled in SIM.
  - When a HOTAS is detected in CLASSIC: toast "HOTAS detected - switch to SIM?" with Yes / No / Always. Remember the answer.
- Craft picker next to the toggle: glass strip with low-poly silhouette icons, keys 1-6, bindable next/prev actions.
- InputManager outputs one normalized ControlState per physics tick:
  { roll, pitch, yaw, throttle, collective, brakeL, brakeR, flaps, trim, lookX, lookY } plus discrete actions.
  Craft consume ControlState; each craft's input profile decides meaning (e.g. throttle axis -> collective on helicopter).
- Named actions (all rebindable on every device): copilotPTT, craftAbility, boost, waypointNearest, photoMode, viewCycle, viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext, craftPrev, modeToggle, gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward, timeBack, ringCourse, journal, settings, controlsPanel, relaunch, engineToggle, chuteDeploy.
- Keyboard/mouse/touch keep v1 defaults. Add SIM defaults: mouse = virtual stick (offset from screen center = deflection), Q/E rudder, G gear, F/Shift+F flaps, B airbrake, C view cycle. No collisions with v1 keys. Document all in docs/controls.md.
- Also ship a default profile for standard-mapping gamepads (Xbox-style).

MILESTONE C - SIM FLIGHT MODEL, ASSISTS, GROUND CONTACT (glider + bush plane first)
Physics core (all sim craft):
- Fixed 120 Hz physics with accumulator, render interpolation, independent of render rate.
- State in SI units: position, velocity, orientation quaternion, angular velocity.
- dt clamp at 0.1s (tab blur). NaN/Infinity guard every tick: restore last good state and log once.
- Air density rho = 1.225 * exp(-altitude / 8500).
- Airspeed is relative to air mass: vAir = velocity - WindField.sample(pos, t).vel.
Fixed-wing model (SimFixedWing):
- Lift = 0.5 * rho * V^2 * S * CL(alpha). CL linear to critical AoA (about 14-16 deg GA, about 25 deg jet), then post-stall drop.
- Drag = parasitic + induced (CL^2 / (pi * e * AR)) + flaps + gear + airbrake.
- Side force from sideslip. Control authority scales with dynamic pressure.
- Aerodynamic damping on all axes. Pitch and weathervane stability. Adverse yaw from aileron. Prop torque/P-factor on prop craft. Pitch trim.
- Stall with wing drop proportional to sideslip. Spins possible at 0% assists, always recoverable.
Assists slider 0-100%, per craft, persisted, active assists listed in a tooltip:
- 100%: auto-coordination, AoA/stall limiter, auto-level when hands off, G limiter, auto-trim, helicopter auto-hover + heading hold, drone angle mode with altitude hold.
- 50%: auto-coordination, auto-trim, stall warning only.
- 0%: raw physics.
Autopilot (copilot "autopilot on", heading/waypoint): in SIM it must fly THROUGH the flight model with PID control of the control surfaces (heading hold, altitude hold, speed hold). It never sets orientation directly.
Ground contact:
- Collision uses the SHARED deterministic height function, never the chunk mesh, so it works even when chunks aren't loaded. v1's terrain clamp stays only as a last-resort guard: penetration over 1 m triggers the soft crash.
- Per-craft contact points (gear, skids, body) with spring-damper suspension and wheel/skid friction. Toe brakes: both = wheel brakes on ground / airbrake in air; differential = ground steering. Rudder steers at taxi speed.
- Touchdown grade from vertical speed: Butter / Smooth / Firm / Hard toast. Best landing saved to journal.
- Soft crash (still NO fail state): impact over craft limits, a non-gear part striking terrain at speed, or water contact for anything that can't float -> 0.4s fade, respawn 300 m AGL at same XZ and heading, level, at cruise (helicopter/drone hovering). No penalties.
- Settings option "Start on ground": spawns on nearby flat terrain (slope check) for takeoff practice.
- relaunch action: glider = aerotow to 1000 m AGL; wingsuit = teleport to nearest high peak.
Craft this milestone:
- GLIDER: 15 m span, L/D about 40, min sink about 0.6 m/s, stall about 65 km/h, Vne about 270 km/h. Spoilers on toe brakes/airbrake. Variometer audio in Milestone G.
- BUSH PLANE (Super Cub style): stall about 55 km/h with full flaps, cruise about 170 km/h, climb about 5 m/s, 3 flap notches, oversized tires, strong prop torque.

MILESTONE D - HOTAS (Thrustmaster T.16000M FCS Flight Pack)
Hardware facts:
- Browser sees TWO devices: the T.16000M stick, and the TWCS throttle with the TFRP pedals attached via RJ12.
- TWCS axes: throttle (Z), mini-stick X/Y, rocker (Rz), antenna slider (Slider 0), rudder (Slider 1), left and right toe brakes.
- Stick: X, Y, twist (Rz), its own throttle slider (ignore while TWCS is present), 8-way hat, 16 buttons.
- Each device has 16 or fewer buttons, so use the standard Gamepad API. No WebHID.
Implementation:
- Identify devices by parsing vendor/product IDs from gamepad.id (Thrustmaster vendor 044f), falling back to name substrings "T.16000M" / "TWCS". NEVER by slot index; slot order changes across reboots. Log the observed IDs and hardcode them in a known-devices table.
- Gamepad API only exposes devices after a button press. Controls panel shows "Press any button on your stick and throttle" until both appear.
- Hats: Chrome may report a hat as a single axis with discrete values and an out-of-range value for centered, or as buttons. Handle both. The calibration wizard LEARNS each hat's 8 directions and center, so no hardcoded values.
- Per-axis pipeline: invert, center deadzone, edge saturation, expo curve, light low-pass smoothing. Throttle maps to 0..1 with direction learned in calibration. Afterburner detent at configurable 95% with click sound and UI cue.
- Twist yaw auto-disables once the pedal rudder axis has moved (override in settings).
- Hot-plug: on disconnect mid-flight, engage 100% assists hands-off and toast; restore on reconnect.
Default HOTAS bindings:
- Stick X/Y: roll/pitch (helicopter: cyclic).
- Pedal rudder: yaw (helicopter: anti-torque). Twist is the fallback.
- Toe brakes: wheel brakes / airbrake as above.
- TWCS throttle: throttle (helicopter: collective; drone: thrust).
- Rocker: pitch trim.
- Antenna: flaps with notch hysteresis on fixed-wing; FOV zoom on helicopter/drone/wingsuit.
- Mini-stick: free look (absolute angle; releasing returns to center). Mini-stick click: recenterView.
- Trigger (hold): copilot push-to-talk.
- Stick head buttons: craftAbility (CLASSIC: boost), waypointNearest, photoMode.
- Stick hat: view snaps (up = forward/cockpit, down = chase, left/right = look 90 deg).
- Throttle hat: LEFT UNBOUND by default (reserved for Phase 4 music controls).
- Remaining actions: assign sensibly to stick base and throttle buttons, including gear, craft next/prev, mode toggle, autopilot, time of day, ring course, journal, settings. Document in docs/controls.md.
Controls panel (glass UI, key/action controlsPanel):
- Tabs per device with live axis bars and button lights.
- Click an action, then move or press an input to bind. Conflict warnings.
- Global profile plus per-craft overrides. Reset to defaults. Export/import JSON.
- Calibration wizard, in order: center everything; move each axis lock to lock; throttle full forward; pedals full left/right and each toe brake; press each hat direction. Pedal note on screen: "Keep pedals centered and feet off when plugging in."
- All bindings and calibration persist in IndexedDB keyed by device ID and survive restarts.

MILESTONE E - REMAINING WAVE-1 CRAFT
Every craft module provides:
- buildMesh(): procedural low-poly, flat-shaded, v1 palette. Animated control surfaces, prop disc, rotor, gear.
- simProfile, arcadeProfile (flyable in CLASSIC with v1's forgiving rules), inputProfile, audioProfile, cameraRig (eye point, chase distance), instruments, abilities.
- JET: afterburner detent, about 1300 km/h at sea level, about Mach 1.6 at altitude with AB, 9G structural limit, high-AoA handling.
  - Vapor cone particles between Mach 0.9 and 1.05 at low altitude.
  - G effects: gray-out vignette from 6G, heavy at 8G, tunnel vision at 9G sustained 3s, red tint below -2G.
- HELICOPTER (light utility):
  - Collective = rotor thrust along the disc normal. Cyclic tilts the disc with a short lag.
  - Main-rotor torque yaws the body; tail rotor counters it.
  - Translational lift above about 28 km/h. Ground effect within one rotor diameter. Settling-with-power when descending fast at low airspeed.
  - Governed rotor RPM state. engineToggle cuts the engine for autorotation practice.
  - Skids. Vne about 250 km/h.
- WINGSUIT:
  - Glide about 2.5:1, 150-220 km/h. Body pitch trades glide for speed; roll to turn; flare.
  - chuteDeploy -> canopy mode: slow descent, steering on stick/pedals.
  - After landing, relaunch from nearest peak.
  - Wind-rush intensity rises with terrain proximity.
- FPV DRONE (5-inch racing quad):
  - Thrust along the body up axis, thrust-to-weight about 8:1, top speed about 150 km/h.
  - Rate (acro) mode with Betaflight-style rates, max about 670 deg/s, configurable expo. Angle mode at high assists.
  - FPV camera locked to the frame, 25 deg uptilt (configurable 0-40), FOV 120.
- Craft switching: spawns at the current position with a sensible state. Wingsuit below 300 m AGL auto-relaunches from a peak; helicopter and drone spawn hovering.

MILESTONE F - CAMERAS + COCKPIT
- Views: cockpit/first-person (per-craft eye point, low-poly canopy frame and panel), v1 chase cam (unchanged), wing cam, flyby cam (placed ahead, craft passes, relocates).
- Free look on mini-stick in every view (head pan in cockpit, orbit in chase). FOV setting per view.
- Instruments drawn to a CanvasTexture on the cockpit panel at 30 Hz, plus an optional glass HUD overlay for readability:
  - Fixed-wing: airspeed, altitude, attitude, heading, vertical speed, AoA, G, throttle %, flaps/gear.
  - Helicopter adds rotor RPM, torque, radar altitude.
  - Glider adds variometer and L/D.
  - Drone: throttle %, mode (rate/angle).
  - Wingsuit: glide ratio, ground proximity.
- Units setting: knots/ft or km/h/m.

MILESTONE G - PROCEDURAL AUDIO (Web Audio, no external files)
- AudioContext resumes on the first keydown/pointerdown; also try on a gamepad button. If still suspended, show a small "Sound off - click to enable" pill. Never a menu wall.
- Mixer buses: master, engine, environment, UI, copilot, and a music bus (unused until Phase 4). Sliders in settings. Everything else ducks while the copilot speaks.
- Airflow: filtered noise tracking airspeed. Buffet rumble near stall AoA. Lowpassed interior mix in cockpit view.
- Prop: RPM-driven oscillators with harmonics and noise.
- Jet: turbine whine plus rumble; broadband afterburner roar.
- Helicopter: blade slap (AM noise at blade-pass frequency) plus turbine.
- Drone: four slightly detuned motor tones tracking thrust.
- Wingsuit: flutter and wind rush.
- Spatialization and doppler (PannerNode) in chase and flyby views.
- Cues: stall horn, glider variometer beeps (pitch rises with climb rate), gear/flap motors, touchdown thump and tire chirp, AB detent click.
- Optional radar-altitude landing callouts (setting), in a voice distinct from the copilot.

MILESTONE H - WIND FIELD, COPILOT, PERFORMANCE, SETTINGS
WindField (src/env/WindField.js):
- sample(pos, t) -> { vel: Vector3, turbulence: 0..1 }
- Layers:
  - Seeded ambient wind that varies slowly with altitude.
  - Ridge lift from the wind component into the terrain slope (shared height function gradient).
  - Seeded thermal columns in sunny biomes: strongest midday, off at night, marked by a small cumulus cap from the existing cloud system.
  - Turbulence scaled by wind speed and low AGL.
- Phase 2 writer API, fully implemented now: addSource({ id, bounds, sample(pos, t) }) and removeSource(id), with a spatial hash. Prove it works with a dev-only debug source.
- Dev toggle for wind-arrow overlay.
- CLASSIC gets subtle wind only; SIM gets the full field.
Copilot:
- New grammar and keyboard/UI equivalents: "switch to [craft]", "sim mode", "classic mode", "assists up/down/full/off", "cockpit view", "chase view", "deploy chute", "engine off", "relaunch", "calibrate controls", "airspeed", "how was my landing".
- Hold-to-talk on the HOTAS trigger. The v1 mic toggle stays.
- Extend RemoteCopilot flightState with: mode, craft, assists, airspeed, AoA, G, AGL, windAtCraft, gear, flaps, onGround, lastLandingGrade.
- Write docs/copilot-api.md with the full request/response and action schema so an external LLM endpoint can implement it.
Performance:
- Render uncapped via setAnimationLoop. The frame target defaults to the display refresh rate (measured), NOT 60.
- Dynamic resolution holds the target frame time by stepping render scale between 0.6x and 1.0x with hysteresis. v1's view-distance auto-degrade becomes the second stage.
- Settings panel: graphics preset (Low/Med/High/Ultra), frame target (Auto/60/120/144/240/Uncapped), units, mixer, FOVs, assists, HUD, dev badge.
- Dev badge shows backend, three.js revision, fps, a frametime graph, and detected input devices.
Phase 2-4 hooks (real, documented, no fake content):
- Typed event bus events: modeChanged, craftChanged, landed(grade), softCrash, discovery, windSourceAdded.
- Music bus.
- Renderer boot must not hard-block the WebGL2 backend (Phase 4 WebXR runs on it).

MILESTONE I - VERIFICATION (mandatory)
1. Verify loop in Chrome at http://127.0.0.1:5199 AND on the build:single output: 0 errors, 0 warnings, two screenshots that differ, visuals match the golden-hour spec.
2. Flight-test harness at ?test=1 (dev only):
   - Scripted autopilot flies each of the 6 craft for 60s in BOTH modes across 3 seeds.
   - Logs: avg fps, p99 frametime, NaN events, terrain penetrations, soft crashes, heap growth after warmup.
   - Pass criteria: 0 NaN, 0 penetrations, 0 console errors, heap growth under 50 MB, no frame over 50 ms after warmup.
   - Outputs an on-screen summary plus a downloadable JSON report.
3. HOTAS pipeline test at ?test=hotas: mock navigator.getGamepads() with two fake devices matching the stick and TWCS layouts. Script their axes/hats/buttons to verify:
   - bindings and hat decoding
   - calibration results
   - twist auto-disable
   - persistence surviving a page reload
4. Final report: backend, revision, harness results, what changed, known issues.
5. End with a SHORT manual checklist for the real hardware: plug-in order, calibration wizard, one flight per craft, what to look for.

DELIVERABLES
- Working repo on branch v2-phase1, commit per milestone, tag v2-phase1.
- start-driftwing.bat.
- README.md with plain-language run steps (install Node LTS, double-click the .bat).
- docs/controls.md (full default bindings for keyboard, mouse, touch, gamepad, HOTAS).
- docs/copilot-api.md.
- docs/architecture.md (module map, where Phase 2-4 plug in).
- CHANGELOG.md.
