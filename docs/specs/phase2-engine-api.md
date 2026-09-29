# Engine API after wave 1 integration (authoritative; verify against code)

All paths are relative to the repo root.

**1. Registration.** Put each engine in src/spawns/engines/<name>Engine.js, exporting createXEngine(). Import it in src/main.js and append its factory to `const SPAWN_ENGINE_FACTORIES = Object.freeze([ ... ])` (src/main.js line 58).
- main.js calls `ctx.systems.spawns.register(createEngine())` for each factory right after the systems are created. Registration errors are logged.
- The spawns prewarm hook then calls manager.init(), which runs `engine.init(engineCtx)` behind the loading fade. A throwing init marks the engine failed, and its presets are refused as 'engine'.
- Registry names (ENGINE_NAMES in src/spawns/engineRegistry.js): vortex, emitter, weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece.
- validateEngine requires `name` (camelCase) and init, create, update, setLOD, dispose and stats.
- Optional `budget: { instances, particles, lights? }`. Without it, the caps are DIRECTOR_BUDGETS.engines[name] from src/spawns/director.js. For example vortex 3/40000, emitter 16/120000, weatherVolume 6/30000, fauna 8/12000, structure 24/0, celestial 3/6000, waterEffect 4/20000, lightEffect 8/30000, windModifier 12/0, setPiece 1/0.
- `budget.lights` sizes the real-light pool (the sum across engines, capped at 4).

**2. Engine methods.**
- `init(ctx)`: once.
- `create(preset, params, rng)`. `params` is the preset engine entry's params merged with:
  - position: a new THREE.Vector3;
  - heading: compass degrees;
  - site: the placement site or null;
  - startTime: state.time.elapsed;
  - scale;
  - duration: seconds, the director's number or drawn from lifetime.duration; null for sites;
  - seed: uint32.
  - `rng()` is a seeded mulberry32 giving values in [0, 1).
- `update(instance, dt, ctx)`: every frame, dt is the simulated dt (0 while paused), no allocations.
- `setLOD(instance, 'near' | 'mid' | 'far')`: at creation and on every change. There is 8 % hysteresis, and the director's LOD bias (0.7 or 0.5 under load) scales lod.near and lod.mid.
- `dispose(instance)`: must return all GPU memory and remove the engine's wind sources and lights.
- `stats()` returns `{ instances, particles, lights, buffers, drawCalls }`.

**3. Engine ctx** as built by the SpawnManager (src/spawns/spawnManager.js, engineCtx):
- scene, camera, renderer, backend ('WebGPU' | 'WebGL2'), THREE, TSL;
- wind: the WindField;
- audio: ctx.systems.audio;
- terrain: `{ heightAt(x, z), groundHeight(x, z), biomeAt(x, z), waterLevel }`;
- time: state.time (dayTime, sunElevation, nightFactor, goldenFactor, elapsed, …);
- sky: ctx.systems.sky;
- bus, perf, settings, state, uniforms;
- budgets, read only:
  - heavyLimit and maxHeavy, heavyActive;
  - maxRealLights, lightsLimit, lightsActive;
  - engines: `{ [name]: { instances, particles } }`, live caps;
  - instanceLimit(name), instances(name), particleLimit(name), particles(name);
- lights: the real-light pool;
- pools;
- spawns: the SpawnManager itself, for setPiece. It has activate, deactivate, getActive, getInstance, getParts, getSiteSpawn, setSiteActive, canActivate, getPreset, listPresets and so on.

**4. Instance shape.** create() must return at least:
`{ anchor: THREE.Vector3, radius: number, windSourceIds: [], lights: number, particles: number, data: {} }`
- The manager fills id, presetId, engine, heavy and tier, and sets `ended: false` if it is missing. setSiteActive writes `instance.active`, for example the volcano's eruption.
- Mutate `instance.anchor` in place. The LOD, the lure and discovery keep that reference.
- Keep `instance.particles` current; it counts against the per-engine particle cap every frame.
- Set `instance.ended = true` to end an event naturally.
- Every wind source id must be listed in windSourceIds and removed in dispose(). Anything left over is removed by the manager and logged with console.error, which fails the 0-errors criterion.

**5. Pools** (src/spawns/pools.js, reached through ctx.pools).
- `scratch`: vec3(), quat(), mat4() and color() rings of 64. A value is valid only within one call.
- `createSlotAllocator(capacity)`: alloc() returns a slot or -1; free(slot); highWater.
- `createObjectPool(factory, { reset, prefill, limit })`: acquire() and release(object).
- `createInstancedPool({ geometry, material, capacity, name, parent, colors })`:
  - alloc() and free(slot);
  - setMatrix(slot, matrix) and setColor(slot, color);
  - flush() after writing;
  - dispose({ keepGeometry, keepMaterial }).
- `createMeshPool({ material, capacity, parent, name })`: acquire(geometry) and release(mesh).
- Rule from three r184: never create a new Mesh per instance on a shared material, because each one leaks about 8 KB. Build createMeshPool or createInstancedPool in init(), or give each instance its own material and dispose it with the instance.

