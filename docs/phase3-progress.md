# Phase 3 progress

Spec: [docs/specs/phase3.md](specs/phase3.md) (with the lead's note; the
[structure correction](specs/structure-correction.md) wins where they differ). Contracts:
[docs/specs/phase3-contract.md](specs/phase3-contract.md).
Branch: `v2-phase3`, cut from tag `v2-phase2` (commit `5f300b9`). Read this file first when resuming,
and update it in every commit.

## Plan

Status values: `not started`, `in progress`, `merged`, `done` (merged and verified).

### Wave 1: foundations (five engineers in parallel, then an integration pass)

| # | Work | Branch | Contract | Status |
| --- | --- | --- | --- | --- |
| 1 | Floating origin: `src/core/origin.js`, `scene.position = -offset`, the 4096 m lattice, the shader, CPU-matrix and float32-buffer fixes, audio in the render frame | `p3/origin` | a | done |
| 2 | Colliders (box, cylinder, capsule, hull, heightfield, mesh BVH), the flight controller's sweep and soft crash, sensors, perches; retrofits on the v1 landmarks and the Phase 2 structures; `?test=collision` | `p3/colliders` | b | done |
| 3 | Local water bodies (basin, crater, terraces stamps; lake and ice material), the shared water-height query and the caller migration; region overlays; vegetation species 6-12 with WindField sway and trunk colliders | `p3/water-regions` | c, d | done |
| 4 | Fauna ground and water-surface modes (bison, caribou, dolphin, flamingo), PathFollower, the challenge system with the ring migration and the challenge UI | `p3/fauna-challenges` | e, f | done |
| 5 | High-altitude and space rendering: atmosphere, sky / fog / stars / limb, curvature and the planet radius, the far-field impostor, lures from altitude, the per-craft ceiling | `p3/high-altitude` | g | done |
| I1 | Integration pass: merge in the order origin, high altitude, water/regions, colliders, fauna/challenges; the follow-ups of contract appendix A; every lab and step file once on both backends | `v2-phase3` | appendix A | done |

### Wave 1 - p3/origin

- Done: `src/core/origin.js` (`createRenderOrigin`, the 4096 m lattice, `onRebase`, `toRender` /
  `toWorld`, the TSL helpers `worldPositionNode` / `worldCameraPositionNode`), the `originRebased`
  typed event, `uniforms.renderOrigin`, the origin in `ctx` and the loop's first-in-frame update;
  `tools/lab/origin.mjs` (32/32). Shader lines of a.5: terrain (cloud UV, water level x3, vegetation
  focus), cloudShading (height fraction, centre), vortex (fragment height, radial, haze kit), weather
  volume rain shafts (streak noise), celestial rainbow centre, sky fog layer (camera height).
- CPU render-frame readers (a.6): the spawn manager's matrix camera path, the director's isInView, the
  lure fallback, the glass HUD and ui.js projections, the spawn test kit; the game ctx in the engine
  ctx (0.4); the node labs' fake uniforms gain renderOrigin.
- float32 buffers (a.7): the lure mesh now stands at the camera with instance offsets relative to
  it; the weather volume's local rain stands at the render origin with the drift folded into its
  offset uniform (world-fixed across a rebase). Anchored already, unchanged: fx.js (contrails, wind
  streaks, bursts: mesh at the camera), trails.js, waterEffects.js (grid anchor, droplets and pools
  on a 64 m grid, trailOrigin wrapped), waypoints.js (Object3D positions), particleSystem.js and
  glowPoints.js (camera to the metre), ribbons.js (slot mesh at the strike), the structure engine's
  pooled meshes (at the anchor), weather volume puffs and shafts (2048 m grid), celestial (camera or
  2048 m grid), fauna (floating anchor). Reported, not edited: clouds.js (anchored by the field).
  The dev wind overlay (`windOverlay.js`) now stands at the render origin with its arrows relative
  to it, shifted back by the delta on a rebase.
- Audio in the render frame: the spatializer and the spawn voices keep world positions (doppler,
  distances, camera velocity) and feed the Web Audio graph `world - offset`; after a rebase the
  listener and every panner are snapped (`snapParameter`), never glided.
- Found by the step file's image check: three's HemisphereLight takes its up direction from its own
  render-frame position, so after a rebase the sky fill lit everything sideways (a 44 % pixel pop
  near the ground). The sky now keeps it 1 m above the render origin (`sky.js`, `updateDome`).
- Dev hook `DRIFTWING.debug.rebaseOrigin(point?)`; `src/dev/originRebaseCheck.js` and
  `tools/steps/origin-rebase.json` (image checks at fixed poses, with the wind overlay on and 400 km
  out, two flight legs of 900 rendered frames with forced rebases, terrain and site identity over
  21 x 21 site cells). Run 2026-10-07 on both backends: 10/10, 0 errors, 0 warnings; worst
  camera-relative error 0.0000 mm, far point 5.5e-8 px; `tools/lab/origin.mjs` 32/32 (needs
  `--expose-gc`).
- Verified 2026-10-07 (each once, both backends unless noted): `npm run build`, `build:single` (V1
  SHA-256 matches), `test:v1` 2/2; every lab passes (wind-engines 56/56 on a rerun with
  `--expose-gc`: the first run's sampled allocation check blamed `windModifierEngine.js`, which
  this branch does not touch); step files terrain-worker-start, engine-vortex, engine-weatherVolume,
  engine-celestial, director-game, engine-structure-sites (9/9), presets-batch1 (58/58) all 0/0
  (weatherVolume on WebGL2 passed on a rerun: the first run's director load shedder held the LOD
  bias at 0.5, so the 12 and 18 km supercells showed their far tier); `?test=terrain` PASS (the
  WebGPU run passed on a rerun after a 120 s navigation timeout); `?test=1` reduced (HARNESS-1,
  glider and jet, both views, 20 s): 0 NaN, 0 penetrations, 0/0, heap 17 / 12 MB, maneuvers 12/12,
  frames over 50 ms 11 / 37 (machine load: `mainThread`, `gc` and `delayed`, none `systems`); the
  built V2 smoke 0/0 on both backends and the built shell 0/0 (WebGPU).
- Next: nothing in this branch's scope; the integration pass merges it first.
- Open issues: `src/render/water.js` (`surfaceNoise`, `shadowUV`) is the water engineer's (contract
  0.1); they apply `worldPositionNode` there in the integration pass. Two edits outside this
  branch's ownership: `sky.js` (the fog layer's camera height and the hemisphere light, owned by
  `p3/high-altitude`; merges cleanly with it today) and `src/dev/windOverlay.js`. The vortex slot
  data holds world positions in float32 (about 6 cm at 1000 km, far below what a funnel shows); not
  on the a.7 list, left as is. Trial merges: `p3/water-regions` conflicts in `terrain.js`
  `terrainColorNode` (keep its `overlayShade(...)` line and this branch's `renderOrigin` water-level
  line); every branch conflicts in this file's wave 1 subsections (keep all).

### Wave 1 - p3/high-altitude

