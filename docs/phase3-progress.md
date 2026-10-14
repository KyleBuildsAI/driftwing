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
| 2.0 | Craft framework (lands first, alone): catalog and groups, settings, favorites actions, `situate`, ability api, `craftCommand`, custom cockpits, `?test=craft` scaffold | `p3/craft-framework` | h.9 | done |
| 7 | Aerobatic: symmetric airfoil, snap rolls, knife-edge, torque roll, smoke ribbons, the maneuver recognizer (12 figures, lomcevak at low assists) | `p3/craft-aerobatic` | h | done |
| 8 | Seaplane: per-float buoyancy, hump and step, porpoising, water rudders, spray, amphibian gear | `p3/craft-seaplane` | h | done |
| 9 | Tiltrotor: nacelle 0-97 degrees with detents, hover and airplane modes, the conversion corridor, auto-nacelle | `p3/craft-tiltrotor` | h | done |
| 10 | Paraglider: two-body pendulum, speed bar, brakes, weight shift, big ears, collapses, thermals, relaunch | `p3/craft-paraglider` | h | done |
| 11 | Hot air balloon: buoyancy with thermal lag, burner and vents, wind-layer column, altitude hold, basket landings | `p3/craft-balloon` | h | done |
| 12 | Airship: ballonet trim, vectored props, gondola view, scenic cruise | `p3/craft-airship` | h | done |
| 13 | Eagle / Dragon: flapping flight, soaring, perch, screech / fire breath, ignition service, fauna threat | `p3/craft-eagle` | h | done |
| 14 | Spaceplane: rocket, RCS blend, Mach / altitude / apogee, re-entry heating, plasma, blackout, hypersonic glide | `p3/craft-spaceplane` | h | done |
| P | Picker rework (groups, skins, favorites 1-0, HOTAS cycling), situational spawn rules, director updates (ground track, craft weighting, combos, global overrides) | `p3/picker-director` | h.7, i | done |
| I2 | Integration pass: merge 2.0 first (before the craft branches start), then the craft branches in catalog order and the picker / director branch; `?test=craft` on both backends | `v2-phase3` | | done |

### Wave 2 - p3/craft-framework

