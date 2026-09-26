# DRIFTWING v2 architecture

This is the module map and the contracts between systems. Phase 1 builds everything here; the
"Phase 2-4 plug points" section lists where later phases attach without rewrites.

Units are SI everywhere in code (m, m/s, kg, N, s, rad/s internally; degrees only where a field name
or comment says so). World axes: +x east, +y up, -z north. Craft body axes: +x right wing, +y up,
-z nose. Headings are compass degrees (0 north, 90 east).

## Runtime

`src/main.js` boots in this order: storage (`await storage.init()`), typed event bus, settings,
renderer (WebGPU first, WebGL2 fallback; never blocks the WebGL2 backend because WebXR in Phase 4
runs on it), scene, world generator, shared state, wind field, systems, prewarm, frame loop
(`renderer.setAnimationLoop`).

### ctx

Every system factory is `createXSystem(ctx)` and returns an object with `update(simDt, realDt)`
plus optional `prewarm()` / `endPrewarm()` hooks. `ctx` carries:

| field | what |
| --- | --- |
| `THREE`, `TSL`, `addons` | the one three.js r184 WebGPU build (`three/webgpu`) |
| `renderer`, `backend`, `scene`, `camera`, `post` | rendering |
| `bus` | EventBus with typed events (`emitTyped` / `onTyped`) |
| `settings`, `storage` | persisted settings (IndexedDB) and raw storage |
| `world` | the shared deterministic world generator (`heightAt`, `groundHeight`, `biomeAt`, ...) |
| `wind` | the WindField |
| `craftRegistry` | craft catalog and registered craft modules |
| `state` | shared mutable game state (below) |
| `input` | v1 arcade input struct (pitch, roll, yaw, throttleDelta, throttleTarget, boost, fineControl, ...) |
| `controls` | the v2 ControlState (below) |
| `systems` | every system by name |
| `uniforms`, `textures`, `quality`, `util` | shared render uniforms, textures, quality level, helpers |

### Frame loop

Per frame: `simDt` (0 while paused) and `realDt` (clamped), then every system in UPDATE_ORDER
(input, flight, camera, terrain, sky, water, clouds, birds, landmarks, journal, waypoints, rings,
fx, copilot, audio, ui), then render. `state.time.frameDt` is the unclamped real frame time capped at
0.1 s, which the fixed-step physics clock consumes.

## Core services (`src/core`)

- **storage.js**: IndexedDB database `driftwing`, store `kv`, versioned structure and data
  migrations, synchronous cache (`read`, `write`, `remove`, `keys`, `flush`), localStorage then
  memory fallback. v1 localStorage keys migrate once.
- **settings.js**: validated schema, `get`, `set`, `update(key, patch)` for object keys, `reset`,
  `all`. Emits `settings:changed { key, value, settings }`. Keys: `mode`, `craft`,
  `assists{craftId: 0..1}`, `startOnGround`, `units` (`metric` | `aviation`), `views{classic, sim}`,
  `fov{chase, cockpit, wing, flyby, fpv}`, `hud{overlay, landingCallouts}`, `twistYaw`
  (`auto` | `on` | `off`), `afterburnerDetent`, `hotasPrompt` (`ask` | `always` | `never`),
  `frameTarget` (`auto` | 60 | 120 | 144 | 240 | `uncapped`), `dynamicResolution`,
  `mixer{master, engine, environment, ui, copilot, music}`, `devBadge`, `windOverlay`, plus every v1
  key (`masterVolume` is an alias of `mixer.master`).
- **events.js**: typed events with payload shapes, validated in dev and with `?debug=1`.
- **clock.js**: `createFixedStepClock()`: 120 Hz ticks, accumulator, `alpha` for interpolation,
  0.1 s frame clamp.
- **perf.js**: frame target and dynamic resolution (see Performance).

### Events

Typed (`bus.emitTyped(name, payload)`, `bus.onTyped(name, listener)`):

| event | payload |
| --- | --- |
| `modeChanged` | `{ mode, previous }` |
| `craftChanged` | `{ craft, previous }` |
| `landed` | `{ grade: butter\|smooth\|firm\|hard, craft, sinkRate, groundSpeed, position }` |
| `softCrash` | `{ craft, reason, impactSpeed, position }` |
| `discovery` | `{ id, name, kind, position }` (bridged from `landmark:discovered`) |
| `windSourceAdded` / `windSourceRemoved` | `{ id, kind, position, radius }` / `{ id, kind }` |
| `viewChanged` | `{ view, craft, mode }` |
| `deviceConnected` / `deviceDisconnected` | `{ deviceKey, kind, name }` |
| `relaunched` | `{ craft, method, position }` |

Untyped v1 events keep their names (`notify`, `settings:changed`, `user:gesture`, `game:ready`,
`photo:changed`, `copilot:speech`, `ui:command`, `rings:*`, `waypoint:*`, ...). v2 adds
`input:action { id, phase: 'press'|'release', source, device }` and `flight:assistOverride
{ active, reason }`.

