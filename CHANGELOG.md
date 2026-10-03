# Changelog

All notable changes to DRIFTWING are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). v2 ships in four phases. Phase 1 is
`2.0.0-phase.1`; Phases 2-4 (the event director and spawns, more craft, then Spotify, VR, replay
and a multiplayer wingman) follow as later pre-releases of 2.0.0.

## [2.0.0-phase.2] - 2026-10-03

Phase 2 of v2, released as `2.0.0-phase.2` (tag `v2-phase2`): the event director, ten
reusable spawn engines, the first 30 environment spawns and the discovery loop. Scenery becomes
events: storms that build and drop tornadoes, a volcano that wakes, whales, geese that let you join
their V, an eclipse that darkens the world, a sky whale whose slipstream you can ride. Every spawn
is data on generic engines, so Phase 3 adds 70 more without engine rewrites. The milestone letters
(A-G) follow the Phase 2 spec; the work landed on branch `v2-phase2` as one merge per milestone or
wave. V2 has no CLASSIC mode: spawns apply their full wind forces, and the assists are the safety
net.

### Added

#### Placement and terrain stamps (Milestone A)

- Deterministic site placement on a 2 km grid (`src/world/placement.js`): every site preset is
  rolled per cell with hash(seed, cellX, cellZ, presetId) and filtered by the terrain's own biome
  function, the surface, the height and relief, the clearance from Phase 1 landmarks and other
  sites, and a minimum spacing resolved locally. The same seed gives the same sites, in the terrain
  worker and on the main thread, with no messaging; `hashSiteList` is the determinism key.
- Terrain stamps inside the shared height function (`src/world/stamps.js`): a volcano cone with a
  crater, a slot-canyon carve, a waterfall cliff step, a gorge for the rope bridge, a flattened
  airfield strip and islet bases, each with a smooth falloff, found through a spatial hash. Meshes,
  every LOD ring, the skirts and ground collision agree, and height sampling stays within 10 % of
  Phase 1. Stamp-aware vertex colours paint ash, basalt, wet rock, tarmac and riverbeds.

#### Spawn engines and the debugger (Milestone B)

- The spawn framework (`src/spawns/`): the SpawnManager (activation within budgets, NEAR / MID /
  FAR tiers with hysteresis, lifetimes and the despawn rule, discovery with terrain occlusion,
  memory accounting and leak clean-up), the engine registry and interface (`init`, `create`,
  `update`, `setLOD`, `dispose`, `stats`), the preset schema and validator, pooling helpers and a
  real-light pool of at most 4 lights.
- FAR lures: horizon silhouettes for heavy spawns (volcano plume, supercell anvil, tornado funnel,
  sky whale, floating islands, comet), drawn above the fog beyond the terrain's view distance so the
  player sees them from 30-60 km and flies toward them.
- The ten engines, each with a reference page in `docs/engines/`: `vortex` (funnels, debris and
  spray rings, Rankine wind), `emitter` (GPU particles: TSL compute on WebGPU, closed-form motion
  on WebGL2), `weatherVolume` (cloud masses, rain shafts, fog banks, canopy rain), `fauna`
  (instanced boids with vertex-shader wing flaps), `structure` (procedural builds from recipes,
  with stamps, gates, timed courses, graded landings and landable tops), `celestial` (meteors,
  comets, the eclipse, the glory and rainbows), `waterEffect` (whirlpools, splashes, spray,
  bioluminescence, plunge pools on a shared water effects layer), `lightEffect` (lightning, glows,
  swarms, beams), `windModifier` (updrafts, downbursts, wakes, jet streams, slipstreams, lee waves,
  gust fronts, curtains) and `setPiece` (multi-stage timelines over other presets).
- Sky modifiers (`sky.addModifier`): weather and eclipses really change the sun light, sky, fog,
  clouds and stars; the golden-hour opening with clear weather is pixel-identical to before.
- Perf load shedders: under frame-time pressure the director defers heavy spawns and steps far
  spawns to cheaper LOD tiers before dynamic resolution drops.
