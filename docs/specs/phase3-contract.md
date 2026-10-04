# DRIFTWING v2 Phase 3 - system contracts (lead's design; engineers build against this)

Base: branch `v2-phase3`, cut from tag `v2-phase2`. The structure correction
([structure-correction.md](structure-correction.md)) is the source of truth:

- V2 has no CLASSIC mode and no arcade model, so there are no `arcadeProfile` fields anywhere.
  "Every craft works in CLASSIC and SIM" means every craft flies V2's real flight model, with the
  assists slider (0-100 %) as the only difficulty control.
- "Both modes" means the first person and third person views.
- "v1 landmarks / v1 ring course / v1 balloons / v1 water shader" are the v1-derived features that
  live in V2 (`src/world/landmarks.js`, `src/gameplay/rings.js`, `src/render/water.js`). The frozen
  V1 at `public/v1` is never touched.

Units are SI, and the axes are those of docs/architecture.md: +x east, +y up, -z north, compass
degrees 0 north and 90 east. Body axes are x right, y up, z aft. Everything below is additive to
Phases 1 and 2: extend a contract additively and document the extension in your final report.
Phase 2's contracts ([phase2-contract.md](phase2-contract.md), [phase2-engine-api.md](phase2-engine-api.md))
still hold unless a section here changes them.

Progress, the wave plan and the resume protocol live in [docs/phase3-progress.md](../phase3-progress.md).

## 0. Ground rules for every Phase 3 branch

**Frames of reference.** There are two, and every value belongs to exactly one:

| frame | what lives in it | precision |
| --- | --- | --- |
| **world** | the simulation and everything that must be deterministic: flight models, `state.player`, `state.flight`, the WindField, placement, stamps, overlays, water bodies, colliders, the director, challenges, paths, `Object3D.position` of every scene child, `camera.position` | float64 (JS numbers); unbounded |
| **render** | what the GPU sees: `matrixWorld` of every object, TSL `positionWorld` and `cameraPosition`, `Object3D.getWorldPosition()`, audio panner and listener positions | `world - origin.offset`; the craft and camera stay within about 5 km of 0 |

Noise, hashes and every deterministic query sample WORLD coordinates. Nothing in the simulation
ever reads the render origin.

**Determinism.** Placement, stamps, overlays, water bodies, vegetation scatter, trunk colliders,
paths, candidates, combos and global overrides are pure functions of (seed, presets, world
position, flight time). Physics, colliders, water and challenge timing advance on the fixed
120 Hz flight clock (`state.time.elapsed`), never on wall time or frame time. No `Math.random`
anywhere in a deterministic path: use the seeded mulberry32 streams that exist (placement,
candidates, `rng` in engine `create`).

**Allocation.** Every per-frame and per-tick path is allocation-free (Phase 2 rule): typed arrays
for doubles written every frame, scratch rings, pools. Queries take an `out` object.

**Errors.** No empty catch blocks. A failure the player cannot cause is a `console.error` with the
`[DRIFTWING]` prefix (that fails every test). No `console.log`, TODO, FIXME or placeholder content.

**three.js.** `three` stays pinned at 0.184.0. `three-mesh-bvh` 0.9.15 is installed
(`--save-exact`), and `vite.config.js` aliases the bare `'three'` to `'three/webgpu'` (section b.7).
The game keeps importing `three/webgpu`, `three/tsl` and `three/addons/...`.

