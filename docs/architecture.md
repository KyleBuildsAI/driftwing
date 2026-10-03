# DRIFTWING v2 architecture

This is the architecture of DRIFTWING v2 as of Phase 1 (`2.0.0-phase.1`) and the structure
correction (tag `v2-structure`): the two games behind the launcher shell, the module map, the
runtime and frame loop, and the contracts between systems. The last sections list how it is tested
and where Phases 2-4 attach without rewrites. The code is the source of truth; every contract here
names the file that implements it.

Units are SI everywhere in code: m, m/s, kg, N and s, with rad and rad/s inside the physics. Degrees
appear only where a field name or comment says so (telemetry angles, headings, FOVs). World axes are
+x east, +y up and -z north. Craft body axes are +x right wing, +y up and +z aft (the nose is -z).
Headings are compass degrees (0 north, 90 east).

## Two games behind one toggle

DRIFTWING is two separate games. The root page is a small launcher shell that runs one of them at a
time in a full-window iframe.

| page | source | what |
| --- | --- | --- |
| `/` | `index.html`, `src/shell/shell.js` | the launcher shell: the game iframe and the V1 \| V2 pill |
| `/v1/` | `public/v1/index.html` | **V1**, the original single-file game, frozen |
| `/v2/` | `v2/index.html`, `src/main.js` | **V2**, the Vite app this document describes: real flight physics only |

### V1, frozen

V1 is `index.html` from the git tag `v1-final`, byte-for-byte, at `public/v1/index.html`. Vite
serves and copies `public/` without processing it, and the dev and preview servers answer `/v1/`
with that file (`vite.config.js`, `gameDirectories`). V1 keeps its own CDN import map (jsDelivr,
with integrity hashes) and its own copy of three.js r184, so it needs an internet connection. It is
never ported, edited, linted or reformatted:

- `tests/v1.sha256` holds its SHA-256, and `npm run test:v1` (`tests/v1-checksum.test.mjs`) fails
  when the file's hash differs from it or its bytes differ from `git show v1-final:index.html`;
- `npm run build:single` copies it into `dist-single/v1/` and checks the copy's hash too;
- its console is judged only against its original behaviour, recorded in
  [v1-known-issues.md](v1-known-issues.md) (none under normal conditions).

V1 has no switch of its own: from V1 the player switches with the pill.

### The launcher shell