- The F9 spawn debugger (dev builds, or `?dev=1` in a production build): presets with filters,
  force-spawn ahead, teleport to the nearest site, the time of day, the director's state, engine
  stats and the WindField overlay.

#### The event director and regional weather (Milestone C)

- The event director (`src/spawns/director.js`, 2 Hz on the flight clock): something notable within
  60-90 s of flight, activated ahead of the heading 3-8 km out and never behind; rarity periods
  (common every few minutes up to legendary every 1-2 hours), per-preset cooldowns, never the same
  preset twice in a row; at most 2 heavy spawns, per-engine caps and a real-light cap; filters for
  biome, time of day, altitude, weather, surface, distance and nearby landmarks; an activation log
  that is identical for the same seed and path.
- Regional weather (`src/spawns/weather.js`): clear, building, storm and clearing per 12 km region,
  deterministic per seed, with the sky and fog following it and the typed `weatherChanged` event.
  The first 150 s of every flight are clear, so the golden-hour opening never changes.
- `getNearby(radiusKm)` and the typed events `spawnActivated`, `spawnEnded`, `discovery` (for
  spawns), `achievement`, `journalStat` and `wildlifeQuiet`.

#### Spawn audio (Milestone D)

- Spatialised, distance-attenuated procedural voices on the environment bus with a budget of 10
  sounding voices: tornado roar and debris rattle, thunder delayed by distance / 343 m/s, volcano
  rumble and booms, geyser hiss, waterfall roar, whale and sky-whale song, the crystal hum and
  chimes, the turbine whoosh, the murmuration's wing rush, meteor sizzles, the lantern pad, hawk and
  eagle screams, honking geese, and the discovery chime.

#### The 30 presets (Milestone E)

- Weather and sky: tornado, supercell, waterspout, lenticular clouds, microburst, glory and
  full-circle rainbow.
- Volcanic and geo: erupting volcano, geyser field, slot canyon run, mega-waterfall.
- Ocean: whale pod, maelstrom, bioluminescent bay.
- Wildlife: starling murmuration, geese V-formation, thermal hawks, fireflies, eagle wingman.
- Structures: wind farm, rope bridge, abandoned airfield ("Start on ground" prefers the nearest
  discovered one).
- Night and celestial: meteor shower, total solar eclipse, comet, sky lantern festival.
- Fantasy: floating islands with landable tops, sky whale, crystal spires.
- Flight-play: jet stream ribbon.
- The legendary storm chase: a supercell builds, a tornado touches down, tracks and ropes out while
  WREN narrates; the journal keeps the closest pass.
- Twelve of them change the air you fly through, the storm chase does through its children, and
  the thermal hawks circle in real thermals; `docs/spawns.md` lists every preset with its engines,
  filters, rarity and wind.

#### The discovery loop (Milestone F)

- Discoveries: a chime and a glass card with the name and one-liner when a spawn is in range and in
  view; the journal records name, category, seed, coordinates, time of day and the first-seen date,
  and counts found / 30.
- Journal records and achievements, shared by every world: storms chased, closest tornado, best
  canyon run, best landing, V-Formation and Thread the Needle.
- WREN's tour guide: "what's nearby", "take me to the [name or category]", "find a thermal",
  "chase the storm" and "next discovery", with Guide chips in the command bar; proactive callouts
  ("Supercell building 9 km north-west. Want a heading?") at most once per 45 s, never below 150 m
  or while landing, and a "yes" that places the waypoint (setting `copilotCallouts`, on by default).
  The remote copilot's flight state gains `nearby[]`, `activeEvents[]`, `weather` and `callouts`,
  and the actions `nearby`, `goTo`, `findThermal`, `chaseStorm` and `nextDiscovery`.
- The world map (**M**, the bindable `mapToggle`): relief tiles generated in a worker from the
  shared height and biome functions and cached in IndexedDB, discovered sites as category icons,
  the craft, this flight's trail and the waypoint; click to set a waypoint. Undiscovered sites never
  appear.