**Ports.** Never 5199 (the player's origin). Dev servers for checks use `tools/ports.mjs`
`findFreePort()`; tools already do.

**Owner's rule.** Ignore machine load: run each check once and report its numbers plainly.

### 0.1 Shared files: hotspots, anchors and verbatim lines

Wave 1 runs five branches in parallel. Shared files are edited only at the anchors below, so the
integration pass merges cleanly. Where two branches need the same new line, the contract gives
it **verbatim**: paste it exactly (same text, same place). Git merges identical hunks cleanly.

| file | rule |
| --- | --- |
| `src/core/events.js` | new typed events go in `EVENT_TYPES` right AFTER your anchor entry (with its doc comment): origin -> after `relaunched`; colliders -> after `softCrash`; water/regions -> after `windSourceRemoved`; challenges/fauna -> after `achievement`; high altitude -> after `weatherChanged` |
| `src/main.js` uniforms literal | origin: insert `renderOrigin` after the `playerPosition` line. High altitude: insert its uniforms after the `cloudBow` line (the end) |
| `src/main.js` services | colliders: `ctx.colliders = ...` on the line after `ctx.wind = createWindField(...)`. Water: `ctx.waterQuery = ...` on the line after `ctx.perf = perf;`. Origin: `ctx.origin = ...` on the line after the closing `};` of the `uniforms` literal |
| `src/main.js` `factories` | farField after `['terrain', ...]`; waterBodies after `['water', ...]`; challenges after `['rings', ...]`; challengeHud after `['copilot', ...]` |
| `src/main.js` `UPDATE_ORDER` | the final Phase 3 wave 1 order is given verbatim in section 0.2. Every branch that adds a system pastes the whole line |
| `src/spawns/schema.js` `PRESET_FIELDS` | verbatim final list (section 0.3) |
| `src/spawns/index.js`, `src/spawns/spawnManager.js` | the engine ctx gets the game ctx through three verbatim lines (section 0.4); nothing else in the manager's options or engine ctx changes in wave 1. Regions in spawnManager.js: origin -> `refreshCameraFromMatrix` (a.6); colliders -> `disposeParts`, `leaks` and `getStats` (b.5); high altitude -> the distance used for LOD and culling (g.5) |
| shared render files | `lure.js`: origin -> the view position and instance buffers (a.6, a.7); high altitude -> the curvature node in the lure material. `waterEffects.js` and `trails.js`: origin -> buffer anchoring; water -> the water-height reads. `cameraManager.js` / `chase.js`: water -> the floor lines; high altitude -> the near plane. `clouds.js`: high altitude only (curvature); `cloudShading.js`: origin only (a.5) |
| `src/flight/FlightController.js` | water: `env` lines after `waterLevel`, and the bodies of `surfaceHeight`, `crashFloorHeight`, `contactOutcome`'s two water lines. Colliders: `env.colliders` after the `telemetry,` line of `env`, a new section `STRUCTURE COLLISION` after the `SOFT CRASH AND RESPAWN` section, and one call line after `enforceSimCeiling();` in `updateSim`. High altitude: only the body of `enforceSimCeiling` and the `FLIGHT_CEILING` constant |
| `src/world/terrain.js` | origin: only the shader lines listed in a.5 and `countFrustumVisible`. Water/regions: vegetation types, the chunk colour and overlay attributes, the sway node. High altitude: the chunk `positionNode` curvature and the handoff API (new functions, and the visibility check in the chunk update) |
| `src/render/water.js` | water/regions owns it (the material moves into `waterMaterial.js`, c.4). Origin and high altitude do not edit it; they hand their TSL helpers to the water engineer, who applies them in the integration pass |
| list-append files (`src/craft/index.js`, `src/flight/models.js` kinds, `src/ui/instruments/index.js`, `src/audio/engines/index.js`, `src/audio/recipes/index.js`, `src/spawns/presets/index.js`, `src/dev/spawnScenarios.js`, `src/spawns/engines/structure/recipes/index.js`, `stamps.js` tables) | append one line per item; the integration pass keeps every line, in catalog / spec order |

### 0.2 `UPDATE_ORDER` after wave 1 (verbatim)

```js
const UPDATE_ORDER = ['input', 'test', 'flight', 'camera', 'terrain', 'farField', 'weather', 'sky', 'water', 'waterBodies', 'clouds', 'birds', 'spawns', 'landmarks', 'journal', 'waypoints', 'rings', 'challenges', 'fx', 'gEffects', 'copilot', 'audio', 'ui', 'challengeHud', 'windOverlay', 'debugWind', 'spawnDebugger'];
```

The loop skips a name with no system (`updateOrder.filter((name) => ctx.systems[name])` in
loop.js), so every branch that adds a system pastes the whole line, whatever the other branches
have landed. The render origin is not a system: the loop updates it first in the frame (a.3).

### 0.3 `PRESET_FIELDS` for Phase 3 (verbatim)

```js
export const PRESET_FIELDS = Object.freeze([
  'id', 'name', 'category', 'kind', 'rarity', 'heavy', 'placement', 'candidates', 'filters', 'stamps', 'engines',
  'lod', 'lure', 'wind', 'audio', 'journal', 'discovery', 'callouts', 'lifetime', 'achievements',
  'activeState', 'cooldown', 'anchor',
  'overlays', 'waters', 'challenge', 'tags', 'combo', 'override',
]);
```

Validation per field is added by its owner: `overlays` and `waters` (water/regions, wave 1),
`challenge` (challenges, wave 1), `tags`, `combo` and `override` (director, wave 2). Until its
owner lands, a field is accepted unvalidated.

### 0.4 The game ctx in the engine ctx (verbatim)

```js
// src/spawns/index.js, in the createSpawnManager({ ... }) options, after the weatherState line:
    game: ctx,
// src/spawns/spawnManager.js, the options destructuring line becomes:
    water = null, surfaces = null, weatherState = null, game = null,
// src/spawns/spawnManager.js, engineCtx, right after the weatherState entry:
    /** The game ctx: Phase 3 services (origin, colliders, waterQuery, systems.challenges, ...). */
    game,
```

Engines reach the Phase 3 services as `ctx.game.colliders`, `ctx.game.waterQuery`,
`ctx.game.origin`, `ctx.game.systems.challenges` and the pure modules by import
(`src/world/pathFollower.js`, `src/render/curvature.js`). An engine never writes `ctx.game`.

### 0.5 Typed events added in Phase 3

| event | payload | emitted by | wave |
| --- | --- | --- | --- |
| `originRebased` | `{ offset: vector3, previous: vector3, delta: vector3, version: number }` | render origin | 1 (origin) |
| `colliderHit` | `{ id, owner, craft, speed, normal: vector3, position: vector3, crashed: boolean, surface }` | flight controller | 1 (colliders) |
| `colliderSensor` | `{ id, owner, tag, craft, position: vector3 }` | flight controller | 1 (colliders) |
| `challengeStarted` | `{ id, name, craft, gates, presetId? }` | challenges | 1 (challenges) |
| `challengeGate` | `{ id, index, role: start\|checkpoint\|finish, time, split?, delta?, missed: boolean }` | challenges | 1 |
| `challengeFinished` | `{ id, craft, time, medal: gold\|silver\|bronze\|none, best, improved: boolean, missed, penalties, valid: boolean }` | challenges | 1 |
| `challengeCancelled` | `{ id, reason }` | challenges | 1 |
| `figureFlown` | `{ figure, score, craft, position: vector3 }` | aerobatic recognizer | 2 |
| `perched` | `{ craft, perchId, kind: peak\|structure\|tree, position: vector3, perched: boolean }` | eagle model | 2 |
| `comboStarted` | `{ id, presetId, members }` (members: array of preset ids, in order) | director | 2 |
| `globalOverride` | `{ id, kind: bloodMoon\|midnightSun, active: boolean, weight: number }` | director | 2 |
| `reentry` | `{ phase: heating\|blackout\|clear, heating: number }` | spaceplane | 2 |
| `worldVisited` | `{ seed, previous, portalId }` | portal preset (67) | 3 |

`landed` gains an optional `surface: 'ground' | 'water' | 'structure' | 'perch'` (default
`'ground'` when absent; the validator marks it optional; added by the water/regions engineer in
wave 1, set by the colliders engineer for landable structure tops). Water landings (seaplane, paraglider
into a lake, balloon basket) are graded like ground landings.

---

## a. Floating origin (wave 1, engineer 1)

### a.1 Design

Simulation state stays in float64 WORLD coordinates. The render origin is applied in ONE place:
**`scene.position` is `-origin.offset`**. The camera is a child of the scene already
(`scene.add(camera)` in main.js), so `camera.matrixWorld` and every object's `matrixWorld` come
out in the render frame, computed in float64 on the CPU, while `Object3D.position` of every scene
child (and `camera.position`) keeps meaning WORLD. No system re-positions its objects on a rebase;
the scene transform moves them all at once, exactly, in the same frame, so there is no pop.
Objects with `matrixAutoUpdate = false` (terrain chunks, frozen landmark parts) keep working:
their local matrix holds world values, and the scene's changed matrix forces every `matrixWorld`
down the tree on a rebase. No code may write `matrixWorld` directly.

Only three kinds of thing need work, and the origin engineer does all of them in wave 1:
1. shaders that compare `positionWorld` with absolute world values (a.5);
2. CPU code that reads `matrixWorld`, `getWorldPosition()` or the view matrix as if they were
   world (a.6);
3. float32 buffers that store large world positions (a.7).

### a.2 Module: `src/core/origin.js`

```js
export const ORIGIN_REBASE_DISTANCE = 5000;   // m, 3D distance from the focus to the render origin
export const ORIGIN_QUANTUM = 4096;           // m; the origin sits on this lattice on all three axes

export function createRenderOrigin({ THREE, scene, uniforms, bus }) -> origin
```

| member | contract |
| --- | --- |
| `offset` | `THREE.Vector3`, read only: the WORLD position of the render origin. Every component is a multiple of `ORIGIN_QUANTUM`. Starts at (0, 0, 0) |
| `version` | integer, +1 per rebase |
| `update(focus)` | called by the loop once per frame with `state.player.position` (world). When `focus.distanceTo(offset) > ORIGIN_REBASE_DISTANCE`, rebases to `round(focus / QUANTUM) * QUANTUM` per axis. Returns true on a rebase |
| `rebaseTo(worldPoint)` | tests and teleports: rebases now (quantized) even inside the threshold |
| `toRender(world, out)` / `toWorld(render, out)` | `out = world - offset` / `render + offset`; allocation-free |
| `onRebase(listener)` | `listener(delta, origin)` runs synchronously inside `update`, BEFORE the typed event, for render-frame caches (a.6, a.7). Returns an unsubscribe function. Listeners must not allocate |
| `getStats()` | `{ offset, version, rebases, lastRebaseFrame }` |

A rebase, in order: `offset` changes, `scene.position.copy(offset).negate()`, `scene.updateMatrixWorld()`,
`uniforms.renderOrigin.value.copy(offset)`, the listeners, then `bus.emitTyped('originRebased', ...)`.

Why the lattice: every periodic pattern in the game has a power-of-two period that divides 4096 m
(terrain `WRAP_PERIOD` 4096, the water `WAVE_TILE` 4096 and its 4 m grid, `CHUNK_SIZE` 256), so
`mod(positionWorld.xz, P)` is the same before and after a rebase and those shader lines need no
change. After a rebase the focus is at most 3547 m (half the cube diagonal) from the origin, so
rebases never thrash.

### a.3 Wiring and update order

- `main.js`: `ctx.origin = createRenderOrigin({ THREE, scene, uniforms, bus });` on the line after
  the `uniforms` literal; `uniforms.renderOrigin: uniform(new THREE.Vector3())` after
  `playerPosition`.
- `loop.js` `frame()`: `ctx.origin.update(state.player.position)` right after
  `uniforms.playerPosition...` and BEFORE `updateSystems`. Systems therefore always see this
  frame's origin, and only caches from earlier frames need a listener.
- A teleport (`flight.resetTo`, relaunch, debug teleports, the portal) needs nothing: the next
  frame rebases.

### a.4 Who registers what (the spec's list)

| system | how it follows the origin |
| --- | --- |
| terrain chunks, vegetation | automatic (scene children with world `position`, chunk-local geometry). Shader lines: a.5 |
| spawns (engines' meshes) | automatic for objects positioned at their anchor; buffers: a.7; SpawnManager and lure CPU spots: a.6 |
| particles (`fx.js`, `trails.js`, emitter pools, ribbons, glow points) | anchored buffers (a.7) |
| wind debug overlay (`src/dev/windOverlay.js`) | automatic (world `position`); verify its projection code (a.6) |
| camera | automatic: `camera.position` stays world; its `matrixWorld` is render frame. `Matrix4.lookAt(eye, target, up)` on world points is unaffected (pure math) |
| audio panners and listener | render frame (`spatial.js`, `spawnVoices.js`): positions are `toRender(world)`; on `onRebase` every panner and the listener are SNAPPED (cancel scheduled values, `setValueAtTime`), never glided, so no pan sweep; doppler stays computed from world velocities |
| colliders | none: world frame only (section b) |
| water bodies, ocean | automatic (meshes at world anchors); shader lines a.5, applied by the water engineer (0.1) |
| far-field tiles | automatic (tile meshes at world tile centres, tile-local vertices) |
| sky dome, sun / moon lights, shadow camera | automatic (all placed from world positions; light-space math cancels the offset) |

### a.5 Shader rule

`uniforms.renderOrigin` (vec3, world) is the only way a shader gets back to world coordinates:
`positionWorld.add(uniforms.renderOrigin)`. Relative math (`positionWorld - cameraPosition`,
`fwidth`, view directions) needs nothing, and periodic patterns with a period dividing 4096 m need
nothing. Absolute uses that must change (found in the Phase 2 tree):

- `src/world/terrain.js`: `cloudUv` (vs `cloudShadowCenter`), `heightAboveWater` (twice) and
  `seabedDepth` (vs `waterLevel`), and the vegetation `distanceToFocus` (`vegetationFocus` is a
  world uniform);
- `src/render/water.js`: `surfaceNoise` (noise on `positionWorld.xz`) and `shadowUV` (applied by
  the water engineer inside the new water material);
- `src/render/cloudShading.js`: `heightFraction` and `fromCentre` (world `shape` / `anchor`);
- `src/spawns/engines/vortexEngine.js`: `fragmentHeight`, `radial` and the kit's haze calls;
- `src/spawns/engines/weatherVolume/materials.js`: the rain-shaft `streaks` / `fine` noise and
  every `anchor` comparison;
- any uniform built from a world position that a shader compares with `positionWorld` (audit
  `uniform(new THREE.Vector3` / `Vector2` across `src/`).

Pick one fix per site: add `renderOrigin` in the shader (the default), or write the uniform in the
render frame from the CPU (only for values rewritten every frame anyway).

### a.6 CPU code that reads render-frame matrices

Each of these reads `matrixWorld` / `getWorldPosition` / the view matrix and compares with world
values; convert with `origin.toRender` / `toWorld` or read `camera.position` (world) instead:
`src/spawns/spawnManager.js` (`refreshCameraFromMatrix`: camera position and the view cone),
`src/spawns/director.js` (`isInView`: transform the sphere centre to render first),
`src/spawns/lure.js` (the view position from `camera.matrixWorld`), `src/ui/glassHud.js` and
`src/ui/ui.js` (`applyMatrix4(camera.matrixWorldInverse)` and `.project(camera)` on world points),
`src/audio/spatial.js` (listener), `src/world/terrain.js` `countFrustumVisible` (consistent
already: chunk `matrixWorld` vs render frustum; verify), `src/dev/*` helpers that project points.
Rule for new code: never call `getWorldPosition()` for world math.

### a.7 float32 world-position buffers

A float32 buffer that stores world positions is only precise near the world origin (6 cm at
1000 km). Rule: **a float32 buffer stores positions relative to an anchor**, the owning mesh's
`position` (world, float64), and the anchor stays within 8 km of the camera. Two accepted patterns:

1. *Floating anchor* (birds and fauna already do this): re-anchor when the camera is far from the
   anchor, rewriting the buffer relative to the new one.
2. *Origin anchor*: `mesh.position.copy(origin.offset)` and buffer = `world - offset`; on
   `onRebase(delta)` subtract `delta` from the live entries (or let short-lived particles expire
   and write new ones relative to the new anchor).

Audit list for wave 1: `src/render/fx.js` (contrails, wind streaks, bursts), `src/flight/trails.js`,
`src/render/clouds.js` (check its anchor; report, do not edit), `src/render/waterEffects.js`
(`trailOrigin`), `src/gameplay/waypoints.js` (the ring InstancedMesh in `rings.js` is anchored by the
challenges engineer as part of the ring migration, f.4), `src/spawns/engines/particleSystem.js` (both the TSL
compute path and the WebGL2 closed-form path), `ribbons.js`, `glowPoints.js`, `lure.js`, the
structure engine's instanced pools, `weatherVolume` and `celestial` instance data. Record each
finding (anchored already / changed) in the final report.

### a.8 Tests (origin)

- `tools/lab/origin.mjs` (node): quantization, threshold, listener order, `toRender`/`toWorld`
  round trip exact, no allocation in `update` over 100 000 calls.
- `tools/steps/origin-rebase.json` (dev server, both backends): fly (or `resetTo`) across 20 km
  in steps; at every rebase the craft's render position minus the camera's render position is
  continuous within 1 mm across the rebase frame; a far static object's screen position is
  continuous within 0.5 px; terrain, a spawn, the water and a contrail stay put; 0/0 console.
- `?test=craft` spaceplane criterion (k): rebases happen without visible jumps.

---

## b. Colliders (wave 1, engineer 2)

### b.1 Module: `src/world/colliders.js` (pure JS, no three.js import)

```js
export const COLLIDER_TYPES = Object.freeze(['box', 'cylinder', 'capsule', 'hull', 'heightfield', 'mesh']);
export const COLLIDER_SURFACES = Object.freeze(['stone', 'wood', 'metal', 'ice', 'foliage', 'cloth', 'rope']);
export function createColliderWorld({ groundSurfaces, bus, cellSize = 256 }) -> colliders
```

The game's instance is `ctx.colliders`, created in main.js on the line after
`ctx.wind = createWindField(...)`: `ctx.colliders = createColliderWorld({ groundSurfaces: ctx.groundSurfaces, bus });`.

**Shapes** (WORLD frame, metres, float64; `{ x, y, z }` points, `{ x, y, z, w }` quaternions):

| type | fields | notes |
| --- | --- | --- |
| `box` | `center`, `halfExtents { x, y, z }`, `quaternion?` | oriented box |
| `cylinder` | `center`, `radius`, `halfHeight`, `quaternion?` | axis = local +y (a trunk, a tower, a turbine mast; a flat disc for a rotor) |
| `capsule` | `a`, `b`, `radius` | segment plus radius (kite strings, branches, arch ribs, hoodoos) |
| `hull` | `points: Float64Array` (xyz triples, at most 64 points) | the service builds the face planes once (deterministic quickhull) |
| `heightfield` | `x0`, `z0` (min corner), `cell`, `cols`, `rows`, `heights: Float32Array(cols * rows)` (world y), `bottom` (world y) | axis-aligned in xz; a solid prism from `bottom` up to the heights. For landable tops: deck, roof, dam crest, island top, monolith top |
| `mesh` | `mesh: MeshCollider` from `src/world/colliderMesh.js` | three-mesh-bvh; only where no primitive fits (b.6) |

**Record** passed to `add(spec)`:

```js
{
  id: 'string',            // unique; convention `${owner}:${part}`
  owner: 'string',         // spawn instance key, 'landmark:<siteId>', 'challenge:<courseKey>', 'vegetation', ...
  type, ...shapeFields,
  tags: {
    landable: false,       // up-facing faces are ground: published to groundSurfaces (b.3)
    perch: false,          // true (the top centre) or { x, y, z } or [{ x, y, z }, ...]: eagle perch points
    sensor: false,         // never solid: entry emits colliderSensor (kite strings)
    miss: null,            // sensor tag reported to challenges, e.g. 'kiteString'
    surface: 'stone',      // COLLIDER_SURFACES: audio thump, fx, copilot wording
  },
  velocity: null,          // { x, y, z } m/s for a moving collider (train, galleon), read in impact speeds
}
```

### b.2 API

| member | contract |
| --- | --- |
| `add(spec)` | validates (throws naming the id and the field), indexes the bounds in a 2D spatial hash (`cellSize` m cells, like the WindField's), returns the id. A duplicate id throws |
| `update(id, fields)` | moves a kinematic collider: any of `center`, `quaternion`, `a`, `b`, `velocity`; refiles it only when its cells change; allocation-free |
| `remove(id)` | true when it was there; `removeOwner(owner)` returns the count |
| `addProvider({ id, query(minX, minZ, maxX, maxZ, emit) })` / `removeProvider(id)` | procedural colliders computed on demand for the queried box: `emit(spec)` with the same fields (no id registry, no persistence). Used for vegetation trunks (d.4), labyrinth walls, hoodoo fields. Must be deterministic and cache per cell |
| `sweepSphere(from, to, radius, filter, out)` | continuous test of a sphere moving from `from` to `to`. Returns true on a hit, with `out = { t (0..1), point, normal, id, owner, tags, velocity }` for the EARLIEST hit (ties: lower id). `filter`: `{ sensors: false, landableTops: true }` |
| `overlapSphere(center, radius, visit)` | every collider overlapping the sphere; `visit(record)` |
| `raycast(origin, direction, maxDistance, filter, out)` | first hit, for the copilot, cameras and the dragon's fire |
| `perchesNear(x, y, z, radius, visit)` | perch points from tagged colliders and the registered perch providers (`addPerchProvider({ id, near(x, y, z, radius, visit) })`: terrain peaks, tree tops) |
| `count`, `getStats()` (`{ colliders, providers, cells, sweeps, hits, ms }`), `list()` | |

All queries are allocation-free and deterministic (no dependence on insertion order, frame rate
or streaming). Rotations use the record's quaternion; the service keeps its own float64 scratch.

### b.3 Landable tops and ground contact

A collider tagged `landable` (boxes, cylinders, hulls and heightfields) publishes its up-facing top
to `ctx.groundSurfaces` (the Phase 2 extra ground surfaces) under the same id, so the existing
ground contact handles touchdown, rolling, parking, landing grades and the sink-rate soft crash on
it, exactly as on terrain. The sweep ignores a probe's hit on an up-facing face (`normal.y > 0.7`)
of a landable collider when the probe is a gear contact; every other hit is a structure strike.
`groundSurfaces` may move to a spatial hash internally (the colliders engineer owns that file in
wave 1); its API stays.

### b.4 The flight controller's query (sweep, so nothing tunnels)

Each craft has **collision probes**: spheres at body-axis points. A module may declare
`collision: { probes: [{ id, position: [x, y, z], radius }] }`; without it the controller derives
them from `simProfile.contacts` (every contact point, radius 0.35 m) plus the centre of mass
(radius 0.6 m). Every fixed tick, after `model.step`, `guardModel()` and `enforceSimCeiling()`:

1. each probe's world position at the previous tick and now (from the previous and current pose);
2. `sweepSphere(previous, current, radius, { sensors: true }, hit)` per probe; the earliest `t`
   across probes wins;
3. impact speed = `max(0, -(v_craft - v_collider) . normal)` at the hit;
4. **over the limit** (`impactSpeed > limits.bodyStrikeSpeed`, default 5 m/s): the model's position
   is moved back to the hit pose (`previous + (current - previous) * t`, minus the probe offset, plus
   0.05 m along the normal), then `triggerSoftCrash('structure strike', { impactSpeed })`. The
   Phase 1 soft crash holds the craft at that contact point; `crashFloorHeight` therefore never
   lifts it into the structure, and `respawnAfterCrash` lifts the respawn point above any collider
   whose bounds contain it (top + 50 m);
5. **under the limit**: resolve. Put the probe at the hit point plus 0.05 m along the normal, remove
   the inward normal velocity (restitution 0.15), apply tangential friction 0.35. This is a scrape,
   a bump or a perch approach, never a crash;
6. **sensor**: no resolve, no crash. The first entry emits `colliderSensor` once; it re-arms when
   the probe has left the sensor's bounds;
7. every solid hit emits `colliderHit` (for audio, fx and the copilot).

At 120 Hz a 2000 m/s re-entry moves 17 m per tick; the sweep covers the whole segment, so thin
colliders (0.1 m kite strings) still register. The penetration test of `?test=collision` proves no
probe ever ends a tick inside a solid collider.

`env.colliders` (the service, read only: `perchesNear`, `raycast`, `overlapSphere`) is added to the
model `env` for models that need it (the eagle's perch, the paraglider's relaunch slope check).

### b.5 Registration with spawn instances

Exactly like wind sources (Phase 2):
- an engine adds colliders in `create()` through `ctx.game.colliders.add(...)`, names them
  `${preset.id}:${params.seed}:<part>` (the instance id is not known at create) and lists every id
  in `instance.colliderIds: []`;
- `dispose()` removes them;
- the SpawnManager's `disposeParts` removes any id still registered, counts `leaks.colliders` and
  logs `console.error` (which fails every test), as it does for wind sources;
- the spawn check kit's dispose check adds the collider count to its baseline (the spawns test,
  `presetChecks*` and the structure kit all use it);
- moving parts call `colliders.update(id, ...)` from `update()`, allocation-free.

### b.6 three-mesh-bvh

Needed: yes, for the cave tunnel (preset 77): a rock mountain mesh with a winding tunnel through it,
which no set of primitives represents (the inside and the outside are both solid surfaces). Every
other Phase 3 structure fits primitives (arches = capsule ribs plus box legs; viaduct = box piers,
box deck and two hulls per spandrel; castle = boxes and cylinders; world tree = cylinder trunk plus
capsule branches; icebergs = hulls; hoodoos = capsules). A preset author may use `mesh` only with
the lead's agreement, recorded in its preset docs.

`src/world/colliderMesh.js` (main thread only; imports `three/webgpu` and `three-mesh-bvh`):

```js
export function createMeshCollider(geometry, worldMatrixElements /* Float64Array(16), world frame */, { maxLeafSize = 8 } = {})
  -> { type: 'mesh', bvh: MeshBVH, matrix, inverse, bounds: { min, max }, dispose() }
```

The geometry stays in its local frame; the sweep transforms the segment into it (float64), uses
`bvh.shapecast` for the swept sphere (capsule-vs-triangle), and returns the normal in world frame.
The BVH is built once at create (deterministic geometry from the site seed) and disposed with the
instance.

### b.7 The single three.js core

`vite.config.js` resolves the exact specifier `'three'` to `'three/webgpu'`
(`resolve.alias: [{ find: /^three$/, replacement: 'three/webgpu' }]`), so three-mesh-bvh and three's
own addons (BufferGeometryUtils imports bare `'three'`) share the game's build. The check (its
results are in docs/phase3-progress.md): a dev server smoke imports three-mesh-bvh inside the
running game and its `raycastFirst` must return the game's own `THREE.Vector3`; a production build
importing `three/webgpu`, BufferGeometryUtils and three-mesh-bvh must hold one three.js core (one
`Multiple instances` guard string) and log no duplicate-three warning; `build:single`, the built V2
and the built shell smoke with 0 errors and 0 warnings. The integration pass repeats it once the
colliders branch (the first real importer) has merged.

### b.8 Retrofits (who owns which)

| colliders on | owner | shapes and tags |
| --- | --- | --- |
| v1 landmarks in V2 (`src/world/landmarks.js`): arches, monolith circles, lighthouse (tower, cottage, rocks), balloon fair | colliders engineer (wave 1) | arches: box legs plus capsule ribs along the span (the opening stays clear; `landmark:threaded` unchanged); standing stones and trilithons: boxes, `perch` on lintels and tall stones, lintel tops `landable`; lighthouse: cylinder tower (`perch` on the gallery) and box cottage; balloons: a sphere-ish hull per envelope plus a box basket, moving with the drift (`update` each frame) |
| Phase 2 structures (`src/spawns/engines/structure/recipes/*.js`): wind farm turbines, rope bridge, airfield hangars, crystal spires, floating islands | colliders engineer (wave 1) | turbines: cylinder mast, box nacelle, thin cylinder disc for the rotor (solid); rope bridge: capsules for the deck and ropes (`surface: 'rope'`); hangars: boxes with `landable` roofs; spires: hulls, `perch` on the tips; floating islands: hull underside plus the existing island top as a `landable` heightfield (the Phase 2 ground surface moves onto the collider) |
| new Phase 3 presets | the preset's batch engineer (wave 3) | per preset docs |
| vegetation trunks (redwoods, the world tree) | water/regions engineer (provider, d.4); world tree preset 66 (wave 3) | |
| challenge gates | challenges engineer (wave 1) gives gate frames `collider: false` by default; a solid frame is a box set added by the preset | |

### b.9 Tests (colliders)

- `tools/lab/colliders.mjs` (node): every shape against `sweepSphere`, `overlapSphere` and
  `raycast` (analytic expectations), sweeps at 10, 300 and 2000 m/s at grazing and normal incidence
  (never through), the earliest-hit rule, sensors re-arming, landable tops reaching
  `groundSurfaces`, providers, determinism (shuffled insertion gives identical results), cost
  (sweep of 30 probes against 2000 colliders under 0.1 ms) and zero allocation.
- `?test=collision` (k.2).

---

## c. Water: the shared water-height query and local water bodies (wave 1, engineer 3)

### c.1 Water bodies are data (pure, both threads)

A site preset declares local water in a `waters` list next to `stamps`. Placement resolves them per
site like stamps (same seed stream, after the stamps), into world-space records:

```js
// preset (pure data)
waters: [{
  kind: 'lake',              // 'lake' | 'pool' | 'thin' (a film over a flat: salt flat, rice terrace flats)
  stamp: 0,                  // index of the stamp whose basin clips the water (required)
  level: { mode: 'basin', fill: 0.85 },   // 'basin' (fraction of the basin depth) | 'absolute' (m MSL) | 'aboveGround' (m, thin films)
  material: 'water',         // 'water' | 'ice'
  tint: 0x2f8f9a,            // optional body colour (flamingo pink, turquoise, salt-white)
  waves: 0.25,               // swell scale (0..1) relative to the ocean
  glint: 1, foam: 1,         // shoreline foam and sun glint scale
  mirror: 0,                 // 0..1: the salt-flat sky mirror (budgeted approximation)
}]

// resolved record (frozen), site.waters[i]
{ id: '<siteId>:w<i>', kind, material, level (m MSL), bounds: { minX, maxX, minZ, maxZ },
  basin: <stamp record>, tint, waves, glint, foam, mirror, seed }
```

The water surface of a body exists at `(x, z)` only where the body's own basin function says the
ground there is below `level` (the clipping), so a lake never spills over its rim. Bodies belong
to sites: they appear and disappear with placement, deterministically, on both threads.

New stamp types owned by this engineer, because they hold water: `basin` (a generic lake bed:
reservoir valley, oasis, flamingo lake, frozen lake, small ponds), `crater` (rim plus bowl), and
`terraces` (stepped hillside or travertine steps with flat pool shelves). New paints: `salt`,
`sand`, `travertine`, `mud`, `ice`. Other new stamp types (`channel`, `crack`, `atoll`, `giant`)
are added by the wave 3 batch that first needs them, in the same stamps.js tables.

### c.2 The query: `src/world/waterQuery.js`

```js
export const OCEAN_WAVES      // the quantized swell table, moved here from water.js (the shader imports it too)
export function oceanHeight(x, z, t, swellScale)        // pure Gerstner sum, the same waves the shader draws
export function createWaterQuery({ world, effects = null }) -> waterQuery
```

The game's instance is `ctx.waterQuery` (main.js, the line after `ctx.perf = perf;`); the
`effects` (the water effects layer, for whirlpool dips) is attached by the water system when it
is created (`waterQuery.attachEffects(effects)`).

| member | contract |
| --- | --- |
| `heightAt(x, z, t = state.time.elapsed)` | the water surface height (m MSL) at (x, z): the highest of the ocean (sea level plus swell, minus any whirlpool dip) and every local body whose clipped surface covers (x, z). `-Infinity` where neither exists (dry land above sea level with no lake). Ocean exists wherever the terrain is below sea level |
| `sample(x, z, t, out)` | `out = { height, normalX, normalY, normalZ, velocityX, velocityY, velocityZ (orbital), kind: 'ocean' \| 'lake' \| 'none', bodyId, material: 'water' \| 'ice', depth (m of water above the ground) }` |
| `bodiesNear(x, z, radius, visit)` | the resolved water bodies (for the renderer, the copilot's "find water to land", the director's water weighting) |
| `isWater(x, z)` | `heightAt > groundHeight` (no time; uses the static level) |
| `swellScale(x, z)` | deterministic swell scale from the WindField ambient at (x, z): the SAME function the shader's swell scale follows |

Determinism: everything is a pure function of (seed, presets, x, z, t) plus the whirlpools, which
come from deterministic spawns. The ocean waves in the physics and the shader use one table and
one swell-scale function; the damped `windStrength` uniform no longer drives the ocean swell.
Ice bodies return their level as a solid surface (`material: 'ice'`).

Worker side: `world.waterBodyAt(x, z)` (pure, in worldgen through placement) returns the static
body and level, so the terrain worker, the map tiles and the far field colour lakes the same way.

### c.3 Caller migration (this engineer migrates every one)

`env.waterLevel` stays (0, for anything not yet migrated) and gains:

```js
env.waterHeight(x, z)        // ctx.waterQuery.heightAt at the tick time
env.waterSample(x, z, out)   // ctx.waterQuery.sample at the tick time
```

| caller | change |
| --- | --- |
| flight models: `groundContact.js`, `SimFixedWing.js`, `SimHelicopter.js`, `SimQuad.js`, `SimWingsuit.js`, `helicopterAssists.js`, `autopilot.js`, `trim.js` | every `Math.max(groundHeight, waterLevel)` and every `< waterLevel` becomes the water height at that point. A craft that cannot float touching any water (lake or ocean) is the water soft crash; `contact.water` is set for lakes too. Ice is ground (`contact.water` false; touchdown and friction 0.05) |
| `FlightController.js`: `surfaceHeight`, `crashFloorHeight`, `contactOutcome` water lines, `spawnAfterCraftChange` | the water height; `state.flight.onWater` (boolean, all craft) from the model contact |
| `src/core/loop.js` safety net and `player.agl` | the water height |
| spray (`trails.js` ballast spray, `waterEffects.js` craft contact and downwash) | the water height and body (spray on lakes) |
| bioluminescence (`waterEffects.js` trails, `waterEffectEngine.js`) | glows only where `sample().kind === 'ocean'` or the body's preset enables it |
| soft crash respawn and hold | via `surfaceHeight` / `crashFloorHeight` |
| cameras (`chase.js`, `cameraManager.js`, `flybyView.js`), `copilot.js` over-water wording, `relaunch.js`, `placement.js` (ground start), `testHarness.js` penetration surface | the water height |

The seaplane (wave 2) reads floats against `env.waterSample` at every float corner.

### c.4 Rendering: `src/render/waterMaterial.js` and the `waterBodies` system

- `createWaterMaterial(ctx, { kind: 'ocean' | 'lake' | 'ice', grid, tint, waves, glint, foam, mirror })`:
  the Phase 1/2 ocean material, moved out of `water.js` unchanged for `kind: 'ocean'` (the golden
  frame must stay pixel-identical), with the lake and ice variants: waves scaled down, sun glint,
  shoreline foam from the basin depth, the ice look (pressure ridges and cracks from noise, white
  rime, a dull specular). It applies the origin's `renderOrigin` (a.5) and the curvature node (g.3).
- `src/render/waterBodies.js`, system `waterBodies` (after `water`): one pooled flat mesh per body
  within 12 km (more distant ones are drawn by the far field), a grid clipped to the basin bounds,
  discarding fragments where the basin ground is above the level (no spill), LOD by distance.

### c.5 Tests (water)

- `tools/lab/water.mjs`: ocean height equals the shader table's height at sampled points and times;
  basin clipping (no water outside a rim, none above the level); ice is solid; `heightAt` and
  `sample` cost (under 1 microsecond median for the ocean-only path; under 3 with a lake in reach);
  zero allocation; worker/main agreement of `waterBodyAt`.
- the flight labs prove a lake crash for a non-floating craft and the Phase 1 ocean behaviour
  unchanged elsewhere.
- `tools/steps/water-bodies.json`: a fixture lake, ice lake and thin film rendered (screenshots,
  both backends), the golden frame unchanged, 0/0.

---

## d. Region overlays and vegetation (wave 1, engineer 3)

### d.1 Data shape (pure, in the shared placement module next to stamps)

A site preset may declare `overlays`. Placement resolves them per site (seed stream after the
waters) into world-space records kept with the site (`site.overlays`). `src/world/overlays.js`
(pure, like stamps.js) holds the types, validation, resolution and the per-point influence:

```js
overlays: [{
  shape: { kind: 'disc', radius: [1800, 2600], falloff: 300 },   // 'disc' | 'ellipse' (radius, aspect, angle) | 'stamp' (follows stamp i's footprint)
  palette: 'cherryBlossom',          // a named palette from OVERLAY_PALETTES (overlays.js): per biome slot colours
  vegetation: { species: ['cherry'], density: 0.7, mode: 'replace' },   // 'replace' | 'add'; species from VEGETATION_SPECIES
  material: null,                    // null | 'ice' (glossy icy ground)
  tintSweep: null,                   // { colors: [0xc0392b, 0xe67e22], periodSeconds: 900, direction: 'downwind' | <deg>, width: 600 }
  stripes: null,                     // { width: 18, angle: 'ridge' | <deg>, colors: [...], species: ['lavender', 'tulip'] }
  priority: 0,                       // overlapping overlays: higher wins, then the lower site id
}]
```

Resolved: `{ id: '<siteId>:o<i>', bounds, shape (world), palette, vegetation, material, tintSweep,
stripes, priority, seed }`.

### d.2 Determinism and worker/main agreement

- Overlays never change height. `heightAt`, `groundHeight` and their cost are untouched.
- `world.overlayAt(x, z, out)` (worldgen, pure) returns `{ weight, palette, material, sweepPhase,
  stripe, speciesSet }` through the same 64 x 64 cell window the stamps use; worldgen's
  `faceColor` blends the overlay palette (with the dithered edges of the stamp paint), and
  `scatterChunk` draws species from the overlay's set.
- Both threads import the same worldgen, placement, overlays and preset list, so the worker's
  chunk meshes equal main-thread builds bit for bit (the terrain test's worker parity check covers
  colours and scatter). `hashSiteList` includes overlay and water ids, bounds and levels (to 1 cm);
  the determinism key changes version once, and the Phase 2 hashes are re-recorded.
- Animated overlays (tint sweeps) bake only per-vertex inputs: chunk geometry gains one attribute
  `overlay` (vec4: sweep weight, sweep phase in metres, material id, stripe id), written by the
  chunk builder on both threads. The terrain material animates the sweep from `uniforms.time` and
  shades ice from the material id. With no overlay every value is 0 and the Phase 2 terrain renders
  identically.

### d.3 Vegetation species

`src/world/vegetationSpecies.js` (pure) extends `world.VEGETATION` (ids 0-5 unchanged):

| id | species | notes |
| --- | --- | --- |
| 6 | `cherry` | pink canopy; petal particles on gusts (preset 82) |
| 7 | `redwood` | giant trunk 60-110 m, trunk collider, perch top |
| 8 | `bamboo` | dense culms, strong sway |
| 9 | `saguaro` | the cactus forest's tall cacti (the Phase 1 `cactus` stays) |
| 10 | `mangrove` | roots over water: allowed below `WATER_LEVEL + 0.9` inside a mangrove overlay only |
| 11 | `lavender` | rows (stripes) |
| 12 | `tulip` | rows (stripes) |

Each species entry: `{ id, name, height: [min, max], trunk: { radius, height } | null (collider),
perch: boolean, sway: { stiffness, gust }, tints: per biome }`. Species 6-12 grow only inside
overlays (the base biomes' scatter is unchanged, so worlds without overlay sites are bit-identical
to Phase 2). `VEGETATION_TYPE_COUNT` and the scatter header grow accordingly in terrain.js and
chunkBuilder.js.

`world.vegetationNear(x, z, radius, visit)` (pure): the scatter instances whose cells overlap the
disc, without building a chunk (trunk colliders, perches, petal emitters).

### d.4 Wind sway driven by the WindField; trunk colliders

- `src/render/windSway.js`: a 64 x 64 sway texture (32 m cells, 2 km square around the streaming
  focus, re-centred on 32 m steps) of the WindField's horizontal wind and turbulence at 10 m AGL,
  refreshed a few rows per frame from `wind.probe` (allocation-free), so spawn wind sources (a
  dust devil, a gust front, a microburst) visibly ripple the vegetation. Exports the TSL node
  `swaySample(worldXZ)` -> vec3 (wind x, wind z, gust). The vegetation position node uses it instead
  of the global `windDirection` / `windStrength` (outside the texture it falls back to those).
- Trunk colliders: `ctx.colliders.addProvider({ id: 'vegetation', query })` emits a `cylinder` per
  species instance with a `trunk` (redwood, and later the world tree) from `world.vegetationNear`;
  perches through `addPerchProvider` (tree tops of `perch` species, plus the tallest Phase 1 pine
  per 64 m cell for the eagle).

### d.5 Tests (overlays)

- `tools/lab/terrain.mjs` extended: overlays never change height (bit-identity of `heightAt`),
  Phase 2 worlds without overlay sites stay bit-identical in colours and scatter, overlay
  resolution determinism, the `overlay` attribute on both threads.
- `?test=terrain&presets=real` covers every new stamp type and an overlay of each kind (wave 3
  extends the fixtures as presets land).

---

## e. Fauna ground and water-surface modes; PathFollower (wave 1, engineer 4)

### e.1 Fauna engine additions (`src/spawns/engines/faunaEngine.js`, `faunaSpecies.js`)

New altitude mode and behaviours (params validated like the Phase 2 ones; docs/engines/fauna.md):

| param | values | meaning |
| --- | --- | --- |
| `altitude.mode` | adds `'ground'` | agents stand on `groundHeight` (the extra ground surfaces too); never in water (`waterQuery.isWater`) |
| `altitude.mode` | `'water'` (generalised) | the surface of `ctx.game.waterQuery` (ocean AND local bodies), following swell |
| `behavior: 'herd'` | `herd: { slopeLimit: 0.45, waterMargin: 8, gaits: { walk, trot, run }, cohesion, spacing, stampede: { trigger: 'player' \| 'timer' \| 'event', radius, speed, duration }, dust: { rate, size, color } }` | terrain-following herd; avoids slopes above `slopeLimit` (rise/run over 6 m) and water within `waterMargin`; a stampede runs downhill-biased away from the trigger with a dust plume (the engine's own pooled dust sprites) |
| `behavior: 'column'` | `column: { path: <PathFollower spec> \| 'auto', spacing, lanes, speed, jitter }` | a long line of walkers along a path (caribou migration, the camel caravan) |
| `behavior: 'surface'` | `surface: { porpoise: { height, interval }, raceShadow: { radius, boost }, wade: { depthMax, flushRadius, takeoffWave: { delay, spread } } }` | dolphins leap and race the craft's shadow on the water; flamingos stand in shallow water (`depthMax`) and take off in a wave when buzzed, fly as a flock and settle back |

Species added in wave 1 (to prove the modes): `bison` (herd), `caribou` (column), `dolphin`
(surface), `flamingo` (surface, then flock). Bats, butterflies and camels come with their presets
(wave 3), in `faunaSpecies.js`. Ground and surface agents pool like the others; their dust and
splashes count against the fauna particle budget.

Predators: the fauna scatter reads `ctx.state.flight.craft` and the active module's optional
`faunaThreat` (number, default 1): scatter radius and burst scale with it. The eagle (wave 2)
sets 2.5.

### e.2 PathFollower (`src/world/pathFollower.js`, pure)

```js
export function createPath({ points /* Float64Array xyz */, closed = false, smoothing = 'catmullRom', samplesPerSegment = 16 })
  -> path: { length (m), sampleAt(distance, out), tangentAt(distance, out), nearestDistance(x, y, z) }

export function createPathFollower({ path, speed /* m/s */, mode = 'loop' /* 'loop' | 'pingpong' | 'once' */,
                                     startTime /* flight s */, startDistance = 0, ground = null /* (x, z) => y, keeps cars on the terrain */,
                                     groundOffset = 0, waits = [] /* [{ distance, seconds }] stations and stops */ })
  -> follower: {
       at(time, out),                  // out = { x, y, z, tx, ty, tz, heading (deg), distance, speed, done }
       carAt(time, offset, out),       // a trailing car `offset` metres behind the head (train cars, camels)
       length, duration,               // duration Infinity for loop / pingpong
     }

export function buildGroundPath(world, waterQuery, { from, to, maxSlope, seed, spacing })   // caravans, herds: avoids slopes and water
```

A follower is a pure function of flight time: two runs at the same time give the same position
(replay, determinism), and a paused clock stops it. Engines call `at` from `update` with
`state.time.elapsed`. Users: the train on the viaduct (56, structure engine), the camel caravan
(58, fauna `column`), the ghost galleon (69, structure engine), the dragon racer's rival (70),
the caribou column (52) and the airship's scenic cruise (wave 2).

### e.3 Tests

- `tools/lab/fauna-modes.mjs` (or the fauna sections of `tools/lab/spawns.mjs`): herds never on
  slopes over the limit or in water, a stampede triggers and settles, flamingos flush in a wave,
  dolphins follow the swell and the craft's shadow, zero allocation in the frame update.
- `tools/lab/path.mjs`: arc-length accuracy (under 0.5 % against a fine polyline), `at` continuity,
  loop / pingpong / once, waits, cars, determinism, `buildGroundPath` respects slope and water.
- `tools/steps/engine-fauna-modes.json`: each new species force-spawned ahead (screenshots, both
  backends), dispose back to baseline.

---

## f. Challenges (wave 1, engineer 4)

### f.1 System: `src/gameplay/challenges.js` (`ctx.systems.challenges`, after `rings`)

```js
export const MEDALS = Object.freeze(['gold', 'silver', 'bronze']);
export const CHALLENGE_STORAGE_KEY = 'driftwing-v2.challenges';
export const CHALLENGE_PATH_KEY_PREFIX = 'driftwing-v2.challengePath.';
export const BEST_PATH_HZ = 10;
export function createChallengeSystem(ctx) -> challenges
```

**Course definition** (built by an engine, a preset's `challenge` block through the structure
recipe `challengeGates`, or the ring adapter):

```js
{
  id: 'canyonGauntlet:canyonGauntlet:12:-4',   // stable: `${presetId}:${siteId}` for site courses
  name: 'Canyon Gauntlet',
  presetId: 'canyonGauntlet',                 // optional
  gates: [{
    id: 'g0', role: 'start' | 'checkpoint' | 'finish',
    center: { x, y, z }, normal: { x, y, z },  // the pass direction (unit)
    up: { x, y, z },                          // with the normal it fixes the gate frame
    shape: 'circle' | 'rect', radius, halfWidth, halfHeight,
  }],
  medals: { gold: 62, silver: 75, bronze: 95 } | null,   // seconds; null: no medals
  missed: { mode: 'penalty' | 'void' | 'count', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 150 },
  sensors: { kiteString: { penaltySeconds: 2 } },   // colliderSensor tags counted as misses
  start: { mode: 'gate' | 'immediate', promptRadius: 1500 },
  abandonDistance: 4500, teleportDistance: 400, timeLimit: null,
  rival: null,                               // { follower, name }: a PathFollower racing the course (preset 70)
  record: true,                              // bests, medals and best-run paths are stored
  legacyRings: false,                        // the ring adapter (f.4)
}
```

**API**

| member | contract |
| --- | --- |
| `register(definition, { owner })` | validates (throws naming the course and field), returns the `courseKey` (`${seed}:${definition.id}`). A second register of the same key replaces the gates (a re-created site) and keeps the records |
| `unregister(courseKey)` | an active run on it is cancelled (`reason: 'removed'`) |
| `start(courseKey, { source })` | `source`: `'gate'` (flew through the start), `'key'`, `'copilot'`, `'ui'`, `'rings'`. Arms the course: `start.mode 'gate'` waits for the start-gate crossing, `'immediate'` starts the clock now |
| `cancel(reason)` | ends the active run, emits `challengeCancelled` |
| `nearest(radius)` | `{ courseKey, name, distance, bearing }` of the nearest registered start gate, or null |
| `getState()` | the live `state.challenge` object (f.2) |
| `getBest(courseKey, craft)`, `getRecords()` | best `{ time, medal, splits, date, missed }` per craft; a plain copy of everything |
| `getBestPath(courseKey, craft)` | `{ hz: 10, frames: Float32Array }` (8 floats per frame: t, x, y, z, qx, qy, qz, qw; t from the start crossing) or null. Phase 4 ghosts read this |
| `count()` | registered courses (dispose checks) |

**Rules**
- Detection runs every frame on the segment flown that frame (`state.player.position`, world), with
  `crossGates` from `src/spawns/engines/gateDetector.js`; a crossing's time is interpolated inside
  the frame. The clock is the flight clock (paused in photo mode).
- Gates are sequential. Crossing the current gate's plane outside its shape, or passing
  `skipDistance` beyond its plane, misses it; `mode` decides: `penalty` adds seconds, `void`
  completes the run but stores no best, `count` just counts (rings).
- Splits: at each checkpoint, the time and the delta to this craft's best split there.
- Medal: the best medal whose threshold the final time (with penalties) meets.
- Best time per craft, per course, per world: saved under `CHALLENGE_STORAGE_KEY`
  `{ version: 1, courses: { [courseKey]: { name, presetId, best: { [craft]: { time, medal, splits, missed, date } } } } }`.
- The best run's path is recorded at 10 Hz from the start crossing to the finish (at most 12 000
  frames) and saved, only when the best improves, under
  `${CHALLENGE_PATH_KEY_PREFIX}${courseKey}.${craft}` as `{ version: 1, hz: 10, frames: [...] }`.
- Owners unregister their courses in `dispose()`; the integration pass adds `count()` to the spawn
  check kit's dispose baseline.

### f.2 `state.challenge` (live; the HUD, the copilot and telemetry read it)

```js
{ active, courseKey, name, phase: 'armed' | 'running' | 'finished' | null, elapsed, gateIndex, gatesTotal,
  nextGate: { x, y, z, nx, ny, nz, distance, bearing } | null, missed, penalties,
  lastSplit: { index, time, delta } | null, medalPace: 'gold' | 'silver' | 'bronze' | 'none' | null,
  best: number | null, rival: { distanceAhead } | null,
  prompt: { courseKey, name, distance, bearing } | null }
```

### f.3 Challenge UI (`src/ui/challengeHud.js`, system `challengeHud` after `ui`)

Glass, in the existing UI style, reading `state.challenge` and the typed challenge events:
the start prompt (near a start gate: name, best for this craft, the key, `Y`), the gate arrow (a
screen-edge chevron toward `nextGate`, and a 3D marker in the gate), the timer with splits (green
ahead / red behind the best), the medal toast on `challengeFinished`, and the missed-gate flash. The
journal shows best times and medals (j). Action `challengeStart` (default `KeyY`, owner: the
challenges system) starts the nearest course within its prompt radius, or cancels the active run.

### f.4 Ring course migration (identical behaviour)

`src/gameplay/rings.js` keeps planning, building and drawing the rings. Pass and miss detection,
timing and the course lifecycle move onto the challenge core through an adapter:
`start(options)` builds the rings as today, then registers `{ id: 'rings', legacyRings: true,
record: false, medals: null, start: { mode: 'immediate' }, missed: { mode: 'count',
outsideCrossing: 'miss', skipDistance: 150 }, abandonDistance: 4500, teleportDistance: 400 }` with
one gate per ring (`shape: 'circle'`, `radius` = `PASS_RADIUS`, the last one `finish`).

Identical means, bit for bit against the Phase 2 code on the same scripted paths:
- the untyped events `rings:started { total }`, `ring:passed { index, streak, position }`,
  `ring:missed { index }`, `rings:finished { time (0.1 s), passed, total, bestStreak }` and
  `rings:cancelled {}`, with the same payloads, in the same order (each ring event before
  `rings:finished`), on the same frames;
- `state.ringCourse` (every field) and `getStats().lastCrossing`;
- `journal.recordRingCourse`, the audio cues, the autopilot's ring following, the R key, the
  copilot's ring lines and the UI chips;
- no typed challenge events and no records for the ring course (it is procedural, so there is no
  course to compare).

Proof: before migrating, record golden event logs from the Phase 2 rings over 6 scripted paths
(clean, every miss kind, an abandon, a teleport, a cancel) into
`tools/lab/fixtures/rings-golden.json`; `tools/lab/challenges.mjs` replays them on the migrated
code and needs equality.

### f.5 Tests

- `tools/lab/challenges.mjs`: the ring goldens; gate crossing interpolation; splits; medals; miss
  modes; sensor misses; best per craft; the 10 Hz path (count, order, storage round trip);
  storage keys and versions; determinism; no allocation per frame.
- `tools/steps/challenge.json`: a fixture course in the game (start prompt, arrow, splits, medal
  toast, journal entry; screenshots), both backends, 0/0.

---

## g. High-altitude and space rendering (wave 1, engineer 5)

### g.1 Air density input: `src/env/atmosphere.js` (pure)

```js
export { airDensity, SEA_LEVEL_DENSITY, speedOfSound } from '../flight/telemetry.js';   // ONE density model
export function densityRatio(altitude)       // rho / rho0, the exponential model the physics flies in
export function skyState(altitude, out)      // the render inputs below, from the CAMERA altitude
```

`state.atmosphere` (written by the sky system every frame from `camera.position.y`):

| field | meaning |
| --- | --- |
| `altitude` | camera altitude (m MSL) |
| `density` | rho (kg/m^3) at the camera |
| `densityRatio` | rho / rho0 (1 at sea level, 0.0001 at 80 km) |
| `skyDarkness` | 0..1: the gradient's blend toward black |
| `starVisibility` | 0..1: stars in daylight, rising from 30 km |
| `limb` | 0..1: the thin blue atmospheric limb at the horizon |
| `sunSharpness` | 0..1: the sun disc sharpens, the glow narrows |
| `fogScale` | fog density multiplier (density-driven) |
| `horizonDistance` | m: `sqrt(2 R h + h^2)` with the planet radius R |
| `curvature` | 0..1: the curvature blend (0 below 5 km, 1 by 8 km) |
| `viewDistance` | m: what the far plane and the far field must reach |

Uniforms (main.js, after `cloudBow`): `atmosphereDensity`, `skyDarkness`, `starVisibility`,
`limbStrength`, `sunSharpness`, `curvatureAmount`, `planetRadius`, `horizonDip` (rad).

### g.2 Sky, fog, stars and limb hooks (`src/render/sky.js`)

- The dome gradient blends toward black with `skyDarkness`; the sun disc sharpens and its glow
  narrows with `sunSharpness`; stars show at `max(night, starVisibility)`; the limb is a thin band
  at the horizon dip angle (`acos(R / (R + h))`) tinted blue, `limbStrength` wide.
- Fog density and the fog node's haze scale with `fogScale`; `camera.far` (owned by sky.js) follows
  `viewDistance` (at most 600 km). `camera.near` (owned by the camera system) may scale with
  altitude above 12 km in third person views only, so the WebGL2 depth range stays usable.
- With the camera below 3 km nothing changes: the golden-hour opening is pixel-identical
  (`tools/steps/golden-frame.json`).
- Sky modifiers (Phase 2) still fold on top. The director's global overrides (i.5) add a sun
  override hook to sky.js in wave 2.

### g.3 Curvature (`src/render/curvature.js`)

```js
export const DEFAULT_PLANET_RADIUS = 1_000_000;    // m; the setting planetRadiusKm (200..6371, default 1000)
export function curvatureDrop(dx, dz, radius)       // CPU: (dx^2 + dz^2) / (2 R)
export function curvedPositionNode(ctx, positionLocalNode)  // TSL: positionLocal lowered by the drop of its horizontal render distance to the camera, times curvatureAmount
export function rigidCurvatureDrop(ctx, worldX, worldZ)     // CPU, for discrete objects placed each frame
```

- Visual only: physics, colliders, water, wind and placement stay flat.
- Vertex curvature: terrain chunks, far-field tiles, water (ocean and bodies), the cloud field,
  weather volumes, FAR lures and the far-field cloud layer.
- Discrete objects farther than 5 km (landmarks, structure instances, fauna groups) take
  `rigidCurvatureDrop` on their root's y each frame while `curvatureAmount > 0` (landmarks.js and
  the structure engine in wave 1; every Phase 3 preset engine in wave 3).