- **Done** (contract h.9; what was built, beyond the letter of h, is in contract h.10):
  - catalog (`src/craft/registry.js`): the eight Phase 3 entries with picker silhouettes, `group`
    on every entry, `CRAFT_GROUPS` / `CRAFT_GROUP_LABELS`, `registry.groups()`, `entry(id)`,
    `createCraftRegistry(catalog, groups)` (labs) and the optional-field validation of h.2;
  - settings v6: `CRAFT_IDS` (14), `craftFavorites` (ten slots, a list key), `craftSkins`, the
    migration (new craft at their defaults, at 50 % when the HOTAS default had run);
  - actions: `craftSelect1-10` ("Favorite 1-10", keys 1-9 and 0), `craftAbilityAlt` (Shift+Space,
    TWCS button 10; no gamepad default: every button is taken); favorites and cycling in
    `performAction`; a module's `bindings` as per-craft defaults in the binding store;
  - the controller: `situate(situation, api)` with seven placement modes and `flight.startAt`,
    `input.presetThrottle`, both ability slots and the ability api (`isHeld`, `controls`,
    `colliders`, `waterQuery`, `wind`, `setCraftState`, `emitTrail(..., 'smokeColor')`, ...),
    `runCraftCommand` / `getCraftCommands` / `getCraftStatus`, skins (`buildMesh(ctx, { skin })`,
    mesh-only rebuild), `visual.craftState`, `env.windField`, `state.flight.ceiling`,
    `limits.waterLanding`;
  - custom cockpits (`style: 'custom'`, `build(builder, spec, THREE)`);
  - the copilot: `craftCommand` (schema, local phrase matching with the capture group as the value,
    the executor, `flightState.craftCommands` / `craftStatus`, "systems check"), the reference
    server and docs/copilot-api.md;
  - the journal: records v2 with `craftTime` per craft, `journalStatInfo` for module stats;
  - `?test=craft` (`src/dev/craftTest.js`, `src/dev/craftScenarios/` with a file per existing craft),
    `run-harness --test craft`, npm `test:craft` / `test:craft:webgl`, `lab:craft`;
  - help panel and controls panel follow the favorites; docs: architecture.md ("How to add a
    craft", the module, controller and settings tables, the test tables), controls.md, the contract's
    h.10.
- **Labs** (new or extended): `tools/lab/craft.mjs` 66/66 (new), settings 45/45 (migrateV5,
  favorites), copilot 240/240 (craftCommands), discovery 43/43 (craftTime).
- **Fixes found on the way:** the 14-button picker overlapped the compass at 1280 px (buttons now
  26 px wide; the picker / director branch regroups them); the HOTAS test's persistence binding
  moved from TWCS index 9 (now `craftAbilityAlt`) to index 10.
- **Verified 2026-10-08** (each once, both backends unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built, no dev kit in the V2 bundle (craftTest, craftScenarios, collisionTest, spawnCheckKit, shadowResizeCheck), one three.js core | |
  | Labs: craft 66, settings 45, copilot 240, copilot-server 17, discovery 43, flight-lab 82, atmosphere 28, challenges 70, colliders 84, director 50, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden (goldens identical), setpiece 47, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, wingsuit 37, audio 191 (alone; 190/191 on the first run, the WebGPU waterfall distance law 1.22 dB, 191/191 on the rerun; src/audio untouched) | all pass | |
  | `run-harness --test craft` (six craft: the general test in both views and 13 scenario runs) | PASS 25/25 runs, 61/61 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 | PASS 25/25, same |
  | `run-harness --test hotas` | 140/140 | 140/140 |
  | Step files view-physics, copilot-guide, input-review, discovery, hotplug | all pass, 0/0 (hotplug: the first WebGPU run failed its device-source checks with a duplicate stick key, `044f-b10a#2`, while the HOTAS harness was still plugging; passed on the rerun) | all pass, 0/0 |
  | `run-harness --test 1` reduced (HARNESS-1/2, glider and jet, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, heap 18.93 MB, 8/8 runs, 24/24 manoeuvres; frames over 50 ms: 1 (mainThread) | same criteria pass, heap 9.04 MB; frames over 50 ms: 5 (mainThread, gc) |
  | Built `dist-single/v2` and the built shell smoke | 0/0, screenshots differ | 0/0, screenshots differ (V2) |

- **Next:** I2 merges this branch alone; then the eight craft branches and the picker / director
  branch start from it.
- **Open issues:** the copilot's "switch to [craft]" synonyms for the eight new craft (and skins by
  name: "dragon") are Milestone O's (j.2), as are the journal panel's Craft section and the remote
  `flightState` craft fields of h.3; the picker shows the 14 craft in one strip until the picker
  branch regroups them.

### Wave 2 - p3/craft-aerobatic

- **Done** (contract h; the craft's reference is [docs/aerobatic.md](aerobatic.md)):
  - the module `src/craft/aerobatic.js`: an Extra 330 class mesh (low tapered symmetric wing with
    near-full-span ailerons and their spades, bubble canopy, big rudder and elevator, wheel pants,
    three-blade prop; ailerons, spades, elevator, rudder, tail wheel and prop animate; the cockpit deck
    hides in first person), its profile, Space smoke / Shift+Space colour, `situate`, per-craft
    bindings (the gamepad's and T.16000M's gear button cycles the colour: fixed gear), copilot
    commands (`smoke`, `smokeColor`, `lastFigure`, `figures`) and status, a `canopy` cockpit with the
    new `smoke` and `figure` instruments, journal stats (each figure's best score, op `max`);
  - the model kind `aerobatic` (SimFixedWing; `src/flight/aerobaticAssists.js`): no attitude
    protections at any level; coordination, yaw damper, auto-trim and stall warning to 50 %; AoA
    limiter (both signs), G limiter (+8.5 / -6 g), auto-level and overspeed protection to 100 %; the
    fixed-wing autopilot and trim reused;
  - the extension `aerobaticAero` (`src/flight/aerobaticAero.js`): the stalled wing's roll-damping
    reversal (snap rolls), and the figure judging on the 120 Hz flight clock;
  - the recognizer `src/flight/maneuverRecognizer.js` (pure, allocation-free): the 12 figures, each
    scored 0-100, the lomcevak credited only at 25 % assists or less; the typed event `figureFlown`,
    a toast and a `journalStat` per figure; `craftState.figureInProgress` / `lastFigure`;
  - the smoke ribbon `src/render/smokeRibbon.js` (one pooled 1024-sample mesh, sunlit, camera-facing,
    drifting with the wind, fading over 30 s, re-anchored every 2 km) plus puffs at the nozzle;
  - the audio family `aerobaticProp` (the prop family plus the high-rpm snarl and the smoke hiss);
  - tests: `tools/lab/aerobatic.mjs` (79 checks), `src/dev/craftScenarios/aerobatic.js` (loop, aileron
    roll, smoke, snap roll), the `?test=1` flight script, the view-physics step.
- **Edits outside the craft's own files** (single lines unless noted): `src/craft/index.js`,
  `src/flight/models.js` (kind and `MODEL_KINDS`), `src/audio/engines/index.js`,
  `src/ui/instruments/index.js`, `src/dev/craftScenarios/index.js`, `src/core/events.js` (`figureFlown`
  after `challengeCancelled`), `tools/steps/view-physics.json` (one step, and the closing count), `src/dev/testFlightScripts.js`
  (the script, its map entry and `SCRIPTED_CRAFT`), `src/dev/testHarness.js` (the `smokeSeconds`
  observation, three lines), `tools/lab/craft.mjs` (the catalog checks follow the registered craft) and
  `src/gameplay/journal.js` (the module-stat cache rebuilds when a module is replaced).
- **Fixes found on the way:** the journal's module-stat cache keyed on craft ids only, so a module
  replaced under the same id (the craft lab's test craft) kept stale stats; it now keys on the module
  objects. The view-physics step's closing check expected exactly six craft; it now expects every
  flyable craft. A figure's score was computed after its window was cleared (the Cuban eight's lobe
  symmetry read no markers); it is scored first now.
- **Verified 2026-10-08** (each once unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1`, `docs-check` 240/240 | built; the V2 bundle holds no craft scenarios, one three.js core | |
  | Labs: aerobatic 81/81 (`--expose-gc`), craft 66, discovery 43, copilot 240, copilot-server 17, settings 45, flight-lab 82, jet 60, helicopter 46, wingsuit 37, fpv 87, input 34, atmosphere 28, colliders 84, director 50, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden 6, setpiece 47, spawns 98, storage 54, structure 75, terrain 404, wind-engines 56; challenges 70, origin 32, fauna-modes 44 (their allocation checks need `--expose-gc`: 68/70, 31/32, 42/44 without it, all pass with it); water 33/34 (its open-ocean `heightAt` cost check, 1.29 us against 1 us, under the machine's load; water code untouched) | as listed | |
  | `run-harness --test craft --crafts aerobatic` at the branch head (general test in both views, loop and roll in both views, smoke, snap) | PASS 8/8 runs, 25/25 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 | PASS, same |
  | `run-harness --test craft` (all seven craft, 33 runs) | an earlier head: 81/86 checks, the aerobatic's roll and snap scripts and one general-test dive at p99 147-266 ms (machine at 100 %); the scripts were made frame-proof and the hands-off levelling faster, then the aerobatic set passed on both backends (row above) | PASS 33/33 runs, 86/86 checks, 0/0 (before those fixes) |
  | `run-harness --test 1` reduced (HARNESS-1/2, aerobatic, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, heap growth 2.49 MB, 12/12 manoeuvres (smoke included); frames over 50 ms: 75 (main thread 52, delayed 15, gc 5, systems 3; machine CPU 100 %) | same criteria pass, heap 6.18 MB; frames over 50 ms: 410 at 25 fps (another Chrome at 63 % CPU; slow frames led by camera, terrain, flight, birds) |
  | `tools/steps/view-physics.json` on built V2 (`?debug=1`) | 7/7 craft identical in every view, 0/0 | 7/7, 0/0 |
  | Built `dist-single/v2` and the built shell smoke | 0/0, screenshots differ (shell too) | 0/0, screenshots differ |

- **Next:** I2 merges this branch after 2.0, in catalog order (aerobatic is the first new craft).
- **Open issues:** the reduced flight harness's frames over 50 ms (machine load; a node benchmark puts
  the aerobatic's physics tick at about 50 us warm against the bush plane's 30 us, the recognizer and
  the autorotation included); the journal panel's Figures section (counts per figure from
  `figureFlown`) and the copilot's cross-craft "smoke on / off" are Milestone O's (j.1, j.2).

### Wave 2 - p3/craft-seaplane

- **Done:** the floats extension (`src/flight/floats.js`: per-station buoyancy of two
  V-bottomed floats against the shared water query, planing with the keel slopes and a Froude onset,
  displacement drag with the hump near 40-45 km/h, porpoising from the held trim, water rudders,
  wheel drag and the nose-over, the wheels-up skid on land, water strikes, the gear advisory, the
  water handling assist above 50 %); a `contactForces` hook in SimFixedWing (plus tick fields and the
  extension's `dispose`); the seaplane module (`src/craft/seaplane.js`: Beaver-style mesh with
  animated gear legs and water rudders, sim profile, situate, copilot commands, journal stats,
  bindings); the `radial` audio family; the `waterRudder` instrument; `tools/lab/seaplane.mjs`
  (113/113); the craft lab's catalog checks now follow the registered modules.
- **Also done:** the `?test=craft` scenarios (`src/dev/craftScenarios/seaplane.js`: `seaplane-ocean` and
  `seaplane-lake`, a full circuit each from a fixed start in the CRAFT-1 'waters' world, takeoff and
  landing on the water, in both views; `seaplane-nose-over`, the gear advisory then the soft crash);
  the seaplane in the `?test=1` flight scripts and the view-physics step file; the docs
  (architecture.md: floats.js, the module, the `contactForces` hook, the craftState fields, the radial
  family and the lab; controls.md: the seaplane row).
- **Verified 2026-10-13** (each once):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `run-harness --test craft --crafts seaplane` (general both views, ocean and lake both views, nose-over) | PASS 7/7 runs, 29/29 checks, 0 NaN, 0 penetrations, 0 soft crashes (the nose-over's allowed one aside), 0/0 (the first attempt timed out navigating the cold dev server; the rerun passed) | PASS 7/7, 29/29, same |
  | `node --expose-gc tools/lab/seaplane.mjs` | 113/113 (without `--expose-gc` its allocation check fails by design, 112/113) | |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built; no scenario code in the V2 bundle | |
  | Labs: atmosphere 28, challenges 70, colliders 84, copilot-server 17, copilot 240, craft 66, director 50, discovery 43, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden 6/6, setpiece 47, settings 45, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, wingsuit 37, flight-lab 82 | all pass | |
  | Audio lab (`tools/lab/audio.mjs`, beside other engineers' Chrome runs) | 189/191 twice, a different pair each time: the WebGPU thunder trigger (5.8 and 5.9 dB against 6; the recipe is random per render, 7.3-7.4 dB on other renders), the WebGPU doppler (1.99 %) and the WebGL2 waterfall distance law (1.22 dB); `--only recipes --backend webgpu` 75/75 on this branch and on the v2-phase3 sources; the branch only adds the `radial` family, which the lab does not exercise | |
  | `run-harness --test 1` reduced (HARNESS-1/2, seaplane and glider, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, 8/8 runs, 24/24 manoeuvres, heap 7.22 MB; frames over 50 ms: 7 (main thread, systems 0) | same criteria pass, heap 8.99 MB; frames over 50 ms: 9 (main thread 8, delayed 1, systems 0) |
  | `run-harness --test hotas` | 140/140, 0/0 | |
  | Step file view-physics on built V2 (`?debug=1`) | 7/7 craft identical in every view (seaplane max difference 1.9e-12), 0/0 | 7/7 (seaplane 0.0), 0/0 |
  | Built `dist-single/v2` and the built shell smoke | 0/0 each, screenshots differ | 0/0 (V2), screenshots differ |

- **Next:** I2 merges this branch in catalog order (after the aerobatic branch).
- **Merge notes:** list-append lines in `src/craft/index.js`, `src/audio/engines/index.js`,
  `src/ui/instruments/index.js`, `src/dev/craftScenarios/index.js` and `testFlightScripts.js`
  (`SCRIPTED_CRAFT`); `tools/steps/view-physics.json` gains one `check('seaplane')` step, and its last
  step now expects every registered craft; SimFixedWing gains the `contactForces` hook (one call after
  the ground contact), the tick's `position` / `velocity` / `quaternion` / `contact` and the
  extension's `dispose`; the craft lab's availability checks follow the registered modules.
- **Open issues:** the frames-over-50-ms criterion of the reduced `?test=1` (main thread, no game
  systems; owner's rule); the audio lab's random thunder render and live-timing checks (see the table).

### Wave 2 - p3/craft-tiltrotor

- **Done** (contract h; spec Milestone D item 9):
  - model kind `tiltrotor` (`src/flight/SimTiltrotor.js`): nacelles 0-97 degrees at 8 deg/s with the
    detents 0 / 60 / 90 (flap buttons step them, the HOTAS antenna sets them, 60 degrees minimum on
    the wheels); two counter-rotating blade-element proprotors with flapping, blowback and
    SimHelicopter's inflow (vortex ring per rotor, blade stall, ground effect); the FCS collective
    schedule (the lever spans the helicopter range until the wing carries the weight, then the
    airplane range; an axial-inflow bias; a governor trim at the engines' limits), 100 % to 84 % rpm;
    the wing in the rotor wash (7 % download in the hover), drooping flaperons, H tail with downwash,
    nacelle and gear drag, rotor strikes; hover: stick = cyclic + differential collective, pedals =
    differential cyclic; airplane mode: flaperons, elevator, rudders;
  - the conversion corridor (`src/flight/tiltrotorCorridor.js`): lower edge from the wing's lift at
    0.9 x flapped CLmax plus the rotors at 1.15 x weight, upper edge from a 55 m/s edgewise limit;
    the auto-nacelle schedule holds the selection 5 degrees inside it; outside it the wing-stall or
    rotor-overspeed state, warnings and real consequences (the wing stalls and the craft sinks; the
    raised discs blow back, the retreating blades stall, the craft slows hard and pitches up);
  - assists, autopilot (converts on the schedule, climbs clear of terrain first) and trim in
    `src/flight/tiltrotorAssists.js`;
  - the craft module `src/craft/tiltrotor.js` (Osprey-style mesh: tilting nacelles, proprotors and blur
    discs, flaperons, elevator, rudders, folding gear; cabin cockpit; auto-nacelle ability; situate
    (hover when slow or low, else airplane mode on the schedule, ground when landed); copilot
    `nacelle`, `airplaneMode`, `hoverMode`, `autoNacelle` and a status line; journal
    `tiltrotorConversions`, `tiltrotorFastestConversion`; Page Up / Page Down keyboard bindings), the
    `proprotor` sound family (slap with the nacelles up, drone tilted forward, rotor beat), the
    `nacelle` corridor instrument, pinned on the HUD through the new optional module field `hud`
    (`src/ui/instrumentHud.js`, one line in `src/camera/cameraManager.js`);
  - tests: `tools/lab/tiltrotor.mjs` (41 checks), `src/dev/craftScenarios/tiltrotor.js` (full
    conversion both ways, overspeed, wing stall), the view-physics step file (now counts every
    registered craft), the `?test=1` flight scripts; the craft lab accepts newly registered modules.
- **Verified 2026-10-08** (each once unless noted):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built; no dev kit in the bundle, one three.js core | |
  | Labs: tiltrotor 41/41, craft 66, flight-lab 82, helicopter 46, jet 60, wingsuit 37, fpv 87, settings 45, copilot 240, copilot-server 17, discovery 43, atmosphere 28, challenges 70, colliders 84, director 50, input 34, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden, setpiece 47, spawns 98, storage 54, structure 75, wind-engines 56; origin 32, fauna-modes 44, water 34, terrain 404 (their allocation checks need `--expose-gc`; without it they miss one each) | all pass | |
  | Audio lab (alone, three runs) | 190/191 each time, a different check: the WebGL2 camera-cut doppler twice, the murmuration loudness once; the base sources passed 191/191 in one run; src/audio only gains the unused-elsewhere `proprotor` family | |
  | `run-harness --test craft --crafts tiltrotor` | PASS 7/7 runs, 31/31 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 | PASS 7/7, 31/31, same |
  | `run-harness --test craft` (all seven craft) | PASS 32/32 runs, 92/92 checks, 0/0 | |
  | View-physics step file | 7/7 craft identical in every view, 0/0 (dev server) | 7/7, 0/0 (built, `?debug=1`) |
  | `run-harness --test 1 --crafts tiltrotor` (HARNESS-1/2, both views, 60 s) | 0 NaN, 0 penetrations, 0 soft crashes, 0/0, heap +14.7 MB max, script 12/12; frames over 50 ms: 650 (machine CPU 100 %, other processes 63 %; main thread 413, systems 136 spread over camera, terrain, flight, spawns) | same criteria pass, heap +8.1 MB; frames over 50 ms: 574 |
  | `run-harness --test hotas`, input-review step file | 140/140, 0/0; input-review 0/0 | |
  | Built V2 smoke flying the tiltrotor (hover, airplane mode, cockpit); built shell smoke | 0/0, screenshots differ | 0/0, screenshots differ |

- **Next:** I2 merges this branch after the framework.
- **Open issues:** the flight model tick boxes doubles across calls V8 does not inline (about
  1.4 KB per tick against the helicopter's 1 KB in node; no per-tick objects), as every flight model
  does; Milestone O's copilot "switch to the tiltrotor" synonyms and the remote `flightState`
  nacelle field (h.3, j.2).

### Wave 2 - p3/craft-paraglider

- **Done:**
  - `src/flight/SimParaglider.js` (model kind `paraglider`): canopy and pilot as two masses on
    inextensible, slackable lines (an impulse and a projection, two substeps per tick), the canopy's
    own yaw, its incidence to the lines (rigging, brakes, bar, big ears, pitch inertia against the
    swing, the surge out of a stall), the WindField probed at the canopy, per-half aerodynamics
    (span-scale gusts from the turbulence, brake camber, open share), collapses (pressure angle under
    the collapse angle for 0.1 s; reinflation with airspeed, a pumped or held brake), the stall, the
    ground (feet as a braked wheel, the seat as a skid), landing (the wing killed and laid down), the
    launch run (inflation arc, run force, lift-off) and water landings (floating, graded). The kind's
    assists (collapse recovery and surge damping from 0 %, turn coordination from 25 %, active
    piloting, stall protection and spiral exit toward 100 %) and autopilot (heading by weight shift
    and brake, speed by the bar). Targets: trim 38.1 km/h at 8.9 : 1, full bar 50.2 km/h, 23.8 km/h
    on deep brakes, big ears 2.5 m/s down.
  - `src/craft/paraglider.js`: the mesh (a 16-cell elliptical wing re-skinned every frame: brake
    flaps, big ears and collapses folded about hinge ribs, flutter, crumpled while deflated and rising
    on the inflation arc; 32 line segments; the pilot in a harness with IK arms on the brake handles,
    IK legs on the speed bar, standing and striding on the ground, leaning into a weight shift), the
    harness cockpit (custom: the flight deck, the pod, the straps), `situate` (flying at trim; below
    60 m AGL or landed: standing on the nearest launch slope, downhill and into the wind, the run
    requested), the big-ears ability (held; B toggles a latched pair; a splashdown relaunches from a
    slope), copilot commands `bigEars`, `speedBar`, `launch`, `findThermal` and a status line,
    journal stats `paragliderBestClimb`, `paragliderBestGain`, `paragliderSlopeLaunches`,
    `paragliderCollapses`, per-craft bindings (standard gamepad: the analog triggers are the brakes,
    the bumpers the speed bar; TWCS button 5: big ears), collision probes along the wing and the line
    curtain, the director profile and fauna threat 0.7.
  - `src/audio/engines/paraglider.js` (canopy flutter, rush, line whistle on the bar, collapse snap
    and reinflation pop; the shared vario on by default) and `src/ui/instruments/speedBar.js` (the
    wing display: brakes, bar, folded tips and collapsed sides, the state in words).
  - `tools/lab/paraglider.mjs` (45 checks) and `src/dev/craftScenarios/paraglider.js` (thermal climb
    in both views, the sun held at noon; big ears; a launch through WREN's `launch` command in both
    views); a paraglider script in `src/dev/testFlightScripts.js` for `?test=1`.
- **Fixes found on the way:** the harness shell loft had no half widths (NaN positions: a
  `computeBoundingSphere` error at the craft switch); a launch request placed exactly at the surface
  was dropped before the feet touched; half a brake hardly turned (a trailing-edge yaw term now; full
  brake spins at 0 %, the spin and spiral protection holds it below 55 deg/s toward 100 %); the
  sky's midday warp carried the sun (and the thermals) away within a minute of a `time: 0.5` start,
  so the thermal scenario holds noon.
- **Verified 2026-10-08** (each once, both backends unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `tools/lab/paraglider.mjs` | 45/45: trim 38.1 km/h at 8.9 : 1 (sink 1.18 m/s), full bar 50.2 km/h at 6.2 : 1, half brakes 28 km/h at 0.98 m/s, deep brakes 23.8 km/h, stall at 0 % and the surge out, half-brake turn 24.9 deg/s, full brake spins at 0 % (128 deg/s) and holds 44 deg/s at 100 %, weight shift 11 deg/s, big ears 2.5 m/s, pendulum swings 22 / 8 / 3 deg, 4 m/s thermal climb 2.2 m/s with the journal's gain and best climb, collapses at 0 % (reopen in calm air), none at 100 %, landing, slope launch, water landing, 28 800 random ticks finite, the model module allocates no objects (58 B/tick of boxed numbers, bound 64) | |
  | `run-harness --test craft --crafts paraglider` (general in both views, thermal climb x2, big ears, launch x2) | PASS 7/7 runs, 24/24 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 (the thermal climb failed on earlier runs until the sun was held at noon) | PASS 7/7, 24/24, same |
  | View physics (view-physics.json with the paraglider only, scratch copy) | PASS, max difference 0 | PASS, 4.2e-12 |
  | `run-harness --test 1 --crafts paraglider --seconds 30` (HARNESS-1, both views) | 0 NaN, 0 penetrations, 0/0, heap growth 2.9 MB, script 8/8; frames over 50 ms: 6 (systems 0; main thread 5, gc 1, machine CPU 93-97 %) | 0 NaN, 0 penetrations, 0/0, heap growth 6.9 MB, script 8/8; frames over 50 ms: 6 (systems 0; main thread 4, gc 1, delayed 1) |
  | Labs: craft 66, settings 45, copilot 240, copilot-server 17, discovery 43, flight-lab 82, wingsuit 37, input 34, atmosphere 28, challenges 70, colliders 84, director 50, fauna-modes 44, fpv 87, helicopter 46, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden, setpiece 47, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, audio 191 | all pass | |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, docs-check 236/236 | pass; no dev test code in the V2 bundle | |
  | Built `dist-single/v2` (switch to the paraglider, both views) and the built shell | 0/0, screenshots differ | 0/0 (V2), screenshots differ |

- **Next:** I2 merges this branch in catalog order.
- **Open issues:** see the integration notes in the final report: the shared-file lines (craft,
  model, audio, instrument and scenario lists, the craft lab's catalog check, the flight harness
  script table) conflict with the other craft branches by design; view-physics.json needs its
  `check('paraglider')` line and the count bumped at integration; docs/architecture.md and
  docs/controls.md (the HOTAS profile) get the paraglider rows in Milestone O.

### Wave 2 - p3/craft-balloon

- **Done** (contract h; spec Milestone E item 11):
  - `src/flight/SimBalloon.js` (kind `balloon`): lift = (rho_ambient - rho_hot) x V x g with the shared
    density model and ISA temperatures, one envelope temperature state (burner through a 4 s plume,
    fabric convection and radiation, parachute and rotation vent outflow, adiabatic cooling) giving a
    20-30 s thermal lag; drag pulls it to the WindField at its height; the rig swings as a pendulum
    about the centre of buoyancy; basket skids bounce and drag, float on water
    (`limits.waterLanding 'basket'`), a vented envelope collapses on the ground and the burner
    reinflates it; a ground start is tied down until it lifts. Assists: over-temperature protection,
    rotation damping, altitude hold (auto-burner in blasts, lag-aware, raised over the terrain under
    the drift); the autopilot flies altitude and basket heading; the copilot's assisted landing.
  - `src/craft/balloon.js`: the v1 balloon family envelope (shared with the fair landmarks through
    `src/world/balloonFamily.js`), basket, burner frame, tanks and pilot; animated flame, pilot lights,
    glow through the fabric, parachute vent, rotation vent flaps, breathing and collapse, the pilot's
    arm; first person in the basket (custom cockpit, instrument pack on the front upright); bindings
    for keyboard, gamepad, T.16000M and TWCS; abilities burner (held) and parachute vent (held); the
    wind-layer column sampled once a second in `craftState.windColumn`; copilot burn, vent, steer by
    layer ("take us east"), wind report, land, status; journal stats; `situate()` = drift at the
    current height (ground or water when the previous craft was).
  - `src/audio/engines/burner.js`: burner roar, rumble and jet hiss with a whump, pilot-light hiss,
    vent rush, basket creaks on blasts, swings, touchdowns and drags; otherwise near silence.
  - Instruments `envelope` and `windColumn`; the instrument HUD shows a craft's `hudInstruments` in
    the third-person views with the overlay off.
  - Tests: `tools/lab/balloon.mjs`, `src/dev/craftScenarios/balloon.js` (wind layer, drift start,
    burner lag, landing, bounce and drag, rotation, steer, water), the flight-test script, the
    view-physics step.
- **Outside the craft files (all needed by the balloon):** `src/world/balloonFamily.js` (new) and
  `src/world/landmarks.js` (the fair balloons import the shared profile, palettes and patterns;
  unchanged output); `src/camera/cockpit.js` (the glareshield follows a panel's x, so an
  off-centre panel keeps its hood); `src/ui/instrumentHud.js` (module `hudInstruments` shown in the
  third-person views with the overlay off); `src/dev/testFlightScripts.js` (a balloon script);
  `tools/lab/craft.mjs` (its catalog check accepts registered Phase 3 craft);
  `tools/steps/view-physics.json` (flies the balloon and fails on any registered craft not flown).
- **Verified 2026-10-13** (each once, both backends unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built, V1 untouched | |
  | Labs: balloon 66/66 (new), craft 66, flight-lab 82, audio 191, atmosphere 28, challenges 70, colliders 84, copilot 240, copilot-server 17, director 50, discovery 43, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden (identical), setpiece 47, settings 45, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, wingsuit 37 | all pass (the allocation labs with `--expose-gc`) | |
  | `run-harness --test craft --crafts balloon` (general test both views, 12 scenario runs) | PASS 14/14 runs, 50/50 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 (rerun; the first run had the same 50/50 and one `WebGPU Device Lost: A valid external Instance reference no longer exists` console error from the shared GPU) | PASS 14/14, 50/50, 0/0 |
  | `run-harness --test 1` reduced (HARNESS-1/2, balloon, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, heap 7.08 MB, 4/4 runs, 8/8 manoeuvres; frames over 50 ms: 145 (mostly mainThread at 100 % machine CPU) | same criteria pass, heap 6.89 MB; frames over 50 ms: 66 |
  | Step file view-physics (now 7 craft) | 7/7 identical, 0/0 | 7/7, 0/0 |
  | Built `dist-single/v2` and the built shell smoke | 0/0, screenshots differ | 0/0 (V2) |

- **Next:** I2 merges this branch in catalog order.
- **Open issues:** frame time (owner's rule, one line): the reduced flight test's slow frames were
  spread over camera, terrain, spawns, clouds and flight at 99-100 % machine CPU, no system
  consistently. The burner's flame light is the emissive flame, glow sprite and the fabric lit
  from inside (no pooled PointLight, so the light pool's spawn budget is untouched).
  docs/architecture.md rows for SimBalloon, balloon.js and balloonFamily.js are left to I2 /
  Milestone O to avoid nine-way table conflicts.

### Wave 2 - p3/craft-airship

- **Done** (contract h, spec Milestone E item 12):
  - flight model `src/flight/SimAirship.js` (kind `airship`): Archimedes on a fixed helium mass with
    ballonets (neutral pressure height 2397 m, a static ceiling above it), the ballonet trim as the
    static-heaviness control (helium into compression tanks, +/-262 kg at the end stops, the blowers
    take 20 s end to end), added mass (k1 0.06, k2 0.82 of the displaced air), the gondola pendulum,
    hull axial and crossflow drag, viscous hull lift and the Munk moment, four tail fins in their own
    local flow (elevators, rudders: 2 % of their cruise authority at walking pace), two vectored props
    (-45 to 120 degrees on the rocker, 30 deg/s servos, differential thrust on the rudder) and a
    lateral stern thruster that fades out from 6 to 14 m/s, wind drift and gust shaking; assists
    (pitch and yaw dampers from 0 %, heading hold from 50 %, altitude hold from 75 %) and an autopilot
    (heading or crabbed ground track, altitude with a 60 s terrain look-ahead, speed through the
    throttle, the scenic cruise's photo pace);
  - craft `src/craft/airship.js`: a 62 m semi-rigid airship mesh (envelope with an orange belly band,
    cruciform tail with moving elevators and rudders, glazed gondola, swivelling prop pods with
    spinning pusher props, the stern ducted fan, landing wheels, nav lights, a breathing envelope), the
    gondola as a custom cockpit (the instrument panel under a raked windshield, window band, seats,
    levers), input profile (throttle, antenna `ballonet`, rocker `vector`; the flap keys / buttons held
    fill or empty the ballonets; the standard gamepad swivels the pods on B / X), audio profile,
    camera rig (chase at 92 m, a pod camera, the gondola), instruments, collision probes along the
    hull, `situate` (trimmed neutral at the current height, under the pressure height, at most the
    cruise, drifting when slow), copilot commands `scenicCruise`, `ballonet`, `vector` and the status
    line, journal stats `airshipCruiseSites` and `airshipLongestCruise`, the director profile (calm,
    slow, spectacle);
  - the scenic cruise `src/craft/airshipCruise.js` (Space): plans a chain of three sites from the
    director's `getNearby()` (live spawns first, sites; not dormant candidates or sky-wide events) and
    the landmarks, aims each leg at a viewing point 260 m beside its site, one altitude clear of the
    ground (470 m over balloon fairs) under the pressure height, a Catmull-Rom path (pathFollower
    `createPath`); the autopilot chases a point 420 m ahead, crabbing into the wind; photo mode slows it
    to 65 %; passing a site counts it and the next chain follows; the stick or the autopilot key ends it;
  - audio family `airshipProp` (twin prop drone with its slow beat, stern fan, ballonet blowers, the
    envelope creaking under load) and the `ballonet` instrument (ballonet fill and target, heaviness,
    the pods' thrust line, the pressure height or the cruise's next site);
  - tests: `tools/lab/airship.mjs`, `src/dev/craftScenarios/airship.js` (`airship-scenic-cruise`,
    `airship-vector-ballonet`, the general test tuned to full 3 s pulses), the airship in the ?test=1
    flight harness (`src/dev/testFlightScripts.js`).
- **Edits outside the craft files:** the single lines of the framework notes (craft/index.js,
  flight/models.js, audio/engines/index.js, ui/instruments/index.js, craftScenarios/index.js);
  `tools/lab/craft.mjs` (its catalog check accepted only the Phase 1 six: it now accepts every
  registered catalog module); `src/dev/testFlightScripts.js` (the AIRSHIP script, its SCRIPTS entry
  and SCRIPTED_CRAFT).
- **Verified 2026-10-08** (each once unless noted; the machine ran at about 91 % CPU from other
  programs throughout):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built; no dev kit (craftTest, craftScenarios, testFlightScripts) in the V2 bundle | |
  | `tools/lab/airship.mjs` 47/47: pressure height 2397 m, heaviness +/-262 kg, neutral 0.0 m in 60 s, static climb 3.07 / sink 3.17 m/s, static ceiling within 3 m, cruise 21.9 m/s at 0.43, top 30.3 m/s, 17 s to 15 m/s, 238 s engines-off coast, vectored climb 5.6 m/s, turn 2.2 deg/s, fins 1.9 % at 3 m/s, stern thruster 3.3 deg/s at rest, drift 9.3 m/s after 300 s, pendulum, 0 % stability, 100 % holds, autopilot, crab, ridge, cruise (3 sites, photo pace 13.6 m/s), landing, copilot, situate; step 16 B/tick over the shared calls, assists 0 B, autopilot 32 B/tick (look-ahead queries) | all pass | |
  | Labs: craft 66, atmosphere 28, challenges 70, colliders 84, copilot 240, copilot-server 17, director 50, discovery 43, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden (identical), setpiece 47, settings 45, spawns 98, storage 54, structure 75, terrain 404, wingsuit 37, flight-lab 82, wind-engines 56 (55/56 on the first run, 56/56 on the rerun) | all pass | |
  | water lab | 33/34: only `[cost] heightAt over the open ocean` 1.12 us against 1 us (machine load; no water code touched) | |
  | audio lab | 188/191 and 189/191: thunder trigger 4.9-6.0 dB over the median against 6 (a recipe render, no recipe touched) and the WebGL2 doppler camera-cut check; the base commit 81594f2 failed the same WebGL2 doppler check (190/191) | |
  | `run-harness --test craft --crafts airship` (general in both views, `airship-scenic-cruise` and `airship-vector-ballonet` in both views) | PASS 6/6 runs, 24/24 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0; the cruise visited 3 sites at 355 s (third) and 244 s (first) | PASS 6/6, 24/24, same; 3 sites at 355 s and 221 s |
  | `run-harness --test 1 --seeds HARNESS-1,HARNESS-2 --crafts airship --seconds 20` | 0 NaN, 0 penetrations, 0/0, heap 8.99 MB, 4/4 runs, 8/8 manoeuvres; frames over 50 ms: 183 (14 attributed to systems, spread over spawns, camera, waypoints, birds: machine load) | same criteria pass, heap 4.37 MB; frames over 50 ms: 209 (28 to systems, spread over input, camera, terrain, flight, journal) |
  | Built `dist-single/v2` smoke with the airship (switch, scenic cruise, gondola and pod views) and the built shell | 0/0, screenshots differ | 0/0, screenshots differ |

- **Next:** I2 merges this branch in catalog order.
- **Open issues:** the ability api has no event bus, so the cruise records its journal stats through
  `systems.journal.recordStat` (no typed `journalStat` event); docs/controls.md (the airship's HOTAS
  profile), docs/copilot-api.md (the three craft commands) and docs/architecture.md (model kind,
  instrument, craftState fields) are Milestone O's; a stand-alone T.16000M has no default vector
  binding (the TWCS rocker is the vector lever).

### Wave 2 - p3/craft-eagle

- **Built** (contract h; additions in the final report and docs/architecture.md):
  - `src/flight/SimFlapper.js` (kind `flapper`): flap power on the throttle axis (0 = glide), the
    tuck (stick pushed hard, or `craftAbilityAlt` held) into a 65 m/s stoop, soaring on the
    WindField's thermals and ridge lift, the perch (scan, auto-landing, standing, takeoff, ground
    stand, resting placements), its assists (stability with a phugoid damper, auto-level, stall
    protection) and its autopilot (energy control; the perch approach for the copilot);
  - `src/craft/eagle.js` + `eagleMeshes.js`: the module with two skins (bald eagle; dragon with
    membranes, jaw, tail chain and flame jet), collision probes, `situate`, abilities (screech /
    fire breath, tuck), copilot commands (findPerch, takeOff, screech, fireBreath, tuck, glide) and
    status, journal stats (eaglePerches, eagleBestSoar, dragonLanternsLit), per-craft bindings,
    directorProfile, faunaThreat 2.5, the creature first-person view, the perch camera orbit;
  - `src/audio/engines/creature.js`, `src/ui/instruments/perch.js`, `src/gameplay/ignition.js`
    (`ctx.ignition`), the typed `perched` event, `cameraRig.chase.orbitYaw` in the camera;
  - `tools/lab/eagle.mjs` (50 checks: glide polar, flapping climb, stoop, handling, thermal and
    ridge soaring, perch capture / hold / takeoff / tailwind hop, peak and ground stands, placements,
    the autopilot approach on flat ground, a hillside and the real CRAFT-1 tree tops, takeoffs and
    fly-outs there, ignition, the step's allocation in a clean child process);
  - `src/dev/craftScenarios/eagle.js` (hand-flown perch and takeoff, the copilot's "find a perch",
    a perch placement, ground takeoff, stoop, dragon fire); the eagle script in the `?test=1`
    harness (`testFlightScripts.js`); the eagle in `tools/steps/view-physics.json`.
- **Edits outside the craft files** (each needed): `main.js` (`ctx.ignition`), `events.js` (`perched`
  after `landed`), `FlightController.js` (the ability api's `ignition`), `cameraManager.js`
  (`chase.orbitYaw`), `cockpit.js` (a custom view with `layout: []` has no panel), `craftTest.js`
  (the perch start searched ring by ring: the 30 km search stalled the page),
  `vegetationColliders.js` (perch queries wholly above the trees scatter nothing),
  `testHarness.js` (comment), `tools/lab/craft.mjs` (the catalog check accepts new modules),
  `view-physics.json` (expects every registered craft).
- **Verified 2026-10-08** (each once unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `run-harness --test craft` (all 14 catalog craft registered so far: 7; general test both views, every scenario) | PASS 39/39 runs, 121/121 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 | PASS 39/39, 121/121, same |
  | `run-harness --test craft --crafts eagle` (general + 6 scenarios, both views) | PASS 14/14, 60/60, 0/0 | PASS 14/14, 60/60, 0/0 |
  | `run-harness --test 1` reduced (HARNESS-1/2, glider and eagle, both views, 20 s) | 0 NaN, 0 penetrations, 0 crashes, 0/0, heap growth 3.34 MB, 8/8 runs, 24/24 manoeuvres; frames over 50 ms: 89 (main thread 61, delayed 22, gc 6, systems 0; machine at 100 % CPU) | same criteria pass (heap 7.9 MB); frames over 50 ms: 146 (systems 7, run before the perch-search fix) |
  | `run-harness --test hotas` | 140/140, 0/0 | |
  | Step files view-physics (7/7 craft identical in every view), input-review, discovery, copilot-guide (failed once on a callout timing check while WREN was talking; passed on the rerun); creature audio in V2 (beats, screech, dragon roar and fire whoosh) | all pass, 0/0 | view-physics 7/7, creature audio, 0/0 |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 237/237; no dev kit in the V2 bundle; one three.js core | built | |
  | Built `dist-single/v2` (eagle, dragon fire) and the built shell smoke | 0/0, screenshots differ | 0/0, screenshots differ |
  | Labs: eagle 50, craft 66, flight-lab 82, settings 45, copilot 240, copilot-server 17, discovery 43, input 34, wingsuit 37, jet 60, helicopter 46, fpv 87, colliders 84, terrain 404 (403 first, a benchmark timing; 404 on the rerun), audio 191 (190 first, the murmuration trigger level; 191 on the rerun), fauna-modes 44, challenges 70, origin 32, water 34 (with `--expose-gc`), atmosphere 28, director 50, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden, setpiece 47, spawns 98, storage 54, structure 75, wind-engines 56 | all pass | |

- **Next:** I2 merges this branch in catalog order (after the seaplane, tiltrotor, paraglider,
  balloon and airship, before the spaceplane).
- **Open issues:** the model step boxes about 40-50 bytes of doubles per tick (the shared ground
  contact and landing monitor keep doubles in closures; the wingsuit measures 5-7 bytes in the same
  child-process measure); the flame seen from straight behind reads as a glowing disc; no lantern or
  torch registers with `ctx.ignition` until the wave 3 owners land; the per-craft copilot commands
  and the HOTAS profile docs are Milestone O's.

### Wave 2 - p3/craft-spaceplane

- **Done** (spec Milestone E item 14, contract h; every file below is new unless marked):
  - flight model: kind `spaceplane` (SimFixedWing + `src/flight/spaceplaneAero.js`, registered in
    models.js): an air-augmented rocket (core 0.6 g in vacuum, ram-air augmentation with the mass
    flow, fading past Mach 4-6, no fuel limit) tuned so a full-power 65 degree climb tops out at
    115 km (50 degrees: 105 km, 80 degrees: 120 km); RCS on all three axes blended in as the dynamic
    pressure falls (150 Pa .. 6 kPa), the yaw jets kept on at entry angles of attack, the pedals on
    the yaw jets; wave drag to Mach 8; heating index rho V^3 / 9e6 gated by Mach 2.8-4.0 with a
    2.5 s skin lag; re-entry buffet; the apogee prediction (powered while the thrust cannot hold
    the climb, else ballistic); stall cues need air and stay quiet in the entry;
  - flight control system `src/flight/spaceplaneFcs.js`: rate loops through the control power
    (jets plus q x surfaces) with integrators; rate damping and coordination (0-50 %), rate
    command with attitude hold, the AoA and G limiters and auto re-entry arming (50-100 %); the
    pilot's attitude hold and auto re-entry switches at any level; the entry guidance (40 degrees
    AoA, pilot bank, zero sideslip) and the hypersonic glide (14 degrees) handing back below Mach
    1.5 or 20 km; the fixed-wing autopilot; a trim that leaves ballistic states alone;
  - craft `src/craft/spaceplane.js`: procedural mesh (lifting body with the black heat-shield belly,
    double delta, dorsal fin, bell nozzle, RCS ports) with animated elevons, body flap, split
    rudder / speed brake, nozzle gimbal, gear; effects `src/render/spaceplaneEffects.js` (plume
    tight in dense air and ballooning in vacuum, instanced RCS puffs, the plasma sheath on the skin
    plus its wake); canopy cockpit with the space panel; abilities (auto re-entry, attitude hold),
    the flight log (space crossings, apogees, the comms blackout and the `reentry` events, journal
    stats, WREN's lines), copilot commands (`autoReentry`, `attitudeHold`, `apogee`, `mach`) and
    status, journal stats (`spaceplaneApogee`, `spaceplaneMaxMach`, `spaceplaneSpaceFlights`,
    `spaceplaneReentries`), situate (climb: 45 degrees, 250 m/s, full thrust), per-craft gamepad and
    T.16000M bindings for attitude hold, the director profile above 20 km;
  - audio family `rocket` (`src/audio/engines/rocket.js`): roar and crackle thinning with the air,
    the structure-borne rumble that stays in the cockpit, RCS hiss / thump, the re-entry roar;
  - instruments `mach`, `apogee`, `heating`, `rcs`;
  - tests: `tools/lab/spaceplane.mjs` (24 checks), `?test=craft` scenarios `spaceplane-climb` and
    `spaceplane-reentry` (continuity of camera-relative positions at every rebase, far-field holes
    every frame above 11 km, readback probes in the handoff band and from space), the flight-test
    script (`?test=1`) and the view-physics step file.
- **Edits outside the craft's files:** single lines in craft/index.js, models.js, audio
  engines/index.js, instruments/index.js, craftScenarios/index.js, events.js (`reentry` after
  `viewChanged`); `abilityApi.bus` in FlightController.js; the comms-blackout hold in copilot.js;
  `airflowBasis: 'equivalent'` in airflow.js; far-field root prefetch past the reach (farField.js);
  the WebGL2 cockpit near plane above 12 km (cameraManager.js); contrails fade out in thin air
  (fx.js); the craft lab's catalog check; testFlightScripts.js and view-physics.json.
- **Verified 2026-10-13** (each once, both backends unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 236/236 | built; no craft scenario or view-physics kit in the V2 bundle | |
  | Labs: spaceplane 24 (new), craft 66, settings 45, copilot 240, copilot-server 17, discovery 43, flight-lab, atmosphere 28, challenges 70, colliders 84, director 50, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden (goldens identical), setpiece 47, spawns 98, storage 54, structure 75, terrain 404, water 34, wind-engines 56, wingsuit 37, audio 191 (alone) | all pass. The allocation labs need `--expose-gc` (challenges, fauna-modes, origin, water failed only their GC checks without it). The audio lab failed its doppler camera-cut check on its first run (both backends, under load), then hung loading the page on the second; the third run, alone, passed 191/191 | |
  | `run-harness --test craft --crafts spaceplane` (the general test in both views, `spaceplane-climb` and `spaceplane-reentry` in both views) | PASS 6/6 runs, 58/58 checks, 0 NaN, 0 penetrations, 0 soft crashes, 0/0 | PASS 6/6, same |
  | `run-harness --test 1 --crafts spaceplane --seconds 20` (HARNESS-1..3, both views) | 0 NaN, 0 penetrations, 0/0, heap growth 7.92 MB max, 6/6 runs, 18/18 manoeuvres; frames over 50 ms: 3 (mainThread) | same criteria pass, heap growth 5.33 MB max; frames over 50 ms: 11 (9 mainThread or delayed, 2 systems: the landmarks' build at 27.9 ms and the camera at 29.7 ms 1.25 s into a cockpit run); the spaceplane's cockpit panel redraw measures 1.11 ms, the jet's 1.06 ms |
  | `run-harness --test hotas` | 140/140 | 140/140 |
  | Step files view-physics (7/7 craft), copilot-guide, high-altitude, origin-rebase | all pass, 0/0 | all pass, 0/0 |
  | Built `dist-single/v2` and the built shell smoke | 0/0, screenshots differ | 0/0, screenshots differ (V2) |

- **Frame time (owner's rule, one line):** the reduced flight harness failed only its frames-over-50-ms
  criterion (3 on WebGPU, 11 on WebGL2) with the machine at 88-100 % CPU; neither "systems" frame
  is the spaceplane's code.
- **Next:** I2 merges this branch in catalog order.
- **Open issues:** none blocking; Milestone O documents the spaceplane's HOTAS profile and its
  remote `flightState` fields (h.3: `apogee` is in `craftState`).

### Wave 2 - p3/picker-director

- **Done** (contract h.7 and i; what was built beyond the letter of them is in contract i.5):
  - the craft picker (`src/ui/craftPicker.js`, `ui.css`): only installed craft, in the six groups
    with a hairline between them, each with its favorite key and its skin's silhouette; from 11
    craft the strip packs to 22 px so all 14 clear the compass at 1280 px; the glass roster panel
    (grid button or right click): ten favorite slots (drag a craft onto a key, a key onto a key, a key
    menu per craft, an x per slot), the craft by group, skins under the eagle; Escape and outside
    clicks close it. Number keys, craftNext / craftPrev and the situational spawn through `situate()`
    are the framework's and work from the picker unchanged;
  - the director (`src/spawns/director.js`): the ground track (velocity bearing smoothed over 1 s,
    the heading below 2 m/s) for every ahead test and `forceSpawn` (the spawns system's `pointAhead`
    too); craft weighting from the module's `directorProfile` or `DEFAULT_DIRECTOR_PROFILES`
    (seaplane, eagle, spaceplane above 20 km, balloon, airship), clamped 0.25..3; combo scheduling
    (preconditions, all-member budgets, exclusivity, deterministic placement and delays with reserved
    budgets, `parent` on the SpawnManager records, `comboStarted`, the log); the global overrides
    (`src/spawns/overrides.js`: per-night schedule, night window, regional blend, the midnight sun's
    bend; `createSkyOverrideSink`, `globalOverride`, the once-a-night spawn); `getState()` adds track,
    craft, weights, combos and overrides, shown in the F9 debugger;
  - the sky: a modifier `moonTint` (moon disc, halo, moon light), `sky.addSunOverride`, and
    `state.time.days` (a forward-only day counter);
  - presets: `tags`, `combo` and `override` validation in schema.js (members and sites cross-checked);
    the 30 Phase 2 presets carry tags; `spawns.debug.restartSpawns({ extraPresets })` for fixtures;
  - tests: `tools/lab/director.mjs` +38 checks (track, craft, combos on dev fixtures, overrides,
    schema), `tools/steps/craft-picker.json` (28 checks), `tools/steps/director-p3.json` (14 checks),
    `director-game.json` aims along the track and holds the perf governor steady while it probes the
    shedder; docs: architecture.md (event director, craft picker, events, testing), spawns.md
    (tags, combos, overrides, templates), controls.md, the contract's i.5.
- **Determinism re-recorded** (reason: every log entry now records the craft, and the in-game ahead
  tests follow the ground track, so the director picks other candidates than along the nose): site
  list d85384433861a1b0, water 61f315c9 and path 55b1a55f unchanged; director log 1093b8c1 -> 703b9a83
  (4 entries), spawn events 74d3d2fa -> 961c09f2. Both backends identical.
- **Verified 2026-10-08** (each once, both backends unless noted; reruns named):

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `build:single` (V1 SHA-256 matches), `test:v1` 2/2, `docs-check` 239/239 | built | |
  | Labs: director 88/88 (`--presets real` 6/6), craft 66, settings 45, copilot 240, copilot-server 17, discovery 43, flight-lab 82, atmosphere 28, challenges 70, colliders 84, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden (6/6 identical), setpiece 47, spawns 98, storage 54, structure 75, terrain 404, wind-engines 56, wingsuit 37, audio 191 (alone), water 33/34 (its `[cost]` check: heightAt over open ocean 1.25 us median against 1 us, machine load; src/world untouched) | all pass but water's timing | |
  | `run-harness --test determinism` | PASS, hashes above, 0/0 | PASS, identical hashes, 0/0 |
  | Step files `craft-picker` (28), `director-p3` (14), `director-game` (3) | all pass, 0/0 | all pass, 0/0 |
  | Built `dist-single/v2` (rebuilt at 03f0994) and the built shell smoke | 0/0, screenshots differ | 0/0, screenshots differ (V2) |
  | `run-harness --test 1` reduced (HARNESS-1/2, glider and jet, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, heap 11.08 MB, 8/8 runs, 24/24 manoeuvres; frames over 50 ms: 318 (mainThread 227, delayed 57, systems 18 led by camera, flight, terrain and landmarks, gc 16; other processes held 91 % of the machine; a first run overlapped this branch's own build:single, 522) | same criteria pass, heap 8.53 MB; frames over 50 ms: 94 (mainThread 66, delayed 20, gc 7, systems 1; others 89 % of the machine) |

- **Next:** I2 merges this branch after the craft branches (catalog order); then the craft modules'
  own `directorProfile`s replace the defaults where they bring one, and the picker shows each craft
  as its module registers.
- **Open issues:** the world's snow patches are 1.5-8 km across (one every ~10 km), so a midnight-sun
  preset (wave 3, preset 98) needs `region.blendKm` of a few km; the contract's example 20 km reaches
  nearly the whole world. A combo's delayed member can lose a reserved heavy slot to a site coming
  into range (the manager never refuses a site); it then retries and is dropped after 60 s, logged.

### Wave 2 - integration (I2, on `v2-phase3`)

- **Merged** in catalog order with `--no-ff`, one commit each: aerobatic `3db9a61`, seaplane
  `5f41963`, tiltrotor `fd73aa9`, paraglider `6acf5a0`, balloon `17b9c44`, airship `3387ab4`,
  eagle `d955fba`, spaceplane `3bbc50f`, picker / director `caf7fbd` (the framework, 2.0, was merged
  before the craft branches started). Conflicts were the list files (`src/craft/index.js`,
  `src/flight/models.js` kinds and registrations, `src/audio/engines/index.js`,
  `src/ui/instruments/index.js`, `src/dev/craftScenarios/index.js`, `src/dev/testFlightScripts.js`:
  every line kept, in catalog order), `tools/lab/craft.mjs` (one generic catalog check kept),
  `tools/steps/view-physics.json` (every check step, in catalog order, and one closing step that
  expects every registered craft), `docs/architecture.md` / `docs/controls.md` rows (all kept),
  `src/dev/testHarness.js` (the header without a craft count), `src/ui/instrumentHud.js` (below) and
  this file (every subsection, rebuilt in catalog order from each branch's own copy).
- **Wiring and fixes** (first parent after `caf7fbd`):
  - one pinned-HUD hook: the tiltrotor (`hud: { instruments }` with the cockpit-panel rule) and the
    balloon (`hudInstruments`) had each built one in `instrumentHud.js`; the merge keeps the
    tiltrotor's and the balloon declares `hud: { instruments: ['windColumn', 'envelope'] }`; the
    registry validates `hud` (each tile one of the craft's instruments) (`17b9c44`, `8f3c139`);
  - the airship's scenic cruise reports its journal stats as typed `journalStat` events through the
    ability api's `bus` (the spaceplane branch added it) instead of calling the journal system
    (`c5ba936`); the cruise already builds its chain from `director.getNearby()`;
  - director: the spaceplane's own `directorProfile` favoured an unknown `heavy` tag above 20 km, so
    far-lure spawns were never weighted and ground-only small spawns never dropped (contract i.2); it
    now favours `celestial` / `farLure` and weights wildlife, structures and flight play at 0.25. The
    registry refuses favour names outside `PRESET_TAGS` / `PRESET_CATEGORIES`. The craft lab checks
    every catalog id through the game's profile lookup (the module's profile, else
    `DEFAULT_DIRECTOR_PROFILES`) and the i.2 profiles on the real modules (`8f3c139`, `30b0c89`).
    "Ahead" follows `state.player.velocity`, the inertial velocity the balloon and airship models
    write, so their drift is the ground track;
  - fauna threat: `faunaThreatOf(module)` in `src/craft/registry.js` is the one lookup; the fauna
    engine uses it and the ambient bird flocks (`src/render/birds.js`) now scale their trigger and
    scatter distances by it (the eagle 2.5, the balloon 0.6) (`30b0c89`);
  - ignition: engines reach the dragon's service as `ctx.game.ignition`; an engine lists what it
    registers in `instance.ignitableIds`, the SpawnManager removes and reports leftovers
    (`leaks.ignitables`), and the spawn check kit, the spawns test and the harness table judge
    ignitables against their baseline (contract appendix B); the spawns lab covers both paths
    (`465a6e4`, `2cf39b1`);
  - tests: the paraglider's and the airship's view-physics steps (`5b7cc24`); the craft test holds a
    scenario's time of day with the day clock frozen (the paraglider's own per-frame noon hold is gone)
    and takes an optional `endWhen(api)` (`77eeca7`); the continuous
    `spaceplane-space-and-back` scenario (the climb placement, full power past 100 km to the apogee,
    auto re-entry, blackout and glide, home under 3 km in one flight; an engine cut at 100 km tops out
    near 107 km and never heats past the blackout, as a node simulation showed) and run-harness's
    six-hour limit for a full craft test (`8033dee`); the discovery step's wider search for a visible
    test event spot (`c3c669a`: from a high opening spawn no spot 300-900 m ahead was within 24
    degrees of the camera, on both backends);
  - the audio families in catalog order (`be92b99`); docs/architecture.md: the 14 craft's files, the
    12 model kinds, the 14 audio families, the 30 instruments, the labs, `hud`, `faunaThreatOf`,
    the ability api's `ignition` and `bus`, ignitable clean-up, the craft test's time hold and
    `endWhen` (`70d1e49`).
- **Verified on the merged tree (2026-10-13/14, each once on both backends unless noted):**

  | Check | WebGPU | WebGL2 |
  | --- | --- | --- |
  | `npm run build`, `npm run build:single` (V1 SHA-256 matches), `npm run test:v1`, `node tools/docs-check.mjs` | built; 2/2; 244/244; one three.js core; no dev kit in the V2 bundle | (same build) |
  | Labs (`--expose-gc`): flight-lab 82, aerobatic 81, airship 47, atmosphere 28, balloon 66, challenges 70, colliders 84, copilot 240, copilot-server 17, craft 81, director 88, discovery 43, eagle 50, fauna-modes 44, fpv 87, helicopter 46, input 34, jet 60, origin 32, paraglider 45, path 37, preset-flight 13, preset-pacing 4, preset-wind 12, ringsGolden 6/6, seaplane 113, setpiece 47, settings 45, spaceplane 24, spawns 101, storage 54, structure 75, terrain 404, tiltrotor 41, water 34, wind-engines 56, wingsuit 37 | all pass; eagle 49/50 on its first run (the model-step allocation sample 144 B/tick, wingsuit 110 B in the same run, beside a browser run), 50/50 alone (39 B); audio 190/191 alone (WebGPU thunder trigger 5.6 dB against 6 dB, the known random render) | |
  | `run-harness --test craft` (14 craft: 28 general runs, 68 scenario runs) | 94/96 runs: 0 NaN, 0 penetrations, 0/0 console; checks 385/386; one soft crash (eagle-perch-placement, third person: a beak strike at 17.5 m/s 5 s into the fly-out from a perch its own start search picked, all its checks passed); balloon-wind-layer first person missed "the target band is the nearest for 30 s" (passes alone: 6/6) | 95/96 runs: 0 NaN, 0 penetrations, 0 soft crashes, 0/0; checks 385/386 (the same balloon-wind-layer first-person check) |
  | Required scenarios | recognizer loop and aileron roll, seaplane ocean and lake, tiltrotor conversion both ways, paraglider thermal climb, balloon wind layer (third person), airship scenic cruise (3 sites), eagle perch and takeoff, spaceplane climb, re-entry and space-and-back (603-674 s, continuity within 1 mm, 0 far-field holes, both readback probes clean): all pass in both views except as noted | same |
  | `run-harness --test collision` | PASS: 146/146 strikes (the spaceplane included), 15/15 targets, 0 pass-throughs, 0 penetrations, bump, deck, dives, tunnel, arch, 15/15 kite misses | PASS, same |
  | `run-harness --test determinism` | PASS: site list d85384433861a1b0, water 61f315c9, director log 703b9a83 (it records the craft now), spawn events 961c09f2, path 55b1a55f | PASS, identical |
  | `run-harness --test spawns` (30 presets) | PASS 30/30 every criterion; lowest avg 91.6 fps, worst p99 22.6 ms | 29/30 on "lights, sky modifiers, ...": the meteor shower's first cycle read 2 -> 1 sky modifiers (one that was live at its baseline ended during the check; its second cycle clean); 44.7 fps lowest, p99 45.3 ms |
  | `run-harness --test terrain`, `--test hotas` | PASS (9/9 stamp types, 5/5 overlays, 0 cracks, 1002 chunks parity); 140/140 | PASS, same; 140/140 |
  | `run-harness --test 1` reduced (HARNESS-1/2, glider and jet, both views, 20 s) | 0 NaN, 0 penetrations, 0/0, heap 13.76 MB, 8/8 runs, 24/24 manoeuvres; frames over 50 ms 1 (main thread); one soft crash reported (HARNESS-2 glider first person, a hard landing at 8.8 s) | same criteria pass, heap 14.88 MB; frames over 50 ms 1 (main thread) |
  | Step files: craft-picker 28, director-p3 14, director-game 3, view-physics (14 craft), copilot-guide 13, input-review 9, hotplug 6, origin-rebase 10, high-altitude 20, water-bodies 41, challenge 23, engine-fauna-modes 20, shadow-resize 5, discovery 17 | all pass, 0/0 (discovery failed 3 checks on both backends before `c3c669a` and passed 17/17 after it) | all pass, 0/0 (same for discovery) |
  | `tools/spawn-check.mjs` | 55/55 | 55/55 |
  | Built `dist-single/v2` and `dist-single/index.html` smoke | 0/0 each, screenshots differ | 0/0 each |

- **Open issues (reported, not chased):** the eagle's fly-out from a perch struck once (above); the
  balloon wind-layer check depends on the run order (the second view inherits the first run's state
  and a later time of day; alone it passes); the reduced flight harness's glider hard landing; the WebGL2
  spawns test's sky-modifier count moved by a modifier the check does not own; frames over 50 ms one
  per backend (main thread). Left by the reports to Milestone O (j.1, j.2, h.3): the "switch to
  [craft]" synonyms for the eight new craft and skins by name, the journal panel's Craft, Figures
  and Challenges sections, the remote `flightState` craft fields, the HOTAS profiles of the new
  craft in docs/controls.md (rows exist for the seaplane, tiltrotor and eagle), and the eight craft
  in docs/copilot-api.md. Tiny per-craft math helpers (`moveToward`, `wrapSignedDegrees`, mesh
  builders) stay in their files; no two craft built the same service twice beyond the HUD hook and the
  stat path above.

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

Waves 1 and 2 are done: the craft framework, the eight craft and the picker / director branch are
merged into `v2-phase3`, wired and verified (the I2 subsection above). Not pushed or tagged (the owner
pushes).

Next: **wave 3, presets 31-100 in seven batches of ten** (`p3/presets-31-40` .. `p3/presets-91-100`,
the spec's numbering), cut from `v2-phase3`; then I3 merges them in spec order (presets/index.js
and spawnScenarios in order) and runs `?test=spawns` for all 100 on both backends. The wave 2
worktrees under `.claude/worktrees/p3-*` can be removed (unlink each `node_modules` junction
first).

## Open issues

- **Wave 2 integration leftovers:** see the I2 subsection (the eagle's perch fly-out strike, the
  balloon wind-layer run-order dependence, the Milestone O items the craft reports left).
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