- Seed links: `/?v=2#seed=XXXX&t=0.723` opens a world at a time of day in the launcher; Copy link
  buttons, a seed field in Settings that reloads into that world, and the current seed remembered.

#### Documentation and tools

- `docs/spawns.md`: the 30 presets with their engines, filters, rarity and wind, and copy-paste
  templates for a new event and a new site with every field documented.
- `docs/engines/*.md`: one reference page per engine.
- `tools/docs-check.mjs`: every relative link and anchor in the docs, the preset table against the
  preset files, the templates validated as presets, and every WindField source param in its
  engine page.
- Labs and step files for every engine, the director, the presets, audio, discovery and the tour
  guide (listed in `docs/architecture.md`, Testing).

#### Verification (Milestone G)

- `?test=spawns` (`npm run test:spawns`, `test:spawns:webgl`): each of the 30 presets is
  force-spawned ahead of the craft at a time of day and in weather that suit it (site presets on
  their nearest real placed site), its frame times recorded and a screenshot framed; disposing it
  must give back its GPU memory (with the geometry tracker), wind sources, real lights, sky
  modifiers and leak counters, and the JS heap must stay within 1 MB over three held create and
  dispose cycles after a warm-up.
- `?test=determinism` (`npm run test:determinism`, `test:determinism:webgl`): the same seed and
  scripted path flown in two page loads, stepped frame by frame from
  `spawns.debug.restartSpawns()`, must give identical site-list hashes and director activation
  logs.
- The 10-minute soak (`?test=1&testPlan=soak`, `npm run test:soak`, `test:soak:webgl`): the
  flight-test harness over 5 seeds, one craft each, first and third person, with the event director
  live; 0 NaN, 0 terrain penetrations, heap growth under 75 MB, p99 within the frame target and no
  frame over 50 ms after warmup.
- `?test=terrain&presets=real` (`npm run test:terrain:real`) now needs all six stamp types.
- `src/dev/spawnCheckKit.js`: one kit for the spawn checks (waits, held time of day and weather,
  photo framing, the dispose check), shared by the spawns test, the preset checks of presets 11-30
  and the structure step files.

### Changed

- **M** opens the world map; the microphone toggle moves to **Shift+M**.
- `docs/architecture.md` covers placement, stamps, the engines and the director, with one module
  table for `src/spawns/`; `docs/controls.md` and `docs/copilot-api.md` cover F9, the map, the
  Guide chips, callouts and seed links.
- The v1 clouds follow the sky modifiers: darker blue-grey undersides in a storm, dimmed by an
  eclipse, unchanged with nothing weighing in.

### Fixed

- The soft crash holds the craft at the surface of its contact point. A fast strike (about 250 m/s
  and up) could end its tick metres inside a steep slope, and the fade-in froze that pose under the
  ground; the craft is now lifted to the highest of the terrain, any extra ground surface above it
  and the sea at the strike, and held there on every fade-in frame.
- A strike during the soft crash's fade-out (a respawn facing a cliff) was ignored, so the craft
  flew on inside the ground for up to 0.4 s; it now starts a new soft crash that fades back to
  black from the current opacity.
- Director activations that spawn nothing are declined: when every engine of an activation ends
  at create (thermal hawks with no working thermal, a whale pod with no open water in reach), the
  SpawnManager refuses it with the reason `declined`, and the director counts no notable, cooldown
  or tier turn and tries the candidate again later.
- The sun disc no longer shows faintly through a storm's overcast; it fades out fully between
  overcast 0.6 and 0.85.
- The storm chase no longer grows a second storm tower at touchdown: its tornado child brings only
  a small dark turning lowering on the funnel instead of the tornado preset's own anvil, overshoot
  and rain.
- A slow terrain worker start is no longer reported as an error. On the dev server, with WebGL2
  compiling its shaders on the main thread, the workers could take longer than the 6 s of frame
  time the terrain waited, and it logged "terrain worker failed". The terrain now waits 30 s of wall
  clock (and at least 120 frames) from its first frame, then builds on the main thread with an info
  note only; a real worker failure is still reported as an error.