- **Done:**
  - `src/env/atmosphere.js`: the one density model (re-exported from telemetry) and `skyState()`,
    every render input from the camera altitude, exactly neutral below 3 km; `state.atmosphere`.
  - `src/render/curvature.js`: `curvatureDrop`, `rigidCurvatureDrop`, `applyRigidDrop`, the TSL
    `curvatureDropNode` / `curvedPositionNode`, the `planetRadiusKm` clamp (setting + Graphics slider).
  - Sky (`sky.js`): darkening to black above the limb band, sharper whiter sun, daylight stars, the
    blue limb on the curved horizon, the column haze taking over from the Phase 1 fog (6-9 km),
    `camera.far` to the horizon (600 km at most), overcast fading above the cloud decks; all in a
    shader branch that is off below 3 km.
  - The per-craft ceiling (`limits.ceiling`, `flight.getCeiling()`), FLIGHT_CEILING the default.
  - Terrain: curved material variants from 5 km (the originals below), the handoff API
    (`getCoverageRadius`, `setFarFieldHandoff`, `handoffUniforms`), hidden above 13 km, streaming
    paused 20 km above the ground.
  - `src/world/farField.js` (system `farField` after `terrain`): quadtree tiles from the map-tile
    worker (new fields `surface` / `albedo`, a bare-world option for coarse tiles), skirts, curvature,
    water glint, the dithered handoff, the cloud-layer shell (cumulus coverage + regional weather).
  - Clouds (rigid drop, haze lift, edge shrink, `getCoverageProbability`), lures (CPU drop before the
    projection), spawnManager g.5 (heavy spawns by horizontal distance at the far tier above 12 km),
    landmark and structure rigid drops, the third-person near plane above 12 km.
  - `tools/lab/atmosphere.mjs` 28/28; `tools/steps/high-altitude.json`; docs/architecture.md.
- **Resumed (2026-10-07):** reviewed the paused work, then fixed what the verification found:
  - the rigid curvature drop threw for engine contexts without the curvature blend (the node labs'
    wind farm); it is now 0 there (`5dbf85b`);
  - the far-field tile cache thrashed (children being gathered for a split were evicted before their
    siblings arrived, 1500 tile builds in 40 s over a still view, the queue never empty): gathered
    children stay with the tiles in use, refinement stops short of the mesh budget, the split factor
    is 2.2 (`80f21aa`); a still view now settles with nothing pending;
  - `tools/steps/high-altitude.json`: climbs to 120 km, settles on full coverage, counts magenta only
    below the rendered horizon, one eval per handoff-band sample (the single band eval outran the
    protocol timeout and kept moving the camera into the next stage);
  - `tools/lab/audio.mjs` waits for the frame loop to flow after `ready` (the fade's 8 s cap can set
    it while the first pipelines still compile on the loaded machine).
  - The far field gives its tiles back after 20 s below 4.5 km (every geometry disposed; a new climb
    rebuilds from the tile cache), checked in the step file with the rebuild (`d5edd1f`).
- **Verified (2026-10-08, dev server unless noted):**
  - `tools/steps/high-altitude.json` (3 / 8 / 15 / 35 / 100 / 120 km and back, the release and a new
    climb): 20/20 on WebGPU and 20/20 on WebGL2, 0 errors / 0 warnings each; no magenta pixel below
    the horizon at any altitude, the 11-13 km band steps at most 0.36 levels, stars 0.91 at 35 km by
    day; below 3 km the forced high-altitude inputs change 0 of 230 400 bytes; the release disposes
    all 648 tile geometries and the next climb rebuilds 552 tiles from the cache with no hole. WebGL2
    screenshots at 15, 35 and 100 km show no z-fighting (near 1.2 / 2.6 / 3 m).
  - dist-single: the shell, V2 on WebGPU and V2 on WebGL2 smoke with 0 errors / 0 warnings.
  - Golden frame: the A/B pair is identical on both backends; across builds the branch-to-base
    difference (38-44 % of pixels, max 224-230, the sky within 1-2 levels) matches base-to-base
    (50 %, max 221, the sky within 1-2 levels): birds, cloud drift and the chase pose, not the sky.
  - `weather-sky.json`: 5/5 on both backends, 0/0 (one earlier WebGL2 run lost its device once
    under load; the rerun was clean).
  - `?test=terrain`: PASS, 0/0. Reduced `?test=1` (INTEG-A/B, glider and jet, both views, 45 s):
    0 NaN, 0 penetrations, 0/0, 24/24; heap growth 54.8 MB on the first run, 44.7 MB on the second
    (base 33.8 MB); frames over 50 ms 209 and 32 (base 359), all main thread or GC on the busy machine.
  - Labs: atmosphere 28/28, flight-lab 82/82, terrain 291/291, structure 68/68, preset-flight 13/13,
    every other lab as on the base; audio 189/191 (a doppler camera-cut check and the WebGL2 thunder
    trigger check, the same two kinds that fail on the base). Builds, `test:v1` 2/2, docs-check 234/234.
- **Next:** nothing on this branch; ready for the wave 1 integration pass.
- **Contract additions (g):** `atmosphere.js` also exports `DENSITY_SCALE_HEIGHT`,
  `MAX_VIEW_DISTANCE`, `ATMOSPHERE_NEUTRAL_BELOW`, the band constants, `scaleHeightsAbove`,
  `horizonDistance`, `horizonDip`, `createAtmosphereState`, and `skyState` takes the planet radius as
  a third argument; `state.atmosphere` adds `horizonDip`, `hazeBlend`, `farField`, `handoff`,
  `planetRadius`; the uniform `atmosphereAltitude` follows `horizonDip`; `curvature.js` adds
  `PLANET_RADIUS_KM`, `planetRadiusFromSetting`, `applyRigidDrop`, `curvatureDropNode`; the terrain
  adds `handoffUniforms`, a `weight` in `setFarFieldHandoff` and `getStats().high`; `farField.js`
  exports `handoffDitherNode` / `handoffPresenceNode`; `clouds.getCoverageProbability(x, z)`; map tiles
  gain the fields `surface` and `albedo` and the request flag `stamps`.
- **Integration notes:** the curvature node still has to go into `waterMaterial.js` (ocean and
  bodies) and the weather volume materials, and the rigid drop into the fauna group roots (contract
  appendix A).
- **Open issues:** none.

### Wave 1 - p3/water-regions