- `settings.planetRadiusKm` (Graphics tab), clamped 200..6371, default 1000.

### g.4 Far-field handoff (`src/world/farField.js`, system `farField` after `terrain`)

- Tiles from the Phase 2 map-tile worker (`createMapTileService`, fields `height`, `color`), in
  concentric rings out to `horizonDistance`, LOD by distance (1 km tiles near, 256 km at the
  horizon), each a flat-shaded grid in tile-local coordinates at its world centre, with skirts and
  vertex curvature. Lakes come from `world.waterBodyAt` through the tile colours and a water flag.
- Below 6 km camera altitude the far field draws nothing. From 6 km it fills the annulus beyond the
  terrain's coverage. Terrain API (high-altitude engineer): `terrain.getCoverageRadius()` and
  `terrain.setFarFieldHandoff({ innerRadius, fade })`. In the overlap band both draw: the far-field
  ground sits a little below (0.2 % of the distance) and both cross-fade with a screen-door dither,
  so there is no seam and no hole.
- Above 12 km the terrain chunks hand off fully (cross-fade 11-13 km): the far field covers from
  the nadir to the horizon, the terrain stops drawing (its streaming continues within 20 km of the
  ground so a descent finds the ground ready, and collision never depended on it).
- Clouds and weather stay visible from above: the far field draws a cloud layer shell at cloud
  height from the deterministic cloud coverage and the regional weather (storm cells read dark).

