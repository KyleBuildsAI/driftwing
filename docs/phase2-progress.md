# Phase 2 progress

Spec: [docs/specs/phase2.md](specs/phase2.md). Contracts: [docs/specs/phase2-contract.md](specs/phase2-contract.md).
Branch: `v2-phase2`, cut from tag `v2-structure`. Read this file first when resuming.

## Plan

| Wave | Work | Branches | Status |
| --- | --- | --- | --- |
| 1 | Milestone A placement and terrain stamps, Milestone B engine framework and F9 debugger, Milestone C director and regional weather, Milestone D spawn audio | `p2/placement`, `p2/framework`, `p2/director`, `p2/audio` | done |
| 2 | The ten engines: vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece | `p2/engines-*` | done |
| 3 | Milestone E presets 1-10, 11-20, 21-30 (verified and committed per batch) | `p2/presets-*` | done |
| 4 | Milestone F discovery loop: journal, copilot tour guide, world map, seed links | `p2/discovery`, `p2/copilot-guide` | done |
| 5 | Milestone G verification: ?test=spawns, ?test=determinism, ?test=terrain, 10-minute soak; docs/spawns.md with the preset template, architecture, controls, copilot API, CHANGELOG; review and fixes; tag `v2-phase2` | `p2/verify` | next |

## Decisions