**Command channel for mode and craft:** the persisted settings `mode` and `craft` are the source of
truth. Any UI, input action or copilot command changes them with `settings.set`; the flight
controller listens, applies the change (or rejects it and writes the previous value back), then
emits `modeChanged` / `craftChanged`.

## Input (`src/input`)

`InputManager` (the `input` system) reads keyboard, mouse, touch, standard gamepads and
Thrustmaster HOTAS devices and writes, every frame:

- `ctx.input`: the v1 arcade struct, exactly as v1 did for keyboard/mouse/touch, plus gamepad and
  HOTAS contributions. CLASSIC flight reads only this.
- `ctx.controls`: the **ControlState** (`src/input/controlState.js`): `roll, pitch, yaw` (-1..1),
  `throttle, collective` (0..1), `brakeL, brakeR, flaps` (0..1), `trim` (-1..1), `lookX, lookY`
  (-1..1), `actions` (Set of action ids pressed since the flight controller last consumed them),
  `held` (Set of held action ids), `sources` (which device last moved each axis). SIM flight reads
  this once per physics tick.
- `input:action` bus events for every press and release.

Actions (all rebindable on every device): `copilotPTT, craftAbility, boost, waypointNearest,
photoMode, viewCycle, viewForward, viewBack, viewLeft, viewRight, recenterView, craftNext,
craftPrev, modeToggle, gearToggle, flapsUp, flapsDown, airbrake, autopilotToggle, timeForward,
timeBack, ringCourse, journal, settings, controlsPanel, relaunch, engineToggle, chuteDeploy`, plus
`craftSelect1` .. `craftSelect6` for the number keys.

Each action has exactly one owner that performs it:

| owner | actions |
| --- | --- |
| flight | craftAbility, boost, craftNext, craftPrev, craftSelect1-6, modeToggle, gearToggle, flapsUp, flapsDown, airbrake (held), relaunch, engineToggle, chuteDeploy |
| camera | viewCycle, viewForward, viewBack, viewLeft, viewRight, recenterView |
| ui | waypointNearest, photoMode, autopilotToggle, timeForward, timeBack, ringCourse, journal, settings, controlsPanel |
| copilot | copilotPTT (held) |

Bindings (`input.bindings` in storage) are a global profile plus per-craft overrides, per device
kind (keyboard, mouse, gamepad) and per HOTAS device key. Calibration is stored per device key
(`input.calibration.<deviceKey>`). Devices are identified by vendor/product id parsed from
`gamepad.id` (Thrustmaster vendor `044f`), falling back to name substrings, never by slot index.

## Flight (`src/flight`)

The **FlightController** is `ctx.systems.flight`. It owns the active craft, the mode, the models,
the fixed-step loop for SIM, interpolation, the mode-switch blend, soft crash and respawn,
relaunch, ground contact outcomes and `state.flight` telemetry. It also keeps `state.player`
(the v1 fields) current in both modes so v1 systems keep working.

API (v1 methods keep their v1 meaning):

| method | notes |
| --- | --- |
| `update(simDt, realDt)` | CLASSIC: one variable step exactly like v1. SIM: fixed 120 Hz ticks, then interpolate |
| `planeMesh` | the active craft's root Object3D |
| `setAutopilot(options)` | v1 options; in SIM the autopilot flies through PID on the control surfaces |
| `barrelRoll(direction)`, `boost()` | CLASSIC only; return false in SIM |
| `getWingtips()` | world-space wingtip points (contrails) |
| `resetTo({ x, y, z, heading })`, `syncVisual()`, `getBaseQuaternion()`, `getStats()` | v1 |
| `getMode()`, `setMode(mode)` | also driven by `settings.mode` |
| `getCraft()`, `setCraft(id)` | also driven by `settings.craft` |
| `relaunch()` | craft relaunch (aerotow, peak launch, airstart) |
| `triggerSoftCrash(reason)` | fade, respawn 300 m AGL, level, at cruise (hover for rotorcraft) |

### Models

A FlightModel is created by a factory `createXModel({ profile, world, bus })` and exposes:

- `kind`: `arcade` | `fixedWing` | `helicopter` | `wingsuit` | `quad`
- `reset(pose)`: pose `{ position, velocity, quaternion, angularVelocity, throttle, onGround, engineOn }`
- `step(dt, controls, env)`: one tick. `env` = `{ time, wind: { vel, turbulence }, groundHeight(x, z),
  waterLevel, rho }`. Controls have already been shaped by the craft input profile, assists and the
  autopilot.
- `state`: `{ position, velocity, quaternion, angularVelocity }` (live, SI, world frame except
  angular velocity which is body frame)