- **Done:** the `basin`, `crater` and `terraces` stamps and the `salt`, `sand`, `travertine`, `mud`
  and `ice` paints; local water bodies as data (src/world/waters.js) and region overlays
  (src/world/overlays.js), resolved by placement after the stamps; the species table 6-12
  (src/world/vegetationSpecies.js); worldgen's `waterBodyAt`, `overlayAt`, `faceOverlay`,
  `vegetationNear`. The shared water-height query (src/world/waterQuery.js, `ctx.waterQuery`) with
  the ocean wave table and swell scale shared with the shader, and every caller migrated (flight
  models through src/flight/waterSurface.js, the controller, loop, cameras, copilot, spray,
  bioluminescence, relaunch, ground start, the harness). The ocean material moved to
  src/render/waterMaterial.js with lake and ice variants; the `waterBodies` system draws them. The
  chunk `overlay` attribute on both threads and its shading (tint sweeps, ice, stripes); the species
  meshes; WindField sway (src/render/windSway.js); the vegetation collider and perch provider
  (src/world/vegetationColliders.js); lakes on the map tiles (their cache tag unchanged for presets
  without waters or overlays). `?test=waters` and tools/steps/water-bodies.json; tools/lab/water.mjs;
  the terrain lab, `?test=terrain` and `?test=determinism` cover the water stamps and every overlay
  kind.
  Review fixes: a water body switching LOD keeps its old mesh drawn until the new one is built;
  redwood trunk colliders no longer tag a perch (the perch provider publishes each tree top once);
  the sway texture refreshes 32 texels a frame (it probed the WindField 128 times a frame, over 1 ms,
  which made the perf governor drop the spawn LOD bias to 0.5 and failed presets-batch1's tornado
  and volcano wind checks; with the fix the bias stays 1 and both pass), and only trusts the square
  every texel of a sweep agrees on.
- **Verification (2026-10-07/08, once each; rerun only where noted):**
  - `npm run build`, `npm run build:single` (V1 SHA-256 matches), no dev kit names in the bundle, one
    three.js core; `npm run test:v1` 2/2; docs-check 233/233.
  - labs: water 32/32 (ocean height vs the shader within 3 cm, heightAt 0.42 us open ocean / 0.30 us
    with a lake, 3 KB retained after 1 000 000 queries), terrain 404/404, flight-lab, jet, helicopter,
    fpv 87/87, wingsuit, preset-flight 13/13, preset-wind 12/12, preset-pacing 4/4, director 50/50,
    discovery 39/39, copilot 226/226, copilot-server 17/17, input 34/34, settings 28/28, storage
    54/54, setpiece 47/47, structure 68/68, spawns 98/98 (after moving its "bad stamp type" to one
    that stays unknown), wind-engines 56/56 (55/56 on its first run: a 0.44 B/frame allocation
    sample in windModifierEngine, not touched here; 56/56 on the rerun), audio 191/191 (185/191 when
    it overlapped a browser run; alone 191/191).
  - smoke on the dev server, both backends, 0 errors / 0 warnings each: plain V2; water-bodies.json
    41/41 (both); golden-frame.json; engine-waterEffect.json; discovery.json; presets-batch2.json
    (30/30); presets-21-30.json (WebGL2 rerun after a 60 s navigation timeout); presets-batch1.json
    after the sway fix (WebGPU and WebGL2, with the LOD bias logged at 1); view-physics.json
    (WebGPU). The built shell and the built V2 (dist-single) 0/0.
  - `run-harness --test terrain` WebGPU and WebGL2 PASS (9/9 stamp types, 5/5 overlay kinds with
    the attribute live, worker = main 1002 chunks max diff 0, 0 cracks); `--presets real` PASS
    (6/6 Phase 2 types; basin, crater, terraces await wave 3 presets). The first attempts timed out
    navigating a cold dev server (120 s) and passed on the rerun.
  - `run-harness --test determinism` WebGPU and WebGL2 PASS with the Phase 2 hashes unchanged (site
    list d85384433861a1b0, director log 1093b8c1, spawn events 74d3d2fa, path 55b1a55f) and the new
    water-height digest equal across loads.
  - reduced `run-harness --test 1` (HARNESS-1, 30 s, all six craft): WebGPU third person and WebGL2
    first person: 0 NaN, 0 penetrations, 0 soft crashes, 0/0 console, heap growth 12.8 / 12.5 MB,
    script 19/19. Frame time misses: WebGPU 9 frames over 50 ms (systems 0, main thread 7, gc 2),
    WebGL2 242 (systems 1, main thread 212) on the shared machine.
- **Next:** nothing on this branch; the integration pass applies the origin and curvature helpers in
  waterMaterial.js (appendix A).
- **Open issues:** the golden frame's ocean is not pixel-compared against Phase 2: the swell scale
  now follows the flight clock (contract c.2) instead of the damped windStrength uniform, and the
  vegetation sways from the WindField, so a Phase 2 frame would differ by design. In photo mode the
  sun's 640 m shadow-map square shows its edge where the camera is far from the parked craft (a
  Phase 2 shadow setting, seen in the frozen-lake screenshot on WebGPU).

### Wave 1 - p3/colliders

- **Done:** the collider service `src/world/colliders.js` (box, cylinder, capsule, hull, heightfield,
  mesh; spatial hash, providers, perches, landable tops published to the ground surfaces, sensors) with
  its narrow phase `src/world/colliderMath.js` and the integer cell grid `src/world/cellGrid.js`;
  `src/world/colliderMesh.js` (three-mesh-bvh); `groundSurfaces.js` on the cell grid with `setBounds`
  and `surfaceIdBelow`; `ctx.colliders` in main.js and the `colliderHit` / `colliderSensor` events;
  the flight controller's per-tick probe sweep (section STRUCTURE COLLISION: strike over
  `bodyStrikeSpeed` -> soft crash held at the contact, slow contact resolve, landable tops left to the
  ground contact, sensors once per entry, respawn lifted clear, `landed.surface = 'structure'`); the
  engine ctx `game` (0.4) and the SpawnManager's collider leak count; the spawn check kit's collider
  baseline; the retrofits on the arches, monolith circles, lighthouses, balloons and the five Phase 2
  structures; `?test=collision` with `tools/run-harness.mjs --test collision`;
  docs/architecture.md and docs/engines/structure.md. The lab's allocation checks judge the steady
  state over up to six rounds (a cold first run once missed it while the JIT warmed up). Mesh
  colliders tell inside from outside by ray parity (three rays, majority), independent of winding;
  the lab checks it on a turned torus with mixed winding. A heightfield no longer extends its last
  cell past its far x and z edges (a probe just beyond them read as inside, under the top).
  `?test=collision` reworked so every criterion holds: time-based run limits, approaches aimed at
  the target collider itself, set-up crashes attributed, a terrain-clear arch run-in, kite strings
  inside the wingspan, a landable deck (the real bush plane stands on it; real-model dives crash on
  it), the spawn's own collider ids checked after dispose, `?testParts` / `--parts`, a fixed quality
  level. WebGPU run: 98/98 strikes, 15/15 targets, 0 pass-throughs, 0 penetrations.
  `tools/lab/wind-engines.mjs` warms its allocation check up for 90 000 frames instead of 30 000:
  the two new typed events alone moved one JIT re-optimisation into its measured window (bisected:
  the Phase 2 events.js passes, this branch's fails at 30 000 and passes at 90 000).
  The spawn check kit leaves live spawns' colliders out (a site built during a check had been
  blamed); the preset kits print the colliders.