- **No CLASSIC mode (the structure correction wins).** Spawns apply their full WindField forces in V2; the assists are the safety net. "Both modes" in the soak test means the first person and third person views.
- **Map key.** M opens the world map (mapToggle). The mic toggle moves to Shift+M.
- **Machine load (owner's rule).** Ignore PC load entirely: never wait for quiet, never build load tooling, never chase spikes the busy machine causes. Run each test once and report its numbers. Correctness criteria still hold.
- **One director name.** `createGameDirector(ctx, options)` (src/spawns/director.js) wires the director to the game; `createDirector(options)` is its headless core for the lab. The spawns system creates the game director itself when it starts and exposes it as `ctx.systems.spawns.director`; there is no `attachDirector`.
- **The director ticks itself.** The spawns system calls `director.update()` every frame and the director ticks at 2 Hz on the flight clock (`DIRECTOR_TICK_SECONDS`), so its activation log depends only on the seed and the flown path.
- **One budget view.** The SpawnManager's `budgets` (heavy limit 2, real-light cap 4, per-engine caps from `engine.budget`, else `DIRECTOR_BUDGETS.engines`) is both the engines' `ctx.budgets` and the director's budgets.
- **Dev presets bypass the director.** `spawns.forceSpawn` goes through `director.forceSpawn` for the director's own presets (`PRESETS`), and straight through the manager for presets added with `debug.addPreset`, so dev test presets are never scheduled by the director.
- **Shedding only when it helps.** The director's load shedder refuses a level with nothing to take away (no heavy candidates and no live spawns), so with no content the governor behaves exactly as in Phase 1.

## Done

- Branch `v2-phase2` created from `v2-structure`; the owner specs and the Phase 2 contracts are in docs/specs/.
- **Wave 1 merged** (each with `git merge --no-ff`):
  - `f524f20` chore: merge placement and terrain stamps (Milestone A)
  - `19f1f4c` chore: merge spawn audio (Milestone D)
  - `0657a32` chore: merge spawn engine framework and f9 debugger (Milestone B)
  - `2d6c16e` chore: merge event director and regional weather (Milestone C)
  - Conflicts resolved: one `weatherChanged` in src/core/events.js (`state` and `previous` enums, `region` the string `"rx:rz"`; the weather system never emits `previous: null`), the framework's spawn and achievement events kept; src/main.js keeps the terrain dev test and world options, `SPAWN_ENGINE_FACTORIES`, and the weather, spawns and spawnDebugger factories and update order; src/spawns/presets/index.js; docs/architecture.md.
- **Wave 1 wiring:**
  - `36fda6e` feat: the SpawnManager honours the director's `opts.duration`, gains `setLodBias(bias)` / `getLodBias()` / `spawnCount()`, and exposes the shared budget view.
  - `e13c93d` feat: the spawns system creates and drives the director (placement feed, discovered check, budgets, `getNearby` for the copilot).
  - `ad3ad89` feat: the F9 debugger's Director section shows the real `getState()` and `getNearby()`.
  - `7d4956f` test: tools/steps/director-game.json runs beside the live director.
  - `5642867` docs: architecture for the wiring.
  - Already joined by the merges: the placement feed reaches the manager as `world.placement`; a typed `discovery` with a `presetId` plays the audio discovery chime (once).
- **Verified on the integrated tree:**
  - `npm run build`, `npm run build:single` (V1 SHA-256 matches; no dev test kit or fixtures in the bundle), `npm run test:v1` 2/2.
  - Labs: flight 82/82, fpv 87/87, helicopter 46/46, jet 57/57, wingsuit 37/37, input 34/34, settings 28/28, storage 54/54, copilot 56/56, copilot-server 8/8, terrain 162/162, spawns 88/88, director 47/47 (24 h), audio 177/177 on both backends.
  - `tools/spawn-check.mjs` 53/53 on WebGPU and WebGL2.
  - `node tools/run-harness.mjs --test terrain`: PASS on both backends (0 cracks, 483 worker chunks identical, collision 0.00001 m, 0/0 console, site-list hash 990ea5d1c3b00efe).
  - Reduced flight harness (seeds INTEG-A and INTEG-B, glider and jet, both views, 45 s): hard criteria pass on both backends (0 NaN, 0 penetrations, 0/0 console, heap growth at most 21.3 MB, 24/24 scripted checks). Frames over 50 ms: 8 on WebGPU and 3 on WebGL2, every one main-thread work with 0 systems time and 0 GC, while 43-90 % of the machine's CPU was other processes'.
  - Smokes, 0 errors and 0 warnings: built V2 and the shell on both backends, built V2 with `?dev=1` (the director in the F9 panel), the dev server's weather-sky and director-game steps on both backends.
  - Live director check on the dev server, both backends: the test engines through the dev hook, the F9 Spawn button and `forceSpawn` fire `spawnActivated`, the End buttons fire `spawnEnded`, `getState()` ticks at 2 Hz on the flight clock, the shedder drives the manager's LOD bias (1, 0.7, 0.5 and back), the weather state machine follows clear -> building -> storm -> clearing at the player and forced states emit `weatherChanged` with the `"rx:rz"` region.

## Done (Milestone F)

- Discovery loop merged from `p2/discovery`:
  - the journal records spawn discoveries and journalStat/achievement records;
  - the glass discovery card;
  - the world map on M, with worker map tiles (src/world/mapTileGen.js and mapTiles.worker.js, reusable for Phase 3's far field);
  - seed links (`/?v=2#seed=X&t=`), the seed setting and Copy link;
  - the mic moved to Shift+M.
- Copilot tour guide merged from `p2/copilot-guide`:
  - src/copilot/tourGuide.js: nearby, go-to, find a thermal, chase the storm and next discovery;
  - proactive callouts, with the setting copilotCallouts;
  - remote flightState nearby[] and activeEvents[];
  - docs/copilot-api.md.
- Verified on the merged tree: labs discovery 39/39, copilot 225/225, settings, input, storage, spawns and director all pass; build:single; built V2 smoke on WebGPU and WebGL2 with 0 errors and 0 warnings.

## Done (wave 2: the ten engines, Milestone B)

- **Merged** into `v2-phase2` in this order, each with `git merge --no-ff`:
  - `8170e35` chore: merge the vortex and windModifier engines (Milestone B)
  - `84fbbc9` chore: merge the emitter and lightEffect engines (Milestone B)
  - `b0fb587` chore: merge the weatherVolume and celestial engines (Milestone B)
  - `4594d13` chore: merge the fauna and waterEffect engines (Milestone B)
  - `a07cc73` chore: merge the structure and setPiece engines (Milestone B)
  - Conflicts were resolved so that both sides survive:
    - src/main.js: one import and one `SPAWN_ENGINE_FACTORIES` line per engine, in ENGINE_NAMES order (vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece).
    - src/spawns/spawnManager.js: four branches had each added `registerPrewarm`. One is kept (a function or null), next to `water`, `surfaces` and `weatherState`.
    - src/core/events.js: both `journalStat` and `wildlifeQuiet` are kept.
    - tools/spawn-check.mjs: the stricter debugger row check is kept (one row per engine). A new check confirms that the ten game engines are registered once each, in ENGINE_NAMES order.
    - docs/architecture.md: every engine row, section and test row is kept. Duplicates are folded together: the sky modifier priorities, the engine ctx paragraph and the achievement event row.
  - sky.js, clouds.js, the audio hooks and the copilot hooks merged without conflicts.
- **Wiring** (committed on `v2-phase2`):
  - `7b55af8` feat: the fauna engine honours `wildlifeQuiet`. While any source holds it, the fauna make no calls, breach calls or scatter cries, and their voice is eased out. `stats().quiet` reports the state.
  - `b8df207` refactor: each shared engine helper now has one implementation, in `src/spawns/engines/engineKit.js`:
    - `createWindSample`, used by every engine's wind source (windSources.js, weatherVolume, structure and fauna);
    - the param readers: `params.js` is folded into engineKit as `createParamView` (reads by name), built on `createParamReader` (reads by value). Every engine that uses them reports a bad param as `[DRIFTWING] <engine> preset "<id>": param "<path>" <problem>`;
    - `roll` and `rollInteger`, plus `smoothstep` for windSources.js.
  - `66340d1` feat: a vortex over open water writes a foam and excitation trail into the water effects layer every 0.25 s. A waterspout therefore leaves a wake, which glows in a bioluminescent bay.
  - `8e9af26` docs: the engine factories register once each, in ENGINE_NAMES order.
  - `243a4d8` feat: one voice per preset, through engineKit's `ownsPresetAudio`. An entry's `voice`, `sound` or `ownsAudio` flag decides. Without a flag, the preset's first engine entry opens `preset.audio`. Before this change, five engines opened the voice by default and the waterEffect engine never did.
  - `4bbebb3` fix: the terrain fixture volcano and waterfall carried emitter params from before the engine existed (`kind`). The real emitter refused them, which failed ?test=sites.
  - `64b3207` test: spawn-check now waits for the GPU counters to settle before taking its memory baseline. Terrain chunks that landed during cycle 1 were read as a leak on WebGPU.
  - `f007d6c` test: the sites checks expect all six fixtures, now that the emitter is registered.
- **Verified on the integrated tree** (each test run once, per the owner's rule):
  - `npm run build` and `npm run build:single` succeed. The V1 SHA-256 matches, and no dev kit is in the bundle. `npm run test:v1` passes 2/2.
  - Labs:
    - flight 82/82, fpv 87/87, helicopter 46/46, jet 57/57, wingsuit 37/37;
    - input 34/34, settings 28/28, storage 54/54, copilot 225/225, copilot-server 17/17, discovery 39/39;
    - terrain 162/162, spawns 88/88, director 47/47;
    - structure 67/67, setpiece 47/47, wind-engines 55/55;
    - audio 177/177 on both backends.
  - `tools/spawn-check.mjs`: 55/55 on WebGPU and 55/55 on WebGL2. The first run, before `64b3207`, gave 52/54 on WebGPU (cycle 1 memory) and 54/54 on WebGL2.
  - Every engine step file ran on both backends against a dev server on port 5263, with 0 errors and 0 warnings each time:
    - vortex 9, windModifier 9, emitter 13, lightEffect 13, weatherVolume 19 and celestial 11 checks;
    - fauna 11 (`seed=ENGINEFAUNA`) and waterEffect 9 (`seed=ENGINEWATER`);
    - structure 20; structure-sites 9/9 (`test=sites`, passing after `4bbebb3` and `f007d6c`); setPiece 10/10.
  - An integration step file (kept in the scratchpad, not in the repo) passed 4/4 on both backends. It checks three things:
    - the waterspout writes its wake into the water layer;
    - the fauna fall quiet while `wildlifeQuiet` holds;
    - the wind sources return to baseline after dispose.
  - `node tools/run-harness.mjs --test terrain`: PASS on both backends. 0 cracks, 483 worker chunks identical, collision 0.00001 m, 0/0 console, site-list hash 990ea5d1c3b00efe.
  - Reduced flight harness (INTEG-A and INTEG-B, glider and jet, both views, 45 s), on both backends:
    - Passed: 0 NaN, 0/0 console, scripts 24/24, 0 frames over 50 ms, and heap growth of at most 22.7 MB (WebGPU) and 22.1 MB (WebGL2).
    - Failed: one penetration on each backend, both in the same run (see Open issues).
  - Smokes of built V2 and of the shell on both backends: 0 errors and 0 warnings.

## Done (wave 3: the 30 presets, Milestone E)

- **Merged** into `v2-phase2` in this order, each with `git merge --no-ff`:
  - `9d1b348` feat: merge spawn presets 1-10 (Milestone E batch 1): tornado, supercell, waterspout, lenticular, microburst, glory, volcano, geyserField, slotCanyon, megaWaterfall.
  - `83da9c0` feat: merge spawn presets 11-20 (Milestone E batch 2): whalePod, maelstrom, bioluminescentBay, starlingMurmuration, geeseFormation, thermalHawks, fireflies, eagleWingman, windFarm, ropeBridge.
  - `4aba4c1` feat: merge spawn presets 21-30 (Milestone E batch 3): abandonedAirfield, meteorShower, totalSolarEclipse, comet, skyLanternFestival, floatingIslands, skyWhale, crystalSpires, jetStream, stormChase.
- **Conflicts resolved** so that every preset and every engine extension survives, with one implementation of each:
  - src/spawns/presets/index.js: all 30 imports and entries in spec order (1-30), under one comment per batch. `validatePresets(PRESETS)` passes.
  - src/spawns/engines/faunaEngine.js: batches 2 and 3 had each added `fadeOut`. One implementation is kept (`endWithDuration`, batch 2): default 6 s, an event fades out over its last `fadeOut` seconds and ends at its duration, and a wingman ends this way only while it is still waiting. Batch 3's range check (0..600 s) is kept. docs/engines/fauna.md has one merged row.
  - src/dev/presetChecks.js: both batches had added a kit under this name, with different APIs. Batch 3's kit stays at `presetChecks.js` (tools/steps/presets-21-30.json). Batch 2's kit moved to `src/dev/presetChecksBatch2.js` (tools/steps/presets-batch2.json now imports it). Both install `window.__dwPresets`; only one is installed per run.
  - tools/lab/terrain.mjs: all three batches had retargeted the phase1 test. Batch 2's version is kept. It covers both other versions: Phase 1 digests with no site presets, bit-identity outside every real stamp, and the placement, determinism, shape, falloff, paint, seam and collision checks around every stamped real preset.
  - tools/lab/director.mjs: `--presets stub|real`. The `mixed` mode and its guessed `STUB_REAL_IDS` are dropped, since all 30 real presets now exist. Real mode runs batch 2's real-sites pacing and batch 3's per-preset report; stub mode adds batch 3's `near` filter check.
  - tools/lab/discovery.mjs, docs/architecture.md and docs/engines/*.md: both sides kept. Every merged test, kit and step file has a row.
- **Wiring** (committed on `v2-phase2`):
  - `5712503` fix: the storm chase's children send no journal stats of their own (`journal: []` on the supercell's weatherVolume and the tornado's vortex). The set piece alone sends `closestTornado` and `stormsChased`, so a chase counts once.
  - `6def090` and `73b992e` test: the director and preset pacing labs pass `landmarkSitesNear` to the director as the game does. Without it the sky lantern festival (`filters.near`) never activated in the labs.
  - `a5d7955` test: the new dev hooks `spawns.debug.holdGamePresets()` / `releaseGamePresets()` take the game's own presets out of the manager and put them back. Every engine step file holds them, so it runs its test presets in an empty game. With the real presets, live sites and director events had broken the engine files' baselines (instances, wind sources, the glory uniforms).
  - `9964c9d` test: presets-21-30's dispose check counts only wind sources added since the create. A live site's source that went away during the check failed floatingIslands, jetStream and stormChase before this fix.
  - `bb8a518` test: `run-harness.mjs --test terrain --presets real` defaults to seed `TERRAIN-REAL-8`. That world has every real stamp type within 40 km of its spawn. P2-TERRAIN has no volcano cone in range, which failed 5/6 types.
  - `12e2d92` and `e27903c` test: the audio lab's browser part holds the game presets, and so do discovery.json and copilot-guide.json. The copilot guide step also waits out the 45 s callout gap of a game callout made before the hold.
- **Verified on the integrated tree** (each test run once, per the owner's rule):
  - `npm run build` and `npm run build:single` succeed. The V1 SHA-256 matches, and no dev kit is in the bundle (`__dwPresets`, `installPresetChecks`, `testMarker`, `terrainFixtures`: 0 each). `npm run test:v1` passes 2/2.
  - Labs:
    - flight 82/82, fpv 87/87, helicopter 46/46, jet 57/57, wingsuit 37/37;
    - input 34/34, settings 28/28, storage 54/54, copilot 225/225, copilot-server 17/17, discovery 39/39;
    - terrain 291/291, spawns 88/88, structure 68/68, setpiece 47/47;
    - director 49/49 (stub);
    - preset-flight 13/13, preset-wind 12/12;
    - audio 191/191 on both backends (the first run, before `12e2d92`, gave 182/189).
  - Labs that failed:
    - wind-engines 54/55: vortex `advanceStage` allocated 0.638 B/frame. Milestone E does not touch that code; the same tiering noise is in Open issues.
    - preset-pacing 3/4 in its default 3 h: the volcano's eruption never started (see Open issues). With `--hours 6` it passes 4/4, with 1 eruption.
  - Pacing with the real presets (`director.mjs --presets real`, 6/6):
    - first notable at 65.5-69.5 s;
    - with no sites, droughts that end within 90 s: glider 100 %, bush plane 98.1 % (longest 107.5 s), jet 100 %;
    - with the real sites (6 h, bush plane): 100 %, with every common and the lantern festival activating.
  - `tools/spawn-check.mjs`: 55/55 on WebGPU and 55/55 on WebGL2.
  - Step files on a dev server on port 5263, on both backends, with 0 errors and 0 warnings:
    - presets-batch1 58/58 (`seed=DRIFTWING`) and presets-batch2 30/30 (`seed=HARNESS-1`);
    - presets-21-30 50/50, after `9964c9d` (47/50 and 49/50 before it);
    - vortex 9, windModifier 9, emitter 13, lightEffect 13, weatherVolume 19, celestial 11;
    - fauna 24 checks (`seed=ENGINEFAUNA`) and waterEffect 18 checks (`seed=ENGINEWATER`);
    - structure 20/20, structure-sites 9/9 (`test=sites`), setPiece 10/10.
    - Before `a5d7955`, windModifier, emitter, lightEffect, celestial (WebGPU), fauna and waterEffect had failed.
  - Other step files:
    - director-game and weather-sky passed on WebGPU, with 0/0 console.
    - seed-link passed 7/7 on the shell (`/?v=2#seed=LINKTEST&t=0.300`).
    - copilot-guide passed on both backends after `e27903c`.
    - discovery passed on WebGPU with no failed check. On WebGL2 it failed 1 check (the chime sample; see Open issues).
  - `node tools/run-harness.mjs --test terrain`, on both backends:
    - fixtures: PASS, site-list hash 990ea5d1c3b00efe (unchanged);
    - `--presets real` (TERRAIN-REAL-8): PASS with 6/6 stamp types, 0 cracks, 555 worker chunks identical, collision 0.00003 m, every LOD seen for every type, 0/0 console. Site-list hash 66961973cb983903.
  - Reduced flight harness (INTEG-A and INTEG-B, glider and jet, both views, 45 s) with the director live on the real presets:
    - hard criteria pass on both backends: 0 NaN, 0 penetrations, 0/0 console, scripts 24/24;
    - heap growth at most 24.03 MB (WebGPU) and 21.67 MB (WebGL2);
    - soft crashes: 0 on WebGPU, 2 on WebGL2 (jet);
    - frames over 50 ms: 1 on WebGPU (110.4 ms) and 5 on WebGL2 (up to 700.7 ms). Each had 0 systems time and 0 GC (4 main thread, 1 delayed), so the harness marks those runs FAIL. They are reported, not investigated.
    - The wave 2 jet penetration did not recur.
  - Smokes of built V2 and of the shell on WebGPU and WebGL2: 0 errors and 0 warnings, and the screenshots differ.

## Current state (resume from here)

- `v2-phase2` holds Phase 1 and Milestones A, B (all ten engines), C, D, E (all 30 presets) and F. All wave 3 work is merged and committed locally. Nothing is pushed; the owner pushes.
- These branches and worktrees can be removed once the owner is happy with them:
  - the three `p2/presets-*` branches and their `.claude/worktrees/p2-b*` worktrees;
  - the five `p2/engines-*` branches and their `.claude/worktrees/p2-e-*` worktrees.
  - Unlink each worktree's node_modules junction first.
- **Next: Milestone G** (branch `p2/verify`):
  - ?test=spawns, ?test=determinism and ?test=terrain. The preset kits are a start for ?test=spawns: src/dev/presetChecks.js (21-30), src/dev/presetChecksBatch2.js (11-20) and the inline checks of tools/steps/presets-batch1.json. Fold them into one generic kit.
  - the 10-minute soak (5 seeds, both views) and the full 36-run flight harness matrix;
  - docs/spawns.md with the preset template, plus the architecture, controls and copilot docs and the CHANGELOG;
  - a review round with fixes (Open issues below), then the `v2-phase2` tag.
- Then Phase 3 (docs/specs/phase3.md, with its own docs/phase3-progress.md), then Phase 4.
- References for preset work:
  - docs/engines/<name>.md, the reference for every param;
  - the preset authoring notes below;
  - docs/specs/phase2-engine-api.md.

**Contract additions from wave 3** (all additive and documented in docs/engines/ and docs/architecture.md):
- **Schema:**
  - `activeState: { duration }` (sites), `cooldown`, and `anchor: { seek: 'peak', radius, align: 'downwind' }` (events);
  - `filters.near: { landmarks: [arch | monoliths | lighthouse | balloons], radius <= 20000 }`, with `LANDMARK_TYPES`;
  - the time-of-day classes `midday` (sun at least 14 degrees up) and `golden` (-3 to 14 degrees, now matched).
- **SpawnManager:**
  - an `activeState` site starts dormant (`instance.active = false`, lure hidden) until `setSiteActive(id, true)`;
  - `preset.anchor` is applied at activation;
  - `setPartLOD` keeps the particle count in step (the particle budget drift fix);
  - **site hours:** a site preset with `filters.timeOfDay` exists only in those hours. It is removed with reason `hours` once it has been out of view. Only the bioluminescent bay uses it.
- **Director:**
  - `filters.near` moves a candidate onto a landmark, or rejects it as `near`;
  - `createGameDirector` passes `terrain.landmarkSitesNear`, and a headless director needs it too.
- **engineKit:** `createApproachJournal(label, spec)`, used by the vortex and weatherVolume `journal` param.
- **Engines:**
  - emitter: `snapToGround`. A `windSource` stands under anchor + `offset`.
  - structure: the `waterfall` recipe (cliffStep); `gates` `corridor` / `river` / `riverWidth`; a teleport spoils a course; windFarm `wake.gust`.
  - fauna:
    - `fadeOut` (default 6 s);
    - `altitude.mode 'player'` with `altitude.ceiling`;
    - `pod.seekWater`;
    - `circling.requireThermal`.
  - waterEffect: `splash.waterOnly`.
  - celestial: `untilDawn` and `dawnElevation`.
  - weatherVolume: `instance.control.wallCloud`.
- **Audio:** the `raptor` and `goose` recipes (trigger `call`).
- **Dev hooks:**
  - `spawns.debug.holdGamePresets()` / `releaseGamePresets()`;
  - `?test=terrain&presets=real`;
  - `createBrowserHelpers` (structureTestKit);
  - geometryTracker entries carry `uuid`.

**Preset authoring notes (contract additions from wave 2):**
- **How an engines entry reaches create().** The entry `{ engine, params }` arrives as `engine.create(preset, params, rng)`. The `params` object is built in three layers:
  - the entry's own params;
  - then the overrides from `activate(..., { params: { [engine]: overrides } })` (a set piece child's `params`);
  - then the activation fields: `position` (a new Vector3), `heading`, `site`, `startTime`, `scale`, `duration` and `seed`.
- Each entry gets its own seeded rng.
- Strict engines refuse an unknown param and name it: vortex, windModifier, emitter, lightEffect, structure and setPiece.
- **Renamed wind params.** An updraft's speed is `updraft` (not `strength`), and a slipstream's lane start is `behind` (not `offset`). The emitter's own `windSource` block is separate and keeps its own names: its updraft speed is still `strength`.
- **One voice per preset.** On a multi-engine preset, set `voice`, `sound` or `ownsAudio` explicitly when the first entry should not own `preset.audio`.
- **Live control for set pieces:**
  - vortex: `instance.control.{ intensity, ropeOut }`;
  - windModifier: `control.{ strength, strengths[i] }`;
  - structure: `instance.params.{ glow, sway, rotorSpeed, audio }` and `setParam`.
- **Events:**
  - typed `wildlifeQuiet { source, quiet }`, emitted by the celestial eclipse; the v1 birds, the audio cues and the fauna listen;
  - `fauna:formation`, `fauna:scatter` and `fauna:call`;
  - `structure:gate`, `structure:course` and `structure:landing`;
  - `setPiece:stage`, `setPiece:narrate` and `setPiece:ended`;
  - typed `achievement` and `journalStat`, with the journal keys `stormsChased`, `closestTornado` and `bestCanyonRun`.
- **Engine ctx additions:**
  - `registerPrewarm` (or null);
  - `water`: the water effects layer, or null;
  - `surfaces`: the extra ground surfaces;
  - `weatherState()`: call it at create only.
- **Sky and cloud additions:**
  - the uniforms `cloudGlory` and `cloudBow`, and `sky.getModifierLevels()`;
  - the sky modifier priorities: weather 10, weatherVolume 15, emitter immersion 20, lightning flash 30, eclipse 30.
- **Other APIs:**
  - `spawns.findGroundStart(x, z)` and the optional engine hook `groundStart(preset, params, site)`;
  - `structureStamps(recipe, options)`, which builds preset stamps that are safe in the terrain worker;
  - `createGateSet` and `crossGates`, in src/spawns/engines/gateDetector.js.

**Standing rules:**
- The structure correction is the source of truth (no CLASSIC mode in V2).
- Ignore PC load entirely: run each test once and report its numbers.
- Before any `git worktree remove`, unlink the worktree's node_modules junction first.
- Push with full refspecs (`refs/heads/...`), because branch and tag names repeat.
- Never edit source files while a browser run is using the dev server: Vite reloads the page in the middle of the run.
- Agents share one scratchpad: give every smoke or harness run its own `--out` directory.
- Engine and dev step files run in an empty game: hold the game's presets first (`spawns.debug.holdGamePresets()`), or count only the spawns the check made.

## Open issues

- **Wave 3 (presets) issues, for Milestone G:**
  - **Rare-tier balance.** With all 30 presets, preset-pacing's default 3 h run starts the volcano eruption 0 times across 18 scenarios, against 16 times with batch 1 alone. A 6 h run starts it once. The tornado fell from 28 activations to 1.
    - The sky lantern festival takes most rare slots (41). Its candidates are moved onto landmarks ahead, which gives them high ahead scores.
    - Review the rare candidates' density and scoring, or the lantern cooldown, then re-run `node tools/lab/preset-pacing.mjs`.
  - **The storm chase's look with the real children.** The real `tornado` preset brings its own storm tower (weatherVolume with an anvil, wall cloud and rain), placed 800 m from the supercell's centre. Inside a storm chase that may read as a second tower growing at touchdown (formSeconds 20).
    - Child params can only override, not drop an entry. Consider a tornado child override that shrinks its tower, or a funnel-only variant.
    - In the integration run, the touchdown screenshot on WebGPU had the funnel hidden behind a ridge (seed E29ZR4), as batch 3 also saw.
  - **One preset check kit.** presetChecks.js (21-30) and presetChecksBatch2.js (11-20) are two kits with different APIs, and batch 1's checks are inline in its step file. Fold them into one generic kit for ?test=spawns.
  - **discovery.json on WebGL2:** "the discovery chime played" saw 0 one-shot nodes. The discoveries had already fired when the 6 s sampling window began. It passes on WebGPU (110 nodes). This step file was run on WebGPU only before.
  - The jet stream tube is straight (bend 0), so its wisps line up with the air. A seeded meander cannot be matched by an emitter shape yet.
  - A 38 m/s jet stream core can stall a 30 m/s glider that enters it abruptly, as real shear would. Joining through the taper or across the edge is gentle.
  - The comet holds a heavy slot for the rest of the night. Its declared lure only draws at the FAR tier, which a sky-anchored spawn does not reach.
  - The thermal hawks: an activation that finds no working thermal ends at once, but it still counts as a notable for pacing.
  - The meteor shower and the eclipse use `discovery.requireInView: false`, so they are discovered as soon as they start.
  - The waterspout is mild for the glider: peak vertical speed 3.1 m/s against 2.0 m/s in calm air. The spec asks for it to be milder than the tornado.
  - The maelstrom's pull is modest in the SIM rig: 700 m abeam, drift goes from -23 to -53 m.
  - The jet barely feels the wind farm wakes at 220 m/s.
  - The waterfall rainbow and the glory show only with the sun behind the viewer. The supercell's rain shafts are subtle from a distance.
  - The canyon checks carry the craft in 30 m steps, so they prove the timing rules, not a flyable route.
  - The new raptor and goose recipes are verified by measurement only. A listening pass by Kyle is worthwhile.
  - Spawns lab allocation checks (batch 1) and the wind-engines vortex allocation check fail now and then from V8 tiering noise. This run: spawns 88/88; wind-engines 54/55 (`advanceStage`, 0.638 B/frame).
- **Wave 2 reports, for the preset wave and Milestone G:**
  - Emitter on WebGPU: its frame update measured 0.5-5.4 B/frame across runs; WebGL2 measured 0-0.2. This looks like V8 re-optimisation.
    - tools/engine-alloc.mjs's pass limit went from 0.1 to 1 B/frame. That is a change of policy, and the lead should review it.
    - Event paths (a strike, bursts, eruption triggers, wind-grid probes, voice levels) allocate a few hundred bytes per event before V8 optimises them. They are reported separately (`--events`).
  - Water effects layer on WebGPU: 0.098 heap samples per frame against the 0.1 limit, all from splash events.
  - Allocations in shared code outside the engines:
    - each WindField terrain probe allocates about 10 KB in worldgen's noise (the emitter rations its probes to about 2 KB/frame);
    - the fauna's terrain queries allocate about 345 B/frame;
    - the WindField allocates about 184 B per 3 samples with sources present, against 146 B in calm air;
    - three's compute dispatch allocates 0.3-0.65 KB/frame on WebGPU;
    - sky.js `set()` allocates about 12 B/frame while a flash or an immersion eases.
  - In the running game, a fractional number written to a THREE.Vector3, a Color or a shared `{ x, y, z }` literal is boxed. engineKit's `createWindSample` and typed arrays avoid it, and new engine code must as well.
  - Fauna cost: an 8000-starling murmuration costs 6-7 ms of engine CPU per frame. Use 2500-4000 starlings per preset.
  - Per-instance GPU frame time cannot be measured headless (vsync-paced frames on the busy machine). The engine docs give draw calls and triangles instead.
  - The engine audio (the tornado and turbine voices, the cockpit rattle, thunder, the whale calls) is verified by measured levels only. A listening pass by Kyle is worthwhile.
  - The node labs' allocation checks measure node's tiering, not Chrome's. A Float64Array value passed to a call V8 does not inline gets boxed. The set-piece lab catches this about half the time, and every time with `--no-maglev`.
  - The vortex, windModifier, weatherVolume, celestial, fauna and waterEffect engines still validate params with their own local readers, so their message wording differs slightly from the engineKit format. Folding them into `createParamView` is a Milestone G cleanup. Every one of them names the field.
  - Dev fixtures: spawnTestKit's testUpdraft and terrainFixtures' `wind` entries use `strength` / `speed`. No windModifier part reads them, so nothing refuses them today.
  - The in-game waterspout check forces `surface: 'water'` over the test seed's mountains. The wake check (scratchpad) proved the write path, and the lab covers the land and water blend.
  - The debug airfield without a flatten stamp can extend over water. Real airfield presets use the stamp.
  - spawn-check on WebGPU needed the settle wait (`64b3207`). Its first cycle saw 6 late geometries (terrain chunks) before it.

- **Storm clouds.** Since wave 2 the v1 cloud field follows the sky modifiers (`cloudShading.js`): darker blue-grey undersides in a storm and dimmed by an eclipse. Storm cloud masses come from the weatherVolume engine. A very faint sun disc (about 1 %) can still show under storm overcast.
- **First query of a stamped cell** resolves placement once (3-10 ms on the loaded machine), in the worker for chunks and on the main thread for the first collision query there.
- **Real lights cost shading while they exist.** The light pool holds only the lights engines declare (`budget.lights`, capped at 4). Meshes on shared materials must be pooled (`createMeshPool` / `createInstancedPool`), or three r184 keeps each disposed mesh alive (about 8 KB each).
- **Occlusion rays allocate a little** (worldgen noise, 0.02-0.03 B/frame after warm-up); the spawn code itself measures about 0.02 B/frame.
- **Audio recipes are verified by measurement only**, not by listening; a listening pass by Kyle is worthwhile. Inverse-law recipes stay above the audibility floor to about 60 km (presets cull at lod.far). V8 boxes doubles passed to AudioParams (about 40-60 KB/s with 10 voices), which code cannot avoid.
- **The audio lab's trigger-dynamics check is randomised.** The thunder strike uses `Math.random`, so "thunder trigger stands out" (> 6 dB) measured 5.7 dB once on WebGPU during integration and 7.7-9.5 dB in the three runs after it. Seeding the recipe randomness for offline renders would make it deterministic.
- **Lure silhouettes** were tuned on the test presets. The real heavy presets have their lures now (the supercell's anvil was checked at 36 km, the volcano's plume with its eruption); compare the others (funnel, whale, islands, comet) against horizon screenshots.
- **performance.memory** heap figures exist only in Chrome and are coarse.
- **Golden-frame comparisons across runs** are not pixel-exact (vegetation sway, birds, cloud drift); the exact proof is the same-frame A/B in tools/steps/golden-frame.json.
- **Full harness matrix.** Only reduced flight harnesses were run in waves 1 to 3. The full 36-run matrix is for Milestone G.
- **Penetration at a high-speed terrain strike (hard criterion; for Milestone G).** In the wave 2 integration harness, the same run failed on both backends: INTEG-A, jet, first person, run 4 of 8.
  - It did not recur in the wave 3 integration harness: 0 penetrations on both backends, with the director live on the real presets. The jet had 2 soft crashes on WebGL2.
  - The scripted jet hit terrain at about 44.5 s and 286 m/s, and the soft crash fired.
  - At that strike it penetrated 8.96 m (WebGPU) and 13.56 m (WebGL2), for 37 frames each.
  - The same run flown alone passed with no crash.
  - The wave 2 base (478cda7, the same harness and seeds, WebGPU) had no penetration. Its jet crashed softly at 226-227 m/s in runs 3 and 7.
  - The engine branches change nothing in flight while no spawn and no extra ground surface exists. The harness flies no spawns, and a same-seed frame comparison of base and integrated builds is identical (233 against 234 draw calls, 181 fps).
  - The flown path depends on the run order and the frame timing. The p2/engines-structure-setpiece engineer reproduced the same class of penetration on the base (STRUCT-A, jet, third person, 250 m/s, 1.21 m deep).
  - The Phase 1 contact code lets a strike above about 250 m/s sink in before the soft crash takes over. That belongs to the flight-model or harness owner, in the Milestone G matrix.
  - Other soft crashes (not a hard criterion): 2 on WebGPU and 1 on WebGL2 in the same harness, all jet strikes.