### g.5 FAR lures from altitude

The SpawnManager keeps heavy instances alive while their HORIZONTAL distance is within `lod.far`
when the camera is above 12 km (their tier is forced to `far`, so only the lure draws), and lures
take the vertex curvature. `spawns:inView` and discovery keep their Phase 2 rules (3D distance).

### g.6 Altitude ceiling and the flight model

`FLIGHT_CEILING` becomes the default: a craft's `limits.ceiling` (m) overrides it (the spaceplane
sets 150 000; every other craft keeps 15 000). `enforceSimCeiling` and the loop's safety net read
`flight.getCeiling()`, which returns the active craft's ceiling.

### g.7 Tests (high altitude)

- `tools/lab/atmosphere.mjs`: density, darkness, stars, limb and curvature numbers against their
  formulas; horizon distances.
- `tools/steps/high-altitude.json` (both backends): a debug climb (teleports) at 3, 8, 15, 35 and
  100 km: screenshots differ, stars visible at 35 km by day, the limb present, the far field with
  no holes (a depth readback over the lower half of the view finds ground everywhere below the
  horizon), the handoff band seamless (pixel steadiness across the 11-13 km band), the golden frame
  unchanged, 0/0.

---

## h. The craft module contract for the 8 new craft (wave 2)

### h.1 Catalog, ids and groups