`src/shell/shell.js` picks the version, switches between the games and places the pill. Its test
handle is `window.DRIFTWING_SHELL` (`version`, `busy`, `switches`, `pillVisible`,
`storageAvailable`, `game` (the running game's `window.DRIFTWING`), `requestVersion(version)`).

| URL | opens |
| --- | --- |
| `/` | the version remembered in `localStorage` `driftwing.shell.lastVersion`, else V2 |
| `/?v=1`, `/?v=2` (also `v1`, `v2`) | that version, which is then remembered |
| `/?v=2&renderer=webgl` | every other query parameter is forwarded to the game (`/v2/?renderer=webgl`) |
| `/#seed=ABC` | the hash is forwarded to the game (`/v2/#seed=ABC`), so seed and room links work through the shell; a later hash change reloads the game with the new hash |
| `/v1/`, `/v2/` | a game on its own, without the shell (`/v1` and `/v2` redirect to them) |

Every load writes `?v=` back into the shell URL, so a reload opens the same game.

**Switching.** Only one game ever runs. A switch fades a veil in (280 ms, none with reduced
motion), points the iframe at `about:blank` (which ends the old game's document and frees its GPU
device, audio context, workers and gamepads), loads the other game, fades the veil out and focuses
the iframe (`frame.focus()` and `contentWindow.focus()`), so keyboard, mouse and gamepads go to the
game. A request made during a switch waits, and the latest one wins. A game that never fires `load`
is shown anyway after 30 s.

**Iframe permissions.** The iframe's `allow` list is exactly `gamepad; microphone; camera;
fullscreen; autoplay; xr-spatial-tracking; encrypted-media; clipboard-write`. There is no
`allowfullscreen` attribute: next to an `allow` list that grants fullscreen it only makes Chrome
warn.

**The pill.** V1 \| V2, glass, top-left. It hides after 3 s without activity and reappears when the
pointer reaches the thin hot strips along the top-left edges, when anything in the shell has focus
or input, and after every switch. It is placed at the first spot clear of the running game's HUD
(V1's top bar, V2's chips, compass and, on touch screens, flight card) and re-placed every 0.5 s
while it shows. V2 inside the shell carries the root class `dw-embedded`, which keeps the corner
free.

**The postMessage protocol.** V2 asks for a switch with exactly

```js
window.parent.postMessage({ source: 'driftwing-v2', type: 'switch-version', to: 'v1' }, window.location.origin);
```

The shell honours a message only when `event.origin` is its own origin, `event.source` is its own
iframe's window, and the data is a plain object with exactly the keys `source`, `type` and `to`
(`to` being `v1` or `v2`). Anything else is ignored without a trace: a page on another origin
(inside the iframe, or embedding the shell), a message of another shape, or one from the shell's
own window. V2's side is `src/shell/bridge.js`, the owner of the bindable `versionToggle` action
(F8, T.16000M base button 10, and WREN's "switch to version one"). Inside the shell it posts the
message; opened on its own at `/v2/` it navigates the tab to `/?v=1`; inside any other page it
says so in a toast and stays put.

**Seed links.** A link to a world is the shell URL `/?v=2#seed=ABC&t=0.723` (`t`, optional, is the
time of day as a fraction of the day, or `HH:MM`), so it opens in the launcher with V2. To reload
into another world (the settings seed field, "New world"), V2 posts exactly
`{ source: 'driftwing-v2', type: 'open-world', hash: '#seed=ABC&t=0.723' }` under the same origin
and source checks; the hash must be one `worldHash()` in `src/core/seed.js` can produce
(`isWorldHash`). The shell makes that hash its own, drops any `?seed=` and `?time=` it would
forward (they would win over the hash), and reloads V2 with it, so the shell URL always names the
world. V2 opened on its own reloads itself with the new `?seed=` instead
(`bridge.openWorld(hash)`).

### Storage isolation

V1, V2 and the shell share one origin, so they keep apart by name:

- **V2** prefixes everything with `driftwing-v2`: the IndexedDB database `driftwing-v2` and every
  key in it (`driftwing-v2.settings`, `driftwing-v2.input.*`, ...), the localStorage fallback keys
  and the dev harnesses' databases and sessionStorage keys. `src/core/storage.js` throws on any
  other key, so V2 can never read or write V1's.
- **V1** keeps its original keys (`driftwing.settings.v1`, `driftwing.journal.*`, `driftwing.ui.*`
  in localStorage).
- **The shell** keeps one key, `driftwing.shell.lastVersion`.

The one-time migration: when `driftwing-v2` is empty on first start, V2 imports the Phase 1
database `driftwing` (its settings without the old `mode` field, the `input.*` and `audio.*` keys
and the journals, under their new names) and then deletes it. Details are under
[Storage](#storage-srccorestoragejs).

### Builds

| command | output |
| --- | --- |
| `npm run dev` | the Vite dev server at `http://127.0.0.1:5199` (strict port): the shell at `/`, V1 at `/v1/`, V2 at `/v2/` |
| `npm run build` | `dist/`: the shell `index.html`, `v1/index.html` (copied untouched from `public/`), `v2/index.html` and the hashed `assets/` |
| `npm run build:single` | `dist-single/`: the shell `index.html` and `v2/index.html`, each one self-contained file (every script, style and the terrain worker inlined), and `v1/index.html` copied byte-for-byte, its SHA-256 checked against `tests/v1.sha256` (`tools/build-single.mjs` runs one Vite build per page) |
| `npm run serve:single` | serves `dist-single/` at `http://127.0.0.1:5199` (`tools/serve.mjs`, no dependencies) |

`start-driftwing.bat` checks Node.js (20.19+, or 22.12+), installs the dependencies on the first
run, and starts `npm run dev -- --open`, which opens the shell at `http://127.0.0.1:5199`.

## Module map

`src/main.js` is the composition root: it boots storage, settings, the renderer, the world and every
system, and then starts the frame loop.

### `src/core`: services every system shares

| file | what |
| --- | --- |
| `config.js` | `CONFIG` tuning constants (v1's, plus `VERSION`) and the world generator options |
| `storage.js` | IndexedDB key-value store with versioned structure and data migrations, a synchronous cache, and localStorage then memory fallbacks |
| `settings.js` | the validated, versioned settings schema persisted through storage; emits `settings:changed` |
| `eventBus.js` | the `EventBus` (`on`, `off`, `emit`) |
| `events.js` | typed events: payload shapes, `emitTyped` / `onTyped`, validation in dev and with `?debug=1` |
| `clock.js` | `createFixedStepClock()`: 120 Hz ticks, accumulator, interpolation `alpha`, 0.1 s frame clamp |
| `loop.js` | the frame loop (`createFrameLoop(ctx, options)`): timing, the fade gate, the system update order, the safety net and telemetry calls, render |
| `perf.js` | display refresh measurement, the frame target, dynamic resolution (stage one) and v1's quality governor (stage two) |
| `seed.js` | the world seed (query, then hash, then the saved seed, else a new random one), the start time of day (`?time=`, then the link's `#t=`), world hashes and share links |
| `sun.js` | sun and moon directions for a time of day, and the inverse |
| `turbulence.js` | `turbulenceResponse(turbulence, airspeed)`: how hard the WindField's turbulence at the craft is felt (0..1), shared by the camera shake and the cockpit rattle |
| `util.js` | `clamp`, `damp`, heading helpers, `compassName`, finite checks |

### `src/render`: renderer, post stack and the atmosphere

| file | what |
| --- | --- |
| `renderer.js` | renderer boot (`createRenderer(params)` returning `{ renderer, backend, uniformUploads }`): WebGPU device probe, `WebGPURenderer` creation, WebGL2 fallback and the rebuild after a late fallback |
| `uniformUploads.js` | garbage-free uniform uploads: replaces three r184's per-uniform update ranges (new objects every frame for every render object) with one persistent whole-buffer range per uniform group |
| `post.js` | the post stack (bloom, warm grade, vignette, grain, render scale) and the `gEffects` system (gray-out, tunnel vision, red-out) |
| `sky.js` | sky dome, sun, moon, stars, aurora, god rays, fog colour and the day / night cycle (v1), and the sky modifiers the weather and celestial events use (Phase 2) |
| `clouds.js` | instanced drifting clouds, cloud shadows (v1), plus a cumulus cap over every thermal; the palette follows the sky modifiers (storm undersides, eclipse) |
| `cloudShading.js` | the cloud puff geometry, palette (`createCloudLook`) and light response (`createCloudRadiance`) shared by the v1 clouds and the weather volumes, and the cloud optics (glory and rainbow bands) |
| `water.js` | animated water, sun glint and shoreline foam (v1), plus the local effects layer's terms |
| `waterEffects.js` | the water effects layer: trail buffer, vortices, ripples, glow regions, spray droplets and pool discs for spawns |
| `birds.js` | boid flocks that scatter (v1) |
| `fx.js` | contrails, wind streaks, bursts (v1) |
| `jetEffects.js` | afterburner flame, vapor cones (Mach 0.9-1.05, low altitude) and wingtip vapour, attached to the jet mesh |
| `wingsuitEffects.js` | the wingsuit's ram-air canopy, lines and pilot chute, with the deployment animation |

### `src/world`: the deterministic world

| file | what |
| --- | --- |
| `worldgen.js` | `createWorldGen(seed, options)`: seeded noise, biomes, the SHARED height function (`heightAt`, `groundHeight`) with the site stamps applied, stamp-aware face colours, vegetation scatter and landmark sites. Imported by the main thread and the worker |
| `placement.js` | deterministic site placement on the 2 km grid ([Placement and terrain stamps](#placement-and-terrain-stamps)); pure, imported by worldgen on both threads |
| `stamps.js` | the terrain stamps (cone, carve, cliffStep, gorge, flatten, islandBase): resolution, height, paint, footprints; pure |
| `groundSurfaces.js` | extra ground surfaces: landable ground that is not terrain (floating island tops; later decks and roofs). `add({ id, minX, maxX, minZ, maxZ, top, heightAt })`, `remove(id)`, `surfaceBelow(x, z, ceiling)`; allocation-free queries. The game's instance is `ctx.groundSurfaces` |
| `terrain.worker.js` | the terrain Web Worker (Vite `?worker&inline`, so it also works in the single-file build) |
| `mapTileGen.js` | map tiles from the shared height and biome functions: `generate({ x, z, size, resolution, fields })` returns `height` (Float32Array), `color` (RGBA sRGB, face colours under a shaded relief, water by depth) and `biome` (Uint8Array); seamless; pure, generic for Phase 3's far-field tiles |
| `mapTiles.worker.js`, `mapTiles.js` | the map-tile worker (imports worldgen like the terrain worker, caches tiles in the IndexedDB database `driftwing-v2-maptiles`) and its main-thread service `createMapTileService({ seed, worldOptions })`: `request(spec, { priority })`, `reprioritize(fn)`, `stats()`, `dispose()` |
| `chunkBuilder.js` | chunk meshes and vegetation scatter, in the worker or time-sliced on the main thread; stamp-aware skirts |
| `terrain.js` | the chunk manager: ring LOD with skirts, pooled meshes, the worker queue (v1) |
| `landmarks.js` | arches, monolith circles, lighthouses and balloons (v1) |
| `spawn.js` | the golden-hour opening spawn (v1) |

### `src/flight`: flight models and the controller

| file | what |
| --- | --- |
| `FlightController.js` | `ctx.systems.flight`: active craft and its flight model, the fixed-step loop, speed blend, soft crash, relaunch, telemetry |
| `models.js` | the model registry (`ctx.flightModels`) and the control-stage registry |
| `SimFixedWing.js` | fixed-wing model (glider, bush plane, and the jet under kind `jet`), with the extension hooks |
| `SimHelicopter.js` | single-main-rotor helicopter |
| `SimWingsuit.js` | wingsuit and its canopy mode |
| `SimQuad.js` | multirotor with its flight-controller firmware (rates, angle mode, altitude hold) |
| `aero.js` | atmosphere, lift and drag curves past the stall, surface forces, ground effect, propeller |
| `jetAero.js` | the jet's SimFixedWing extension: turbofan with afterburner and detent, transonic drag, wing rock, buffet |
| `jetFcs.js` | the jet's flight control system: its assist catalog and handler, autopilot and trim handler |
| `assists.js` | the assists control stage, assist catalogs and handlers per model kind, the fixed-wing handler |
| `assistDefaults.js` | the one-time HOTAS assist default (50 % on craft the player never set) and which craft the player set |
| `helicopterAssists.js` | helicopter assists (auto-hover, heading hold, attitude limits, torque and engine protection, autorotation) and autopilot |
| `autopilot.js` | the PID autopilot control stage and the fixed-wing autopilot |
| `trim.js` | the trim solver run after every airborne reset, with handlers per model kind |
| `groundContact.js` | contact points against the shared height function: spring-damper, friction, brakes, steering |
| `landing.js` | landing grades and the `landed` event |
| `placement.js` | "Start on ground" spot search (slope, vegetation, runway length) and resting pose |
| `relaunch.js` | nearest peak, peak launch, and the aerotow with its tug and rope |
| `crashFade.js` | the soft-crash fade overlay |
| `trails.js` | smoke and ballast-spray particle trails from craft anchors |
| `telemetry.js` | `state.flight`: the one read-only description of the craft, plus atmosphere helpers |

### `src/craft`: the six craft

| file | what |
| --- | --- |
| `registry.js` | `CRAFT_CATALOG` (id, name, role, hotkey, picker silhouette) and `craftRegistry` |
| `index.js` | registers every craft module |
| `kit.js` | the procedural mesh kit and shared materials (v1 palette, nav lights, prop disc) |
| `glider.js`, `bushplane.js`, `jet.js`, `helicopter.js`, `wingsuit.js`, `fpv.js` | one craft module each (schema below) |

### `src/input`: every input device

| file | what |
| --- | --- |
| `InputManager.js` | the `input` system: writes `ctx.controls` (ControlState), routes actions, takes the touch controls' readings |
| `controlState.js` | `AXES`, `ACTIONS`, `createControlState`, `copyControlState` |
| `actions.js` | the action router: holders, press / release pairs, `input:action` events |
| `defaultBindings.js` | default bindings per device profile, axis targets, UI-reserved keys |
| `bindings.js` | the binding store: global profile plus per-craft overrides, conflicts, export / import |
| `keyboardMouse.js` | keyboard and mouse: keyboard flying, the pointer-lock free stick, drag, wheel, photo routing |
| `touch.js` | the on-screen virtual stick and throttle slider, turned into ControlState contributions |
| `gamepad.js` | Gamepad API polling, identification and hot-plug |
| `hotas/devices.js` | device identification by vendor / product id or name, device profiles |
| `deviceMapper.js` | applies bindings to live controller readings (axes, hats, buttons) |
| `axisPipeline.js` | calibration, invert, deadzone, saturation, expo, smoothing |
| `hats.js` | hat decoding from what calibration learned (axis form or button form) |
| `calibration.js` | calibration records per device and the calibration wizard step machine |
| `capture.js` | bind-by-listening |

### `src/camera`: views and lenses

| file | what |
| --- | --- |
| `cameraManager.js` | `ctx.systems.camera`: views, free look, lenses, photo mode, the instrument clock |
| `chase.js` | v1's chase rig and photo mode, extended with detach, zoom and a settings-driven base FOV |
| `cockpit.js` | the cockpit interior and instrument panel generated from `cameraRig.cockpit` |
| `views/cockpitView.js`, `views/wingView.js`, `views/flybyView.js`, `views/fpvView.js` | the four non-chase views |
| `turbulenceShake.js` | the turbulence shake: a small rotation of the final camera pose from the turbulence at the craft |

### `src/audio`: procedural Web Audio (no audio files)

| file | what |
| --- | --- |
| `AudioEngine.js` | the `audio` system: unlock, mixer, engine family, airflow, cues, callouts, spatialisation |
| `mixer.js` | buses `master, engine, environment, ui, copilot, music`, ducking, reverb, muffle, compressor |
| `engines/index.js` | engine families and `resolveAudioProfile` |
| `engines/glider.js`, `prop.js`, `jet.js`, `heli.js`, `drone.js`, `wingsuit.js` | one synth per family |
| `airflow.js` | wind beds, buffet, ground roll, cockpit interior low-pass |
| `turbulenceRattle.js` | the cockpit rattle and airframe thump that follow the turbulence at the craft |
| `flightCues.js` | stall horn, variometer, gear and flap motors, touchdown, afterburner detent click, crash |
| `callouts.js` | radar-altitude landing callouts in a voice distinct from the copilot |
| `eventCues.js`, `voices.js` | v1's chimes, blips, flutter and shutter |
| `spatial.js` | HRTF panner at the craft and doppler in external views |
| `synthKit.js`, `buffers.js` | Web Audio building blocks and procedural noise / reverb buffers |
| `spawnVoices.js` | Phase 2 spawn voices: the voice budget (virtual and realized voices), distance models, air absorption, doppler, the thunder front queue, the discovery chime |
| `recipes/*.js` | one procedural recipe per spawn sound (`recipes/index.js` lists them; `recipeKit.js` holds the shared noise, crackle and envelope helpers) |
| `audition.js` | the dev spawn auditions (`debug.spawn`) and offline renders with spectral analysis |

### `src/spawns`: the spawn framework (Phase 2)

| file | what |
| --- | --- |
| `index.js` | the `spawns` system: the SpawnManager, the engine registry, the site feed (`world.placement`, or `setSiteFeed`), the event director it creates and updates, and in dev builds the `debug` API |
| `spawnManager.js` | activation within the budgets, LOD tiers with hysteresis, lures, lifetimes and the despawn rule, discovery, memory accounting, leak clean-up, stats (below) |
| `engineRegistry.js` | the engine interface check, `ENGINE_NAMES`, `LOD_TIERS` |
| `schema.js` | the preset validator (`validatePreset`, `validatePresets`) and the preset vocabularies; pure |
| `lure.js` | FAR lures: the horizon silhouettes of heavy spawns |
| `lightPool.js` | the real-light budget pool |
| `pools.js` | pooling helpers for engines: scratch rings, slot allocators, object pools, instanced and mesh pools |
| `presets/index.js` | `PRESETS` (spec order) and `PRESET_BY_ID`; one pure-data file per preset |
| `engines/vortexEngine.js` | the vortex engine: tornado, waterspout and dust-devil funnels, their ground ring and their Rankine wind ([docs/engines/vortex.md](engines/vortex.md)) |
| `engines/windModifierEngine.js` | the windModifier engine: WindField sources with no visuals ([docs/engines/windModifier.md](engines/windModifier.md)) |
| `engines/windSources.js` | the allocation-free WindField source samplers both wind engines author (rankine, updraft, downburst, wake, jetStream, slipstream, waveLift, gustFront, curtain), their param tables and bounds; pure, so the labs use it too |
| `engines/emitterEngine.js`, `engines/particleSystem.js` | the `emitter` engine: GPU particle pools (TSL compute on WebGPU, closed-form motion in the vertex shader on WebGL2), wind grids, couplings; params in `docs/engines/emitter.md` |
| `engines/lightEffectEngine.js`, `engines/glowPoints.js`, `engines/ribbons.js` | the `lightEffect` engine: lightning, glows, swarms, beams, the two-light budget; params in `docs/engines/lightEffect.md` |
| `engines/engineKit.js` | helpers the engines share (one implementation each): param readers with clear errors naming the engine, preset and param (`createParamReader`, by value, and `createParamView`, by name), `[min, max]` rolls with the seeded generator, the wind source sample result (`createWindSample`), the one-voice rule (`ownsPresetAudio`: an entry's `voice` / `sound` / `ownsAudio` flag, else the preset's first engine entry opens `preset.audio`), heading frames, ground grids, pooled real lights, fixed-capacity update range lists, batched seeded random numbers, rationed voice levels |
| `engines/weatherVolumeEngine.js`, `engines/weatherVolume/` | the weatherVolume engine: cloud masses, rain shafts, fog banks, the weather inside them ([docs/engines/weatherVolume.md](engines/weatherVolume.md)) |
| `engines/celestialEngine.js`, `engines/celestial/` | the celestial engine: meteors, comets, the eclipse, the glory and rainbows ([docs/engines/celestial.md](engines/celestial.md)) |
| `engines/faunaEngine.js`, `engines/faunaSpecies.js` | the fauna engine and its low-poly species ([docs/engines/fauna.md](engines/fauna.md)) |
| `engines/waterEffectEngine.js` | the water effect engine (on the water effects layer) ([docs/engines/waterEffect.md](engines/waterEffect.md)) |
| `engines/gateDetector.js` | generic pass-through / pass-under gates: `createGateSet(gates)` and `crossGates(set, from, to, first, result)`, allocation-free |
| `engines/structureEngine.js`, `engines/structure/` | the structure engine and its recipes (wind farm, rope bridge, airfield, floating islands, crystal spires, gate course), the v1 palette, the mesh builder and `structureStamps` ([docs/engines/structure.md](engines/structure.md)) |
| `engines/setPieceEngine.js` | the set-piece engine: scripted multi-stage timelines over other presets through the SpawnManager ([docs/engines/setPiece.md](engines/setPiece.md)) |

### `src/env`

| file | what |
| --- | --- |
| `WindField.js` | the wind field (ambient, ridge lift, thermals, turbulence, sources) and `createDebugUpdraft` |

### `src/spawns`: the event director and the regional weather (Phase 2)

| file | what |
| --- | --- |
| `candidates.js` | pure: deterministic event candidates from hash(seed, cellX, cellZ, timeBucket, presetId), the pooled candidate records, the ahead score and the candidates' total order |
| `weather.js` | the pure regional weather model (clear -> building -> storm -> clearing per region cell and time bucket) and the `weather` system that drives the sky modifier and emits `weatherChanged` |
| `director.js` | the event director (2 Hz): pacing, rarity, cooldowns, budgets, filters, lifetimes, despawn, load shedding, `getNearby`, `getState`, the activation log; `createGameDirector(ctx, ...)` wires it to the game |

### `src/ui`: glass UI

| file | what |
| --- | --- |
| `ui.js`, `ui.css` | the v1 glass UI (HUD, compass, panels, toasts, command bar, help, journal) and the v2 chrome wiring |
| `craftPicker.js` | the craft picker strip (keys 1-6) |
| `settingsPanel.js` | the tabbed settings panel (Flight, Graphics, Sound, Controls, General) |
| `controlsPanel.js`, `controlsPanel.css` | the controls panel: device tabs, live readings, bindings, tuning, export / import |
| `calibrationWizard.js` | the calibration wizard screens |
| `instruments/` | 17 instrument renderers (`index.js` registry, `gaugeKit.js`, `units.js`) |
| `glassHud.js`, `glassHud.css` | the glass HUD's attitude indicator, stall / AoA warning and flight path marker, and when the glass HUD shows (the camera system drives it) |
| `instrumentHud.js`, `instrumentHud.css` | the optional glass instrument HUD overlay |
| `stickReticle.js`, `stickReticle.css` | the virtual-stick reticle |
| `soundPill.js`, `soundPill.css` | the "Sound off - click to enable" pill |
| `journalPanel.js`, `journalPanel.css` | the journal panel's body: this world's totals, discoveries (x / N), the global records and achievements, biomes, landmarks, ring courses and landings |
| `discoveryToast.js`, `discoveryToast.css` | the glass discovery card (name, category, one-liner, count) and achievement card; toasts for improved records |
| `worldMap.js`, `worldMap.css` | the world map panel (M): relief tiles, discovered sites, trail, craft, waypoint; click to set a waypoint |
| `seedLinks.js` | the Copy link buttons and reloading into another world through the shell bridge |
| `categoryIcons.js`, `journalFormat.js` | the discovery icons and colours per category and landmark type (SVG and Path2D), and the journal's number, time and coordinate formats |

### `src/copilot`: WREN

| file | what |
| --- | --- |
| `copilot.js` | `Copilot` (local grammar brain), `RemoteCopilot` (HTTP brain with fallback), the `copilot` system |
| `grammar.js` | the v2 aircraft grammar and the shared action validator `sanitizeFlightAction` |
| `flightActions.js` | the executor for aircraft actions, reporting real outcomes |
| `flightState.js` | the v2 half of the flight-state snapshot and craft capabilities |
| `flightChatter.js` | chatter for landings, soft crashes, craft changes, lift hints, and the lines a set piece narrates (`setPiece:narrate`, tokens {distance} {direction} {name} {eta} filled when offered), all through the chatter gate |
| `commandChips.js` | the "Aircraft" and "Guide" quick-chip rows |
| `tourGuide.js` | the Phase 2 tour guide: "what's nearby", "take me to the ...", "find a thermal", "chase the storm", "next discovery", the proactive callouts and their "yes", and the `nearby` / `activeEvents` / `weather` / `callouts` flight-state fields |

### `src/gameplay`

`journal.js` (landmarks, biomes, distance, best landings from v1; spawn discoveries, the global
records and the achievements from Phase 2, see [UI](#ui-ctxsystemsui)), `rings.js` (ring courses)
and `waypoints.js` (waypoint beacon and arrow), from v1.

### `src/dev`: developer tools (never player features)

| file | what |
| --- | --- |
| `statusBadge.js` | the dev badge: version, backend, three.js revision, fps, frame-time graph, render scale, input devices |
| `windOverlay.js` | the wind-arrow overlay (`settings.windOverlay`) and the badge's Wind row |
| `spawnDebugger.js`, `spawnDebugger.css` | the spawn debugger (F9; dev builds, or `?dev=1` in a production build): presets with filters, force spawns ahead, teleport to the nearest site, time of day, director state, engine stats, the wind overlay toggle |
| `spawnTestKit.js` | dev builds only (never in a production bundle): two test engines (`testMarker`, `testWind`) and their presets, loaded by `spawns.debug.loadTestKit()` to prove the framework |
| `structureTestKit.js` | dev builds only: preset-like objects for every structure recipe, `buildTestSite` (a site record with its stamps resolved as placement does), `?test=sites` (the terrain fixtures' stamped world with no harness) and the browser checks of `tools/steps/engine-structure*.json` |
| `setPieceTestKit.js` | dev builds only: the dev timeline (`DEV_TIMELINE`) over the test engines and a structure child, and the browser checks of `tools/steps/engine-setPiece.json` |
| `debugWind.js` | dev-only debug updraft wind source (key L), proving the Phase 2 wind writer path |
| `mockGamepads.js` | scriptable mock T.16000M, TWCS and standard gamepad devices |
| `testHarness.js` | the flight-test harness at `?test=1` (dev builds only) |
| `hotasTest.js` | the HOTAS pipeline test at `?test=hotas` (dev builds only) |
| `terrainTest.js` | the terrain test at `?test=terrain` (dev builds only): stamp seams at every LOD pair, worker parity, collision against the rendered mesh, on the fixtures or (`&presets=real`) the real stamped presets |
| `presetChecks.js` | browser checks for the real presets (`tools/steps/presets-21-30.json` on a dev server): force-spawn ahead at the preset's time and weather, framing for screenshots, discovery (event, journal entry, card), memory, wind sources and sky modifiers back after dispose, real stamped sites with the site-list hash, ground start, eclipse, dawn and set-piece stages |
| `terrainFixtures.js`, `terrainChecks.js` | the six fixture site presets (one per stamp type) and the seam / collision checks, shared by the terrain test and `tools/lab/terrain.mjs` |

### `src/shell`: the launcher shell and V2's side of it

| file | what |
| --- | --- |
| `shell.js` | the launcher shell (loaded by the root `index.html`, not part of V2): version choice, switching, the pill, the message listener |
| `bridge.js` | V2's `shell` system: the `versionToggle` owner that asks the shell for V1, and the `dw-embedded` root class |

### `tools`

| file | what |
| --- | --- |
| `smoke-test.mjs` | headless Chrome check: console errors and warnings fail it; scripted steps and screenshots |
| `steps/*.json` | reusable smoke steps; `view-physics.json` proves every craft flies the same in every view (below) |
| `run-harness.mjs` | runs the `?test=1` / `?test=hotas` / `?test=terrain` harnesses headlessly on a spare port and saves the report (and, for the terrain test, one screenshot per stamp type) |
| `shell-test.mjs` | the launcher shell under load: 20 round trips, one live game, memory back to baseline, focus, hash forwarding, foreign origins ([Testing](#testing)) |
| `shell-check.mjs` | the launcher shell's behaviour: first launch, the pill (shows, hides, clear of each game's HUD), persistence, `?v=`, forwarding, messages |
| `build-single.mjs`, `v1-checksum.mjs` | the `dist-single/` build; the V1 freeze helpers shared with `tests/v1-checksum.test.mjs` |
| `bat-check.mjs` | runs `start-driftwing.bat`'s Node.js version check under cmd.exe against fake `node` versions |
| `browser.mjs`, `ports.mjs` | Chrome / Edge discovery and free-port discovery (never 5199) shared by the headless tools |
| `flight-lab.mjs` | headless flight lab for the glider and bush plane (handling, spawns, craft switches, hot-plug) |
| `lab/jet.mjs`, `lab/helicopter.mjs`, `lab/wingsuit.mjs`, `lab/fpv.mjs` | headless flight labs per craft |
| `lab/settings.mjs` | settings migrations (views per craft included) and the one-time HOTAS assist default |
| `lab/terrain.mjs` | site placement and terrain stamps: Phase 1 bit-identity (no sites; with the real presets, everywhere outside their stamps), filters, determinism, stamp shapes, seams, collision, and the height-sampling cost against Phase 1 |
| `lab/copilot.mjs` | WREN's local grammar (version one, the view commands, retired commands) and the `switchVersion` and `setView` schema |
| `lab/input.mjs`, `lab/storage.mjs`, `lab/copilot-server.mjs` | input pipeline, storage and copilot-server origin labs |
| `copilot-server.mjs` | the reference remote copilot brain (see `docs/copilot-api.md`) |
| `serve.mjs` | zero-dependency static server (`npm run serve:single`) |

## Runtime

### Boot

`main.js` boots in this order:

1. The display refresh measurement starts (it runs while boot waits).
2. `await storage.init()`.
3. The typed event bus (`attachTypedEvents(new EventBus(), { validate })`), the settings and the
   seed: the query (`?seed=`), then the hash (`#seed=`, share links and the launcher shell), then
   the saved `settings.seed` (the world flown last), else a new random one. It is written back into
   the URL and into `settings.seed`. The start time of day is `?time=`, then the link's `#t=`,
   else the golden-hour opening.
4. The renderer (`src/render/renderer.js`): WebGPU first, WebGL2 fallback. WebGPU is chosen only
   when a real device can be created, since an adapter alone does not prove it works. If three.js
   falls back to WebGL2 on its own later, the renderer is rebuilt for WebGL2 so no WebGPU-only
   option (reversed depth) stays on. `?renderer=webgl` forces WebGL2. The boot never hard-blocks
   the WebGL2 backend, because WebXR in Phase 4 runs on it. The boot then installs the uniform
   upload patch (`src/render/uniformUploads.js`). three r184 records every changed uniform as a new
   `{ start, count }` range plus a Map entry, and every render object's matrices change every
   frame, so V8 promoted about 17 MB/s (WebGPU; 12 MB/s on WebGL2) to the old generation and ran a
   major GC every 3-4 s; those pauses were the flight test's frames over 50 ms. Each uniform group
   now keeps one whole-buffer range that is never cleared (a changed group uploads whole, a few
   hundred bytes). Measured over 40 s of flight on the loaded test machine, promotion fell to
   1-3 MB/s and the mark-compact collections from 12 to 4-9 on WebGPU and from 21 to 6 on WebGL2,
   while the frame rate rose by a third on WebGPU and more than doubled on WebGL2. The patch
   takes the class from the first bound uniform group, since `three/webgpu` does not export it, and
   throws if the renderer internals it needs are missing. `getStats().uniformUploadPatch` reports it.
5. The scene, camera and shared TSL uniforms; the world generator and the opening spawn; the shared
   `state` and the `ctx` object.
6. The wind field, then the perf governor (`ctx.perf`).
7. Every system, created in this order: shell (the launcher bridge), audio, ui, assistDefaults, input, sky, weather, terrain, water, clouds, birds,
   spawns, journal, landmarks, waypoints, rings, flight, camera, fx, gEffects, copilot, windOverlay,
   spawnDebugger (dev builds and `?dev=1` only) and debugWind (dev builds and `?debug=1` only). A
   factory that throws is logged and replaced by an inert system, so one failure never stops the
   game. The spawn engines (`SPAWN_ENGINE_FACTORIES` in `main.js`) register with the spawns system
   right after, and its prewarm hook starts it: it validates the presets (dev builds, `?debug=1` and `?dev=1`),
   initialises the engines and records the memory baseline, behind the loading fade. The spawns
   system then creates the event director (below) on the started manager.
8. `prewarm()` hooks and the pipeline prewarm: objects that first appear later (rings, beacons,
   landmarks) are drawn once behind the loading fade so their pipelines compile before play.
9. The post stack (in `try` / `catch`; it degrades to direct rendering), resize handling and
   `window.DRIFTWING`.
10. The frame loop starts with `renderer.setAnimationLoop` (uncapped).

A harness started by `?test=1` or `?test=hotas` hooks in once, after the systems are created.

### Frame loop (`src/core/loop.js`)

Every frame:

1. **Timing.** `realDt` is the frame interval clamped to 1/20 s (1/60 after a stall over 0.25 s).
   `simDt` is `realDt`, or 0 while paused (photo mode). `state.time.frameDt` is the unclamped real
   frame time capped at 0.1 s: the fixed-step physics clock consumes it.
2. **Systems.** Each system in `UPDATE_ORDER` runs `update(simDt, realDt)`: input, flight, camera,
   terrain, weather, sky, water, clouds, birds, spawns, landmarks, journal, waypoints, rings, fx,
   gEffects, copilot, audio, ui, windOverlay, debugWind, spawnDebugger. A system that throws is
   disabled and logged; the rest carry on.
3. **Safety net, right after flight.** A non-finite pose is restored from the last good one and the
   model is reset from it. The flight model has real ground contact, so the net only keeps the
   last-resort guard: more than 1 m below the shared height function is a soft crash. The altitude
   ceiling comes from the controller (15000 m).
4. **Telemetry.** `flight.publishTelemetry()` writes `state.flight` from the final, safety-checked
   pose.
5. **Biome tracking** (`biome:changed`), then `perf.update({ frameMs, cpuMs })` with the real,
   unclamped frame interval.
6. **Render** through the post pipeline (screenshot capture raises the pixel ratio for that one
   frame).
7. **Fade gate.** The loading fade lifts once the ground around the spawn is built and frames arrive
   steadily (8 s cap). Then `state.ready` is set, `endPrewarm()` hooks run and `game:ready` fires.

### Physics inside the flight update

V2 always flies the real flight model (there is no CLASSIC mode; V1, the original game, runs on its
own behind the launcher shell). The flight controller advances a fixed-step clock (`src/core/clock.js`, 120 Hz) by
`state.time.frameDt`. For each tick it:

1. copies the live ControlState;
2. applies the craft `inputProfile` (for example `throttle: 'none'` zeroes it, `'collective'`
   copies it to the collective);
3. zeroes the stick while the hands-off hold of a disconnected controller is active;
4. runs the control stages (autopilot, then assists);
5. samples the wind (`ctx.wind.sample`) and the air density `rho = 1.225 * exp(-altitude / 8500)`
   at the craft;
6. calls `model.step(dt, controls, env)`, guarding every tick against NaN / Infinity (it restores
   the last good snapshot and logs once).

The rendered pose is interpolated between the last two ticks with `alpha`.

### `window.DRIFTWING`

`{ ready, backend, revision, seed, frame, readyMs, ctx, state, getStats(), debug? }`.
`getStats()` returns the backend, revision, fps, frame time, render scale, the frame target and a
`perf` block, draw calls, quality, time of day, the copilot flight state, terrain, cloud, bird and
landmark stats, and the disabled systems. The smoke test and the harnesses script the game through it.

In dev builds, with `?debug=1` or with `?test`, `debug` steps the frame loop by hand:
`pauseLoop()` stops the animation loop, `stepFrames(count, frameMs = 1000 / 60)` runs frames at a
fixed frame time, `resetTiming()` makes the next frame start the timing afresh (no physics time),
and `resumeLoop()` hands the frames back. Scripted checks use it to give two runs the same frame
and tick timing (`tools/steps/view-physics.json`).

## Contracts

### ctx

Every system factory is `createXSystem(ctx)` and returns an object with `update(simDt, realDt)`,
plus optional `prewarm()` / `endPrewarm()` hooks and whatever API it offers. `ctx` carries:

| field | what |
| --- | --- |
| `THREE`, `TSL`, `addons` | the one three.js r184 build (`three/webgpu`, `three/tsl`, `addons.BufferGeometryUtils`) |
| `CONFIG`, `worldOptions` | tuning constants and the world generator options (the terrain worker gets the same options; a dev test may add fixture `presets`) |
| `renderer`, `backend` (`'WebGPU'` \| `'WebGL2'`), `scene`, `camera`, `post` | rendering |
| `bus` | the EventBus with typed events (`emitTyped` / `onTyped`) |
| `settings`, `storage` | persisted settings and the raw key-value storage |
| `world` | the shared deterministic world generator (`heightAt`, `groundHeight`, `biomeAt`, `sitesNear`, `sitesInCell`, `stampInfluence`, ...) |
| `groundSurfaces` | extra ground surfaces (`src/world/groundSurfaces.js`): landable tops that are not terrain; spawn engines add them (engine ctx `surfaces`), the flight controller stands on them |
| `wind` | the WindField |
| `perf` | the perf governor |
| `craftRegistry` | craft catalog and registered craft modules |
| `flightModels` | the flight model and control-stage registry |
| `state` | shared mutable game state (`frame`, `ready`, `paused`, `photoMode`, `seed`, `spawn`, `time`, `player`, `flight`, `waypoint`, `ringCourse`, `perf`) |
| `controls` | the v2 ControlState |
| `systems` | every system by name |
| `uniforms`, `textures`, `quality`, `util` | shared TSL uniforms (including `cloudGlory` and `cloudBow`, the cloud optics the celestial engine drives), textures (cloud shadow), the current quality level, helpers |
| `registerPrewarm(object)` | registers a lazily shown object for the pipeline prewarm |
| `executeAction`, `getFlightState`, `setPhotoMode`, `requestScreenshot`, `userHasInteracted` | v1 hooks shared by the UI, copilot and camera |

`state.player` keeps the v1 pose fields the world, camera, audio and HUD read (position, velocity,
quaternion, forward / up / right, speed, throttle, heading, pitch, roll, yawRate, verticalSpeed,
gForce, altitude, agl, stalled, autopilot, biome) current from the flight model. `state.flight` is the v2
telemetry (below).

### Storage (`src/core/storage.js`)

V2 shares its origin with V1 behind the launcher shell, so all V2 storage is prefixed
`driftwing-v2`: the IndexedDB database is `driftwing-v2`, with one object store, `kv`, and every key
starts with `driftwing-v2.` (`read`, `write` and `remove` throw on any other key, so V2 can never
touch V1's `driftwing.settings.v1`, `driftwing.journal.*` or `driftwing.ui.*` localStorage keys).
`init()` loads everything into a cache, so `read(key, fallback)` is synchronous. `write(key, value)`
updates the cache and persists in the background, returning false only when nothing can persist.
The API also has `remove`, `keys(prefix)`, `flush()` (resolves when every write has landed),
`backend` (`'indexeddb'` \| `'localstorage'` \| `'memory'`) and `available`. Structure migrations
run in `onupgradeneeded` and data migrations after load; new steps are only appended. The first
data migration imports the Phase 1 database `driftwing` once, when `driftwing-v2` is still empty:
the settings record (without its old `mode` field), the `input.*` and `audio.*` keys and the
journals are copied under their new names, then the old database is deleted.

| key | what |
| --- | --- |
| `driftwing-v2.settings` | settings |
| `driftwing-v2.journal.<seed>` | the per-world journal (landmarks, biomes, totals, ring courses, landings, spawn discoveries) |
| `driftwing-v2.records` | the global records: journal statistics, achievements and the best landing in any world |
| `driftwing-v2.ui.firstRunHintSeen` | first-run hint flag |
| `driftwing-v2.input.bindings` | the binding profile `{ version, devices, global: { device: { target: Ref[] } }, crafts: { craftId: {...} } }` |
| `driftwing-v2.input.calibration.<deviceKey>` | calibration per device |
| `driftwing-v2.audio.vario` | the variometer audio (`on` \| `off`; Phase 1's `auto` reads as `on`) |

The map-tile worker keeps finished map tiles in its own IndexedDB database, `driftwing-v2-maptiles`
(one store, `tiles`, keyed by the seed, the tile version, a hash of the presets' placement data and
the tile; the oldest go beyond 1200 tiles). The dev harnesses use their own databases (`driftwing-v2-test`, `driftwing-v2-test-hotas`) and
sessionStorage keys (`driftwing-v2.test.flight`, `driftwing-v2.test.hotas`). The launcher shell
keeps one key of its own, `driftwing.shell.lastVersion`.

IndexedDB is scoped to the origin including the port. That is why the dev server is pinned to
`127.0.0.1:5199` (`vite.config.js`: `strictPort`), and why `npm run serve:single` serves the
single-file build on the same address.

### Settings (`src/core/settings.js`)

The API is `get(key)` (object values come back as copies), `set(key, value)` (whole value; returns
false when invalid), `update(key, patch)` (merges into an object key), `reset(key?)` and `all()`.
Every change emits `settings:changed { key, value, settings }`. The record is versioned
(`SETTINGS_VERSION` 5) and migrated. Unknown fields are dropped, and an invalid field falls back to
its default. Version 4 removed the CLASSIC | SIM `mode`, the per-mode `views` and `hotasPrompt`: the
SIM view became `view`, and craft whose assists a record had moved off 100 % count as set by the
player. Version 5 remembers the view per craft: `view` seeds every craft's `views` entry (and
`thirdPersonViews` when it is a third-person view), and a first run starts every craft in chase
(`tools/lab/settings.mjs` checks the migrations).

| key | default | values |
| --- | --- | --- |
| `dayLength`, `timeFrozen` | 360, false | seconds 60-3600; boolean (v1) |
| `quality` | `auto` | `auto` \| `minimal` \| `low` \| `medium` \| `high` \| `ultra` (v1) |
| `mouseSensitivity`, `invertPitch` | 1, false | 0.2-4; boolean (v1) |
| `copilotVoice`, `copilotChatter` | true, true | boolean (v1) |
| `remoteCopilot`, `remoteEndpoint` | false, `http://localhost:3000/copilot` | boolean; http(s) URL (v1) |
| `showFps`, `hudAutoHide` | false, true | boolean (v1) |
| `craft` | `glider` | `glider` \| `bushplane` \| `jet` \| `helicopter` \| `wingsuit` \| `fpv` |
| `assists` | 1 for every craft | `{ craftId: 0..1 }`: the only difficulty control |
| `assistsSetByPlayer` | false for every craft | `{ craftId: boolean }`: the player chose that craft's assists (any change `assistDefaults.js` did not make) |
| `hotasAssistsApplied` | false | boolean: the one-time HOTAS default has run |
| `startOnGround` | false | boolean |
| `units` | `metric` | `metric` (km/h, m, m/s) \| `aviation` (kt, ft, fpm) |
| `views` | `chase` for every craft | `{ craftId: 'chase' \| 'cockpit' \| 'wing' \| 'flyby' }`: the view each craft was last flown in (the FPV camera is stored as `cockpit`, the first-person slot) |
| `thirdPersonViews` | `chase` for every craft | `{ craftId: 'chase' \| 'wing' \| 'flyby' }`: the last third-person view, where `viewToggle1P3P` returns |
| `fov` | `{ chase: 60, cockpit: 74, wing: 68, flyby: 50, fpv: 120 }` | degrees; ranges 40-100, 50-110, 40-110, 20-90, 90-150 |
| `fpv` | `{ uptilt: 25, expo: 0.3, rate: 670 }` | FPV drone: camera uptilt 0-40 deg, stick expo 0-1, maximum rate in deg/s |
| `hud` | `{ overlay: false, landingCallouts: false, cockpitGlass: false, flightPathMarker: true }` | booleans: the instrument overlay, landing callouts, the glass HUD in a cockpit with a panel, the flight path marker |
| `twistYaw` | `auto` | `auto` \| `on` \| `off` |
| `afterburnerDetent` | 0.95 | 0.8-1 |
| `frameTarget` | `auto` | `auto` \| 60 \| 120 \| 144 \| 240 \| `uncapped` |
| `dynamicResolution` | true | boolean |
| `mixer` | `{ master: 0.7, engine: 0.9, environment: 0.85, ui: 0.8, copilot: 1, music: 0.7 }` | 0..1 per bus |
| `seed` | `''` | the world flown last (A-Z, 0-9, dashes; at most 24); a link or `?seed=` wins over it at boot |
| `devBadge`, `windOverlay` | false, false | booleans |

`masterVolume` is an alias of `mixer.master`, kept for v1-era callers. Bindings and calibration are
not settings: they live in their own storage keys, so a device profile can be exported on its own.

**Command channel for the craft.** The persisted setting `craft` is the source of truth. Any UI,
input action or copilot command changes it with `settings.set`. The flight controller listens,
applies the change (or refuses it and writes the previous value back), then emits `craftChanged`.
The picker follows both, so a refused switch reverts on screen too.

**Assist defaults** (`src/flight/assistDefaults.js`). Assists start at 100 % for keyboard and
mouse. The first typed `deviceConnected` with a `hotas-*` kind sets 50 % on every craft whose
`assistsSetByPlayer` is false, toasts "HOTAS detected - assists set to 50%. Change them in
Settings." and sets `hotasAssistsApplied`, so it never runs again. Any other change to `assists`
marks the craft it changed in `assistsSetByPlayer`.

### Events (`src/core/events.js`)

Typed events are emitted with `bus.emitTyped(name, payload)` and heard with
`bus.onTyped(name, listener)`. An unknown name throws. Payloads are validated in dev builds and with
`?debug=1`, and a bad payload is reported once per type and still delivered.

| event | payload | emitted by |
| --- | --- | --- |
| `craftChanged` | `{ craft, previous }` | flight controller |
| `landed` | `{ grade: butter\|smooth\|firm\|hard, craft, sinkRate, groundSpeed, position }` | landing monitor |
| `softCrash` | `{ craft, reason, impactSpeed, position }` | flight controller |
| `discovery` | `{ id, name, kind, position, presetId? }`: landmarks (bridged from `landmark:discovered`) and spawns (`kind` is the preset category, `id` the site id or the event preset id, `presetId` the preset) | events.js, SpawnManager |
| `windSourceAdded` / `windSourceRemoved` | `{ id, kind, position, radius }` / `{ id, kind }` | WindField |
| `viewChanged` | `{ view: chase\|cockpit\|wing\|flyby\|fpv, craft }` (also at start and on craft change) | camera |
| `deviceConnected` / `deviceDisconnected` | `{ deviceKey, kind, name }`; kind `gamepad` \| `hotas-stick` \| `hotas-throttle` \| `hotas-pedals` | gamepad registry |
| `relaunched` | `{ craft, method, position }` | flight controller |
| `spawnActivated` | `{ id, presetId, category, kind: site\|event, position }` | SpawnManager |
| `spawnEnded` | `{ id, presetId, reason }`; reason `ended`, `expired`, `despawn`, `range`, `error`, `debug`, `removed`, `disposed` or the caller's (the director's `lifetime`, `despawn`, `dispose`) | SpawnManager |
| `weatherChanged` | `{ state: clear\|building\|storm\|clearing, previous, region }`; fires only on a real change, so `previous` is always a state; `region` is the weather cell `"rx:rz"` | weather system |
| `achievement` | `{ id, title }`; the journal keeps each id once, in every world | presets and engines |
| `journalStat` | `{ key, value, op: min\|max\|add, presetId? }`: `stormsChased` (add 1), `closestTornado` (min, m), `bestCanyonRun` (min, s, clean runs only) and any other key (folded with its op) | presets and engines |
| `wildlifeQuiet` | `{ source, quiet }`: `source` (a spawn id) starts (`true`) or ends (`false`) its hold; the wildlife is quiet while any source holds. The v1 birds settle out of the sky and the flutter cue stays silent; fauna listen too | celestial engine (eclipse) |

Landing grades come from the sink rate at touchdown: butter up to 0.5 m/s, smooth up to 1.2 m/s,
firm up to 2.2 m/s, and hard above that.

Untyped events keep v1's `namespace:verb` names:

- `notify { text, kind }`;
- `settings:changed`, `user:gesture`, `game:ready`, `resize`;
- `photo:changed`, `screenshot:taken`;
- `quality:changed`, `time:changed`, `biome:changed`;
- `autopilot:changed`, `safety:nonFinite { craft }`;
- `rings:started`, `rings:finished`, `rings:cancelled`;
- `waypoint:set`, `waypoint:reached`, `waypoint:cleared`;
- `landmark:discovered`, `landmark:threaded`, `journal:changed`, `birds:scattered`;
- `copilot:speech { text, source }`, `copilot:listening`, `copilot:transcript`, `mic:toggle`;
- `copilot:callout { text, presetId, spawnId }`, `copilot:offer { active, name?, presetId?, expiresIn? }` (the tour guide);
- `ui:command`, `ui:action`;
- `journal:discovery { entry, found, total }`, `journal:record { key, value, previous, improved, op,
  presetId }`, `journal:achievement { entry }` (the journal, after it recorded one).

v2 adds these untyped events:

| event | payload |
| --- | --- |
| `input:action` | `{ id, phase: 'press' \| 'release', source: 'keyboard' \| 'mouse' \| 'touch' \| 'gamepad' \| 'hotas' \| 'copilot', device }`; `device` is `keyboard`, `mouse`, `touch`, `copilot` or a controller's deviceKey |
| `flight:assistOverride` | `{ active, reason: 'deviceDisconnected' \| 'device reconnected' \| 'manual input', deviceKey? }` |
| `ui:openControls` | `{ calibrate?: boolean }`: opens the controls panel, and with `calibrate` starts the wizard |
| `perf:renderScale` | the dynamic-resolution scale changed |
| `perf:loadShed` | `{ action: 'shed' | 'restore', id, depth }`: a load shedder shed or restored one level |
| `spawns:siteInView` | `{ id, presetId }`: a site came into view for the first time; the director counts it as a notable (reserved: the SpawnManager reports sightings with `spawns:inView`, which the director also hears) |
| `audio:started` | `{ context }`, once, when the AudioContext is created |
| `spawns:inView` | `{ id, presetId, siteId, kind, distance }`: a spawn was first seen (in the view cone, not hidden by terrain), once per spawn; heavy spawns count from their lure range, others from lod.mid. The director counts it toward pacing |

### Input actions and owners (`src/input/controlState.js`)

Every action is rebindable on every device:

`copilotPTT, craftAbility, waypointNearest, waypointAhead, photoMode, viewCycle, viewToggle1P3P,
viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext, craftPrev, craftSelect1` ..
`craftSelect6, gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward, timeBack,
ringCourse, journal, mapToggle, settings, controlsPanel, relaunch, engineToggle, chuteDeploy, versionToggle`.
Stored or imported bindings for the retired `modeToggle` and `boost`, and Phase 1 references
limited to the CLASSIC key layer, are dropped quietly on load.

Each press and release is published as `input:action`. Each action has exactly one owner that
performs it:

| owner | actions |
| --- | --- |
| flight (`FlightController.js`) | craftAbility, craftNext, craftPrev, craftSelect1-6, gearToggle, flapsUp, flapsDown, airbrake (held), relaunch, engineToggle, chuteDeploy. The flight model itself handles gearToggle, flapsUp, flapsDown, airbrake, engineToggle and chuteDeploy (they reach it in `controls.actions` on the frame's first tick, and held ones in `controls.held`) |
| camera (`cameraManager.js`) | viewCycle, viewToggle1P3P, viewForward, viewBack, viewLeft, viewRight, recenterView |
| ui (`ui.js`) | waypointAhead, waypointNearest, photoMode, autopilotToggle, timeForward, timeBack, ringCourse, journal, mapToggle, settings, controlsPanel |
| copilot (`copilot.js`) | copilotPTT (held) |
| shell bridge (`src/shell/bridge.js`) | versionToggle |

In photo mode only photoMode, timeForward, timeBack and copilotPTT pass. Default bindings are
listed in `docs/controls.md`.

### ControlState (`src/input/controlState.js`)

`ctx.controls` is the one device-independent description of what the pilot asks for. Flight reads
it once per physics tick, and cameras and UI read it every frame.

| field | range | meaning |
| --- | --- | --- |
| `roll`, `pitch`, `yaw` | -1..1 | right, nose up, nose right positive |
| `throttle`, `collective` | 0..1 | lever positions |
| `brakeL`, `brakeR` | 0..1 | toe brakes |
| `flaps` | 0..1 | axis-commanded flap setting |
| `trim` | -1..1 | pitch trim, nose up positive |
| `lookX`, `lookY` | -1..1 | free look as a fraction of the view's maximum; 0 is centred |
| `antenna` | 0..1 | HOTAS antenna; the craft maps it to flap notches or zoom |
| `afterburnerDetent` | 0.8..1 | from settings |
| `afterburner` | boolean | throttle at or past the detent |
| `actions` | Set | action ids pressed since the flight controller last consumed them |
| `held` | Set | action ids currently held |
| `sources` | object | which device last moved each axis |

Every device writes it: the keyboard, the mouse virtual stick, the touch controls (the UI reports
the on-screen stick and slider through `ctx.systems.input.touch`), gamepads and HOTAS.

Axis combination per target (`AXIS_TARGETS` in `defaultBindings.js`): `sum` for roll, pitch, yaw
and look; `max` for the toe brakes; `position` for throttle, collective, flaps, trim and antenna.
With `position`, an absolute axis takes over when it moves, and rate references move the value.

### Devices, bindings and calibration

- **Identification.** Devices are identified by the vendor / product id parsed from `gamepad.id`
  (Thrustmaster `044f`: T.16000M `b10a`, TWCS `b687`, TFRP `b679`), falling back to name
  substrings, and never by slot index. The deviceKey is `vvvv-pppp`; a second identical device gets
  `#2`, and a device with no parseable id gets `name-...`. A device that moves to another slot keeps
  its key. `?debug=1` logs each observed id once.
- **Bindings.** A global profile plus per-craft overrides, per binding device: `keyboard`, `mouse`,
  `gamepad` (every standard-mapping pad), or a HOTAS deviceKey. The reference shapes are documented
  at the top of `defaultBindings.js`.
- **Calibration.** Stored per deviceKey. It learns centres and ranges, throttle and brake
  directions, and each hat's form (axis or buttons) with the value of every direction and of
  centre.
- **Axis pipeline.** calibration, invert, deadzone, saturation, expo, smoothing
  (`axisPipeline.js`).
- **Special axes.** Twist yaw yields to the pedal rudder once the pedals move (`twistYaw`). The
  stick's own slider is ignored while a TWCS is connected. The TWCS rocker is a rate input that
  moves the trim.

The input system API (`ctx.systems.input`) is listed in `docs/controls.md`.

### FlightController (`ctx.systems.flight`)

v1 methods keep their v1 meaning.

| member | notes |
| --- | --- |
| `update(simDt, realDt)` | fixed 120 Hz ticks, then interpolation |
| `planeMesh` | the active craft's root Object3D |
| `setAutopilot(options)` | v1 options `{ enabled, heading, altitude, followWaypoint }` plus `speed`; the PID autopilot flies through the controls |
| `getWingtips()` | world-space wingtip points (contrails) |
| `resetTo({ x, y, z, heading })`, `syncVisual()`, `getStats()` | v1 |
| `publishTelemetry()` | writes `state.flight`; the frame loop calls it after the safety net |
| `getCraft()`, `setCraft(id)` | `setCraft` goes through the settings channel and returns whether the craft is now flying |
| `getCraftModule()`, `getCameraRig()`, `getEyeAnchor()` | the active craft module, its `cameraRig`, and the mesh eye anchor |
| `getModel()` | the active FlightModel |
| `getCeiling()` | 15000 m (`FLIGHT_CEILING`) |
| `isTowing()`, `isAssistOverridden()` | aerotow in progress; hands-off hold active |
| `relaunch()` | the craft's relaunch: aerotow to 1000 m AGL (glider), a dive from the nearest peak (wingsuit), or a 300 m airstart (hovering for rotorcraft) |
| `triggerSoftCrash(reason)` | 0.4 s fade, respawn 300 m AGL at the same XZ and heading, level, at cruise (hovering for rotorcraft; the wingsuit restarts from a peak) |
| `runAbility()` | the craft ability |

The controller boots straight into the craft's flight model at the spawn: level at its cruise, or
on the ground with "Start on ground", which prefers the nearest discovered site offering a
ground-start spot (an airfield's runway threshold, facing down the runway most nearly into the wind:
`spawns.findGroundStart`). The ground contact is the higher of the terrain and any extra ground
surface (`ctx.groundSurfaces`) at most 12 m above the craft's centre, so a craft lands and parks on
a floating island top but flies freely beneath it. Every airborne reset is trimmed and eases a speed outside
`[1.25 x stall, 0.9 x Vne]` into that range over 0.5 s. Craft switches rebuild the mesh and the
model and respawn at the same place with a sensible state: the helicopter and drone hover, and a
wingsuit below 300 m AGL relaunches from a peak. A craft whose model kind is not registered is
refused with a notice, and a craft that fails to build leaves the previous one flying. On a
controller disconnect in flight, the hands-off hold forces assists to 100 % and holds heading and
altitude. It releases on reconnect, or when another device holds the stick past 35 %
for 0.25 s.

### FlightModel interface (`src/flight/models.js`)

A model is created by a factory registered per kind: `flightModels.register(kind, factory)`. It is
called with `{ profile, craft, world, bus, state, craftState, settings }`, where `profile` is the
`simProfile` (whose `model` field names the kind). Registered kinds are `fixedWing`, `jet`
(SimFixedWing with the jet's own assists), `helicopter`, `wingsuit` and `quad`. `create()` checks this interface:

| member | contract |
| --- | --- |
| `kind` | the model kind |
| `reset(pose)` | `pose = { position, velocity, quaternion, angularVelocity, throttle, onGround, engineOn }` |
| `step(dt, controls, env)` | one tick. `controls` is the shaped ControlState copy (plus `powerLimit` 0..1 for the jet). `env = { time, wind: { vel, turbulence }, groundHeight(x, z), waterLevel, rho, world, craftState, assists, handsOff, autopilot, telemetry }` |
| `state` | `{ position, velocity, quaternion, angularVelocity }`: live and SI; world frame, except the angular velocity, which is in body axes |
| `contact` | the last tick's ground contact: `{ onGround, touchdown: { sinkRate } \| null, bodyStrike: { part, speed } \| null, water, penetration }` |
| `writeTelemetry(flight)` | fills the `state.flight` fields the model owns |
| `snapshot()` / `restore(snapshot)` | plain, serializable state (NaN restore, trim probes, replay) |
| optional `surfaces` | `{ aileron, elevator, rudder, propSpeed, ... }` for the mesh animation (otherwise the stick is shown) |
| optional `flightData` | model-specific values read by the assists and autopilot (airspeed, aoa, load, stall margin, ...) |
| optional `dispose()` | releases model resources |

A soft crash triggers when:

- `bodyStrike.speed` exceeds `limits.bodyStrikeSpeed` (default 5 m/s);
- `touchdown.sinkRate` exceeds `limits.crashSinkRate`;
- a craft that cannot float touches water;
- the penetration exceeds 1 m.

`SimFixedWing` also takes an optional `profile.extension({ profile, craft, bus, craftState, limits,
flightData })`. Its hooks are `shapeControls`, `engine { update, forces, reset }`,
`dragCoefficient`, `moments`, `afterStep`, `reset`, `writeTelemetry`, `snapshot` and `restore`. The
jet flies on it (`jetAero.js`). `profile.vneBasis: 'equivalent'` and `profile.maxSpeed` suit fast
craft.

### Control stages, assists, autopilot and trim

**Control stages.** `flightModels.registerControlStage({ id, order = 50, apply(controls, context) })`
(also `unregisterControlStage`, `controlStages()`). Stages run in ascending order every tick,
before `model.step`. The context is `{ dt, model, craft, craftId, env, autopilot, assists (0..1,
forced to 1 by the hands-off hold), handsOff, telemetry, activeAssists }`. Push the names of assists
acting this tick into `activeAssists`; they appear in `state.flight.activeAssists`. Registered
stages:

- the PID autopilot, order 20 (`autopilot.js`);
- the assists, order 40 (`assists.js`), so the limiters also protect autopilot commands.

**Assists** (`assists.js`). The level is 0..1 per craft (`settings.assists`). Every assist has a
weight that ramps with the level.

- API: `registerAssistCatalog(kind, entries)`, where entries are `{ key, name, from, full }`;
  `registerAssistHandler(kind, { createMemory(), apply(controls, context, weights, memory),
  prime?(memory, trim) })`; `assistWeights(level, kind)`, `describeAssists(level, kind)` and
  `primeAssists(model, trim)`.
- Catalogs per kind:

| kind | 50 % (and ramping in from 0) | toward 100 % |
| --- | --- | --- |
| fixedWing | auto-coordination, auto-trim, stall warning | AoA limiter, G limiter, auto-level, flight-path hold, bank protection, pitch protection, overspeed protection |
| jet (`jetFcs.js`) | auto-coordination, yaw and roll dampers, auto-trim, stall warning | fly-by-wire G command, AoA limiter, G limiter, auto-level, overspeed protection (no attitude limits, so loops and rolls stay possible) |
| helicopter (`helicopterAssists.js`) | trim and stability augmentation, heading hold | attitude limits, torque auto-compensation, auto-hover (plus engine protection, vortex-ring avoidance and autorotation) |
| wingsuit (`SimWingsuit.js`) | stability, terrain proximity warning | auto-level, stall protection |
| quad (`SimQuad.js`) | angle mode (above 35 %) | altitude hold (above 85 %); 0 % is rate (acro) mode |

- At 100 % hands off, fixed-wing craft hold the air-mass flight path within 0.85-1.25 g.

**Autopilot** (`autopilot.js`). It flies through the controls and never sets the attitude. It holds
heading, altitude and speed with PID loops, follows waypoints and rings, and uses a terrain
look-ahead. Other kinds register theirs with `registerAutopilotHandler(kind, { createMemory(),
apply(controls, context, memory) })`. `autopilotHandlerFor(kind)` lets a kind reuse another's (the
jet flies the fixed-wing autopilot). The helicopter, wingsuit and quad have their own.

**Trim** (`trim.js`). After every airborne reset (boot, respawn, airstart, craft switch, tow
release, NaN fallback), the controller calls `trimModel(model, request)`, where
`request = { env, dt, throttle, trim, bank?, load? }`. The result is `{ aoa, elevator, load,
targetLoad, flightPath, bank, speed, stallSpeed, vne, safeSpeed: { min, max }, aoaLimited }`. Then it
calls `primeAssists`. Handlers are registered with `registerTrimHandler(kind, { trim(model,
request) })` (also `hasTrimHandler`, `trimHandlerFor`, `neutralLoad(flightPath, bank)`). The
`fixedWing` and `jet` kinds have trim handlers; other kinds are left as reset.

### Telemetry (`state.flight`, `src/flight/telemetry.js`)

The controller writes it once per rendered frame from the interpolated, safety-checked pose.
Consumers (HUD, instruments, audio, camera, copilot, the harness, and later replay and multiplayer)
read it and never write it.

| group | fields |
| --- | --- |
| identity | `craft`, `tick`, `alpha` |
| pose | `position`, `velocity`, `airVelocity`, `wind`, `turbulence`, `quaternion`, `angularVelocity` (body rad/s) |
| air data | `airspeed` (true), `indicatedAirspeed`, `groundSpeed`, `mach`, `altitude`, `agl`, `radarAltitude`, `verticalSpeed`, `vario` (total energy), `heading`, `pitch`, `roll`, `aoa`, `sideslip`, `gLoad`, `glideRatio` |
| engine | `throttle`, `afterburner`, `engineOn`, `rpm` (0..1 of rated), `rotorRpm` (1 = governed), `torque` (1 = rated) |
| configuration | `flaps`, `flapNotch`, `gear { retractable, down, transit }`, `airbrake`, `brakes`, `trim` |
| state | `onGround`, `contacts`, `stall { warning, stalled, buffet }`, `overspeed`, `crash { active, reason, progress }` |
| assists | `assists`, `activeAssists[]`, `autopilot { enabled, heading, altitude, speed }` |
| landings | `lastLanding`, `bestLanding` (from the `landed` event) |
| craft | `craftState` (below) |

For helicopters, `throttle` is the collective and `rpm` the engine N2; `radarAltitude` is the skid
height; `stall.warning` is the low-rotor-rpm horn.

`craftState` is shared by the ability, the mesh, audio, instruments and the copilot:

- glider: `ballast`, `dumping`;
- jet: `abDetent`, `abRequest`, `afterburner`, `nozzle`, `spool`, `mach`, `overG`, `thrust`;
- helicopter: `hoverHold`;
- wingsuit: `canopy`, `phase` (`flight` \| `deploying` \| `canopy` \| `landed`), `deploy`,
  `brakeLeft` / `brakeRight`, `proximityWarning`, `proximity`, `clearance`, `impactSeconds`,
  `windStreaks`, ...;
- FPV drone: `droneMode` (`rate` \| `angle`), `altitudeHold`, `modeOverride`, `turtle`.

A deployed chute is `craftState.canopy === true`.

### Craft modules (`src/craft/<id>.js`)

Each craft file default-exports a frozen module, and `src/craft/index.js` registers it.
`craftRegistry.register()` checks the required fields (`buildMesh`, `simProfile`, `inputProfile`, `audioProfile`, `cameraRig`, `instruments`, `abilities`, `spawn`, `limits`). The
registry API is `catalog`, `register`, `get`, `has`, `list()` (with `available`) and
`step(id, direction)`.

| field | contents |
| --- | --- |
| `id`, `name` | as in `CRAFT_CATALOG` |
| `buildMesh(ctx)` | returns `{ root, update(visual, dt), wingtips, eyeAnchor, anchors, dispose() }`. The mesh is procedural, low-poly and flat-shaded in the v1 palette, with animated surfaces, prop disc, rotor and gear. `visual = { aileron, elevator, rudder, flaps, throttle, propSpeed, engineOn, onGround, gearDown, airbrake, groundSpeed, time }`. `anchors` are named local points (`towHook`, `smoke`, `tail`, ...). Parts with `userData.hideInCockpit` hide in the cockpit view |
| `simProfile` | `{ model, targets, mass, inertia, centerOfMass, contacts, ... }` plus the model's own blocks: fixedWing `wing, aero, fuselage, tail, controls, flaps, spoilers, gear, engine, ballast`; jet adds `jet, extension, maxSpeed, vneBasis, gEffects`; helicopter `rotor, tailRotor, engine, fuselage, stabilizers, vortexRing, bladeStall`; wingsuit `suit, pitch, roll, yaw, canopy, deploy, radarOffset`; quad `thrustToWeight, motors, motor, aero, controller` |
| `inputProfile` | `{ throttle: 'throttle' \| 'none' \| 'collective' \| 'thrust', antenna?: 'zoom', flapNotches, toeBrakes: 'wheels' \| 'wheelsAndSpoilers' \| 'canopyToggles' \| 'none', spoilers?, rudderSteersTailwheel?, afterburnerDetent?, rates? }` (`rates`: Betaflight `{ rcRate, superRate, expo }` per axis for the quad) |
| `audioProfile` | `{ engine: family, ...parameters }` (below) |
| `cameraRig` | `{ eye, chase, wing, fpv, cockpit }` (below) |
| `instruments` | ordered instrument ids for the panel and HUD (below) |
| `abilities` | `{ craftAbility: { label, initialState?(), run(api), update?(api, dt) } }`. `api = { craftState, craft, telemetry, player, notify(text), relaunch(), emitTrail(kind, anchor, dt) }` |
| `spawn` | `{ cruise (airspeed, m/s), cruiseThrottle? (craft with an engine), hover, relaunch: 'aerotow' \| 'peak' \| 'airstart', respawn?: 'peak', canStartOnGround, runwayLength?, peakDive?: { angle, speed } }` |
| `limits` | `{ vne, vneMach?, gLimit, crashSinkRate, bodyStrikeSpeed?, floats }` |
| `capabilities` (optional) | `{ engine?, chute? }`; otherwise inferred from the profiles (copilot, UI) |

**`cameraRig`.**

- `eye`: `[x, y, z]` body axes.
- `chase`: `{ distance, height, lookAhead, speedRange?: { CRUISE, MAX, TOP } }` (the speeds the pull-back, FOV stretch and shake scale to; v1's `CONFIG.SPEED` by default). It may be an
  object with getters; the wingsuit's widens under the canopy.
- `wing`: `{ position, target }` in body axes. Without it the mount is derived from the right
  wingtip.
- `fpv`: `{ position, uptilt (0-40, default 25), near }`. Its presence makes the first-person slot
  the FPV view.
- `cockpit`: `{ style: 'canopy' \| 'cabin' \| 'bubble' \| 'open' \| 'none', width, sill, floor,
  front, back, roof, panel: { width, center, tilt, layout: [[ids], ...] }, frameColor, stick,
  near }`. All fields are optional, in metres relative to the eye. A craft with an eye but no
  cockpit gets style `none`.

**`audioProfile`** (`src/audio/engines/index.js`). Missing parameters take the family defaults, so
`{ engine: 'jet' }` is enough.

- Common parameters: `airflowSpeed`, `interiorCutoff` (0 means an open
  cockpit), `spatial`, `stallHorn`, `stallAoa`, `stallHornStyle` (`horn` \| `beep`), `touchdown`
  (`wheels` \| `skids` \| `body`), `callouts`, `vario`, `varioLift`, `varioSink`, `motorPitch` and
  `level`.
- Families:
  - `glider`: no engine voice (a sailplane; also the fallback family);
  - `prop`: `cylinders`, `blades`, `maxRpm`, `idleRpm`;
  - `jet`: `whineHz`, `rumbleHz`, `idleSpool`, `spoolUp`, `spoolDown`, `afterburnerRoar`;
  - `heli`: `blades`, `rotorRpm`, `tailBlades`, `tailRatio`, `turbineHz`;
  - `drone`: `motors`, `idleHz`, `maxHz`;
  - `wingsuit`: `flutterHz`, `proximityRange`.

**Instruments** (`src/ui/instruments/index.js`). There are 17 ids: `airspeed, altitude, attitude,
heading, vsi, aoa, g, throttle, flapsGear, rotorRpm, torque, radarAlt, vario, ld, droneMode, glide,
proximity`. A renderer is `{ id, label, draw(pen, source, theme, memory), createMemory?,
update?(memory, dt, source), reset? }`. It draws in a 200 x 200 design box in a `panel` theme (steam
gauge on the cockpit CanvasTexture) and a `glass` theme (HUD tile). Units follow `settings.units`.
Unknown ids are skipped and reported in the camera stats.

| craft | model kind | instruments |
| --- | --- | --- |
| glider | fixedWing | airspeed, altitude, attitude, heading, vsi, aoa, g, flapsGear, vario, ld |
| bushplane | fixedWing | airspeed, altitude, attitude, heading, vsi, aoa, g, throttle, flapsGear |
| jet | jet | airspeed (with the Mach window), altitude, attitude, heading, vsi, aoa, g, throttle (with the afterburner range), flapsGear |
| helicopter | helicopter | airspeed, altitude, attitude, heading, vsi, rotorRpm, torque, radarAlt, throttle |
| wingsuit | wingsuit | airspeed, altitude, heading, vsi, glide, proximity |
| fpv | quad | throttle, droneMode, airspeed, altitude, attitude, heading, vsi |

### Camera (`ctx.systems.camera`)

It keeps v1's API: `update`, `setPhotoMode`, `shake`, `snap`, `getMode()` (`chase` \| `photo` \|
`returning`) and `setFreeCameraPose`. It adds:

- `getView()`: `chase` \| `cockpit` \| `wing` \| `flyby` \| `fpv`.
- `setView(slot)`: `chase` \| `cockpit` \| `wing` \| `flyby`. `cockpit` is the first-person slot,
  which becomes `fpv` when the craft has `cameraRig.fpv`. The choice is saved per craft in
  `settings.views`, and a third-person one also in `settings.thirdPersonViews`.
- `cycleView(direction)` and `listViews()`.
- `toggleFirstThirdPerson()` (the `viewToggle1P3P` action), `isFirstPerson()` and
  `getLastThirdPerson()`.
- `getLook()`: `{ yaw, pitch, snapYaw }` in degrees.
- `getStats()`: view, slot, first person, last third-person slot, lens, zoom, FPV uptilt, hidden
  parts, cockpit, HUD, glass HUD, reticle, flyby and instrument timings.
- `debug.previewCockpit(descriptor)`: dev builds, `?debug=1` or `?test` only.

Behaviour:

- First person is the cockpit (the FPV camera on the drone, the helmet view on the wingsuit);
  third person is chase, wing and flyby. `viewCycle` steps chase, cockpit, wing, flyby;
  `viewToggle1P3P` cuts at once between first person and the craft's last third-person view (the
  chase rig keeps integrating while detached, so it is already in place); the stick hat keeps its
  snaps (`viewForward` cockpit, `viewBack` chase, `viewLeft` / `viewRight` look 90 degrees).
- Each craft starts in its remembered view (chase on a first launch: the golden-hour opening
  shot), and a craft change flies the new craft from its own view. A `settings.views` change for
  the active craft from another channel (WREN) switches the view.
- The chase view is v1's rig: critically damped lag, 60 % of the bank, a look-ahead and the FOV
  stretch with speed.
- Free look reads `lookX` / `lookY`: head pan in the cockpit, an orbit in chase and a small offset
  elsewhere.
- Each view takes its FOV from `settings.fov`. The chase view keeps v1's speed stretch and is
  exactly v1 at the default 60.
- An `inputProfile.antenna` of `'zoom'` narrows the lens by up to 3x.
- The instruments redraw at 30 Hz, onto the cockpit panel texture and the optional instrument
  overlay (and the glass HUD's attitude indicator).
- **Glass HUD** (`src/ui/glassHud.js`, updated after the camera pose is final). Every
  third-person view shows it: v1's flight card (airspeed, altitude, AGL and vertical speed in
  `settings.units`, the throttle bar) and compass, a compact attitude indicator (`state.flight`
  pitch and roll), a stall / AoA warning (`state.flight.stall` and `aoa`; on the helicopter the
  stall lamp is the low-rotor-rpm warning), and the flight path marker. The marker is drawn where
  `state.flight.airVelocity` points, projected 1500 m ahead of the craft, next to a nose mark
  projected along the craft's axis: sideslip shows as a lateral offset, angle of attack as a
  vertical one. Off screen it pins to the edge and dims; below 5 m/s it hides. A first-person view
  with an instrument panel shows the glass HUD only with `hud.cockpitGlass`; the panel-less first
  person views (FPV camera, wingsuit) keep it. A warning keeps an idle HUD awake.
- **Views never touch the physics.** The camera writes no ControlState and no model state. Free
  look is its own ControlState axes (`lookX`, `lookY`), which no flight model, control stage or
  assist reads; the HOTAS antenna is flaps on fixed-wing craft (read by SimFixedWing in every view)
  and only a lens zoom on the craft whose `inputProfile.antenna` is `'zoom'`. The fixed 120 Hz
  clock makes the flight depend on the tick count only, never on how fast a view renders.
  `tools/steps/view-physics.json` checks it: every craft flies the same keyboard and free-look
  script from the cockpit, from chase and while switching views with V and C, from a start the
  craft is rebuilt at for each run, and the trajectories must agree at every tick (they are
  bit-identical; a 0.1 % rudder leak in one view shows as 0.7 mm to 15 cm).
- The FPV view reads its uptilt, and SimQuad its rate curve, from `settings.fpv` live, over the
  craft profile values.
- **Turbulence shake** (`turbulenceShake.js`). After the view writes its pose, the WindField's
  turbulence at the craft (`state.flight.turbulence`) rotates the camera a little: pitch, yaw and roll
  from 2-9 Hz multi-sine noise that runs faster with airspeed. The amount is
  `turbulenceResponse(turbulence, airspeed)` (`src/core/turbulence.js`): zero up to 0.2 (the Phase 1
  field's ordinary chop stays under it, so quiet flight and the opening shot are untouched), then
  rising with the square, harder at speed. Per view: cockpit 1.35, FPV 1.1, wing 0.8, chase 0.75,
  flyby 0 (degrees at full response, times up to 0.9 pitch, 0.55 yaw, 1.2 roll). It eases in fast and
  out slowly, stops while paused, and is off in photo mode and during a return flight. The next
  camera update takes the rotation back off first, so it never accumulates and never touches the
  flight. `getStats().turbulenceShake` is `{ amount, peak }`.

### Audio (`ctx.systems.audio`)

- **v1 API**: `update`, `unlock`, `chime`, `blip`, `flutter`, `getStats`.
- **v2 additions**:
  - `getBus(name)`: the input GainNode of `master`, `engine`, `environment`, `ui`, `copilot` or
    `music`, or null before audio starts;
  - `getContext()`;
  - `setVarioMode('on' \| 'off')` and `getVarioMode()`;
  - `debug` (dev builds, `?debug=1` or `?test` only): `setProfile`, `drive`, `cue`, `refresh`, and
    `spawn` (auditions: `play`, `place`, `intensity`, `trigger`, `stop`, `stopAll`, `voice`,
    `voices`, `stats`, `thunder`, `thunderLog`, `chime`, `setBudget`, `render`);
- **Phase 2 spawn sound** (`spawnVoices.js`, `recipes/`):
  - `spawnVoice(recipe, params)` returns `{ id, recipe, setPosition(vec3, velocity?),
    setIntensity(0..1), trigger(name, options), dispose(), realized, disposed, describe() }`. It
    works before audio starts. Recipes: `tornado`, `thunder` (trigger `strike`), `volcano`
    (`boom`), `geyser` (`burst`), `waterfall`, `whale` and `skyWhale` (`call`), `crystal`
    (`chime`; the hum rises with the intensity), `turbine` (intensity = wind speed), `murmuration`
    (`scatter`), `meteor` (`streak`, `fireball`), `lantern`, `discovery` (`chime`). A preset's
    `audio.params` may set `intensity` and override `refDistance`, `rolloffFactor`,
    `distanceModel`, `size` and `reverb`;
  - `thunder({ position, intensity })` plays a crack and a rolling rumble when the sound front
    (343 m/s) reaches the listener, who may move meanwhile;
  - `discoveryChime({ bus?, position?, pan?, volume? })`; a typed `discovery` event with a
    `presetId` plays it too (once, however it is asked for);
  - `spawnRecipes`: the recipe names.
- **Spawn voice budget.** At most 10 voices have nodes at once; the quietest (recipe level x
  intensity x distance gain) are culled to silent virtual voices and come back when they are
  louder than a sounding one. Voices sit on the environment bus behind a submix that takes the
  closed-cockpit low-pass, so ducking and the mixer apply.
- **Unlock.** The AudioContext is created only inside a real user activation (the first key,
  pointer press or touch). A gamepad press also tries. If audio stays suspended, the sound pill
  offers a click to enable it.
- **Mixing.** Every bus except the copilot ducks while WREN speaks. Photo mode dips the master, as in
  v1, and the soft crash muffles it.
- **Sources.** Engine synths follow the craft `audioProfile` and `state.flight`. External views are
  spatialised with doppler; cockpit and FPV views get the interior low-pass.
- **Turbulence rattle** (`turbulenceRattle.js`, environment bus). The same `turbulenceResponse` as
  the camera shake drives a bright rattle (band-passed noise chopped at 9-17 Hz) and a low airframe
  thump. Inside a closed cockpit the rattle is close and clear; outside it is a faint buzz under the
  thump. Silent at zero turbulence and through the calm-air floor, in photo mode and while paused.
  `getStats().turbulenceRattle` is `{ amount, interior, rattle, thump, levels }`.
- **Typed events consumed**: `viewChanged`, `craftChanged`, `landed` and `softCrash`.

### WindField (`ctx.wind`, `src/env/WindField.js`)

| member | what |
| --- | --- |
| `sample(pos, t, out?)` | `{ vel: Vector3 (m/s), turbulence: 0..1 }`: ambient wind (seeded, veering with height), ridge lift from the shared height gradient, seeded thermals (midday-strong, off at night, leaning downwind, with a sinking ring), turbulence (wind speed and low AGL), plus registered sources. Craft compute airspeed as `velocity - vel` |
| `probe(pos, t?, out?)` | the same query without touching `lastLayers` (overlays, many-point probes) |
| `addSource({ id, bounds, sample(pos, t), kind? })` | Phase 2 writers. `bounds` is `{ min, max }` or `{ center, radius }`. `sample` returns `{ vel?, turbulence? }` or null. Velocities add; turbulence takes the maximum. Sources are found through a spatial hash. Emits `windSourceAdded` |
| `setSourceBounds(id, bounds)`, `removeSource(id)` | moves a source, or removes it (emits `windSourceRemoved`). `setSourceBounds` rewrites the box in place and refiles the source only when it covers other hash cells, so an engine may move a source every frame without allocating |
| `sourceCount`, `listSources()` | registered sources |
| `thermalsNear(x, z, radius, visit, t?)`, `nearestThermal(pos, minStrength?)` | thermal queries (cloud caps, copilot lift hints) |
| `ambientAt(pos)` | `{ speed, fromDegrees }` |
| `lastLayers` | per-layer values from the craft's last sample |

The flight model feels all of it every tick. `createDebugUpdraft({ id, center, radius, strength })` builds the dev source
that `src/dev/debugWind.js` drops with the L key.

### Spawns (`ctx.systems.spawns`, `src/spawns/`)

The Phase 2 contracts (sections 3 and 4 of `docs/specs/phase2-contract.md`) are implemented here.

- **System API.** `update`, `prewarm` (starts it), `register(engine)`, `activate(presetId, opts)`,
  `deactivate(id, reason)`, `getActive()`, `getInstance(id)`, `getStats()`, `setSiteFeed(feed)`,
  `director`, `getNearby(radiusKm)`, `forceSpawn(presetId, { distance, force })` (ahead of the
  craft; through `director.forceSpawn` for the director's own presets, straight through the manager
  for presets added with `debug.addPreset`), `pointAhead(distance)`, `findGroundStart(x, z,
  { maxDistance })` (the ground-start spot of the nearest discovered site within 80 km that offers
  one, facing most nearly into the ambient wind; "Start on ground" uses it) and `manager` (the
  SpawnManager). In dev builds and with `?debug=1` or `?dev=1`, `debug`: `addPreset`,
  `removePreset`, `registerEngine`, `unregisterEngine` and `loadTestKit()` (dev builds only).
- **The director.** `start()` (the prewarm hook) creates the event director once the manager runs:
  `createGameDirector(ctx, { spawnManager, presets: PRESETS, placement, isDiscovered, budgets:
  manager.budgets, devHooks })`, where `placement` reads whichever site feed the manager holds and
  `isDiscovered` is the manager's. The system calls `director.update()` every frame; the director
  ticks at 2 Hz on the flight clock. A director that fails to start or throws is logged and
  stopped; the spawns carry on without it.
- **Site feed.** `{ sitesInCell(cellX, cellZ) }` (cached arrays, 2 km cells; read in time slices,
  48 cells a frame, over the largest site `lod.far`) or `{ sitesNear(x, z, radius) }` (read once per
  sweep). A site within its preset's `lod.far` is activated with source `site`; it is removed past
  `lod.far + lifetime.despawn.hysteresis`.
- **Activation.** `activate(presetId, { position, heading (compass degrees), source: 'site' |
  'director' | 'debug', site?, seed?, scale?, force?, duration?, params? })` returns the spawn id or
  null. `params` (`{ [engine name]: { ... } }`) is merged over that engine entry's preset params for
  this activation only: the set-piece engine places and tunes its children this way.
  `canActivate(presetId, source)` names the refusal: `preset`, `engine` (not registered or failed to
  initialise), `capacity` (512 spawns), `heavy` (the heavy limit, 2; sites are never refused for it
  and count toward it only while `setSiteActive(id, true)`), `instances` or `particles` (per-engine
  caps from `engine.budget` `{ instances, particles, lights? }`, else the engine's entry in
  `DIRECTOR_BUDGETS.engines`, else 32 instances and 60 000 particles; `setBudget`, `setHeavyLimit`).
  A debug activation with `force: true` passes the budgets. Each preset engine entry becomes one
  engine instance (a part) created with the preset's params merged with `{ position, heading, site,
  startTime, scale, duration, seed }` and its own seeded random generator. `opts.duration` (the
  director draws it) is the event's duration; without it the manager draws one from
  `lifetime.duration`.
- **LOD.** The tier comes from the camera distance to the spawn's anchor and `preset.lod`, moving out
  past `boundary * 1.08` and back in below `boundary * 0.92` (`LOD_HYSTERESIS`). Engines hear
  `setLOD(instance, tier)` at creation and on every change. `setLodBias(bias)` (0 < bias <= 1)
  multiplies `lod.near` and `lod.mid` for every spawn: the director's load shedder sets 0.7 and 0.5
  under load, so spawns step to their cheaper tiers sooner; `getLodBias()` and `getStats().lodBias`
  read it.
- **Lures** (`lure.js`). Heavy presets with `lure` get a FAR silhouette: plume (volcano, leaning into
  a drifting umbrella, lava glow at night), anvil (supercell: cauliflower tower, flat base, rain
  shaft, anvil and overshooting top, lightning flashes at night), funnel (tornado with wall cloud and
  debris), whale (sky whale, facing its heading, tail beat), islands (three floating islands with
  trees and waterfalls) and comet (self-luminous head and tail pointing away from the sun). One
  instanced mesh of camera-facing quads draws them all, fading in over 1.2 s at the FAR tier. A lure
  beyond 92 % of the fog's far distance is drawn at that distance, scaled to keep its direction and
  angular size, so it stays inside the camera's far plane; terrain nearer than that hides its foot
  through the depth test, and the nearly fully fogged terrain behind it is drawn over. The material
  ignores fog and is shaded from the sky itself (`sky.skyColorNode`): zenith ambient, the sun on its
  sunward side, a silver lining against the sun, and aerial perspective toward the sky colour in its
  own direction (more at its foot). Render order 1: after the water, before the near effects.
- **Lifetimes.** An event ends when an engine sets `instance.ended` (`ended`), 45 s after its drawn
  duration (`expired`), past `lod.far * 1.08` (`range`), or beyond `despawn.distance +
  despawn.hysteresis` after `despawn.outOfViewSeconds` out of view (`despawn`). Debug spawns follow
  only the first two.
- **Discovery.** A spawn within `discovery.radius` that is in view (inside the camera's view cone,
  the frustum's four side planes, at any distance; and not hidden by visible terrain: the sight line
  to the middle of its lure or body is sampled 10 times out to the fog's far distance) emits the
  typed `discovery` once per site id or event preset per world. `markDiscovered(keys)`, `isDiscovered(key)` and `getDiscovered()` let the
  journal restore and read it. Visibility checks run round-robin, 2 a frame, only for spawns that
  still need one, and at most every 30 frames per spawn.
- **Real lights** (`lightPool.js`). The pool holds as many PointLights as the registered engines
  declare in `budget.lights`, capped at 4 (`MAX_REAL_LIGHTS`), sized when the manager starts behind
  the loading fade (an engine registered later grows it). Its lights stay in the scene for the whole
  session, parked at intensity 0 while free, because adding or removing a light rebuilds every lit
  material's shaders; with no engine declaring lights the scene has none. `ctx.lights.acquire(priority,
  onRevoke?)` / `release(light)`; a holder that passed `onRevoke` can lose its light to a higher
  priority. Lights a disposed spawn still holds are released and reported.
- **Engine ctx.** `{ scene, camera, renderer, backend, THREE, TSL, wind, audio, terrain: { heightAt,
  groundHeight, biomeAt, waterLevel }, time, sky, bus, perf, settings, state, uniforms, budgets,
  lights, pools, spawns, surfaces, weatherState, registerPrewarm, water }`. `surfaces` is the game's extra ground
  surfaces (landable tops; null in a lab without them), `weatherState()` returns the player's
  regional weather state (`clear` | `building` | `storm` | `clearing`, or null without a weather
  system; it allocates, so engines call it at create and follow the typed `weatherChanged` after,
  which reports changes only). `budgets` is read-only (`heavyLimit` / `maxHeavy`, `heavyActive`,
  `maxRealLights`, `lightsLimit`, `lightsActive`, `engines` (every engine's live `{ instances,
  particles }` caps), `instanceLimit(name)`, `instances(name)`, `particleLimit(name)`,
  `particles(name)`); the director reads this same view, so the two never disagree; `pools` has `scratch` (Vector3 / Quaternion / Matrix4 / Color rings),
  `createSlotAllocator`, `createObjectPool`, `createInstancedPool` and `createMeshPool`; `spawns` is
  the SpawnManager (the setPiece engine orchestrates through it). `registerPrewarm(object3D)` (null in the headless
  lab) registers a mesh from `init()` for core's pipeline prewarm, so it is drawn once behind the
  loading fade: the first spawn costs no pipeline build, and lazily counted geometries are in the
  memory baseline before any dispose check. `water` is the water effects layer (below; null where the water
  system is absent).
- **Water effects layer** (`src/render/waterEffects.js`, `ctx.systems.water.effects`, the engine
  ctx's `water`). Local water deformation and shading on the v1 ocean, shared by every spawn: a
  toroidal 640 m trail buffer (bioluminescent excitation and foam) that the craft writes through a
  contact query against its telemetry and that engines write through mark descriptors (`createMark`
  with `disturb`, `trail`, `foamRing`, `ripple` and `splashMark`; numeric shorthands such as
  `addWaterDisturbance` and `splash` for one-off writes); ripple rings; up to 4 whirlpool vortices,
  4 glow regions and 4 pool discs (slot API with descriptors); and one instanced spray-droplet batch
  (`createSpray` / `emitSpray`). Its frame work allocates nothing (typed-array state, no doubles
  across non-inlined calls, splashes queued for the hot update). `surfaceHeightAt(x, z)` adds the funnels to sea level. With nothing registered and an
  empty trail buffer every added term is zero, so the ocean renders as in Phase 1. The full API is in
  docs/engines/waterEffect.md.
- **Fauna and water engines (wave 2).** `fauna` (instanced boids: murmuration, flock,
  formation with the formation-slot API, circling in thermals, whale pod, wingman, drift with a
  slipstream; docs/engines/fauna.md) and `waterEffect` (whirlpool, splash, spray, bioluminescence,
  plunge pool on the water effects layer; docs/engines/waterEffect.md).
- **Mesh lifetime in three r184.** A RenderObject listens for its material's `dispose` event, which
  keeps it, its mesh and its geometry alive until that material is disposed. A new Mesh per spawn
  instance on a shared material therefore leaks about 8 KB per instance even after its geometry is
  disposed. Engines pool meshes on shared materials (`createMeshPool`, `createInstancedPool` built in
  `init`) or give a per-instance mesh its own material and dispose it with the instance.
- **Optional engine hooks.** `groundStart(preset, params, site)` returns ground-start spots
  `[{ x, z, y, heading, runwayLength }]` or null, pure from the site's resolved stamps (the
  structure engine's airfield); `setParam(instance, name, value)` sets a live param and returns
  whether it is known (a set piece's ramps). An instance may also expose live numbers directly as
  `instance.params` (the structure engine) or `instance.control` (the vortex engine), which a set
  piece writes without a call. Engine-specific bus events are namespaced (`structure:gate`,
  `structure:course`, `structure:landing`, `setPiece:stage`, `setPiece:narrate`, `setPiece:ended`);
  the references are in `docs/engines/`.
- **Clean-up.** After `dispose(instance)` the manager removes any wind source still listed in
  `instance.windSourceIds` and releases any real light the spawn still holds, and reports each as a
  leak (`console.error`, `getStats().leaks`).
- **Memory accounting.** `renderer.info.memory` (geometries, textures, attributes, programs, total
  bytes) and the JS heap (`performance.memory`, Chrome) are read before each create, after it, and
  after each dispose: `getStats().memory` has the baseline (after the engines initialised;
  `resetMemoryBaseline()` moves it), the current reading, the create and dispose counts and a log of
  the last 64 spawns.
- **No allocations per frame.** The update keeps every per-spawn double in typed arrays, passes no
  double across a call V8 may not inline (it would box it), avoids `Math.hypot`, builds the view cone
  from the camera's own position, quaternion and lens, and reads the site feed's cached cells. The
  only garbage its frames cause is the terrain height the occlusion rays sample (worldgen's noise),
  which is why those rays are rationed.
- **Stats.** `getStats()`: spawns, sites, events, heavy and its limit, tier counts, per-engine
  `{ instances, particles, lights, buffers, drawCalls, active, budget, failed }` and totals, the light
  pool, the lures, discoveries, counters, refusals, leaks, memory and the site feed.
  `window.DRIFTWING.getStats().spawns` carries it.
- **Wind engines (wave 2).** Each engine has a reference page for preset authors in `docs/engines/`.
  - `vortex` ([vortex.md](engines/vortex.md)): up to 4 vortices share one shell mesh and one
    instanced sprite (2 draw calls in all); their motion is computed in the vertex shaders from a
    per-slot uniform block, the same on WebGPU and WebGL2, so a spawn uploads no buffers and adds no
    GPU memory. Lifecycle forming, mature, ropeOut, dissipated (then `ended`); a seeded track over the
    terrain precomputed at create. One `rankine` WindField source per vortex, removed at FAR when its
    inflow radius cannot reach the player there.
  - `windModifier` ([windModifier.md](engines/windModifier.md)): up to 8 WindField sources per
    instance (updraft, downburst, wake, jetStream, slipstream, waveLift, gustFront, curtain) with
    fades, start / stop windows, strength timelines, drift or `follow` a sibling part, and the
    `control.strength` / `control.strengths[i]` hooks; no visuals.
  - Both refuse a param their type does not have, naming it, so a preset typo never passes silently.
  - Their sources (`src/spawns/engines/windSources.js`) sample into one reused result and move with
    `setSourceBounds`: the engines' frames allocate nothing (`tools/lab/wind-engines.mjs`).
- **Weather and sky engines (wave 2).**
  - `weatherVolume` ([weatherVolume.md](engines/weatherVolume.md)): forms tower, cumulus, lens, bank,
    sheet and mist from instanced puffs in the v1 look (one shared mesh), rain, snow and dust shafts,
    distance compression of masses beyond the fog (direction and angular size kept, so an anvil reads
    at 30+ km before its lure takes over), an inside-fog sky modifier (priority 15), a veil, local
    streaks and canopy rain in the cockpit and FPV views, and one WindField source per volume
    (turbulence, updraft, shaft downdrafts and outflow, lens waves), removed at FAR and on dispose.
  - `celestial` ([celestial.md](engines/celestial.md)): meteors, comets, the eclipse (a priority-30
    sky modifier that really darkens the sun, sky, fog and lights; `wildlifeQuiet` through totality),
    the glory and full-circle rainbow on every cloud (`uniforms.cloudGlory` / `cloudBow`), rainbows in
    mist and static sky values; sky objects on a shell at 96 % of the camera's far plane.
  - Both engines build every GPU resource in `init()` and give an instance only slots, so `dispose()`
    returns `renderer.info.memory` exactly; they write their instance buffers in place through
    persistent update ranges (no allocation per frame). They key their once-per-frame work on
    `state.frame`, so a second update of the same instance in one frame is skipped.

### Performance (`ctx.perf`, `src/core/perf.js`)

- **Frame loop.** Rendering is uncapped through `setAnimationLoop`.
- **Frame target.** On `auto` it is the measured display refresh; readings outside 45-360 Hz are
  recorded but not adopted, and 60 Hz holds until the running vsync estimate proves the rate. It
  is explicit on 60 / 120 / 144 / 240. `uncapped` only defends 30 fps.
- **Stage one, dynamic resolution.** It steps the scene pass through `1, 0.9, 0.8, 0.7, 0.6` with
  asymmetric thresholds, dwell times and growing blocks after a failed up-step. The block lifts
  early once the load has clearly dropped. Bloom, grade and grain stay at full resolution.
- **Stage two.** v1's quality governor (view distance, densities, pixel ratio) acts only when the
  scale is pinned.
- **Load shedders (Phase 2), before stage one.** `addLoadShedder({ id, shed() -> boolean, restore() })`
  returns `{ remove() }`. When frames stay over the target for the step-down dwell, the governor asks
  the shedders in registration order to shed one level each time, and steps the render scale down
  only when none can shed more. With headroom it climbs the scale back to 1 first and then restores
  the shed levels, last first; a restore that has to be shed again within 4 s blocks further
  restores for a growing time, like a failed scale up-step. They also act with dynamic resolution
  off. With no shedder registered stage one is exactly Phase 1's (`tools/lab/director.mjs` replays
  load traces against the `v2-structure` governor). A shedder that throws is logged and removed.
- **Headroom.** `getHeadroom()` returns `{ missing, ratio, shedDepth }` (a reused record): `missing`
  while the control frame time is over the step-down threshold of the target (only while the game
  runs), `ratio` = control frame time / target.
- **API**: `update`, `setMeasuredRefresh`, `measureDisplayRefresh`, `refreshRenderScale`,
  `getRenderScale`, `getBasePixelRatio`, `beginCapture`, `snapRefreshRate`, `addLoadShedder`,
  `removeLoadShedder` and `getHeadroom`. The post stack adds `setRenderScale` / `getRenderScale`.
- **State.** `state.perf` holds fps, frame times, the target and refresh values, render scale,
  quality, `shedDepth` and `shedHistory`. `perf:renderScale` fires on each scale step and
  `perf:loadShed` on each shed or restore.

### Sky modifiers (`ctx.systems.sky`, `src/render/sky.js`)

`sky.addModifier(id, { priority })` returns `{ set(values), remove() }`. `set` takes any of
`sunIntensity`, `ambient`, `fogDensity` (multipliers, 1 = unchanged), `darkness` (dims the sky and
every light), `overcast` (hides the sun disc, god rays, moon, stars and aurora behind cloud),
`stars` (raises the star field, for an eclipse), `fogColor` / `fogColorAmount` and `skyTint` /
`skyTintAmount` (a `THREE.Color` or `0xRRGGBB`, mixed in at the amount while keeping the luminance
of what they tint), `flash` (0..1) with `flashColor` (a lightning strike: the one brightening
field, it adds its colour to the palette and the fog colour and lifts the hemisphere light; the
strongest flash wins), and `weight` (0..1, default 1, eases the whole modifier). Fields left out
keep their value; a duplicate id or a non-finite value throws.

Each frame the modifiers fold in priority order (lowest first): multipliers multiply, darkness and
overcast stack like filters, stars takes the maximum and the tints composite over each other. Each
value is eased from neutral by its modifier's weight. The result acts on the CPU side only: the
four palette colours the dome, the fog node and the fog colour derive from, the glow, the sun disc,
the god rays, the moon and stars, the fog distances and the sun, moon and hemisphere lights. No
shader changes, so with no modifier weighing in (none registered, weight 0 or neutral values)
every colour takes exactly the Phase 1 path. `tools/steps/golden-frame.json` renders the same still
frame with the weather's clear-sky modifier and after removing it, and the two are pixel-identical
on both backends. `getModifierState()` returns the folded values for the debugger and tests.

Priorities in use: the weather 10, the weather volumes' inside fog (`weatherVolume`) 15, an
emitter's immersion (inside an ash plume) 20, a lightning flash 30, and the celestial engine's
eclipse, fireball flashes and static sky values (`<id>:celestial`) 30.

Effects that place themselves in their vertex shaders (the spawn particles and glow points) draw
their own fog with the scene's: `sky.fogAmountNode(offset)` is the scene fog's haze (0..1) for a
world offset from the camera, built by the same function as `scene.fogNode`, and
`sky.skyColorNode(direction)` the sky colour to haze toward.

`getModifierLevels()` returns the live folded record itself (no copy, read only), for systems that
follow the sky every frame: the cloud palette (`cloudShading.js`) reads it, so the v1 clouds take a
storm's darker blue-grey undersides and an eclipse's darkness, and with nothing weighing in keep their
exact look (an A/B of the old and new cloud module in one page is pixel-identical at golden hour,
noon, low sun and night, on both backends). `SUN_ANGULAR_RADIUS` and `CELESTIAL_POLE_ELEVATION_DEG`
are exported for the celestial engine.

### Regional weather (`ctx.systems.weather`, `src/spawns/weather.js`)

`createWeatherModel(seedHash)` is pure: `sampleRegion(rx, rz, time, out)`, `sampleAt(x, z, time, out)`
(the state of the region holding the point, with `storminess` and `golden` blended smoothly between
the four nearest region centres), `stateAt(x, z, time)` and `regionOf(coordinate)`. `time` is the
flight clock, `state.time.elapsed`.

- **Layout.** Regions of 12 km, buckets of 150 s, cycles of 8 buckets (20 min) per region with a
  seeded per-region offset. A cycle is stormy with chance 0.7 and then ends with one building
  bucket, one or two storm buckets and one clearing bucket, so the order clear -> building ->
  storm -> clearing -> clear always holds and every (region, bucket) state is a pure function of
  the seed. The offset keeps the first bucket of every flight clear: the golden-hour opening is
  always clear weather.
- **Why these values.** Across 3600 regions and 24 h: clear 69 %, building 9 %, storm 13 %,
  clearing 9 %. Of 20-minute flights, 82 % (glider), 88 % (bush plane) and 98 % (jet) meet a storm;
  of 30-minute flights, 70 %, 76 % and 98 % meet all four states (`tools/lab/director.mjs`).
- **Levels.** Storminess rises to 0.7 through building, to 1 early in the storm and back to 0
  through clearing; `golden` peaks halfway through clearing.
- **The system** (created after `sky`, updated right before it) samples the model at the player,
  eases the sky toward it (8 s; a teleport snaps), drives the `weather` sky modifier (a storm:
  sun x0.3, fog density x2.8, darker bluer-grey sky and fog, overcast; clearing: the sun breaks
  through with a golden sky and fog; clear: weight 0) and emits `weatherChanged`. API: `model`,
  `getState()`, `dispose()`, and `forceState(state | null, progress, { snap })` in dev builds and with
  `?debug=1`.

### Event director (`src/spawns/director.js`)

`createDirector(options)` takes its inputs as functions and objects so the lab can run it headless;
`createGameDirector(ctx, { spawnManager, presets, placement?, isDiscovered?, budgets?, devHooks? })`
wires it to the game (the flight clock, `state.player`, `state.time`, the camera frustum, the weather
model, the world's `heightAt` / `biomeAt`, `ctx.perf` and the bus). The spawns system creates it
once its SpawnManager runs and calls `update()` every frame; it ticks at 2 Hz on the half second of
flight time. It is `ctx.systems.spawns.director`.

- **Pacing.** The drought clock restarts on a discovery, a spawn coming into view
  (`spawns:inView`, or `spawns:siteInView`), an activation and every tick a spawn the director started is in view. At a
  seeded 60-70 s it activates the best eligible candidate ahead, 3-8 km out, of the common tier or a
  due tier; from 75 s uncommon too, from 80 s rare too and up to 60 degrees off the heading.
- **Rarity.** Per-tier due times drawn from common 150-300 s, uncommon 600-900 s, rare
  1800-3600 s and legendary 3600-7200 s; per-preset cooldowns (common 150 s, uncommon 1200 s,
  rare 2700 s, legendary 5400 s, or the preset's own `cooldown`); never the same preset twice in a
  row.
- **Ahead.** Scheduled activations within 45 degrees of the heading, inside the preset's
  `filters.minDistance` / `maxDistance` band (default 3-8 km); never behind.
- **Near a landmark.** `filters.near: { landmarks: [types], radius }` (types from `arch`,
  `monoliths`, `lighthouse`, `balloons`; radius up to 20 km) moves each candidate onto the nearest
  Phase 1 landmark of those types within `radius` of its seeded point (through
  `world.landmarkSitesNear`, cached per candidate), before the distance and heading rules see it; a
  candidate with none in reach is rejected as `near`. The sky lantern festival uses it to rise at a
  lighthouse or a balloon fair.
- **Budgets.** In the game the director reads the SpawnManager's budget view (`manager.budgets`):
  the heavy limit (2), every engine's caps (from `engine.budget`, else `DIRECTOR_BUDGETS.engines`)
  and the real-light cap (4). The lab runs on `DIRECTOR_BUDGETS` itself (8 real lights). Particles
  count as full at 85 % of the cap, and a lighting preset needs 2 lights free. A refused activation
  leaves its candidate alone for the rest of its bucket.
- **Lifetimes.** An event ends when its engine sets `ended`, or at its seeded duration plus 60 s;
  beyond `despawn.distance + hysteresis` and out of view for `outOfViewSeconds` it is despawned.
- **Load shedding.** The director registers the shedder `director`: level 1 defers heavy
  activations, levels 2 and 3 set `spawnManager.setLodBias(0.7)` and `(0.5)`. A level that would take
  nothing away is refused (no heavy candidates and no live spawns for level 1, no live spawns for
  levels 2 and 3, from `spawnManager.spawnCount()`), so with no content the governor behaves as in
  Phase 1. A headroom miss defers heavy activations too.
- **Site active states.** A site preset with `activeState: { duration }` (the volcano's eruption)
  gets bucketed candidates at its sites from `placement.sitesNear`; the director activates one with
  `spawnManager.activate(presetId, { source: 'director', site, ... })`.
- **API.** `getNearby(radiusKm)` returns `[{ id, name, category, distance (m), bearing (deg), state
  (active, dormant, site or discovered), etaSeconds }]`, nearest first; `getState()` for the
  debugger (drought, pacing record, budgets, heavy count, shed level, tier due times, cooldowns,
  candidates with their rejection reasons, active spawns, the last 50 log entries and the log hash);
  `getLog()` (every `{ time, presetId, candidateId, reason }`); `hasPreset(presetId)`;
  `forceSpawn(presetId, { distance, bearingOffset, force })` in dev builds and with `?debug=1` or
  `?dev=1`; `shedder`; `dispose()`. Sites of presets it does not know (the terrain test's fixtures)
  are left out of `getNearby`.
- **SpawnManager calls.** `activate(presetId, { position: { x, y, z }, heading, source, seed,
  duration, site? })`, `deactivate(id, reason)` with reasons `lifetime`, `despawn` and `dispose`,
  `getActive()`, `getInstance(id)` (`anchor`, `radius`, `heavy`, `ended`), `getStats()` as
  `{ engines: { name: { instances, particles } }, total: { lights } }`, `setLodBias(bias)`,
  `spawnCount()`, and `canActivate`, `getSiteSpawn` / `setSiteActive` when offered.

### UI (`ctx.systems.ui`)

The UI system offers `update`, `toast`, `setSubtitle`, `setMicState`, `showPanel`,
`togglePanel(id)` (panels include `settings`, `journal`, `map`, `help` and `controls`), `setPhotoMode`,
`wake` and `openControls({ calibrate })`. It also exposes the v2 chrome objects `craftPicker`,
`settingsPanel`, `controlsPanel`, `statusBadge`, `seedLinks`, `worldMap` and `discoveryToast`.

- **Discovery loop (Phase 2, Milestone F).** A spawn discovery (the SpawnManager's typed
  `discovery` with a `presetId`) is recorded by the journal (`recordSpawnDiscovery`: name, category,
  kind, seed, coordinates, time of day, first-seen date, the preset's `journal.description`); the
  audio system plays the chime, and the journal's `journal:discovery` raises the discovery card.
  The journal restores its discoveries into the manager (`markDiscovered`), so they never fire
  twice in one world. The collection count is found / total over the manager's preset registry
  (`listPresets()`, which is `PRESETS` in a player's build). `journalStat` and `achievement`
  events fold into the global records (`driftwing-v2.records`); achievements and bests are shared by
  every world, discoveries belong to their seed.
- **World map** (`worldMap.js`). A panel like the others, so the flight goes on. Tiles come from
  `createMapTileService` at 128 samples a side, 1 km to 256 km per tile (the level whose tiles show
  about 256 px wide), a memory LRU of 220 decoded tiles over the worker's IndexedDB cache, and a
  coarser cached tile stands in while a tile is built. Only journal entries appear: sites among the
  spawn discoveries and the landmarks found. The trail is recorded all flight in a fixed ring of
  6000 points (a new line after a jump of 1.5 km or a relaunch). A click or tap sets the waypoint
  through `ctx.systems.waypoints.set`. The root class `dw-map-open` is set while it is open.

- Root classes: `dw-devbadge-on`, `dw-touch` (touch controls), `dw-glass-off` (a cockpit without
  the glass HUD hides every `.dw-glass` element), and `dw-no-throttle` for craft whose
  `inputProfile.throttle` is `'none'` (the glider and the wingsuit).
- The hint strip and the help panel's key lists are read from the live keyboard bindings.
- Touch: the virtual stick and the throttle slider report to `ctx.systems.input.touch`, so they fly
  through ControlState like every other device; the action cluster holds the menu.

### Copilot (`ctx.systems.copilot`)

The copilot system offers `update`, `ask`, `toggleMic`, `isListening`, `pushToTalk(held)`, `speak`,
`getBrainName`, `getStats` and `tourGuide` (`gatherEntries(radiusKm)`, `getOffer()`,
`snapshotFields()`, `handlers`).

- `ctx.executeAction(action)` returns the reply text or a promise of it.
- The remote brain contract (request, flight state, action schema, validation, fallbacks) is
  `docs/copilot-api.md`. The shared validator is `sanitizeFlightAction` in `grammar.js`.
- Aircraft actions only use the public channels: settings for craft, assists and the wing and
  flyby views (`settings.views`); `input:action` with source `copilot` for the cockpit, chase and
  outside views (`viewForward`, `viewBack`, `viewToggle1P3P`), engine, chute and `versionToggle`
  ("switch to version one": the shell bridge asks the launcher shell for V1);
  `flight.relaunch()`; and `ui:openControls` for calibration.
- The tour guide (`tourGuide.js`) reads the spawns only through their public API: the director's
  `getNearby(radiusKm)`, the SpawnManager's `getActive`, `getInstance`, `getPreset`, `listPresets`,
  `isDiscovered` and `getSiteFeed().sitesNear`, and the typed `spawnActivated` / `spawnEnded`
  events. Preset names, journal titles, ids, a synonym table and the categories resolve "take me to
  the ..."; `ctx.wind.nearestThermal` answers "find a thermal"; the weather system's `getState()`
  keeps "chase the storm" honest. It places waypoints through `ctx.systems.waypoints.set`.
- Callouts (setting `copilotCallouts`, default on) speak a preset's `callouts` line on
  `spawnActivated` (events, and sites not yet discovered coming into range): at most one per 45 s,
  never below 150 m AGL, while landing (`isLandingPhase`) or over another WREN line (the ask queue,
  the mic, speech synthesis, 4 s after any line). A bare "yes" within 20 s places the waypoint; it is
  answered before the brain, so it works with the remote brain too.

### Dev tools and test entry points

| entry | what |
| --- | --- |
| `?debug=1` | the dev badge, typed-event validation, `console.info` of the backend and of every gamepad id, the debug updraft (L), audio and camera `debug` hooks |
| `?renderer=webgl` | force the WebGL2 backend |
| `?seed=...`, `?time=0..1`, `?touch=1` | world seed, start time of day, force touch controls (v1) |
| `?dev=1` | in a production build: the spawn debugger (F9) and the spawns `debug` API (dev builds always have them) |
| `?test=hotas` | installs the mock gamepads (`ctx.systems.input.mock`) and, in dev builds, runs the HOTAS pipeline test (`src/dev/hotasTest.js`): bindings and hat decoding in both hat forms, calibration results, twist auto-disable, the one-time HOTAS assist default, and persistence across a reload |
| `tools/steps/view-physics.json` | run with `tools/smoke-test.mjs --url <dev server>/v2/` (or a build with `?debug=1`): pauses the loop, steps frames by hand and proves every craft flies identically in the cockpit, in chase and while switching views |
| `?test=sites` | dev builds: the terrain test's fixture site presets (an airfield strip, a gorge with its rope bridge, islets with floating islands, a canyon course) reach worldgen on both threads with no harness, for `tools/steps/engine-structure-sites.json` |
| `?test=terrain` | dev builds: the terrain test (`src/dev/terrainTest.js`). The fixture site presets reach worldgen on both threads; near every stamp type, every LOD pair of neighbouring chunks is checked for cracks, the displayed (worker-built) meshes must equal main-thread builds bit for bit, and `groundHeight` must match the rendered LOD0 mesh within 0.5 m. On-screen summary and `window.DRIFTWING.testReport`; `window.DRIFTWING.terrainTest.showView(i)` frames stamp type i. With `&presets=real` (`node tools/run-harness.mjs --test terrain --presets real`) the same checks run on the game's own stamped site presets, in the world as a player gets it |
| `?test=1` | dev builds: the flight-test harness (`src/dev/testHarness.js`). It flies each of the six craft for 60 s in first person and in third person across 3 seeds (36 runs), and logs average fps, p99 frame time, NaN events, terrain penetrations, soft crashes, heap growth and console errors. It shows an on-screen summary and offers a JSON report (`window.DRIFTWING.testReport`). URL options: `testSeeds`, `testSeconds`, `testCraft`, `testViews` (`first`, `third`) |
| `tools/run-harness.mjs` | runs either harness headlessly on a spare port (`--test 1\|hotas`, `--backend webgpu\|webgl`, `--seeds`, `--seconds`, `--crafts`, `--views`, `--out`), prints a table per run and per craft and view, and exits 0 on PASS |
| `tools/shell-test.mjs` | the launcher shell test (below) |
| `tools/smoke-test.mjs` | `--file dist-single/index.html` or `--url`, `--query`, `--steps` / `--steps-file` (`wait`, `press`, `down`, `up`, `click`, `move`, `eval`, `shot`), `--out`; fails on any console error or warning |
| labs | `node tools/flight-lab.mjs`, `node tools/lab/<name>.mjs` (the craft labs, `settings`, `copilot`, `input`, `storage`, `copilot-server`, `terrain`, `spawns`, `director`, `audio`, `discovery`) |
| `tools/spawn-check.mjs` | `--url <dev server>/v2/ [--backend webgpu\|webgl] [--out]`: the spawn framework proofs in the browser with the dev test kit (below) |
| `tools/engine-alloc.mjs` | `--url <dev server>/v2/ --steps tools/steps/engine-<name>.json --presets a,b [--backend webgpu\|webgl] [--frames] [--warmup] [--events f,g]`: the sampled JS allocations of spawn engines' frame updates with the clock running and the camera swaying (under 1 byte per frame, about a twelfth of one heap number a frame; callees, lifecycle and reports, and the named event paths reported apart) |

## Testing

Every headless tool runs Chrome (or Edge; `CHROME_PATH` overrides the discovery in
`tools/browser.mjs`) with a fresh profile, starts its own servers on free ports (never the player's
5199), and fails on any console error or warning from the shell or V2. V1's console is recorded
separately and judged only against [v1-known-issues.md](v1-known-issues.md).

| command | what it proves |
| --- | --- |
| `npm run test:v1` | V1 is byte-for-byte `v1-final:index.html` and matches `tests/v1.sha256` |
| `npm run test:shell` | the launcher shell under load (below), against the dev server and the built `dist-single/` |
| `npm run test:flight`, `test:flight:webgl` | the Phase 1 flight-test harness for every craft in first and third person, 3 seeds (36 runs of 60 s) |
| `npm run test:hotas`, `test:hotas:webgl` | the HOTAS pipeline, including persistence across a reload in the `driftwing-v2-test-hotas` database |
| `npm run test:terrain`, `test:terrain:webgl` | terrain stamps in the running game: no cracks at any LOD pair, worker meshes identical to main-thread builds, collision within 0.5 m of the rendered mesh; screenshots of every stamp type |
| `npm run lab:terrain` | placement and stamps headless: Phase 1 bit-identity with no site presets, and with the real (stamped) preset list bit-identity everywhere outside the stamps' bounds; placement filters, determinism, stamp shapes, seams, collision, height-sampling cost within 10 % of Phase 1 |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/view-physics.json` | every craft flies bit-identically in every view |
| `node tools/shell-check.mjs --url <shell>` | the pill (shows, hides, clear of both games' HUDs), persistence and forwarding |
| `node tools/flight-lab.mjs`, `node tools/lab/<name>.mjs` | the flight models, settings migrations, storage, input, WREN's grammar, the copilot server |
| `node --expose-gc tools/lab/spawns.mjs` | the spawn framework headless: the preset validator, the engine registry, the pools, LOD hysteresis, budgets, lures, discovery (view cone, terrain occlusion, once per world), sites from a feed, wind sources and lights removed on dispose, leak clean-up, lifetimes, and a manager frame update that allocates nothing (young-generation growth over 100 000 frames with 40 spawns) |
| `node --expose-gc tools/lab/structure.mjs` | the structure engine headless: every recipe on its stamped site and free-standing, params, stamps and `structureStamps`, gates and achievements, timed courses and their journal statistic, graded landings, landable island tops, ground-start spots, the wind farm's wake by tier, LOD, memory, per-recipe cost, and 100 000 allocation-free frames |
| `node --expose-gc tools/lab/setpiece.mjs` | the set-piece engine headless in a real SpawnManager: timeline validation, the dev timeline end to end (children through the manager, ramps, `set`, tracking, narration, records, journal statistics), every trigger kind, budget retries, control records, determinism, early dispose, the copilot's narration tokens, cost and allocation |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-structure.json` (add `--query renderer=webgl`) | every structure test preset force-spawned ahead of the craft and framed (screenshots), GPU memory and wind sources back after each dispose, the bridge's gate and achievement |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --query test=sites --steps-file tools/steps/engine-structure-sites.json` | the structure recipes on real stamped sites: the runway on its flatten strip with ground-start spots, the bridge gate across the gorge, island tops as ground surfaces, the course across the canyon |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-setPiece.json` (add `--query renderer=webgl`) | the dev timeline in the game: stages in order, children started and ended through the manager, a narration line spoken by the copilot, records, and GPU memory and wind sources back to their level after the run |
| `node tools/spawn-check.mjs --url <dev server>/v2/` | the spawn framework in V2 on either backend: 200 instances created and disposed three times with `renderer.info.memory` back to its baseline exactly and the heap within 1 MB, LOD transitions with hysteresis, lures at 12-30 km at golden hour, midday and night (screenshots), a wind source removed on dispose, discovery firing once, the sampled allocation of the manager's frame update, and the F9 debugger's keyboard behaviour |
| `npm test` | the V1 check, `build:single` and a smoke test of the built shell |
| `node tools/lab/discovery.mjs` | seed links (resolution order, times, world hashes, share links), the journal's spawn discoveries and collection count, the global records (add / min / max, known ops, bad payloads), achievements, and the map tiles (fields, determinism, no seams, water, cost) |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/discovery.json` | with the spawn test kit: forced discoveries give a toast, the chime and a journal entry and raise the count; journalStat and achievement events reach the records and the journal panel; M opens the map with the discovered site only, terrain tiles and the trail; a click sets the waypoint; Copy link is the shell link with the seed and time; the seed is saved |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-weatherVolume.json` (and `engine-celestial.json`; `--query renderer=webgl` for WebGL2) | each engine's forms and components force-spawned ahead of the craft with screenshots, their wind, inside and eclipse effects, and create/dispose with `renderer.info.memory`, wind sources and sky modifiers back to their baseline exactly |
| `node tools/lab/director.mjs [--hours 24]` | the director over simulated hours: pacing, rarity rates, nothing behind, cooldowns, budgets, lifetimes, heavy deferral, the weather distribution and session variety, determinism of the activation log, and load shedding before dynamic resolution (with Phase 1's governor unchanged without shedders) |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/weather-sky.json` (or a build with `?debug=1`) | the opening is clear with the sky untouched, the sky modifier blend, the four weather states' sky (screenshots) and `weatherChanged` |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-emitter.json` (or `engine-lightEffect.json`; add `--query renderer=webgl` for WebGL2) | the emitter and lightEffect engines force-spawned ahead of the craft in their representative configurations (screenshots at golden hour and night), their wind sources, lights, LOD and budgets, their per-frame cost, and dispose back to the memory, wind, modifier and light baseline (see `docs/engines/`) |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/director-game.json` | the game-wired director: its load shedder, `forceSpawn` ahead, `getNearby`, the camera frustum, the LOD bias and `dispose` |
| `node tools/lab/wind-engines.mjs [--verbose]` | the vortex and windModifier engines headless on a real WindField: every source type blows the right way, the vortex lifecycle and tracking, fades, windows, timelines and control hooks, refused params, the SIM glider and jet flown through every source (vertical speed, load factor, airspeed, drift logged), zero allocations in the engine updates and samplers, and the CPU cost |
| `node tools/lab/preset-wind.mjs [--verbose]` | the game's own wind-affecting presets (their windModifier entries and `wind` lists, built by the real engine as the SpawnManager builds them): the SIM glider and jet flown with scripted inputs through each one and the same path in calm air, logging vertical speed, g, airspeed, ground speed, height, drift and sideslip (the jet stream's core and edge, the sky whale's slipstream lane), and dispose removing every source |
| `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-vortex.json` (or `engine-windModifier.json`; add `--query renderer=webgl` for WebGL2) | the wind engines in V2: force-spawned ahead, their wind probed, screenshots, dispose back to the same GPU memory with every wind source removed; the windModifier file also checks the cockpit shake and rattle in rough air and both off in photo mode |
| `tools/steps/golden-frame.json` with `node tools/png-diff.mjs a.png b.png` | a paused still frame of the opening, rendered with the weather's clear-sky modifier and without any modifier: pixel-identical |

**The flight-test harness** passes with 0 NaN events, 0 terrain penetrations, 0 console errors and
warnings, heap growth under 50 MB per world, no frame over 50 ms after warmup, every run flown in
its planned craft and view, and every scripted manoeuvre observed. Its frame limit measures the
whole machine, and the project's test machine is shared with other projects' builds that never
stop. So `tools/run-harness.mjs` records the evidence to tell the two apart:

- per run: the machine's CPU load, the GPU's utilisation (`nvidia-smi`), the page main thread's
  CPU share, and on Windows the CPU and GPU load of every other process against the harness's own
  Chrome and node (`tools/process-load.mjs`, from each process's processor time and Windows'
  per-process GPU engine counters, with the busiest other programs named);
- per slow frame: its cause (game systems, GC, other main-thread work, or a delay while the thread
  was idle), its long-animation-frame script and blocking time, and all of the load figures above
  at that moment (`slowFrameList[].load` in the report, and a table in the tool's output).

A slow frame the game causes (its systems, its garbage, its main-thread work) is a bug to fix. A
slow frame with no game work in it that lands in a burst of other programs' CPU or GPU load is
reported as caused by the environment, with that evidence. The 50 ms limit is never loosened and
no frame is left out.

Warmup, which the frame statistics skip (NaN, penetration, crash and console checks cover every
frame), is: 5 s after each page load; a UI warmup of about 15 s; a warmup lap that flies every
craft and view of the world for 3 s each; and the first 3 s of every run. The UI warmup steps the
time of day through dawn, noon, golden hour, dusk and night and back, lets a toast leave and the
HUD auto-hide, then wakes it. Chrome compiles its rasterizer's and compositor's GPU programs
(Skia) the first time each is used, 15-50 ms apiece, on the GPU process's main thread, which also
executes WebGPU. On the harness's fresh browser profile, a trace showed them as slow frames the
first time a toast left or dusk fell (`shader_compile` and `cache_miss` inside
`RasterDecoderImpl::DoEndRasterCHROMIUM`). A player's Chrome keeps these programs in its disk
cache and compiles each only once, ever.

**The shell test** (`tools/shell-test.mjs`) makes 20 round trips V2 -> V1 -> V2 (V2 -> V1 by the
pill and by F8 in turn, V1 -> V2 by the pill). After each of the 40 switches it asserts exactly one
iframe holding exactly one live game document (the page's frames, and Chrome's document counter
after a forced GC), reached through `about:blank`, with `document.activeElement` on the iframe and
the iframe's document focused. It opens the shell at `/#seed=ABC` and needs V2's seed to be `ABC`.
A page on another port posts the exact switch request twice, from inside the shell's iframe and as
the page embedding the shell, and nothing may switch; the same request from V2's own iframe is the
control and must switch.

Memory is read 10 s after the game reports ready, after a forced GC (`HeapProfiler.collectGarbage`):
the JS heap (`Performance.getMetrics` `JSHeapUsedSize`), the documents, nodes and listeners
(`Memory.getDOMCounters`), and Chrome's GPU process (the `--type=gpu-process` child of the launched
browser: working set and private bytes, and on Windows the dedicated and shared GPU memory from
the `GPU Process Memory` performance counters). The reading after each game's 20th load is
compared with its first load, and may rise by at most (the larger of a share and an amount):

| metric | allowance | why |
| --- | --- | --- |
| JS heap | 10 % or 8 MB | one running game holds 13-26 MB of heap, so one retained game fails it; normal variation is about 1 MB |
| documents | none | a retained game is a retained document: this is the exact check |
| nodes, listeners | 10 % or 400; 10 % or 60 | a retained game adds 1,600+ nodes and 90+ listeners; toasts and hints on screen vary them slightly |
| GPU process working set, private bytes, dedicated and shared GPU memory | 15 % or 100 MB | Chrome's GPU process keeps shader and pipeline caches and pooled staging memory across loads by design, so one load can sit about 60 MB above another; the allowance catches GPU memory that grows by 5 MB or more per load over the 20 loads |

The tool's `MEMORY_TOLERANCE` comment has the measurements behind these, and the JSON report lists
each game's footprint over a blank tab next to each allowance.

## Placement and terrain stamps

Milestone A of Phase 2 (`src/world/placement.js`, `src/world/stamps.js`, contract section 2).

- **Sites.** Every site preset (`kind: 'site'` with a `placement` block, from
  `src/spawns/presets/index.js`) is rolled once per 2 km cell with hash(seed, cellX, cellZ, presetId).
  A candidate must pass, in order: the chance; the dominant biome from the terrain's own biome
  function; the surface (`land` | `water` | `coast` | `any`, from the unstamped height at the centre
  and on a ring the size of its stamps); the height band and relief (`peak` | `valley` | `flat` |
  `ridge` | `any`); every stamp fitting its ground (a canyon whose path would cut too deep or lift
  too much, or a gorge on a slope or too low for its depth, is dropped); the preset's `clearance` between its stamp footprints and every Phase 1
  landmark; `minSpacing` from sites of the same preset; and `clearance` between its footprints and
  every other site's. The two spacing rules keep the candidate with the higher priority roll, compared
  against the neighbours' rule 1-6 results, so the answer is local and the same from any starting
  cell. `placement.align` (`random` | `downhill` | `ridge`) orients the site.
- **Site records.** `{ id: '<presetId>:<cellX>:<cellZ>', presetId, cellX, cellZ, x, z, groundY,
  rotation, scale, seed, biome, stamps }`, frozen. `world.sitesInCell(cellX, cellZ)` and
  `world.sitesNear(x, z, radius)` (nearest first) query them; `hashSiteList(sites)` in placement.js is
  the determinism key (ids and coordinates to 1 cm).
- **Stamps.** A preset's `stamps` are specs (sizes as numbers or `[min, max]` ranges; see the table
  at the top of stamps.js). Placement resolves each once per site into world-space geometry with
  bounds, reference heights and the places engines need (the cone's `rimY` and `craterFloorY`, the
  canyon's `path` with `floorY` and `rimY` per point, the waterfall's `lipX/Z`, `poolX/Z`, `topY` and
  `bottomY`, the gorge's `anchors` and `span`, the airfield's `y` and `thresholds`, the islet's
  `topY`). `heightAt` applies them after the Phase 1 landmark shaping, so meshes, every LOD ring,
  skirts and `groundHeight` agree. Each has a smooth falloff and changes nothing outside its bounds.
- **Paint.** A stamp may paint the ground `ash`, `basalt`, `wetRock`, `tarmac` or `riverbed`
  (`world.stampInfluence(x, z)` -> `{ paint, weight }`). `faceColor` blends four shades of the paint
  over the biome colour with dithered edges, and nothing grows on painted ground.
- **Both threads, no messaging.** The worker imports the same worldgen, placement, stamps and preset
  list, and gets the same options (`ctx.worldOptions`), so it places the same sites. The terrain test
  proves it: the meshes the worker builds equal main-thread builds bit for bit.
- **Cost.** A world without stamped presets uses the Phase 1 height function itself (bit-identical,
  proven against digests recorded from the Phase 1 code). With stamps, a sample adds one lookup in a
  toroidal 64 x 64 window of 2 km cells (per-cell bounds and kinds in typed arrays) and, inside a
  stamp's bounds, its function called through a table by kind (trig in lookup tables, the canyon's
  segments through a coarse grid): the lab measures `heightAt` and `groundHeight` within 10 % of Phase 1.
- **Skirts.** A chunk a stamp touches hangs each skirt segment below the lowest ground of the
  coarsest LOD segment holding it (sampled on the LOD0 lattice), so a neighbour at any LOD can never
  open a crack at a canyon wall or a cliff; untouched chunks keep the Phase 1 skirts bit for bit.

## Phase 2-4 plug points

- **Event director and spawns (Phase 2).**
  - Subscribe to the typed events: `discovery`, `landed`, `softCrash`, `craftChanged`,
    `viewChanged` and `relaunched`.
  - Register wind sources with `ctx.wind.addSource({ id, kind, bounds, sample })` and move them
    with `setSourceBounds`. Their `windSourceAdded` / `windSourceRemoved` events come for free.
  - Place meshes in `ctx.scene`, and register lazily shown ones with `ctx.registerPrewarm`.
  - Nothing in the flight models changes, because every tick already flies through
    `WindField.sample`.
  - New typed events go into `EVENT_TYPES` in `src/core/events.js` with their payload shapes.
- **More craft (Phase 3).**
  - Append an entry to `CRAFT_CATALOG` (id, name, role, hotkey, silhouette), add
    `src/craft/<id>.js` with the module schema above, and register it in `src/craft/index.js`.
  - Add the id to `CRAFT_IDS` in `settings.js`.
  - Reuse a model kind, or add one: `flightModels.register(kind, factory)`, plus optional
    `registerAssistCatalog` / `registerAssistHandler`, `registerAutopilotHandler` and
    `registerTrimHandler` for that kind.
  - The picker, the copilot (`availableCraft`, capabilities), the instruments, the audio families
    and the cameras all read the module, so none of them change.
- **Spotify and music (Phase 4).**
  - Connect the player to `ctx.systems.audio.getBus('music')`. It already has a mixer slider
    (`settings.mixer.music`) and ducks under the copilot.
  - The TWCS throttle hat is deliberately left unbound for its controls.
  - The fixed `127.0.0.1:5199` origin is also what Spotify's redirect URI needs.
- **WebXR (Phase 4).** `src/render/renderer.js` keeps the WebGL2 backend available (never
  hard-blocked, and forceable with `?renderer=webgl`), and WebXR runs on it. Views are camera-system
  slots, so a VR view is one more slot.
- **Flight recorder and replay (Phase 4).**
  - Flight advances in fixed 120 Hz ticks from ControlState alone, and `copyControlState` makes the
    per-tick snapshot, so recording the ControlState stream is enough to re-drive a flight.
  - Every model has plain `snapshot()` / `restore()` (the trim and the NaN guard already rely on
    them) for keyframes.
  - The wind field is a pure function of position, time and seed.
  - Gameplay outcomes are typed events, which can be recorded and replayed as they are.
- **Multiplayer wingman (Phase 4).**
  - Send `state.flight` pose and telemetry, or ControlState plus periodic model snapshots, and the
    typed events.
  - Remote craft can be built from the same craft modules (`buildMesh` plus the `visual` fields)
    and driven by interpolated snapshots. The deterministic world and wind (same seed) mean both
    peers fly the same terrain and air.