- At most 2 heavy spawns really run at once: an always-on heavy site (the floating islands) now
  holds a heavy slot while it exists, so the director no longer starts two heavy events beside it.
  A site with an active state (the volcano) still counts only while that state runs.
- The WindField's spatial hash drops a cell once its last source leaves it; moving sources
  (drifting weather, tornado tracks, slipstreams) left an empty bucket behind in every cell they
  crossed for the rest of the session.
- The celestial and weatherVolume engines run silently without an audio service instead of
  refusing their audio-owning presets. A spawn whose voice is refused at create (an unknown recipe)
  no longer leaves the celestial engine's sky modifier registered or the fauna engine's agent range
  allocated.
- A director disposed while shedding load puts the spawn LOD bias back to 1, so spawns no longer
  stay on their cheaper LOD tiers after the spawns system drops a failed director.
- WREN's tour guide forgets an event's callout key when the spawn ends, so the set no longer grows
  by one entry per called-out event.

### Known issues

- Rare-tier turns go to whichever eligible rare preset comes first, so the sky whale (anywhere, any
  time) wins most daytime turns and the volcano's eruption is rare: the pacing lab starts it once in
  54 simulated hours (18 scenarios of 3 h).
- The jet stream tube is straight; a glider entering its 38 m/s core abruptly can stall.
- The comet holds a heavy slot all night, and its declared lure does not draw (it is sky-anchored).
- The waterfall rainbow and the glory show only with the sun behind the viewer; the supercell's
  rain shafts are subtle at range.
- The spawn audio recipes are verified by measurement only; a listening pass is pending.

### Verification

Milestone G, run once per test on the merged tree on the project's shared Windows machine while
other projects' builds kept it busy (the owner's rule: frame-time numbers are reported, not chased).

- `npm run build` and `npm run build:single` succeed; V1's SHA-256 matches and no dev kit is in the
  bundle. `npm run test:v1` 2/2. `node tools/docs-check.mjs` 223/223.
- Labs: flight 82/82, jet 60/60, helicopter 46/46, fpv 87/87, wingsuit 37/37, input 34/34, settings
  28/28, storage 54/54, copilot 225/225, copilot-server 17/17, discovery 39/39, terrain 291/291,
  director 49/49 (stub) and 6/6 (real presets), preset-flight 13/13, preset-wind 12/12, spawns
  90/90, structure 68/68, setpiece 47/47, preset-pacing 4/4 (volcano eruption 1, tornado 4, comet
  20, sky whale 29, lantern festival 14), audio 191/191 (node and both browsers). wind-engines
  54/55: the vortex update allocated 0.556 B/frame, the known V8 tiering noise.
- `tools/spawn-check.mjs`: 55/55 on WebGPU and on WebGL2.
- The 24 dev-server step files (the ten engines, the three preset batches, discovery, the copilot
  guide, the director, weather and sky, input, hotplug, view physics, the terrain worker start and
  the golden frame) pass on both backends with 0 console errors and 0 warnings. The golden-frame
  A/B pair is identical on WebGPU; on WebGL2 1 pixel of 921,600 differs by 1 level.
  `seed-link.json` on the shell 7/7.
- `run-harness --test terrain`: PASS on both backends (0 cracks, 483 worker chunks identical,
  collision 0.00001 m, 21/21 poses, site-list hash 990ea5d1c3b00efe). With `--presets real`: PASS,
  6/6 stamp types, 555 chunks identical, collision 0.00003 m, hash 66961973cb983903.
- `run-harness --test determinism`: PASS on both backends with the same hashes (site list
  d85384433861a1b0 in both runs and a fresh world, director log 4 entries 1093b8c1, spawn events
  74d3d2fa, path 55b1a55f over 28.66 km).
- `run-harness --test spawns` (30 presets): PASS 30/30 on every criterion on both backends, 0/0
  console, 30 screenshots each; lowest average 71.6 fps (WebGPU) and 72.3 fps (WebGL2), worst p99
  34.3 ms and 28.8 ms.