**6. Light pool** (src/spawns/lightPool.js).
- `ctx.lights.acquire(priority = 0, onRevoke?)` returns a PointLight, parked at intensity 0 while free, or null.
- `ctx.lights.release(light)` gives it back.
- A holder that passed onRevoke can lose its light to a higher priority.
- Lights a disposed spawn still holds are released and reported as leaks.
- The pool only holds as many lights as the engines declare in `budget.lights`, capped at 4. Declare them to get any.

**7. Lure hooks** (src/spawns/lure.js). Engines do nothing for lures; the manager draws them.
- A heavy preset declares `lure: { type: 'plume' | 'anvil' | 'funnel' | 'whale' | 'islands' | 'comet', height, width, color, altitude?, glow?, flash? }`. It must be null for presets that are not heavy.
- The lure is anchored on instance.anchor, oriented by the heading, and shown at the 'far' tier with a crossfade. Beyond 92 % of the fog's far distance it is projected there.
- So an engine's own geometry can stop drawing at 'far'.

**8. Audio.** In create():
```js
const voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...preset.audio.params, intensity });
```
- It works before the AudioContext exists. An unknown recipe throws.
- In update(), call `voice.setPosition(instance.anchor, velocity?)` and `voice.setIntensity(0..1)`. Both copy numbers only.
- `voice.trigger(name, opts)` returns a boolean. Triggers:
  - volcano 'boom' { strength }
  - geyser 'burst' { duration, strength }
  - crystal 'chime' { strength, notes }
  - murmuration 'scatter'
  - meteor 'streak' and 'fireball'
  - whale and skyWhale 'call'
  - thunder 'strike' { intensity, position? }
  - discovery 'chime'
- In dispose(), call `voice.dispose()`.
- For storms, also `ctx.audio.thunder({ position, intensity })`, which returns whether the strike was queued.
- `ctx.audio.discoveryChime(opts)`, `ctx.audio.spawnRecipes`, and RECIPE_NAMES from src/audio/recipes/index.js.
- Crystal intensity is the approach, turbine intensity is the wind speed, volcano intensity is the activity.
- The budget is 10 sounding voices; the quietest are culled automatically.

**9. Sky modifiers** (src/render/sky.js, reached as ctx.sky).
```js
const handle = ctx.sky.addModifier(id, { priority }); // { id, set(values), remove() }
```
- `set` takes any of sunIntensity, ambient, fogDensity (multipliers), darkness, overcast (0..1), stars, fogColor / fogColorAmount, skyTint / skyTintAmount (a THREE.Color or 0xRRGGBB), and weight (0..1).
- A duplicate id or a non-finite value throws.
- The weather uses priority 10; the eclipse should sit above it.
- `ctx.sky.getModifierState()` returns the folded values.
- Call remove() in dispose().

**10. Wind sources** (src/env/WindField.js, reached as ctx.wind).
```js
ctx.wind.addSource({ id, bounds, sample(pos, t), kind? }); // returns id
```
- bounds is `{ min, max }` or `{ center, radius }`.
- sample(pos, t) returns `{ vel?: { x, y, z }, turbulence?: 0..1 }` or null, and must not allocate. Velocities add; turbulence takes the maximum.
- Also `setSourceBounds(id, bounds)`, `removeSource(id)`, `sample` / `probe(pos, t, out)` and `sourceCount`.
- addSource and removeSource emit windSourceAdded and windSourceRemoved.
- Use unique ids, for example `${instance.id}:vortex`.
- Spawns apply full forces in V2; there is no CLASSIC scaling.

**11. Testing with a preset-like object before real presets exist.** The dev hook is `window.DRIFTWING.ctx.systems.spawns.debug`. It exists in dev builds and with ?debug=1 or ?dev=1.
- `debug.registerEngine(createXEngine())` registers the engine and runs init at once if the manager has started.
- `debug.addPreset(preset)` validates it with validatePreset (src/spawns/schema.js) against the registered engine names. Unknown top-level fields are refused, and errors name the preset and the field.
- Then `spawns.forceSpawn(presetId, { distance, force: true })` places it ahead of the craft. It goes straight through the manager with source 'debug', which is exempt from range and despawn. The director never schedules dev-added presets.
- To end it: `spawns.deactivate(id, reason)`, or `debug.removePreset(id)` and `debug.unregisterEngine(name)`.
- `debug.loadTestKit()` (dev builds only) adds the framework's test engines and presets.
- Model a preset on testEvent() in src/dev/spawnTestKit.js: all contract section 1 fields, `lure: null` unless heavy, `lifetime.duration` and `despawn`, and `callouts` with at least 3 entries.
- Inspect with `spawns.manager.getParts(id)`, `getInstance(id)`, `getStats().engines` and `getStats().memory`.
- Memory proofs follow tools/spawn-check.mjs.

**12. The spawn debugger** (F9, src/dev/spawnDebugger.js).
- The Presets list comes from manager.listPresets(), with Spawn and Nearest buttons.
- The Engines table comes from manager.getStats().engines: every registered engine with active/cap instances, particles/cap, lights and buffers, plus heavy count, real lights, lures, GPU memory and discoveries.
- The Active spawns list has an End button each.
- The Director section shows director.getState() and getNearby(10).