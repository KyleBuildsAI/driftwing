# vortex engine

The vortex engine draws a rotating air column and blows its wind: tornadoes, waterspouts, the
maelstrom's air vortex and the storm-chase tornado stage, and in Phase 3 dust devils, the hurricane
eyewall and more. One param set covers everything from a gentle dust devil to a violent tornado.

- Code: `src/spawns/engines/vortexEngine.js`.
- Wind: `src/spawns/engines/windSources.js` (the `rankine` source).
- Headless tests: `node tools/lab/wind-engines.mjs`. In the game:
  `tools/steps/engine-vortex.json` (see [Testing](#testing)).

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'vortex', params: { ... } }`. A bad value throws a clear error that names the field, for
example `[DRIFTWING] vortex: coreRadius must be a finite number, got NaN`. An unknown param throws too
(`[DRIFTWING] vortex: "coreRadiu" is not a vortex param`), so a typo never passes silently.

## What one vortex is

| part | what it looks like | params |
| --- | --- | --- |
| funnel shell | a tapered, twisting tube hanging from a cloud base, translucent near the ground and opaque aloft, with soft cloud-like edges, condensation striations spiralling up, sun-wrapped shading with a dark backlit body and a silver rim against the sun, and a dusty foot over land | `coreRadius`, `topRadius`, `cloudBase`, `taper`, `twist`, `opacity`, `striation`, `color`, `shadeColor` |
| rope axis | wobbles and bows at mid height; at rope-out it thins, leans away from its track and lifts off the ground | `wobble`, `wobblePeriod`, `ropeLean`, `ropeThin` |
| collar | the funnel flares into a lowered cloud collar under the cloud base, built of flattened puffs | `collar` |
| condensation puffs | soft puffs spiralling up the skin | `puffs`, `puffSize` |
| ground ring | at the ground contact, a churning cloud (dust or mist, two thirds of the particles) and fine bits (debris or droplets) that lift and orbit; brown debris over land, white spray over water, blended while the vortex tracks across a coast | `groundParticles`, `debrisRadius`, `debrisHeight`, `particleSize`, `sprayHeight`, `debrisColor`, `sprayColor`, `surface` |
| wind | a WindField `rankine` source whose axis follows the visible rope | [Wind params](#wind-params) |
| sound | the preset's `audio` voice (the `tornado` recipe), placed on the vortex, with its intensity following the vortex strength | `audioIntensity`, `voice` |

All vortices look deterministic: the particle seeds are fixed, and each spawn's own seed picks its
spin phase, wobble phase, rope-out side and track meander.

## Lifecycle

`forming` -> `mature` -> `ropeOut` -> `dissipated`. At `dissipated` the engine sets
`instance.ended`, so the manager removes the spawn.

- **forming** (`formSeconds`): the funnel descends from the cloud base to the ground (touchdown). It
  condenses over the first 20 % of the time. The ground ring builds from 35 % to 80 % of the
  descent. The wind strength eases in with the descent.
- **mature**: full strength until `duration - ropeSeconds`, so the rope-out ends with the event.
- **ropeOut** (`ropeSeconds`): the rope thins to `ropeThin` of its width, leans by `ropeLean`, wobbles
  three times harder, and its foot lifts back to the cloud base over the last 45 %. The ground ring
  widens and dies away. The wind weakens as (1 - rope)^1.5.
- **dissipated**: nothing drawn, no wind.

A site (no duration) stays `mature` until something sets `instance.control.ropeOut = true` (a set
piece). It then ropes out and stays dissipated without ending. `startStage: 'mature'` skips the
touchdown, for a vortex that is already on the ground when the player arrives.

Timeline hooks (a set piece writes them):

| hook | effect |
| --- | --- |
| `instance.control.intensity` | 0..1.5, default 1: scales the wind and the voice and fades the condensation, eased over about 2 s |
| `instance.control.ropeOut` | `true` starts the rope-out now |
| `instance.active` | `false` (a site's `setSiteActive`) fades the vortex out; `true` brings it back |

## Parameters

Every length is multiplied by the activation `scale` (the manager passes `opts.scale` or the site's
scale; 1 by default), and so are the wind's lengths. The ranges are clamps: a value outside is pulled
to the nearest end.

### Shape

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `coreRadius` | m | 2..2000 | 60 | the funnel radius at the ground, and the wind's core radius unless `windCoreRadius` is set |
| `topRadius` | m | 5..6000 | 240 | the funnel radius at the cloud base |
| `cloudBase` | m above the ground | 30..12000 | 900 | where the funnel hangs from; the wind column's top unless `windTop` is set |
| `taper` | exponent | 0.5..6 | 2.2 | radius = mix(core, top, height share^taper): high values keep the funnel thin until it flares near the base (a rope or a dust devil); 1 is a straight cone |
| `twist` | turns | -4..4 | 0.6 | how far the striations and puffs twist from the ground to the base; negative twists the other way |
| `wobble` | m | 0..2000 | 25 | the rope axis's sway at mid height (three times larger at full rope-out) |
| `wobblePeriod` | s | 1..120 | 9 | one sway cycle |
| `ropeLean` | share of `cloudBase` | 0..2 | 0.5 | how far the top leans from the foot at full rope-out, to a seeded side of the track |
| `ropeThin` | factor | 0.05..1 | 0.22 | the funnel width at full rope-out |
| `collar` | factor | 0..3 | 0.8 | the flare into the lowered collar and the collar puff ring's size; 0 has no collar (a dust devil) |

### Look

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `opacity` | 0..1 | | 0.95 | the shell's densest opacity (it still thins near the ground and at its silhouette) |
| `striation` | 0..1 | | 0.6 | how strongly the condensation bands show |
| `spin` | rad/s | 0..12 | 0 (auto) | the visible spin; 0 takes a calm fraction of the wind's rotation: 0.35 x `maxTangential` / `coreRadius`, at most 3 |
| `color` | 0xRRGGBB | | 0xb8b2aa | the sunlit condensation colour (also the puffs) |
| `shadeColor` | 0xRRGGBB | | 0x4b4e57 | the shadowed and backlit body (also the collar, and the ring against the sun) |
| `debrisColor` | 0xRRGGBB | | 0x5e4b3a | the debris and the dusty foot over land |
| `sprayColor` | 0xRRGGBB | | 0xe6eff2 | the spray over water |

At night the whole vortex darkens to 30 %. A vortex hazes toward the sky colour behind it with
distance (the clouds' aerial perspective, up to 90 % at 7.5 km), and its foot takes the terrain fog.

### Particles

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `groundParticles` | count | 0..4096 | 2400 | the ground ring |
| `debrisRadius` | x `coreRadius` | 0.5..12 | 2.6 | the ring's radius (it widens by 60 % through rope-out) |
| `debrisHeight` | m | 0..3000 | 160 | how high the debris lifts |
| `particleSize` | m | 0.2..60 | 3.5 | a fine bit; the dust or mist clouds are 4-9 times larger |
| `sprayHeight` | m | 0..2000 | 70 | the spray's arc over water |
| `puffs` | count | 0..1024 | 420 | condensation puffs (40 % of them build the collar when `collar` > 0) |
| `puffSize` | m | 1..1500 | 80 | |

### Surface and track

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `surface` | `auto`, `land`, `water` | | `auto` | `auto` follows the ground under the vortex (spray over water, debris over land, blended across a coast); `water` forces a waterspout's spray, `land` forces debris |
| `trackSpeed` | m/s | 0..80 | 0 | 0 stands still; otherwise the vortex walks along a seeded path precomputed at create (at most 512 points, one per 60 m), riding the ground or the water. A site ping-pongs along a 10-minute path |
| `trackTurn` | degrees | -180..180 | 0 | the track's heading relative to the activation heading |
| `trackWander` | degrees | 0..90 | 20 | the track meanders up to this far either side |
| `trackMeander` | m | 100..20000 | 1500 | one meander wavelength |

### Lifecycle and sound

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `startStage` | `forming`, `mature` | | `forming` | |
| `formSeconds` | s | 0..600 | 20 | touchdown time |
| `ropeSeconds` | s | 0..600 | 30 | rope-out time, the last part of the event's duration |
| `audioIntensity` | 0..1 | | 1 | scales the voice's intensity (the vortex strength times this) |
| `voice` | bool | | true | `false` keeps the vortex silent even when the preset has `audio` |

### Wind params

The wind source is a Rankine vortex:

- the tangential wind is a solid body inside the core radius and falls off as 1/r outside it,
  counterclockwise from above (cyclonic) for `rotation: 1`;
- radial inflow pulls toward the core out to the inflow radius (about 40 % of `inflowSpeed` at two
  thirds of it, nothing past it), strongest in the lower 35 % of the column;
- a violent updraft core, with a ring of sinking air around it;
- heavy turbulence: its own gusts of `turbulence x gust` m/s, and a turbulence value that drives the
  camera shake and cockpit rattle.

The column's axis follows the visible lean and wobble, and its strength follows the lifecycle and
`control.intensity`.

Set wind params in the engine params, or in the preset's own `wind: [{ type: 'rankine', params }]`
entry (the engine params win). `wind: false` in the engine params makes a vortex with no wind.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `maxTangential` | m/s | 0..120 | 60 | the peak rotation, at the core radius |
| `inflowRadius` | m | 20..20000 | 1500 | the pull's reach (the tornado pulls within 1.5 km) |
| `inflowSpeed` | m/s | 0..60 | 12 | |
| `updraft` | m/s | 0..90 | 40 | the core's updraft |
| `sinkRing` | share | 0..1 | 0.12 | the sinking ring around the core, as a share of the updraft |
| `turbulence` | 0..1 | | 0.9 | the turbulence value in the core (45 % of it across most of the inflow radius) |
| `gust` | m/s | 0..30 | 7 | the gust amplitude at full turbulence |
| `rotation` | -1 or 1 | | 1 | 1 is counterclockwise from above, -1 clockwise |
| `windCoreRadius` | m | 2..2000 | `coreRadius` | the wind's core, if it should differ from the visible funnel |
| `windTop` | m | 20..15000 | `cloudBase` | the wind column's top |

**Wind at the far tier.** The source is removed at FAR when its reach (the inflow radius plus the
lean and wobble) is inside the nearest distance the FAR tier can start: `lod.mid x 0.5` (the
director's strongest LOD bias) `x 0.92` (the LOD hysteresis). There it can never touch the player.
It comes back at MID. A vortex whose inflow reaches farther than that keeps its source at FAR.

## LOD

| tier | drawn |
| --- | --- |
| near | everything |
| mid | the shell, 60 % of the puffs, 35 % of the ground ring |
| far | a heavy preset hides (its lure takes over, so give heavy presets a `lure`); a light preset keeps its shell and 25 % of its puffs |

Fades between tiers are eased (about 0.4 s).

## Budgets and cost

- At most 4 vortices at once (the shared meshes have 4 slots). The director's budget is 3 instances
  and 40 000 particles. A fifth `create` throws a clear error, and the manager refuses it.
- Particles: `groundParticles + puffs` per vortex, at most 5120.
- GPU: one shell mesh (28 x 40 quads, 2240 triangles per slot) and one instanced sprite
  (5120 sprites per slot) hold every vortex: 2 draw calls in all. The drawn range covers the slots in
  use. Motion is computed in the vertex shaders from a per-slot uniform block (11 vec4 per slot), and
  each frame writes a few dozen numbers and uploads no buffers. The same shaders run on WebGPU and
  WebGL2 (no compute, no storage buffers).
- Memory: everything is built and prewarmed in `init()`. A spawn adds no geometry or texture, and
  `dispose` frees its slot.
- CPU: `update` is about 0.35-0.7 µs per vortex, with zero allocations (lab).
- Measured in the game (the step file, three vortices in view against none from the same camera):
  +2 draw calls and +37 440 triangles on both backends. The frame-time difference is below the
  headless frame pacing (4-17 ms intervals on the shared, busy machine), so it cannot be resolved
  there.

## Examples

A violent tornado that walks across the land (heavy, with a lure and the tornado voice):

```js
engines: [{ engine: 'vortex', params: { trackSpeed: 12, trackWander: 25, formSeconds: 25, ropeSeconds: 40 } }],
wind: [{ type: 'rankine', params: { coreRadius: 60, maxTangential: 70, inflowRadius: 1500, updraft: 45 } }],
audio: { recipe: 'tornado', params: {} },
```

A waterspout (thinner, milder, a spray ring):

```js
{ engine: 'vortex', params: {
  surface: 'water', coreRadius: 16, topRadius: 80, cloudBase: 650, collar: 0.6,
  color: 0xc9ccce, shadeColor: 0x5a626d, debrisRadius: 3.2, sprayHeight: 55, particleSize: 3,
  puffs: 300, puffSize: 45, maxTangential: 35, inflowRadius: 500, updraft: 18,
} }
```

A dust devil (Phase 3; small, sandy, no collar, no cloud):

```js
{ engine: 'vortex', params: {
  startStage: 'mature', coreRadius: 6, topRadius: 22, cloudBase: 220, taper: 1.6, twist: 1.4,
  wobble: 6, collar: 0, opacity: 0.55, striation: 0.9, color: 0xb59a78, shadeColor: 0x6b5842,
  groundParticles: 1200, debrisRadius: 3, debrisHeight: 60, particleSize: 1.2, puffs: 0,
  maxTangential: 18, inflowRadius: 150, inflowSpeed: 5, updraft: 8, turbulence: 0.6, gust: 3,
} }
```

The maelstrom's air vortex (a wide, slow, clockwise column over its whirlpool; a site that stays
mature):

```js
{ engine: 'vortex', params: {
  startStage: 'mature', surface: 'water', coreRadius: 120, topRadius: 600, cloudBase: 1400,
  taper: 1.3, twist: 0.3, opacity: 0.45, striation: 0.8, collar: 1.2, puffs: 700, puffSize: 140,
  groundParticles: 3000, debrisRadius: 2, sprayHeight: 90, particleSize: 5,
  maxTangential: 30, inflowRadius: 2500, inflowSpeed: 6, updraft: 20, rotation: -1,
} }
```

A hurricane eyewall (Phase 3) is the same engine at a large `scale` with a low `taper`, a wide
`coreRadius` and a high `opacity`.

## Testing

- `node tools/lab/wind-engines.mjs`: the Rankine profile (solid body, 1/r, cyclonic, inflow within
  the radius and none past it, the updraft core), the lifecycle and `ended`, rope-out on
  `control.ropeOut`, terrain tracking, the FAR rule, the fifth-vortex refusal, refused params, the
  glider and jet flown past a tornado, zero allocations and the CPU cost.
- `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-vortex.json`
  (add `--query renderer=webgl` for WebGL2). It force-spawns a tornado, a waterspout and a dust devil
  ahead of the craft, probes the tornado's wind, screenshots each vortex and the tornado at night,
  checks that the spawns add no GPU memory and that dispose removes every wind source, and runs a
  rope-out and a touchdown on the flight clock.