- `run-harness --test soak` (10 minutes, 5 seeds, both views, the director live): every hard
  criterion passes on both backends (0 NaN, 0 penetrations, 0/0 console, heap growth at most
  25.68 MB on WebGPU and 22.7 MB on WebGL2, 10/10 runs, 32/32 scripts, director live 5/5, 0
  declined). The p99 criterion fails: worst p99 21.9 ms (WebGPU, average 96.2 fps) and 24.6 ms
  (WebGL2, average 90.1 fps) against the 16.67 ms target, and WebGL2 had 2 frames over 50 ms
  (59.2 ms main thread and 52.3 ms delayed; 0 game systems, 0 GC). 4 soft crashes per backend.
- Smokes of the built `dist-single/v2` and the shell on both backends: 0 errors and 0 warnings,
  screenshots differ.

## [Structure correction] - 2026-09-28

The structure correction, tagged `v2-structure`: DRIFTWING is two separate games behind one
toggle. V1 is the original game, frozen byte-for-byte; V2 is the new game, with real flight physics
only and free switching between first and third person. Phase 1's CLASSIC | SIM mode misread that
intent and is gone from V2.

### Added

- **V1, frozen**: `index.html` from tag `v1-final`, byte-for-byte at `public/v1/index.html`, with
  its own CDN import map and three.js. `tests/v1.sha256` and `npm run test:v1` fail on any change;
  `docs/v1-known-issues.md` records what V1 prints (nothing under normal conditions).
- **The launcher shell** at `/`: one full-window iframe and a glass **V1 | V2** pill that hides
  after 3 s and steers clear of both games' HUDs. A switch fades out, sends the old game to
  `about:blank` (freeing its GPU device, audio and gamepads), loads the other and focuses it.
  `/?v=1` and `/?v=2` open a game; the last one is remembered in `driftwing.shell.lastVersion`,
  and the first launch opens V2. Every other query parameter and the `#hash` (seed and room links)
  are forwarded to the game. The iframe allows `gamepad`, `microphone`, `camera`, `fullscreen`,
  `autoplay`, `xr-spatial-tracking`, `encrypted-media` and `clipboard-write`.