Appended to `CRAFT_CATALOG` (append-only, so settings and bindings keep their meaning):

| id | name | group | model kind (new kinds in **bold**) |
| --- | --- | --- | --- |
| `aerobatic` | Aerobatic | planes | `fixedWing` with the `aerobaticAero` extension |
| `seaplane` | Seaplane | planes | `fixedWing` with the `floats` extension |
| `tiltrotor` | Tiltrotor | rotor | **`tiltrotor`** |
| `paraglider` | Paraglider | human | **`paraglider`** |
| `balloon` | Hot air balloon | lighterThanAir | **`balloon`** |
| `airship` | Airship | lighterThanAir | **`airship`** |
| `eagle` | Eagle / Dragon | creature | **`flapper`** (skins `eagle`, `dragon`) |
| `spaceplane` | Spaceplane | space | `fixedWing` with the `rocket` extension and RCS (or **`spaceplane`** if the extension hooks cannot carry RCS) |

`CRAFT_GROUPS` (registry.js): `planes: [glider, bushplane, aerobatic, seaplane, jet]`,
`rotor: [helicopter, tiltrotor, fpv]`, `human: [wingsuit, paraglider]`,
`lighterThanAir: [balloon, airship]`, `creature: [eagle]`, `space: [spaceplane]`. Catalog entries
gain `group`; `hotkey` becomes informational (favorites own the number keys). `CRAFT_IDS` in
settings.js appends the eight ids (per-craft settings: assists, views, third-person views).