- `contact`: result of the last tick's ground contact `{ onGround, touchdown, bodyStrike, water,
  penetration }`
- `writeTelemetry(flight)`: fills `state.flight` fields it owns
- `snapshot()` / `restore(snapshot)`: plain, serializable state (NaN restore, mode conversion,
  Phase 4 replay)

`ArcadeModel` is the v1 flight model extracted without behaviour change and parameterised by a
craft's `arcadeProfile` (the glider's profile is v1's constants). SIM models: `SimFixedWing`
(glider, bush plane, jet), `SimHelicopter`, `SimWingsuit`, `SimQuad`. Shared pieces: `aero.js`
(atmosphere, coefficient curves), `assists.js`, `autopilot.js` (PID), `groundContact.js`
(contact points against the shared height function, spring-damper, friction, brakes, steering),
`telemetry.js`.

### Telemetry (`state.flight`)

Written once per frame from the interpolated pose; see `src/flight/telemetry.js` for every field.
Consumers read it and never write it.

## Craft (`src/craft`)

`registry.js` holds the catalog (id, name, role, number key, picker silhouette). Each craft file
`src/craft/<id>.js` default-exports a module and `src/craft/index.js` registers them all. A module
provides:

| field | contents |
| --- | --- |
| `id`, `name` | as in the catalog |
| `buildMesh(ctx)` | returns `{ root, update(visual, dt), wingtips, eyeAnchor, dispose() }`: low-poly flat-shaded mesh in the v1 palette with animated control surfaces, prop disc, rotor, gear. `visual` carries telemetry plus control-surface deflections |
| `simProfile` | `{ model, ...parameters }` for the SIM model |
| `arcadeProfile` | CLASSIC tuning (v1's forgiving rules) |
| `inputProfile` | how ControlState axes map for this craft (for example throttle to collective) |
| `audioProfile` | `{ engine: 'glider'\|'prop'\|'jet'\|'heli'\|'drone'\|'wingsuit', ...parameters }` |
| `cameraRig` | `{ eye, chase: { distance, height, lookAhead }, wing, fpv }` |
| `instruments` | ordered instrument ids for the panel and HUD |
| `abilities` | `{ craftAbility: { label, run(flight) } }` |
| `spawn` | `{ cruise, hover, relaunch: 'aerotow'\|'peak'\|'airstart', canStartOnGround }` |
| `limits` | `{ vne, gLimit, crashSinkRate, floats }` |

## Wind (`src/env/WindField.js`)

`sample(pos, t, out?) -> { vel: Vector3, turbulence: 0..1 }` layers ambient wind, ridge lift,
seeded thermals and turbulence, plus registered sources. `thermalsNear(x, z, radius, visit)` lets
the cloud system draw each thermal's cumulus cap. Phase 2 writers use `addSource({ id, bounds,
sample(pos, t) })`, `setSourceBounds(id, bounds)` and `removeSource(id)`; bounds are `{ min, max }`
or `{ center, radius }` and sources are found through a spatial hash. CLASSIC applies a scaled,
subtle share of the field; SIM applies all of it.

## Cameras (`src/camera`)

The `camera` system manages views `chase` (the v1 rig, unchanged), `cockpit` (per-craft eye point,
canopy frame and instrument panel), `wing` and `flyby`, free look (ControlState `lookX/lookY`,
view snaps), per-view FOV from `settings.fov`, and photo mode (v1). CLASSIC defaults to chase and
SIM to cockpit (`settings.views`).

## Audio (`src/audio`)

`AudioEngine` (the `audio` system) owns the AudioContext, the mixer buses `master, engine,
environment, ui, copilot, music` (volumes from `settings.mixer`), ducking while the copilot speaks,
and procedural modules driven by `state.flight` and the craft `audioProfile`. The music bus is
exposed as `ctx.systems.audio.getBus('music')` for Phase 4.

## UI (`src/ui`)

Glass UI from v1 plus the CLASSIC | SIM pill, craft picker, HOTAS prompt, settings panel, controls
panel with calibration wizard, instrument HUD overlay and the sound-off pill.

## Performance

Uncapped `setAnimationLoop`. The frame target defaults to the measured display refresh. Dynamic
resolution steps render scale between 0.6 and 1.0 with hysteresis to hold the target; v1's quality
levels (view distance and density) are the second stage.

## Dev (`src/dev`)

Status badge (backend, revision, fps, frametime graph, input devices), the flight-test harness
(`?test=1`) and the HOTAS pipeline test (`?test=hotas`).

## Phase 2-4 plug points

- **Event director and spawns (Phase 2)**: subscribe to typed events, register wind sources with
  `ctx.wind.addSource`, place meshes in the scene; nothing in the flight models changes because
  they already fly through `WindField.sample`.
- **More craft (Phase 3)**: append to `CRAFT_CATALOG`, add `src/craft/<id>.js`, register it in
  `src/craft/index.js`; reuse or add a model in `src/flight`.
- **Music (Phase 4)**: connect to the `music` bus; the throttle hat is left unbound for it.
- **WebXR (Phase 4)**: the renderer boot keeps the WebGL2 backend available.
- **Replay and multiplayer (Phase 4)**: SIM runs in fixed ticks from ControlState, models expose
  `snapshot()` / `restore()`, and every gameplay outcome is a typed event.