- **`versionToggle`**, a bindable action (F8, T.16000M base button 10, WREN's "switch to version
  one"): V2 asks the shell for V1 with a `postMessage` the shell accepts only from its own iframe,
  its own origin and the exact message shape. V1 switches with the pill.
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
- `tools/shell-test.mjs` (`npm run test:shell`): 20 round trips between the games against the dev
  server and `dist-single/`, one live game document after every switch, memory (JS heap, DOM
  counters, Chrome's GPU process) back to its first-load level, focus in the game, `/#seed=ABC`
  reaching V2, and foreign-origin messages ignored; a PASS / FAIL table and a JSON report.
  `tools/shell-check.mjs` checks the pill, persistence and forwarding.
- `tools/steps/view-physics.json`: flies every craft through the same scripted inputs from the
  cockpit, from chase and while switching views, and needs the same trajectory at every tick. It
  steps frames through the dev-only `DRIFTWING.debug` hooks (`pauseLoop`, `stepFrames`,
  `resetTiming`, `resumeLoop`).
- `tools/lab/settings.mjs` (settings migrations, the HOTAS assist default) and
  `tools/lab/copilot.mjs` (WREN's grammar and the `switchVersion` schema); the HOTAS harness checks
  the assist default across a reload.
- npm scripts `test:shell`, `test:flight`, `test:flight:webgl`, `test:hotas` and
  `test:hotas:webgl`.
- `tools/process-load.mjs`: the flight-test runner records other programs' CPU and GPU load
  against its own (Windows' per-process counters, the busiest programs named) for every run and at
  every frame over 50 ms, next to the whole machine's CPU and the GPU's utilisation, so a spike can
  be told apart as the game's or the shared machine's.

### Changed

- The Vite app moved to `/v2/` (`v2/index.html`); the root page is the launcher shell.
- All V2 storage is prefixed `driftwing-v2`: the IndexedDB database `driftwing-v2` and every key
  in it, the localStorage fallback and the dev harnesses' databases and session keys. V2 never
  reads or writes V1's keys. On first start V2 imports the Phase 1 database `driftwing` once (its
  settings without `mode`, bindings, calibration, audio and journals) and deletes it.
- The builds: `npm run build` writes `dist/` with the shell, `v1/index.html` (untouched) and
  `v2/index.html`; `npm run build:single` writes `dist-single/` with the shell and V2 as one
  self-contained file each, and V1 copied byte-for-byte with its SHA-256 checked.
- The flight-test harness flies every craft in first person and in third person on each seed
  (36 runs, where Phase 1 flew CLASSIC and SIM), checks the camera view every frame, and
  `tools/run-harness.mjs` gains `--views` and a table per craft and view. Each world now has a UI
  warmup before the warmup lap (every time of day, a toast leaving, the HUD fading and waking), so
  Chrome's first-use GPU program compiles for its rasterizer and compositor are not measured.
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

### Fixed

- Garbage-collection stalls in V2: three r184 allocated a `{ start, count }` range and a Map entry
  for every changed uniform of every render object, every frame, and V8 promoted 12-17 MB/s of
  them to the old generation, so a major GC ran every few seconds and its pauses were the flight
  test's frames over 50 ms. `src/render/uniformUploads.js` gives each uniform group one persistent
  whole-buffer range instead (promotion 1-3 MB/s, the frame rate up by a third on WebGPU and more
  than double on WebGL2).

### Verification

Run on the project's shared Windows machine while other projects' builds kept it busy (the
machine's CPU not used by the harness averaged 59-66 % over the flight tests).

- `npm run test:v1`: V1 matches `tests/v1.sha256`, also as copied into `dist-single/v1/`.
- Flight test, 36 runs of 60 s (six craft, first and third person, three seeds) per backend: 0 NaN
  events, 0 terrain penetrations, 0 console errors and 0 warnings, heap growth at most 26.9 MB
  (WebGPU) and 26.0 MB (WebGL2) per world, every scripted manoeuvre observed. Average 87.8 fps
  (WebGPU) and 93.9 fps (WebGL2), worst p99 26.7 ms and 28.6 ms.
- Frames over 50 ms after warmup: 11 of 189,683 on WebGPU (max 85.3 ms; 0 game systems, 3 GC,
  6 main thread, 2 delayed) and 7 of 202,946 on WebGL2 (max 65.9 ms; 0 game systems, 0 GC, 6 main
  thread, 1 delayed). None had game-system time in it. The machine's CPU not used by the harness
  was 74 % and 77 % at those frames, against 66 % and 59 % over the runs. Runs where it averaged
  70 % or more had 3-8 times as many of them as the others. Several of the frames follow a game
  event that reveals the HUD (the chute opening, the autopilot switching) or a major GC. Traced
  on the same machine in isolation, a HUD reveal's slowest frame was 18-38 ms and a major GC's
  pause 5-20 ms, so those frames passed the limit only while the shared machine was loaded. They
  are reported, not excluded, and the 50 ms limit is unchanged.
- `?test=hotas`: 140 of 140 checks on each backend, including persistence across a reload in the
  `driftwing-v2-test-hotas` database.
- Shell test, WebGPU and WebGL2, dev server and `dist-single/`: 30 of 30 checks each. After 20
  round trips every JS heap, document, node, listener and GPU-process reading was within its
  allowance of the first load.
- The verify loop: the shell at `127.0.0.1:<port>` (dev server and `dist-single/`) on both
  backends opens V2 in the chase view at golden hour, with two screenshots 4 s apart that differ
  and a clean console.

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
  the flight-test harness.

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

[Structure correction]: https://github.com/KyleBuildsAI/driftwing/tree/v2-structure
[2.0.0-phase.1]: https://github.com/KyleBuildsAI/driftwing/tree/v2-phase1
[1.0.0]: https://github.com/KyleBuildsAI/driftwing/releases/tag/v1.0.0