- **Verified (2026-10-08, once each; reruns only where the page never loaded):** `npm run build`,
  `npm run build:single` (V1 SHA-256 matches; one `Multiple instances` guard in the V2 bundle; no
  dev test code in it), `npm run test:v1` 2/2; labs: colliders 84/84, structure 68/68, spawns 98/98,
  flight-lab 82/82, terrain 291/291, wind-engines 56/56, director 50/50, setpiece 47/47 and every
  other node lab passing; the audio lab 189/191 (browser-rendered thunder and waterfall levels,
  no audio file changed here). `?test=collision` PASS on WebGPU and WebGL2 (98/98 strikes, 15/15
  targets, 0 pass-throughs, 0 penetrations, bump, deck, deck dives, tunnel, arch, 15/15 kite misses,
  one three.js core, 0/0 console). Step files on both backends, 0 errors and 0 warnings:
  engine-structure, engine-structure-sites, presets-batch1, presets-batch2, presets-21-30.
  `?test=spawns` for windFarm, ropeBridge, abandonedAirfield, crystalSpires, floatingIslands PASS on
  both backends (colliders back after every dispose). Reduced `?test=1` (HARNESS-1, glider, bush
  plane, jet, both views, 30 s): 0 NaN, 0 penetrations, 0/0 console, 18/18 manoeuvres; 26 frames
  over 50 ms (main thread, GC and delayed frames on the busy machine; the one "systems" frame is
  clouds 37 ms). dist-single smoke of V2 and the shell on both backends: 0 errors, 0 warnings.
- **Next:** the wave 1 integration pass (merge order: origin, high altitude, water/regions,
  colliders, fauna/challenges).
- **Open issues:** a burst of WebGPU warnings `Destroyed texture [Texture "ShadowDepthTexture"]
  used in a submit` appeared in 3 of 11 collision runs, always after the perf governor had
  auto-degraded the quality (shadow map 2048 -> 1024) and at the next craft switch; forced
  degrades and craft switches in a probe never reproduced it. The collision test now holds the
  quality at high; the shadow resize path (sky.js `applyShadowQuality`) needs a look by its owner.

| 4 | Fauna ground and water-surface modes (bison, caribou, dolphin, flamingo), PathFollower, the challenge system with the ring migration and the challenge UI | `p3/fauna-challenges` | e, f | in progress |
| 5 | High-altitude and space rendering: atmosphere, sky / fog / stars / limb, curvature and the planet radius, the far-field impostor, lures from altitude, the per-craft ceiling | `p3/high-altitude` | g | not started |
| I1 | Integration pass: merge in the order origin, high altitude, water/regions, colliders, fauna/challenges; the follow-ups of contract appendix A; every lab and step file once on both backends | `v2-phase3` | appendix A | not started |

### Wave 1 - p3/fauna-challenges

- **Done:** the ring golden logs (contract f.4), recorded from the unmodified Phase 2 `rings.js`
  before any change to it: `tools/lab/ringsGolden.mjs --record` flies six scripted flights (clean,
  misses, abandon, teleport, cancel, restart) on a stub world with a seeded `Math.random`, and
  writes `tools/lab/fixtures/rings-golden.json` (every bus event with its frame, a float64 digest
  of `state.ringCourse` and `lastCrossing` per frame, full snapshots on event frames, the journal
  calls). Re-recording reproduces the file byte for byte.
- **Done:** `src/world/pathFollower.js` (createPath, createPathFollower with loop / pingpong / once,
  waits and trailing cars, buildGroundPath as an A* over slope- and water-checked steps) and
  `tools/lab/path.mjs` (37/37: arc length within 0.01 % of a fine polyline, continuity at 120 Hz,
  modes, waits, cars, ground, determinism, ground routes, zero allocation).
- **Done:** the challenge core `src/gameplay/challenges.js` (course validation, sequential gate
  crossings interpolated inside the frame on the flight clock, penalty / void / count misses, sensor
  misses, splits and deltas, medals and medal pace, bests per craft under `driftwing-v2.challenges`,
  the best run's 10 Hz path under `driftwing-v2.challengePath.*`, start gate / armed / immediate
  starts, Y = `challengeStart`, abandon, time limit, crash and unregister cancels, `state.challenge`),
  the four typed events, the preset `challenge` field (validated in schema.js), the ring course
  migrated onto the core through a legacy adapter (identical to the six Phase 2 goldens), the
  challenge HUD (`src/ui/challengeHud.js`: prompt, edge chevron and 3D gate frame, timer with splits,
  miss flash, medal toast), the journal's Challenges section, and `tools/lab/challenges.mjs` (68/68).
- **Done:** the structure recipe `challengeGates` (gate frames from a preset's `challenge` block, the
  course registered with the challenge system for the instance's life; structure lab 75/75), and the
  engine ctx `game` handle (contract 0.4, verbatim lines).
- **Done:** FaunaEngine ground and water-surface modes: `herd` (altitude mode `ground`, a fine ground
  grid, slope and water avoidance, grazing, player / timer / event stampedes, pooled dust sprites),
  `column` (PathFollower walkers, 'auto' paths from buildGroundPath), `surface` (dolphins porpoising
  on the water query's swell and racing the craft's shadow; flamingos wading, flushed in a wave,
  flying as a flock and settling back); species bison, caribou, dolphin, flamingo; `faunaThreat`;
  `tools/lab/fauna-modes.mjs` (40/40).
- **Done:** docs/engines/fauna.md (the Phase 3 modes, params, events and far-tier behaviour); the
  step files `tools/steps/engine-fauna-modes.json` (four species force-spawned, the herd on dry gentle
  ground and its stampede and settle, the column on an auto route, dolphins on the swell racing the
  shadow, flamingos wading, flushing in a wave and settling, dispose back to the memory, particle and
  dust baselines; screenshots) and `tools/steps/challenge.json` (a fixture course: the prompt, Y arms
  it, the arrow, splits ahead and behind, bronze then gold, a missed rect gate with +5 s, Y cancels,
  the journal entry, cleanup; screenshots); `node tools/lab/ringsGolden.mjs` replays the six goldens
  on the migrated code (6/6; `--record` is refused now that rings.js is migrated).
- **Done (fixes found by the step files):** a herd's stampede clock and a flushed wader flock's flight
  now run on at the far tier (they froze there); waders on a steep bank stand still inside its narrow
  shallow band and spread along it instead of piling onto the centre; an unregistered course leaves
  the start prompt at once; each challenge gate shape has its own marker mesh (swapping the geometry
  between the ring and the rect frame broke the WebGPU post pipeline once). Labs: fauna-modes 44/44,
  challenges 69/69, path 37/37, structure 75/75.
- **Verified (2026-10-07, dev server, one run each, reruns noted):**
  - `tools/smoke-test.mjs`: `engine-fauna-modes.json` WebGPU and WebGL2 11/11, 0/0 console,
    screenshots differ; `challenge.json` WebGPU 12/12 0/0; on WebGL2 the first run failed only the
    armed check's `distance > 500` (the craft had already closed to 472 m; the threshold is now
    100 m) and the rerun passed 12/12 0/0 (scratch streaming driver; smoke-test.mjs's Chrome
    shutdown took 10-25 minutes per run on this machine).
  - The same steps through a scratch driver that streams each check (identical evals, console
    capture): `engine-fauna.json` (`seed=ENGINEFAUNA`) 11 checks, `discovery.json` 7,
    `presets-batch1.json` (`seed=DRIFTWING`) 25, `presets-batch2.json` (`seed=HARNESS-1`) 31,
    `presets-21-30.json` 51, all PASS with 0/0 console on both backends. Reruns: batch 2 WebGL2
    (a WebGL context loss under GPU load on the first run), presets 21-30 on both backends (the
    first worlds had a live waterfall site whose curtain wind source and geometries came into range
    during three dispose checks; a navigation timeout once), challenge WebGPU (a navigation timeout).
  - Reduced flight harness (INTEG-A and INTEG-B, glider and jet, both views, 45 s): 0 NaN, 0
    penetrations, 0/0 console, heap growth 38.3 MB (WebGPU) and 23.4 MB (WebGL2), 8/8 runs, 24/24
    manoeuvres. Frames over 50 ms: 18 on WebGPU and 198 on WebGL2 (INTEG-A's WebGL2 runs at a
    65-80 ms median), nearly all main-thread / GPU time; the systems-attributed ones are flight
    41 ms and terrain 88 ms frames each with a 10-23 MB GC inside, none in the challenge, HUD or
    fauna systems.
  - `npm run build`, `npm run build:single` (V1 SHA-256 matches), `npm run test:v1` 2/2,
    `tools/docs-check.mjs` 233/233; labs: fauna-modes 44/44, challenges 69/69, path 37/37,
    structure 75/75, spawns 98/98, discovery 39/39, ringsGolden 6/6.