### h.2 What a craft module exports

Required (unchanged): `id`, `name`, `buildMesh`, `simProfile`, `inputProfile`, `audioProfile`,
`cameraRig`, `instruments`, `abilities`, `spawn`, `limits`. Optional, validated by the registry
when present:

| field | contract |
| --- | --- |
| `buildMesh(ctx, { skin })` | procedural low-poly, flat-shaded, v1 palette, animated moving parts (props, rotors, nacelles, flaps, wings, burner flame, envelope breathing, legs on perch). `visual` gains `craftState` (read only) so craft-specific parts animate from it |
| `skins` | `{ default: 'eagle', list: [{ id, name, silhouette }] }`; the picker offers them; `settings.craftSkins[id]` stores the choice; switching skin rebuilds the mesh only (same physics family) |
| `simProfile` | the model kind's profile (no `arcadeProfile`: there is none in V2) |
| `inputProfile` | adds `throttle: 'burner' \| 'flapPower' \| 'speedBar' \| 'rocket'`, `antenna: 'nacelle' \| 'ballonet' \| 'zoom'`, `rocker: 'vector'`, `toeBrakes: 'waterRudders' \| 'paragliderBrakes'`, `stickX: 'weightShift' \| 'rotationVents'` |
| `bindings` | optional per-craft default overrides (Phase 1 per-craft overrides) for keyboard, gamepad and the HOTAS profile documented in docs/controls.md |
| `audioProfile` | families added in `src/audio/engines/<family>.js` (one line each in index.js): `radial` (prop variant), `aerobaticProp` (high-RPM snarl), `proprotor` (character with nacelle angle), `paraglider` (canopy flutter; the vario exists), `burner` (roar with flame light; basket creak), `airshipProp`, `creature` (per-flap whoosh, screech; dragon wingbeats, roar, fire whoosh), `rocket` (roar thinning with density to structure-borne rumble; re-entry roar) |
| `cameraRig` | as Phase 1, plus `cockpit.style: 'custom'` with `cockpit.build(builder, spec, THREE)` for the gondola, basket, harness and creature views; every craft has a first-person view (cockpit, gondola, basket, harness, rider) |
| `instruments` | Phase 1 ids plus new ones in `src/ui/instruments/<id>.js`: `smoke`, `figure`, `waterRudder`, `nacelle` (the conversion corridor), `speedBar`, `envelope`, `windColumn`, `ballonet`, `perch`, `mach`, `apogee`, `heating`, `rcs` |
| `collision` | `{ probes: [{ id, position, radius }] }` (b.4); default from contacts |
| `limits` | adds `ceiling` (m), `waterLanding: 'floats' \| 'basket' \| null`, `noseOverSpeed`, `skidCrashSpeed` (seaplane wheels-up on land: 5.6 m/s = 20 km/h) |
| `situate(situation, api)` | the spawn-in-a-sensible-state hook (h.4) |
| `copilot` | `{ commands: [{ id, phrases: [regex source strings], run(api, value) -> reply }], status(craftState, telemetry) -> string }` (h.6) |
| `journal` | `{ stats: [{ key, label, unit, op }] }`: craft-specific journalStat keys (camelCase, e.g. `aerobaticBestScore`, `balloonMaxAltitude`, `spaceplaneApogee`, `paragliderBestClimb`) |
| `directorProfile` | `{ favor: { tags: { water: 1.6, lake: 1.6 }, categories: { celestial: 2 } }, above: [{ altitude: 20000, favor: { ... } }] }` (i.2) |
| `faunaThreat` | number (e.g. eagle 2.5): fauna scatter wider (e.1) |
| `capabilities` | as Phase 1, plus `smoke`, `water`, `perch`, `space` booleans for the copilot |

