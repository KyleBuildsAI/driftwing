# DRIFTWING v2 Phase 2 - system contracts (lead's design; engineers build against this)

Base: branch v2-phase2, cut from tag v2-structure. V2 is the real-physics game at /v2/. There is
no CLASSIC mode: wherever the Phase 2 spec says "CLASSIC and SIM", read "V2". Spawns apply their
full WindField forces. The assists (0-100 %) remain the safety net, and the Phase 1 soft crash still
ends every terrain strike. Wherever the spec says "both modes", read "first person and third person
views".

Units are SI, and the axes are those of docs/architecture.md: +x east, +y up, -z north.
Everything below is additive to Phase 1. Extend a contract additively and document the extension
in your final report.

## 1. Presets (src/spawns/presets/<id>.js)

Each preset is PURE DATA: a default-exported frozen object with no imports, or imports of other
pure-data modules only, so the terrain worker can import it. src/spawns/presets/index.js exports
PRESETS, an array in spec order, and PRESET_BY_ID. src/spawns/schema.js validates every preset at
startup in dev builds and in the labs, and throws a clear error naming the preset and the field.

```js
export default Object.freeze({
  id: 'tornado',                       // camelCase, unique
  name: 'Tornado',
  category: 'weather',                 // weather | geo | ocean | wildlife | structure | celestial | fantasy | flightplay | setpiece
  kind: 'event',                       // 'site' (persistent place) | 'event' (temporary happening)
  rarity: 'rare',                      // common | uncommon | rare | legendary
  heavy: true,                         // counts toward the max-2-heavy budget; gets a FAR lure
  // sites only: deterministic placement on the 2 km grid
  placement: {
    chance: 0.03,                      // probability per 2 km cell after filters
    minSpacing: 16000,                 // m between two sites of this preset
    biomes: ['pine', 'snow'],          // null = any (uses the SAME biome function as the terrain)
    surface: 'land',                   // land | water | coast | any
    terrain: { minHeight: 40, maxHeight: 900, relief: 'peak' },   // optional; relief: peak | valley | flat | ridge | any
    clearance: 600,                    // m from Phase 1 landmarks and from other presets' stamps
  },
  // events only: deterministic candidates
  candidates: { cellSize: 6000, bucketSeconds: 600, chance: 0.2 },
  filters: {                           // when the director may activate an event or a site's active state
    biomes: null, timeOfDay: ['day', 'dusk'], altitude: { min: 0, max: 4000 },   // player MSL, m
    weather: ['building', 'storm'], surface: 'land', minDistance: 3000, maxDistance: 8000,
  },
  stamps: [ /* sites only; see 2.2 */ ],
  engines: [ { engine: 'vortex', params: { /* engine-specific */ } }, { engine: 'emitter', params: {} } ],
  lod: { near: 1500, mid: 6000, far: 40000 },   // m; beyond far the instance is not created
  lure: { type: 'funnel', height: 1800, width: 500, color: 0x5a5f6a },   // heavy presets: the FAR silhouette; null otherwise
  wind: [ { type: 'rankine', params: { coreRadius: 60, maxTangential: 70, inflowRadius: 1500, updraft: 45 } } ],  // [] if none
  audio: { recipe: 'tornado', params: {} },       // null if silent
  journal: { title: 'Tornado', description: 'A rope of wind that walks across the land.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: ['Tornado on the ground {distance} {direction}.', '...', '...'],   // >= 3; tokens {distance} {direction} {name} {eta}
  lifetime: { duration: [240, 360], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 } }, // duration null for sites
  achievements: [],                    // optional: [{ id, title, description }]
});
```

## 2. Placement and stamps (src/world/placement.js, src/world/stamps.js). Pure, and imported by worldgen, the terrain worker and the main thread.

