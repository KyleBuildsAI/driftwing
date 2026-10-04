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
| 1 | Floating origin: `src/core/origin.js`, `scene.position = -offset`, the 4096 m lattice, the shader, CPU-matrix and float32-buffer fixes, audio in the render frame | `p3/origin` | a | in progress |
| 2 | Colliders (box, cylinder, capsule, hull, heightfield, mesh BVH), the flight controller's sweep and soft crash, sensors, perches; retrofits on the v1 landmarks and the Phase 2 structures; `?test=collision` | `p3/colliders` | b | not started |
| 3 | Local water bodies (basin, crater, terraces stamps; lake and ice material), the shared water-height query and the caller migration; region overlays; vegetation species 6-12 with WindField sway and trunk colliders | `p3/water-regions` | c, d | not started |
| 4 | Fauna ground and water-surface modes (bison, caribou, dolphin, flamingo), PathFollower, the challenge system with the ring migration and the challenge UI | `p3/fauna-challenges` | e, f | not started |
| 5 | High-altitude and space rendering: atmosphere, sky / fog / stars / limb, curvature and the planet radius, the far-field impostor, lures from altitude, the per-craft ceiling | `p3/high-altitude` | g | not started |
| I1 | Integration pass: merge in the order origin, high altitude, water/regions, colliders, fauna/challenges; the follow-ups of contract appendix A; every lab and step file once on both backends | `v2-phase3` | appendix A | not started |

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
- Audio in the render frame: the spatializer and the spawn voices keep world positions (doppler,
  distances, camera velocity) and feed the Web Audio graph `world - offset`; after a rebase the
  listener and every panner are snapped (`snapParameter`), never glided.
- Found by the step file's image check: three's HemisphereLight takes its up direction from its own
  render-frame position, so after a rebase the sky fill lit everything sideways (a 44 % pixel pop
  near the ground). The sky now keeps it 1 m above the render origin (`sky.js`, `updateDome`).
- Dev hook `DRIFTWING.debug.rebaseOrigin(point?)`; `src/dev/originRebaseCheck.js` and
  `tools/steps/origin-rebase.json` (image checks at fixed poses, two flight legs of 900 rendered
  frames with forced rebases, terrain and site identity).
- Next: the verification runs on both backends.
- Open issues: `src/render/water.js` (`surfaceNoise`, `shadowUV`) is the water engineer's (contract
  0.1); they apply `worldPositionNode` there in the integration pass.

### Wave 2: craft (one engineer per craft, plus the picker / director engineer)

| # | Work | Branch | Contract | Status |
| --- | --- | --- | --- | --- |
| 2.0 | Craft framework (lands first, alone): catalog and groups, settings, favorites actions, `situate`, ability api, `craftCommand`, custom cockpits, `?test=craft` scaffold | `p3/craft-framework` | h.9 | not started |
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

1. Wave 1: create the five worktrees (see How to resume) and start the five engineers on
   `p3/origin`, `p3/colliders`, `p3/water-regions`, `p3/fauna-challenges` and `p3/high-altitude`,
   each with the contract sections listed above and appendix A's file ownership.
2. Before migrating the rings, engineer 4 records `tools/lab/fixtures/rings-golden.json` from the
   unmodified Phase 2 code.
3. Wave 1 integration pass (I1), then wave 2 step 2.0.

## Open issues

- **Carried from Phase 2** (docs/phase2-progress.md, Open issues): the soak's p99 against the
  16.67 ms target on the shared machine, the full 36-run flight matrix never run, the one-pixel
  WebGL2 golden-frame difference, the airfield and crystal spires' one slow frame each, the
  warm-up heap of a few presets, the rare-tier fairness, the faint storm chase funnel.
- **WebGL2 depth range at altitude.** WebGPU uses reversed depth; WebGL2 does not. The far plane
  grows to the horizon (up to 600 km) above 12 km, so the high-altitude engineer must prove the
  WebGL2 fallback has no z-fighting at 15, 35 and 100 km (contract g.2 allows a larger near plane in
  third person views above 12 km).
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