### h.3 Craft-specific flight state (`state.flight`)

Top level (all craft): `onWater` (boolean), `ceiling` (m). `state.flight.craftState` per craft:

| craft | fields |
| --- | --- |
| aerobatic | `smoke`, `smokeColor` (index), `figureInProgress`, `lastFigure { figure, score }` |
| seaplane | `onWater` (mirror), `onStep`, `waterRudders`, `porpoise` (0..1), `noseOverWarning` |
| tiltrotor | `nacelleAngle` (deg, 0 airplane .. 97), `nacelleTarget`, `autoNacelle`, `corridor { min, max, state: ok \| wingStall \| overspeed }` |
| paraglider | `brakeLeft`, `brakeRight`, `speedBar`, `bigEars`, `collapse { left, right }` (0..1), `pendulum` (deg) |
| balloon | `envelopeTemperature` (deg C), `ambientTemperature`, `burner`, `vent` (0..1), `altitudeHold` (m or null), `windColumn [{ altitude, fromDegrees, speed }]` |
| airship | `ballonet` (0..1), `vectorAngle` (deg), `scenicCruise { active, index, waypoints }` |
| eagle | `skin`, `perched`, `perchId`, `flapPower`, `wingTuck` |
| spaceplane | `apogee` (m, the ballistic prediction; null when descending), `dynamicPressure` (Pa), `rcsBlend` (0..1), `heating` (0..1, from rho V^3), `blackout`, `attitudeHold`, `autoReentry` |

The challenge state is `state.challenge` (f.2). WREN's remote `flightState` adds `onWater`,
`craftState` (the fields above, rounded) and `challenge` (docs/copilot-api.md in Milestone O).

### h.4 Spawn in a sensible state

`spawnAfterCraftChange` (FlightController) calls the new craft's `situate(situation, api)` when it
exists, else keeps the Phase 1 rules. `situation`:
`{ position, heading, trackHeading, groundSpeed, agl, overWater, waterBody, waterHeight, wasOnGround,
wasOnWater, previousCraft, wind { vel }, time }`. It returns
`{ mode: 'air' | 'ground' | 'water' | 'hover' | 'drift' | 'climb' | 'perch', position, heading, speed,
pitch, throttle, craftState }` (any field omitted keeps the Phase 1 default). Required behaviour:
seaplane over water = on the water when low or landed, else a low approach into the wind at
1.3 x stall; balloon = drifting with the wind at the current height (envelope at equilibrium);
spaceplane = climbing at 45 degrees at 250 m/s, full thrust; airship = trimmed neutral at the
current height; paraglider = flying at trim (relaunch from a slope when below 60 m AGL); eagle =
gliding, or perched when on a perch; tiltrotor = hover when slow or low, else airplane mode.
The soak checks: no soft crash within 10 s of a switch.

### h.5 Abilities