### 2.1 Sites
`createPlacement({ seed, world, presets })`, where world gives the UNSTAMPED base functions from
worldgen (baseHeight, biome weights, hash2):
- `sitesInCell(cellX, cellZ)` returns `[site]`. The cell size is 2000 m. Every candidate preset is
  rolled with hash(seed, cellX, cellZ, presetId). Candidates go through the preset's placement filters,
  the biome filter (the terrain's own biome function), surface and terrain relief, the clearance from
  Phase 1 landmarks, and minSpacing, which is resolved deterministically by checking the neighbouring
  cells in a fixed order. Results are cached per cell.
- `sitesNear(x, z, radius)` returns `[site]`, sorted by distance.
- `site = { id: '<presetId>:<cellX>:<cellZ>', presetId, x, z, groundY, rotation, scale, seed (uint32 for rng), stamps: [resolved stamp] }`
- The same seed always gives the same sites. The site-list hash (sorted ids and coordinates rounded
  to 1 cm) is the determinism test's key.

### 2.2 Stamps
Resolved stamps are geometry in world space: a type, a centre and rotation, sizes, and a paint.
Types:
- cone (volcano cone plus crater)
- carve (a slot canyon along a seeded polyline, 2-4 km long, twisting walls, river floor)
- cliffStep (the waterfall cliff)
- gorge (for the rope bridge)
- flatten (the airfield strip)
- islandBase (sea-stack or islet bases under floating islands)

Each has a smooth falloff. Stamps apply INSIDE worldgen's heightAt after the Phase 1 landmark shaping.
groundHeight, LOD rings, skirts and collision therefore all agree, because they all go through heightAt.
Stamps are looked up through a spatial hash (per 2 km cell, the list of stamps whose bounds overlap
it). heightAt must stay within 10 % of its Phase 1 cost; a node benchmark in tools/lab/terrain.mjs
proves it.
Paint: every stamp may carry `paint: 'ash' | 'basalt' | 'wetRock' | 'tarmac' | 'riverbed'` with a
mask. worldgen.faceColor blends the paint over the biome palette (stamp-aware vertex colours).
`stampInfluence(x, z)` returns `{ paint, weight }` for the colour pass.

## 3. Engines (src/spawns/engines/<name>Engine.js)

```js
export function createVortexEngine() {
  return {
    name: 'vortex',
    init(ctx) {},                           // once, at startup (build shared geometry/materials, pools)
    create(preset, params, rng) {},         // returns an instance (see below); params = the preset's engine params
                                            // merged with the activation: { position, heading, site, startTime, scale }
    update(instance, dt, ctx) {},           // every frame while active; NO allocations
    setLOD(instance, tier) {},              // 'near' | 'mid' | 'far'
    dispose(instance) {},                   // returns every GPU resource and removes every wind source
    stats() {},                             // { instances, particles, lights, buffers, drawCalls }
  };
}
```
Instance: `{ id, presetId, engine, anchor: Vector3, radius, heavy, tier, ended: false, windSourceIds: [], lights: 0, particles: 0, data }`.
Setting `ended = true` tells the SpawnManager that an event has finished naturally (a tornado has roped out).

The engine ctx, built once by the SpawnManager:
```js
{
  scene, camera, renderer, backend: 'WebGPU' | 'WebGL2', THREE, TSL,
  wind,                // WindField (addSource/removeSource/setSourceBounds/sample)
  audio,               // AudioEngine spawn API (section 6)
  terrain: { heightAt, groundHeight, biomeAt, waterLevel },
  time,                // state.time (dayTime, sunElevation, nightFactor, goldenFactor, elapsed)
  sky,                 // sky modifier API (section 7)
  bus, perf, settings, state, uniforms,
  budgets,             // read-only view of the director budgets (section 5)
  lights,              // the real-light pool: acquire(priority) -> PointLight | null, release(light)
  pools,               // helpers: vector/quaternion/matrix scratch pools, instanced-mesh slot allocators
}
```
Engines never allocate in update(). They pool everything. dispose() must return GPU memory; the
test compares renderer.info.memory geometries and textures and the heap before and after.
WebGPU-only features (TSL compute, storage buffers) need a WebGL2 path that still looks right.

The ten engines and their registry names:
- vortex
- emitter
- weatherVolume
- fauna
- structure
- celestial
- waterEffect
- lightEffect
- windModifier
- setPiece

The setPiece engine orchestrates other engines through the SpawnManager (stages, triggers,
durations and copilot narration hooks through bus events).

## 4. SpawnManager (src/spawns/spawnManager.js). It is the 'spawns' system, created after 'wind' and 'sky'.

- `register(engine)` / `init()`
- `activate(presetId, { position, heading, source: 'site' | 'director' | 'debug', site?, seed? })` returns an instanceId, or null if a budget refuses it.
- `deactivate(instanceId, reason)`
- Every frame: update the instances. The LOD tier comes from the camera distance using the preset lod distances, with hysteresis. FAR lures render for heavy presets beyond terrain view distance and above the fog: a silhouette impostor from preset.lure, drawn after the fog. Instances are culled beyond lod.far.
- Sites: an instance is created automatically when a site comes within lod.far and removed beyond far + despawn.hysteresis. A site's ACTIVE state (for example an erupting volcano) is a director decision.
- Events: created by the director, and ended naturally (instance.ended) or by the despawn rule.
- Typed events: spawnActivated { id, presetId, category, kind, position }, spawnEnded { id, presetId, reason }.
- Discovery: when an instance is within discovery.radius and in view (in the frustum and not occluded by terrain, sampled along the ray), emit discovery { id: presetId or siteId, name, kind: category, position, presetId }. It fires once per site id or event preset per world.
- `getActive()`, `getStats()` (per engine and total), `getInstance(id)`.
- Budget accounting per engine (particles, instances), plus real lights and the heavy count.

## 5. Director (src/spawns/director.js). It runs at 2 Hz inside the spawns system.

Inputs: player position, heading, speed, biome, time of day, regional weather, active spawns, and perf headroom.
- Pacing: something notable (a new site in view, or an event) within 60-90 s of flight. On a drought, activate the best dormant deterministic candidate AHEAD of the player's heading, 3-8 km out, never behind.
- Rarity periods:
  - common: every few minutes
  - uncommon: every 10-15 min
  - rare: every 30-60 min
  - legendary: every 1-2 h of flight
- Per-preset cooldowns. The same event type never runs back-to-back.
- Budgets: at most 2 HEAVY spawns, per-engine particle and instance caps, and a maximum number of real lights.
- Candidates: src/spawns/candidates.js (pure), deterministic from hash(seed, cellX, cellZ, timeBucket, presetId).
- Activation log: `{ time, presetId, candidateId, reason }` is recorded for the determinism test.
- Regional weather state machine: clear -> building -> storm -> clearing, deterministic per region cell and time bucket. The weatherChanged typed event is { state, previous, region }. Storm presets depend on it, and sky and fog colours follow it through the sky modifier API.
- Perf: the director registers a load shedder with the perf governor (section 8). While frames miss the target, it defers heavy activations BEFORE dynamic resolution drops.
- `getNearby(radiusKm)` returns `[{ id, name, category, distance, bearing, state ('active' | 'dormant' | 'site' | 'discovered'), etaSeconds }]`.
- `getState()` returns the drought timer, budgets, the heavy count, candidates, cooldowns, weather and the log, for the debugger.
- `forceSpawn(presetId, opts)` is dev only and goes through the SpawnManager with source 'debug'.

## 6. Audio (AudioEngine additions, src/audio/spawnVoices.js)

- `audio.spawnVoice(recipe, params)` returns a voice: `{ setPosition(vec3), setIntensity(0..1), trigger(name, opts), dispose() }`. It lives on the environment bus, is spatialized (PannerNode) and is distance-attenuated. It has no allocations per frame.
- `audio.thunder({ position, intensity })` plays the crack and the rolling rumble, delayed by distance / 343 m/s.
- `audio.discoveryChime()` plays the discovery chime.
- Recipes:
  - tornado
  - thunder
  - volcano
  - geyser
  - waterfall
  - whale and skyWhale
  - crystal
  - turbine
  - murmuration
  - meteor
  - lantern
  - discovery

## 7. Sky modifiers (src/render/sky.js addition)

- `sky.addModifier(id, { priority })` returns a handle with `set({ sunIntensity, ambient, fogColor: Color, fogColorAmount, fogDensity, skyTint: Color, skyTintAmount, darkness, stars })` and `remove()`.
- Values blend by priority and weight. The weather state (director) and the eclipse (celestial engine) drive them.
- The golden-hour opening with clear weather must look exactly as before, with no modifier active.

## 8. Perf load shedding (src/core/perf.js addition)

- `perf.addLoadShedder({ id, shed() -> boolean, restore() })`. While the control frame time misses the target, the governor calls shed() on each shedder in turn (the director defers heavy activations and demotes far LODs) and only steps render scale down when no shedder can shed more.
- `perf.getHeadroom()` returns `{ missing: boolean, ratio: controlFrameMs / targetMs }`.

## 9. Typed events (src/core/events.js additions)

- spawnActivated { id, presetId, category, kind, position }
- spawnEnded { id, presetId, reason }
- weatherChanged { state, previous, region }
- discovery (existing): now also emitted for spawns, { id, name, kind (category), position, presetId? }
- achievement { id, title }

## 10. Discovery loop (Milestone F), for later waves

- Journal: spawn discoveries plus stats (storms chased, closest tornado, best canyon run, best landing, achievements). The count is x / 30 over implemented presets.
- Copilot tour guide.
- World map (mapToggle, key M; the mic toggle moves to Shift+M).
- Seed links (#seed=XXXX&t=...).

## 11. Dev spawn debugger (src/dev/spawnDebugger.js)

- F9 opens it. It exists in dev builds; in build:single it exists only with ?dev=1.
- Features: preset list with filters, force-spawn ahead, teleport to the nearest site of a type, a time-of-day scrubber, director state, engine stats, and the WindField overlay toggle (src/dev/windOverlay.js already exists).