- **Next:** none on this branch (ready for the wave 1 integration pass).
- **Open issues:** the challenge core keeps its own plane test (`crossGate`, the Phase 2 ring
  course's math operation for operation, with rect gates) instead of `gateDetector.crossGates`,
  which the golden logs need; the integration pass adds `challenges.count()` to the spawn check
  kit's dispose baseline and the rigid curvature drop to the fauna group roots (contract appendix A).

### Wave 1 - integration (I1, on `v2-phase3`)

- **Merged** in the contract's order with `--no-ff`: origin `c6bdb2b`, high altitude `da03000`,
  water/regions `b33ab09`, colliders `a2ed145`, fauna/challenges `afcdb33`. Conflicts were only this
  file (every subsection kept), `terrain.js` (both import sets, both header notes, the overlay shade
  with the origin's water-level line, the high-altitude block beside the overlay sweep slots),
  `mapTileGen.js` (both the far field's `surface` / `albedo` fields and the body tints; the albedo
  now draws local bodies in their own tint and keeps ice opaque), `FlightController.js`
  (`getCollisionProbes` beside `getCeiling`), `main.js` (the dev-test comment),
  `structureEngine.js` (the rigid drop and the collider imports, `challenge: null` beside
  `colliders: []`, `registerChallenge` after `registerSurfaces`, both dispose calls) and
  `schema.js` (the three pure validator imports). The verbatim lines (`UPDATE_ORDER`,
  `PRESET_FIELDS`, the game ctx) are exact after every merge.
- **Wiring:**
  - the water materials (`waterMaterial.js`): noise reads `worldXZ` (positionWorld plus
    `renderOrigin`), the cloud shadow moves its centre into the render frame, the lake's wave phase
    wraps the render-frame position (4096 m divides the origin lattice), the lake trail foam takes a
    render-frame position (`waterEffects.js`); the curvature drop on the ocean grid
    (`curvatureDropNode` in its position node) and on the lake and ice meshes (`curvedPositionNode`);
  - weather volumes: each puff and shaft is drawn lowered by `rigidCurvatureDrop` of its own position
    before the distance compression (the instanced meshes take the drop on the CPU, where their
    instance matrices are written every frame);
  - fauna: agents and dust are drawn lowered by `rigidCurvatureDrop` (the per-agent equivalent of a
    group-root drop, since the species share pooled buffers); the `water` altitude mode reads
    `ctx.game.waterQuery` (ocean swell and lakes; sea level where neither covers the point);
  - vegetation: the WindField sway texture is read with the render-frame position (the window
    centre moves into the render frame; the 2048 m texture repeat divides the origin lattice), and
    the instances take the same curvature drop as the chunk under them;
  - the vegetation perch provider reports `visit(x, y, z, kind, sourceId)` as `perchesNear` does
    (it passed one object before); the water lab now registers the vegetation providers with the
    real collider service (a sweep hits a redwood trunk, the tree tops are perches, unregistering
    removes both);
  - the spawn check kit counts challenge courses (`challenges.list()`, the ring course and live
    spawns' courses excluded) in every dispose check: `challengesOk` joins `ok`, the spawns test's
    "other" criterion and the harness table;
  - the challenge best path stores positions relative to the first gate (`anchor`, float64), so the
    float32 frames keep centimetre precision far from the world origin; `getBestPath` returns
    `{ hz, anchor, frames }` (contract f.1 updated; a stored path without an anchor reads with 0);
  - floating island tops (landable heightfields) also tag their crown as a perch, beside the
    lintels, tall stones, lighthouse gallery and spire tips the colliders branch tagged.
- **Fixes:**
  - the shadow map resize (the WebGPU burst "Destroyed texture [Texture "ShadowDepthTexture"]
    used in a submit" after a governor degrade): `sky.js` now resizes the sun's shadow render target
    itself when the quality changes (between frames, never inside the shadow pass, where three r184
    resizes it), dispatches `dispose` on the old depth texture so every sampler binding rebinds the
    new one, and forces one shadow pass (`needsUpdate`, also at night when the shadows are not
    live). `sky.getShadowState()` reports it. Proof: `tools/steps/shadow-resize.json`
    (`src/dev/shadowResizeCheck.js`) drives the governor's own degrade (quality auto, a simulated
    45 ms load) to a 1024 map, tours five craft with view swaps, resizes at night and at dawn and
    grows back; WebGPU 5/5, 0 errors, 0 warnings. The burst never reproduced on demand before the
    fix either (two probes: a plain degrade plus craft switches, and the collision test's special
    runs with the governor forced down to 1024 mid-run: 0 warnings each), so the proof is that the
    path now runs clean, not a before/after.
  - step-file hardening against live spawns and the load shedder: the spawns dev hook gains
    `pinLodBias(bias)` / `releaseLodBias()` (the director's shedder requests are kept and applied on
    release); `holdGamePresets()` pins the bias at 1 (every engine step file and the collision and
    spawns tests), and the preset step files (`presets-batch1.json`, `presetChecks.js`,
    `presetChecksBatch2.js`) pin it in their setup; the spawn check kit leaves live spawns' wind
    sources out of a dispose check, as it does for their colliders and courses (a game site the feed
    builds during a check is not the disposed spawn's).
  - the far field no longer releases (disposes) its prewarm stand-in tile 20 s after boot when no
    tile was ever built: that one-time geometry free landed inside the strict GPU-memory baselines
    of engine-fauna, engine-fauna-modes, engine-structure, engine-waterEffect and
    engine-windModifier on WebGL2 (one geometry fewer "during" a check); it now releases only after
    tiles were built (`tilesBuilt`), as the high-altitude step file's release check expects;
  - wading birds choose their shallows by the still water level (`waterQuery.staticLevelInto`: a
    lake's level or sea level), not the instantaneous swell, so a spot 1 m deep no longer reads as
    shallow under a passing trough (engine-fauna-modes' wade check failed on WebGL2 that way).
  - `tools/spawn-check.mjs` waits for frames to flow (20 animation frames in a second) after ready,
    after loading the test kit and after each create: on WebGPU the cold pipeline compile stalls the
    page for about 20 s after ready (no animation frame runs), and the memory cycles read a standing
    world ("0 near", 3 of 55 failed). It measured 51/55 and 52/55 before, 55/55 after.
- **Docs:** the architecture test table lists the wave 1 labs (origin, water, challenges and the
  ring goldens, path, fauna modes) and step files (origin-rebase, water-bodies, challenge,
  engine-fauna-modes, shadow-resize).
- **Integration commits** (first parent, after `1a741b8`): merges `c6bdb2b`, `da03000`, `b33ab09`,
  `a2ed145`, `afcdb33`; wiring and fixes `685f2c4` (water origin and curvature), `5a28211`
  (weather volume and fauna curvature, fauna water mode), `66d0076` (vegetation sway and
  curvature), `be00adf` (vegetation perches), `292187f` (challenge courses in the dispose checks),
  `5fc8e27` (anchored best path), `c20409c` (island crown perches), `71c63ec` (shadow map
  resize), `ef6fb2a` (LOD bias pin, live spawns' wind sources), `6fe23f8` (docs), `11e0710`
  (far-field stand-in), `3eb04b9` (wading shallows), `49be17e` (spawn check frame waits), and
  this file's own updates.
- **Verified on the merged tree (2026-10-08, each once on both backends; reruns named):**

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `npm run build:single` (V1 SHA-256 matches), `npm run test:v1`, `node tools/docs-check.mjs` | built; 2/2; 235/235 | (same build) |
  | V2 bundle | one three.js core (one `Multiple instances` guard); no dev kit module (collisionTest, spawnCheckKit, shadowResizeCheck); three-mesh-bvh tree-shaken until preset 77 | |
  | Labs (`--expose-gc`): flight-lab 82, atmosphere 28, challenges 70, colliders 84, copilot 226, copilot-server 17, director 50, discovery 39, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden 6/6 goldens identical, setpiece 47, settings 28, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, wingsuit 37, audio 191 (alone) | all pass | |
  | Wave 1 step files: origin-rebase 10, high-altitude 20, water-bodies 41, challenge 23, engine-fauna-modes 20, shadow-resize 5 | all pass, 0/0 | all pass, 0/0 (fauna-modes after `11e0710` and `3eb04b9`; high-altitude rerun after `11e0710`) |
  | Phase 2 step files: golden-frame (A/B pair identical), weather-sky 5, view-physics 6, director-game 3, discovery 17, copilot-guide 13, engine-celestial 11, engine-emitter 13, engine-fauna 25, engine-lightEffect 13, engine-setPiece, engine-structure 21, engine-structure-sites 10, engine-vortex 9, engine-waterEffect 19, engine-weatherVolume 19, engine-windModifier 9, env-fixes, input-review 9, hotplug 6, terrain-worker-start 4, presets-batch1 58, presets-batch2 31, presets-21-30 51, seed-link 7 | all pass, 0/0 | all pass, 0/0 (engine-fauna, engine-structure, engine-waterEffect and engine-windModifier failed their strict GPU baselines by one geometry on the first run, the far-field stand-in release; all pass after `11e0710`) |
  | `tools/spawn-check.mjs` | 55/55 (51/55 and 52/55 before `49be17e`: the cold-compile stall) | 55/55 |
  | `run-harness --test terrain` (fixtures) | PASS: 9/9 stamp types, 5/5 overlay kinds, 0 cracks, worker parity 1002 chunks, collision 0.00001 m, 51/51 poses | PASS, same numbers |
  | `run-harness --test terrain --presets real` | PASS: 6/6 types (basin, crater, terraces wait for wave 3), worker parity 555 chunks (first attempt: navigation timeout on the cold server) | PASS, same (first attempt: navigation aborted) |
  | `run-harness --test collision` | PASS: 98/98 strikes, 15/15 targets, 0 pass-throughs, 0 penetrations, bump, deck, dives, tunnel, arch, 15/15 kite misses, one core (first attempt: navigation timeout) | PASS, same |
  | `run-harness --test determinism` | PASS: site list d85384433861a1b0, director log 1093b8c1, water digest 61f315c9, spawn events 74d3d2fa, path 55b1a55f (the Phase 2 hashes; nothing to re-record) | PASS, identical hashes |
  | `run-harness --test spawns` (30 presets) | PASS 30/30 on every criterion incl. colliders and challenge courses; lowest avg 50 fps, worst p99 61.2 ms (reported) | PASS 30/30; 58.4 fps, p99 44.1 ms |
  | `run-harness --test 1` (INTEG-A/B, glider and jet, both views, 45 s) | 0 NaN, 0 penetrations, 0/0, 8/8 runs, 24/24 manoeuvres, heap growth 20.51 MB max; FAIL on frames over 50 ms: 351 (INTEG-B glider: 219 and 126, the rest 0-2) | same criteria pass, heap 24.59 MB max; frames over 50 ms 11 |
  | Built `dist-single/v2` and `dist-single/index.html` smoke | 0/0 each, screenshots differ | 0/0 each |

- **Heap growth (reported problem):** measured on the merged tree at 20.51 MB (WebGPU) and
  24.59 MB (WebGL2) against the 50 MB limit; per-run deltas -0.4 to 19.9 MB with no trend across
  runs or views. No retention found; the high-altitude branch's one 54.8 MB run (44.7 MB on its
  rerun, base 33.8 MB) reads as run-to-run noise.
- **Frame time (owner's rule, one line):** the WebGPU INTEG-B glider runs had 219 and 126 frames
  over 50 ms with the slow frames spread over whatever system was running (input, camera, birds,
  terrain, spawns at 30-65 ms each), while the same runs on WebGL2 had 0-2; the machine ran at
  about 90 % CPU with another program's game during the harness work.

### Wave 2: craft (one engineer per craft, plus the picker / director engineer)

| # | Work | Branch | Contract | Status |
| --- | --- | --- | --- | --- |
| 2.0 | Craft framework (lands first, alone): catalog and groups, settings, favorites actions, `situate`, ability api, `craftCommand`, custom cockpits, `?test=craft` scaffold | `p3/craft-framework` | h.9 | in progress |
| 7 | Aerobatic: symmetric airfoil, snap rolls, knife-edge, torque roll, smoke ribbons, the maneuver recognizer (12 figures, lomcevak at low assists) | `p3/craft-aerobatic` | h | not started |
| 8 | Seaplane: per-float buoyancy, hump and step, porpoising, water rudders, spray, amphibian gear | `p3/craft-seaplane` | h | not started |
| 9 | Tiltrotor: nacelle 0-97 degrees with detents, hover and airplane modes, the conversion corridor, auto-nacelle | `p3/craft-tiltrotor` | h | not started |
| 10 | Paraglider: two-body pendulum, speed bar, brakes, weight shift, big ears, collapses, thermals, relaunch | `p3/craft-paraglider` | h | not started |
| 11 | Hot air balloon: buoyancy with thermal lag, burner and vents, wind-layer column, altitude hold, basket landings | `p3/craft-balloon` | h | not started |
| 12 | Airship: ballonet trim, vectored props, gondola view, scenic cruise | `p3/craft-airship` | h | not started |
| 13 | Eagle / Dragon: flapping flight, soaring, perch, screech / fire breath, ignition service, fauna threat | `p3/craft-eagle` | h | not started |
| 14 | Spaceplane: rocket, RCS blend, Mach / altitude / apogee, re-entry heating, plasma, blackout, hypersonic glide | `p3/craft-spaceplane` | h | not started |
| P | Picker rework (groups, skins, favorites 1-0, HOTAS cycling), situational spawn rules, director updates (ground track, craft weighting, combos, global overrides) | `p3/picker-director` | h.7, i | not started |
| I2 | Integration pass: merge 2.0 first (before the craft branches start), then the craft branches in catalog order and the picker / director branch; `?test=craft` on both backends | `v2-phase3` | | not started |

### Wave 2 - p3/craft-framework

- **Done:** the catalog (`src/craft/registry.js`): the eight Phase 3 entries with their picker
  silhouettes, `group` on every entry, `CRAFT_GROUPS` / `CRAFT_GROUP_LABELS`, `registry.groups()`,
  `registry.entry(id)`, `createCraftRegistry(catalog, groups)` for labs, and the optional-field
  validation of contract h.2 (abilities, inputProfile values, limits, custom cockpit, skins,
  bindings, collision, situate, copilot, journal, directorProfile, faunaThreat, capabilities);
  settings v6 (`CRAFT_IDS` with 14 ids, `craftFavorites` with ten slots, `craftSkins`, the
  migration: new craft at their defaults, at 50 % when the one-time HOTAS default was applied);
  `tools/lab/settings.mjs` 45/45.
- **Next:** favorites actions and bindings, the controller hooks (situate, abilities, craftCommand,
  skins), custom cockpits, the copilot action, the journal, `?test=craft`, docs.

### Wave 3: presets 31-100 (seven batches of ten, the spec's numbering)

| # | Presets | Branch | Status |
| --- | --- | --- | --- |
| B4 | 31-40: sandstorm wall, snow squall, hurricane eye, valley fog river, dirty thunderstorm, lava rivers, fissure eruption, crater lake, hot spring terraces, salt flat mirror | `p3/presets-31-40` | not started |
| B5 | 41-50: calving glacier, coral atoll, reef shipwreck, dolphin pod, sea stacks and arches, rogue wave, tidal bore, bats at dusk, herd stampede, flamingo lake | `p3/presets-41-50` | not started |
| B6 | 51-60: butterfly migration, caribou migration, cliffside monastery, sea-cliff castle, observatory, steam train viaduct, dam spillway, oasis caravan, labyrinth, fireball impact | `p3/presets-51-60` | not started |
| B7 | 61-70: blood moon, green flash, noctilucent clouds, Milky Way core, moonbow, world tree, portal ring, sleeping giant, ghost galleon, dragon racer | `p3/presets-61-70` | not started |
| B8 | 71-80: reverse waterfall, forest wisps, ridge lift band, wind shear line, thermal street, canyon gauntlet, cave tunnel, waterfall wall, balloon festival, kite-string slalom | `p3/presets-71-80` | not started |
| B9 | 81-90: five-arch chain, cherry blossom valley, autumn colour wave, lavender and tulip stripes, rice terraces, redwood giants, badlands hoodoos, mangrove delta, cactus forest with dust devils, bamboo forest | `p3/presets-81-90` | not started |
| B10 | 91-100: frozen lake and the legendary combos (aurora + meteors, volcano + lightning + aurora, double rainbow over whales, eclipse over the monoliths, comet breakup, migration convergence, midnight sun, resonating spires, lighthouse chain) | `p3/presets-91-100` | not started |
| I3 | Integration pass: presets/index.js and spawnScenarios in spec order; `?test=spawns` for all 100 on both backends | `v2-phase3` | not started |

Each preset ships with its journal title and one-liner, 3+ callouts, its audio recipe, LOD and a
FAR lure where heavy, colliders where solid, rarity, filters and lifetime (docs/spawns.md
template). The challenge-based presets (70, 76-81) use the wave 1 challenge system; the combo
presets (92-100) use the wave 2 combo scheduling.

### Wave 4: discovery and verification, then the tag

| # | Work | Branch | Status |
| --- | --- | --- | --- |
| O | Milestone O: journal x / 100, flight time per craft, figures, medals, worlds visited, perches, max altitude; the copilot grammar and its keyboard / UI equivalents; remote flightState fields; docs/copilot-api.md, docs/controls.md (a HOTAS profile per new craft), docs/spawns.md (all 100), docs/architecture.md | `p3/discovery` | not started |
| P | Milestone P: the verify loop (dev server and build:single, 0/0, screenshots differ, golden-hour opening unchanged), `?test=spawns` (100), `?test=craft` (14), `?test=collision`, determinism and terrain extended, the 20-minute soak, the final report, CHANGELOG, the manual checklist for Kyle | `p3/verify` | not started |
| R | Review, fixes, version bump, then the owner tags `v2-phase3` | `v2-phase3` | not started |

## Decisions

- **The structure correction wins.** No CLASSIC mode, no `arcadeProfile`; assists are the only
  difficulty control; "both modes" means the first and third person views.
- **Floating origin through the scene transform.** `scene.position = -origin.offset` renders every
  scene child (and the camera, already a child of the scene) in the render frame, while
  `Object3D.position` and `camera.position` keep meaning WORLD. Only shaders comparing
  `positionWorld` with absolute values, CPU code reading render-frame matrices and float32 buffers
  of large world positions need work. The origin moves on a 4096 m lattice on all three axes (the
  y axis too, for the spaceplane's cockpit at 100 km), so every power-of-two periodic pattern
  (terrain wrap, wave tile, chunks) is unaffected. The loop rebases first in the frame.
- **Audio in the render frame**, snapped on a rebase (no pan sweep), for panning precision far from
  the world origin.
- **three-mesh-bvh is needed, and only for the cave tunnel (preset 77).** Every other structure fits
  primitives. Installed as 0.9.15 (`--save-exact`; peer `three >= 0.159.0`; released after three
  0.184.0); `vite.config.js` aliases the exact specifier `'three'` to `'three/webgpu'`.
- **Collision is a per-tick sweep of craft probe spheres** (from the contact points by default), so
  nothing tunnels at re-entry speeds. Over `limits.bodyStrikeSpeed` (Phase 1's 5 m/s default) it is
  the Phase 1 soft crash held at the contact point; under it the contact resolves (scrape, bump,
  perch approach). Landable tops publish to the Phase 2 ground surfaces, so landings on structures
  use the existing ground contact and grades. Sensors (kite strings) count misses, never crash.
- **One water model.** Physics and the shader share the ocean wave table and a deterministic swell
  scale; local water bodies are pure data resolved by placement next to the stamps and clipped by
  their basin stamp. Every `waterLevel` caller migrates to `env.waterHeight` / `ctx.waterQuery`.
- **Region overlays never change height**, so `heightAt` keeps its cost and its Phase 2 bit
  identity; the new species grow only inside overlays, so worlds without overlay sites are
  unchanged.
- **The ring course runs on the challenge core with identical behaviour**, proven against golden
  event logs recorded from the Phase 2 code before the migration; it keeps no medals or records.
- **Curvature is visual only**; the simulation stays flat.
- **Wave 2 starts with a short framework step (2.0)** merged before the eight craft branches, so
  they code against real hooks.
- **Shared files are edited at fixed anchors or with verbatim lines** (contract 0.1-0.4), so the
  wave 1 branches merge cleanly; list-append files are resolved at integration in catalog / spec
  order.
- **Machine load (owner's rule).** Ignore PC load: run each check once and report its numbers.

## Done

- Branch `v2-phase3` created from tag `v2-phase2`.
- The Phase 3 contracts: docs/specs/phase3-contract.md, listed in docs/specs/README.md.
- Contract review: the origin engineer's events anchor is `relaunched` (clear of the water
  engineer's `landed` edit), and the floating origin section notes that objects with
  `matrixAutoUpdate = false` follow a rebase (nothing writes `matrixWorld` directly).
- three-mesh-bvh 0.9.15 installed (exact) and the `'three'` -> `'three/webgpu'` alias
  (contract b.7), verified once each (2026-10-03):
  - dev server (port from `findFreePort`): V2 smoke 0 errors and 0 warnings, screenshots differ,
    and three-mesh-bvh imported inside the running game built a BVH over the game's own
    `BoxGeometry`; `raycastFirst` hit at 45 m with a point that is an instance of the game's
    `THREE.Vector3` (one core), `window.__THREE__` "184";
  - `npm run build:single`: V1 SHA-256 matches; built V2 and the built shell smoke with 0 errors and
    0 warnings, screenshots differ; the V2 bundle holds one three.js core (one `Multiple instances`
    guard string);
  - a production build of a probe page importing `three/webgpu`, BufferGeometryUtils (bare
    `'three'`) and three-mesh-bvh through the project's own alias: one core, the raycast correct,
    0 console errors or warnings, no duplicate-three warning (the probe page is kept outside git,
    in `.claude/orchestration/bvh-probe/`);
  - `npm run test:v1` 2/2.

## What's next

Wave 1 is done: the five branches are merged into `v2-phase3`, wired and verified (the
integration subsection above). Not pushed or tagged (the owner pushes).

Next: **wave 2 step 2.0, the craft framework** (`p3/craft-framework`, contract h.9), cut from
`v2-phase3` and merged alone before the eight craft branches and the picker / director branch
start. The wave 1 worktrees under `.claude/worktrees/p3-*` can be removed (unlink each
`node_modules` junction first). The craft engineers build against the merged APIs listed in the
integration subsection and the contract (origin a, colliders and probes b, water query and
`onWater` c, atmosphere and ceilings g, challenges f, PathFollower e.2, `faunaThreat` e.1).

## Open issues

- **Wave 1 integration leftovers:** the WebGPU flight harness's frames over 50 ms on the busy
  machine (above); the shadow-map warning burst never reproduced on demand, so the fix is proven by
  the degrade path running clean, not by a before/after; golden-frame shot 1 (the first render of
  the still) differs from shots 2 and 3 by up to 1 level on WebGPU and 19 on WebGL2, while the A/B
  pair (2 and 3, with and without the weather modifier) is identical; fauna `pod` groups (whales)
  still ride the flat sea level, not the swell (only the `water` altitude mode and wading birds read
  the water query); the far field's tile geometry release after 20 s below 4.5 km still frees
  geometries at a time no check controls (now only after a climb), so a strict GPU baseline taken
  across that moment would move by those tiles; the presets-21-30 kit still counts a game site's
  geometries that appear mid-check (its wind sources are excluded now).
- **Cold pipeline compile on WebGPU** stalls the page for about 20 s after `ready` on this
  machine (no animation frame runs): tools that start timed checks right after `ready` must wait
  for frames to flow (`tools/spawn-check.mjs` and `tools/lab/audio.mjs` do).

- **Carried from Phase 2** (docs/phase2-progress.md, Open issues): the soak's p99 against the
  16.67 ms target on the shared machine, the full 36-run flight matrix never run, the one-pixel
  WebGL2 golden-frame difference, the airfield and crystal spires' one slow frame each, the
  warm-up heap of a few presets, the rare-tier fairness, the faint storm chase funnel.
- **WebGL2 depth range at altitude.** WebGPU uses reversed depth; WebGL2 does not. The far plane
  grows to the horizon (up to 600 km) above 12 km. Checked by the high-altitude branch: WebGL2
  screenshots at 15, 35 and 100 km show no z-fighting with the third-person near plane at 1.2 / 2.6 /
  3 m; the first-person views keep the Phase 2 near plane, so the spaceplane cockpit (wave 2) must
  check its own views up there.
- **Rigid curvature drop for discrete objects** (g.3) relies on every engine applying it; the
  wave 3 checklist must include it, or distant structures float above curved terrain from altitude.
- **The ring course's identical behaviour** depends on the golden logs being recorded before any
  change to rings.js.
- **npm audit** reports advisories in the existing dev dependencies; three-mesh-bvh has no
  dependencies of its own.

## How to resume

- Read this file, then the contract, then the spec. `git status`, `git log --oneline -10`.
- **Worktrees** live under `.claude/worktrees/` (ignored by git), one per branch, for example:
  ```sh
  git worktree add .claude/worktrees/p3-origin -b p3/origin v2-phase3
  cmd //c mklink /J ".claude\\worktrees\\p3-origin\\node_modules" "node_modules"
  ```
  Each worktree's `node_modules` is a **junction** to the main checkout's (no second install).
- **Before `git worktree remove`, unlink the junction first**, with `cmd //c rmdir
  ".claude\\worktrees\\<name>\\node_modules"` (removes the link only). Never `rm -rf` a worktree
  that still holds the junction: it would delete the main checkout's node_modules.
- **Push with full refspecs** (`git push origin refs/heads/v2-phase3:refs/heads/v2-phase3`):
  branch and tag names repeat. Agents never push or tag; the owner does.
- **The branch `v2-phase2` and the tag `v2-phase2` share a name**: refer to the tag as
  `refs/tags/v2-phase2` (an annotated tag; its commit is `refs/tags/v2-phase2^{commit}` = `5f300b9`).
- Dev servers for checks: `node -e` with `findFreePort()` from `tools/ports.mjs`, then
  `npx vite --port <port> --strictPort`. Never port 5199. Give every smoke or harness run its own
  `--out` directory (agents share one scratchpad).
- Never edit source files while a browser run is using that dev server (Vite reloads the page).
- Engine and dev step files run in an empty game: hold the game's presets first
  (`spawns.debug.holdGamePresets()`), or count only the spawns the check made.
- Commit messages: conventional commits, each ending with the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Update this file in every commit.