`abilities: { craftAbility, craftAbilityAlt? }`; `craftAbilityAlt` is a new action (default
Shift+Space; gamepad and HOTAS in docs/controls.md). The ability `api` gains `isHeld(actionId)`,
`controls` (the tick's shaped ControlState, read only), `colliders`, `waterQuery`, `wind`,
`emitTrail(kind, anchor, dt)` (adds `'smokeColor'`), `setCraftState(field, value)`.

| craft | craftAbility | craftAbilityAlt |
| --- | --- | --- |
| aerobatic | smoke on / off | smoke colour cycle |
| seaplane | water rudders up / down | |
| tiltrotor | auto-nacelle schedule on / off | |
| paraglider | big ears (held) | |
| balloon | burner (held; the throttle axis burns too) | vent (held) |
| airship | scenic cruise on / off | |
| eagle | screech (eagle) / fire breath (dragon, held) | |
| spaceplane | auto re-entry arm / disarm | attitude hold |

Smoke (aerobatic): a ribbon trail mesh (sun-lit, colour cycle, fades over 30 s), anchored per a.7.
Fire breath: a harmless visual plus a pooled light; it ignites registered ignitables through
`src/gameplay/ignition.js` (eagle engineer): `ignition.add({ id, position, radius, onIgnite })`,
`ignition.remove(id)`, `ignition.cone(origin, direction, length, angle, visit)`. Lantern and
torch owners (the sky lantern festival, the monastery, the castle, the galleon) register theirs.

### h.6 Copilot commands per craft

Each module's `copilot.commands` reach WREN's local grammar through one generic action,
`{ type: 'craftCommand', craft, command, value? }` (added to `sanitizeFlightAction`), executed by
`flightActions.js` through `flight.runCraftCommand(command, value)`, which calls the module's
`run(api, value)` and returns the spoken reply. The remote brain gets the list in
`flightState.craftCommands`. Milestone O adds the cross-craft grammar (j.2).

### h.7 Picker groups and favorites (wave 2, picker engineer)

- The picker strip shows the 14 craft in the six groups (h.1), skins under the eagle.
- `settings.craftFavorites`: 10 slots (craft ids), default
  `[glider, bushplane, jet, helicopter, wingsuit, fpv, aerobatic, seaplane, eagle, spaceplane]`
  (keys 1-6 keep their Phase 1 craft). The picker assigns a slot by drag or a slot menu.
- Actions `craftSelect1` .. `craftSelect10` (labels "Favorite 1" .. "Favorite 10"); default keys
  Digit1 .. Digit9 and Digit0. `craftNext` / `craftPrev` (HOTAS and `]` / `[`) cycle the favorites,
  skipping empty slots. Stored bindings of `craftSelect1-6` keep working.

### h.8 Tests per craft (each craft engineer)

`tools/lab/<craft>.mjs` (handling targets in the spec: roll rate, glide, hump speed, conversion,
lift, inertia, perch, apogee) and the craft's scenarios in `src/dev/craftScenarios/<craft>.js` for
`?test=craft` (k.1). Every craft flies in the first person and third person views, and the
view-physics step file covers all 14.

### h.9 Wave 2 step 0: the craft framework (picker engineer, merged before the craft branches)

Lands first, alone, then the eight craft engineers branch from it: the catalog entries and
groups, `CRAFT_IDS`, `craftFavorites` and `craftSkins` settings with a migration, actions
`craftSelect7-10` and `craftAbilityAlt` with default bindings, favorites in `performAction`, the
`situate` call, the ability api additions, `runCraftCommand` and the `craftCommand` action, the
`custom` cockpit style hook, `env.windField`, the optional-field validation in the registry, and
the dev scaffold of `src/dev/craftScenarios/index.js` and `src/dev/craftTest.js` (`?test=craft`
running the general flight test for every registered craft, in both views). Craft modules for
the eight new ids register as the craft branches merge; a catalog craft without a module stays
visible but disabled (Phase 1 behaviour).

---

## i. Director updates (wave 2, picker / director engineer)

### i.1 "Ahead" is the ground track

`getPlayer()` returns `{ position, heading, speed, velocity }`; the director derives
`trackHeading` from the horizontal velocity (falling back to the nose heading below 2 m/s ground
speed, with 1 s smoothing) and every ahead test (`aheadScore`, the 45 / 60 degree cones, drought
fills, `forceSpawn` ahead, `getNearby` bearings stay compass) uses it. The balloon, the airship and
anything drifting get content along their drift line.

### i.2 Craft-aware weighting

Presets gain `tags` (vocabulary `PRESET_TAGS` in schema.js): `water`, `lake`, `coast`, `thermal`,
`perch`, `murmuration`, `celestial`, `farLure`, `calm`, `slow`, `spectacle`, `challenge`, `night`,
`snow`, `desert`, `forest`. The director's ranking multiplies the ahead score by
`craftWeight(preset, craft, altitude)` from the active module's `directorProfile` (h.2), clamped to
0.25..3, never enough to reorder rarity tiers. Required profiles: seaplane favours `water` and
`lake`; eagle favours `thermal`, `perch`, `murmuration`; spaceplane above 20 km favours
`celestial` and `farLure` (heavy) and drops ground-only small spawns; balloon favours `calm`,
`slow`, `spectacle` along its drift line. Weighting is deterministic (the craft is part of the
input, and the activation log records it).

### i.3 Combo scheduling (legendary presets 92-97, 99 and 100)

```js
combo: {
  preconditions: { biomes: ['snow'], timeOfDay: ['night'], weather: ['storm'], siteActive: ['volcano'],
                   near: { landmarks: ['monoliths'], sites: ['crystalSpires'], radius: 6000 } },
  members: [{ presetId: 'aurora', role: 'anchor' }, { presetId: 'meteorShower', place: { bearing: 30, distance: 4000, jitter: 600 }, delay: 20 }],
  exclusive: true,          // no other legendary while it runs
  heavySlots: 2,            // the heavy budget it needs, all at once
}
```

The director treats a combo preset as a legendary candidate whose preconditions all hold at the
candidate; it activates only when the budgets admit every member. Member positions and delays are
deterministic: `hash(seedHash, comboCandidateId, memberIndex)` drives the jitter. Members start
through the SpawnManager with source `'director'` and the combo's id as their parent (the setPiece
engine orchestrates them when the preset uses it); the activation log records the combo id and
member ids in order, and `comboStarted` fires. The F9 debugger's force-spawn of a combo ignores
its preconditions (that is how Kyle's manual check forces one).

### i.4 Global overrides with regional blending

`src/spawns/overrides.js` (pure schedule) plus the director's wiring:

The blood moon (61) and the midnight sun (98) are presets with an `override` block:

```js
override: { kind: 'bloodMoon' | 'midnightSun', nightChance: 0.04, region: { biomes: ['snow'], blendKm: 20 } | null }
```

- Schedule: per night index `n = floor(dayCount)`, active when `hash(seedHash, n, presetId) <
  nightChance`; deterministic, no player input.
- Weight at the player: 1 everywhere (`region: null`, the blood moon), or the biome weight field
  blended over `blendKm` (the midnight sun in polar / snow regions).
- Application: sky modifiers (blood moon: moon tint and darkness) and a sun override hook in
  sky.js, `sky.addSunOverride(id, { apply(dayTime, direction, weight) })`, which bends the sun path
  so it skims the horizon (midnight sun). `state.time` fields follow the blended sun, so the
  WindField thermals (midday-strong) stay consistent and deterministic.
- `globalOverride` fires on start, end and on crossing weight 0.5.

---

## j. Journal and copilot additions (wave 4, Milestone O)

### j.1 Journal

- Collection count x / 100: unchanged code path (found / `listPresets()`); the 70 new presets make
  it 100.
- Global records (`driftwing-v2.records`, version 2 with a migration from 1) add:
  `craftTime { [craftId]: seconds }` (counted every frame of flight per craft),
  `figures { [figure]: { count, bestScore } }` (from `figureFlown`), medals (read from
  `ctx.systems.challenges.getRecords()`), `worldsVisited [seed]` (from `worldVisited`),
  `perches { count, kinds }` (from `perched`), and the `maxAltitude` journal stat (op `max`, m;
  space altitudes included). Each module's `journal.stats` keys join `JOURNAL_STATS`.
- The journal panel gains Craft (time per craft), Figures, Challenges (best time and medal per
  course and craft) and Worlds sections.

### j.2 Copilot grammar (and the keyboard / UI equivalent of each)

| phrase | action | keyboard / UI equivalent |
| --- | --- | --- |
| "switch to [craft]" | `setCraft` (14 ids, skins by name: "dragon") | favorites 1-0, `]` / `[`, the picker |
| "smoke on / off" | `craftCommand smoke` | Space on the aerobatic (and bush plane); Shift+Space cycles the colour |
| "find water to land" | waypoint to the nearest landable water (`waterQuery.bodiesNear`, the ocean coast) | the Guide chip "Find water", the map |
| "find a perch" | waypoint to the nearest perch (`colliders.perchesNear`) | the Guide chip "Find a perch" (eagle) |
| "wind at [altitude]" | spoken wind from `ctx.wind.probe` at that height | the balloon's wind-layer column (HUD) |
| "start the challenge" | `challengeStart` (nearest course) | `Y`, the start prompt |
| "take me to space" | spaceplane autopilot climb profile (switches to the spaceplane first, after a confirm) | the Guide chip "To space" on the spaceplane |
| "scenic cruise" | airship scenic cruise (`craftCommand scenicCruise`) | Space on the airship |

docs/copilot-api.md, docs/controls.md (a full HOTAS profile per new craft), docs/spawns.md (all
100) and docs/architecture.md are updated in Milestone O.

---

## k. Test hooks

All dev-only (never in a production bundle; the bundle checks of Phase 2 extend to the new kit
names), each with a `tools/run-harness.mjs --test <name>` mode and npm scripts `test:<name>` and
`test:<name>:webgl`.

### k.1 `?test=craft` (`src/dev/craftTest.js`, scenarios in `src/dev/craftScenarios/<craft>.js`)

Scenario shape:

```js
{ id: 'seaplane-ocean-takeoff', craft: 'seaplane', views: ['first', 'third'], seed: 'CRAFT-SEA-1',
  start: { at: 'ocean' | 'lake' | 'thermal' | 'slope' | 'perch' | { x, y, z }, heading, mode: 'water' | 'air' | 'ground' | 'hover' },
  seconds: 90, script(t, api) -> controls (writes ControlState through the test input path),
  checks: [{ id: 'airborne', until: 60, test(api) -> boolean }] }
```

Required beyond the general flight test (all 14 craft, both views): the recognizer detects a
scripted loop and aileron roll; seaplane takeoff and landing on the ocean AND on a lake; tiltrotor
full conversion both ways; paraglider thermal climb; balloon reaches a target wind layer; airship
scenic cruise visits 3 sites; eagle perch and takeoff; spaceplane climbs to 100 km and re-enters to
3 km with 0 NaN, rebases without visible jumps (camera-relative continuity, a.8) and the far-field
handoff with no holes (g.7). URL options `testCraft=a,b`, `testViews`, `testScenarios`.

### k.2 `?test=collision` (`src/dev/collisionTest.js`)

A fixture world (no harness flight script) with one collider of every type, every retrofitted
landmark and Phase 2 structure, a tunnel mountain (mesh BVH) and a kite-string slalom: the jet,
the bush plane and the spaceplane (scripted) fly into each at 60, 250 and 1500 m/s and must soft
crash with reason `structure strike` and never end a tick with a probe inside a solid collider;
a slow (3 m/s) bump resolves without a crash; the tunnel centreline run (a PathFollower through
the bore) completes with 0 hits; kite strings register misses (`colliderSensor` and the challenge
count) and never crash. Reports per collider type, both backends.

### k.3 `?test=spawns` for 100 presets

`src/dev/spawnScenarios.js` gains one import line per batch file
(`src/dev/spawnScenarios/batch31.js` .. `batch91.js`), each holding its ten scenarios. Per preset:
force-spawn at its time and weather, screenshot, frame times, dispose back to the GPU memory,
wind source, light, sky modifier, collider and challenge baselines, the JS heap within 1 MB over
the held cycles (Phase 2 rules), both backends. `testPresets=` selects a subset.

### k.4 Determinism and terrain

- `?test=determinism`: the site-list hash (with overlays and waters, version 2), the director log
  (with the craft, combos and overrides), plus three new digests compared across two loads: water
  heights on a 32 x 32 grid at three times, a collider sweep battery around the path, and the
  PathFollower positions of the live movers.
- `?test=terrain`: the fixtures gain one site per new stamp type and per overlay kind; worker
  parity (bit-identical meshes incl. the `overlay` attribute), seams, collision; `&presets=real`
  needs every real stamp type within the search radius (pick a seed, as Phase 2 did).

### k.5 The 20-minute soak

`?test=1&testPlan=soak`: 5 seeds (`SOAK-1` .. `SOAK-5`) x 4 minutes, the director live, a craft
switch every 2 minutes through the settings channel (as the picker does) and a view swap every
minute. The ten legs fly `aerobatic, seaplane, tiltrotor, paraglider, balloon, airship, eagle,
spaceplane, jet, glider` (`testSoakCraft=` overrides). Pass: 0 NaN, 0 terrain penetrations, 0
structure penetrations, heap growth under 75 MB per world, p99 within the frame target, no frame
over 50 ms after warmup, 0/0 console, no soft crash within 10 s after a switch (Phase 2 criteria
plus the last two).

---

## Appendix A. Wave 1 file ownership

| engineer | branch | owns (creates or edits freely) | edits only at the anchors of 0.1 |
| --- | --- | --- | --- |
| 1 floating origin | `p3/origin` | `src/core/origin.js`, `tools/lab/origin.mjs`, `tools/steps/origin-rebase.json`; the CPU spots of a.6; the buffer anchoring of a.7 in `fx.js`, `trails.js`, `waterEffects.js`, `waypoints.js`, `particleSystem.js`, `ribbons.js`, `glowPoints.js`, `lure.js`; `spatial.js`, `spawnVoices.js` (audio frame) | `main.js`, `loop.js`, `terrain.js`, `cloudShading.js`, `vortexEngine.js`, `weatherVolume/materials.js` (shader lines of a.5), `events.js` |
| 2 colliders | `p3/colliders` | `src/world/colliders.js`, `src/world/colliderMesh.js`, `src/world/groundSurfaces.js`, `src/dev/collisionTest.js`, `tools/lab/colliders.mjs`, the retrofits in `landmarks.js` and `structure/recipes/*.js` (collider code only), `spawnCheckKit.js` | `FlightController.js`, `spawnManager.js` (`disposeParts` and 0.4), `main.js`, `events.js`, `run-harness.mjs` (the `collision` mode) |
| 3 water, regions, vegetation | `p3/water-regions` | `src/world/waterQuery.js`, `overlays.js`, `vegetationSpecies.js`, `src/render/waterMaterial.js`, `waterBodies.js`, `windSway.js`, `water.js`; `stamps.js` (basin, crater, terraces, paints), `placement.js` (waters, overlays), `worldgen.js`, `chunkBuilder.js`; the model and caller migrations of c.3; `tools/lab/water.mjs`, `terrain.mjs` | `FlightController.js`, `terrain.js`, `schema.js`, `main.js`, `events.js` |
| 4 fauna modes, paths, challenges | `p3/fauna-challenges` | `faunaEngine.js`, `faunaSpecies.js`, `src/world/pathFollower.js`, `src/gameplay/challenges.js`, `src/ui/challengeHud.js` (+ css), `rings.js` (the whole file: detection, lifecycle and the a.7 anchoring of its InstancedMesh, f.4), `structure/recipes/challengeGates.js`, `journal.js` (challenge section), tools labs and steps of e.3 / f.5, `tools/lab/fixtures/rings-golden.json`, `docs/engines/fauna.md` | `controlState.js` / `defaultBindings.js` (`challengeStart`), `schema.js`, `main.js`, `events.js` |
| 5 high altitude | `p3/high-altitude` | `src/env/atmosphere.js`, `src/render/curvature.js`, `src/world/farField.js`, `sky.js`, `clouds.js` (curvature), `lure.js` (curvature), `spawnManager.js` LOD rule of g.5, settings `planetRadiusKm`, `tools/lab/atmosphere.mjs`, `tools/steps/high-altitude.json` | `FlightController.js` (g.6), `terrain.js`, `main.js`, `landmarks.js` and `structureEngine.js` (the rigid drop line only), `cameraManager.js` (near plane), `mapTiles.js` (priority hook) |

Merge order for the wave 1 integration pass: origin, high altitude, water/regions, colliders,
fauna/challenges. After the merges the integration pass: applies the origin's and the curvature's
TSL helpers inside `waterMaterial.js` (0.1) and the curvature node in the weather volume
materials, the rigid drop in the fauna engine's group roots, adds the challenge count to the spawn
check kit,
re-records the determinism and terrain hashes, runs every lab and step file once on both backends
and records the numbers in the progress file.

## Appendix B. Dispose rules (all waves)

An instance, a site object or a system part that adds any of these removes it in its dispose, and
the owner's check catches leftovers: wind sources (`windSourceIds`), colliders (`colliderIds`),
challenge courses (`unregister`), ground surfaces (with their collider), ignitables, real lights,
sky modifiers, sun overrides, origin listeners (the unsubscribe), audio voices and GPU resources
(geometries, materials, textures, BVHs). The spawns test measures each against its baseline.
