# emitter engine

GPU particle emitters for plumes, jets, sprays, sparks, dust rings, mist and rising lanterns, with
ballistic and wind-driven motion, and optional couplings: a real light, a glow that lights the plume
from below, a WindField source, an immersion fog and a spawn voice. The code is in
`src/spawns/engines/emitterEngine.js` (params, emission, couplings) and
`src/spawns/engines/particleSystem.js` (the GPU pools, the motion and the look). Shared helpers are
in `src/spawns/engines/engineKit.js`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'emitter', params: { ... } }`. A preset may list several emitter entries (an ash plume and
its lava bombs), and each entry is one emitter. Every parameter below is optional. A bad value throws
a clear error that names the preset and the field, for example
`[DRIFTWING] emitter preset "volcano": param "shape.type" must be one of point, sphere, disc, ring, box, line, got "cone"`.
Unknown keys are refused too, so a typo never passes silently.

## How it works

- **Two shared pools, two draw calls.** Every emitter's particles live in one of two instanced
  pools: `alpha` (soft, lit puffs: ash, steam, dust, mist, spray) and `additive` (glows, sparks,
  lanterns, embers). Each pool is a single draw call whatever the number of emitters. An emitter
  owns whole pages of 1024 slots and uses them as a ring.
- **The CPU writes births only.** Emitting a particle writes its birth record (position, velocity,
  life, seed, size) once. The CPU never touches a particle again.
- **Motion on the GPU.** On WebGPU a TSL compute kernel integrates every live particle each frame
  in storage buffers. On WebGL2 the vertex shader evaluates the closed-form solution of the same
  equations from the birth record. Both use gravity, decaying buoyancy, drag toward the local wind,
  and the ground. The two backends look the same. The only differences are that WebGL2 takes the
  wind as constant along each path, and that a WebGL2 bounce settles.
- **Wind without per-particle CPU work.** Each emitter has a coarse 4 x 3 x 4 grid of WindField
  samples around it (the `field` params). A new or moved grid fills at 2 nodes a frame; after that
  one node across all emitters is refreshed every 5 frames, and the nodes ease over 6 s. Particles
  read the grid by trilinear interpolation on the GPU, so a plume leans with the real wind,
  including other spawns' wind sources.
- **The look.** Size, colour (three stops) and opacity change over life. Turbulence is a seeded
  random walk plus a wobble. Puffs get the v1 cloud lighting (sun key, shade palette, moonlight,
  silver lining toward the sun), and an optional underglow lights them from below. Emission is HDR,
  so the bloom carries sparks, lava and lanterns. Particles fade near the ground (`depthFade`) and
  right at the lens (a soft-particle fade with no depth texture, identical on both backends), and
  fog applies per emitter.
- **Warm start.** An emitter that enters an emitting tier appears as if it had been running for a
  life, so a plume first seen from 6 km is already a plume, not a puff growing from the ground.

### Local frame

Offsets and directions are `[right, up, forward]` in metres, in the frame of the activation heading
(forward is the heading, up is world up). `scale` from the activation multiplies every length marked
"scaled" below.

## Parameters

### Emission

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `particles` | count | 1..32768 | 4000 | ring capacity. It is rounded up to whole pages of 1024 when allocated. If the pool is short, the emitter runs on the pages it got, and its rate follows |
| `rate` | 1/s | 0..1e6 | `particles x 0.9 / mean life` | continuous emission at level 1. It is capped so that one life never needs more than the ring holds. Use 0 for bursts only |
| `intensity` | 0..1 | | 1 | base level of the emission (and the voice, light and wind source) |
| `inactiveIntensity` | 0..1 | | 0.15 | level while a site is dormant (`setSiteActive(false)`, for example a volcano between eruptions) |
| `schedule` | object or null | | null | a seeded eruption cycle: `{ period [s,s] = [60,120], active [s,s] = [8,15], rampUp s = 1.5, rampDown s = 3, idle 0..1 = 0 (level between eruptions), startActive bool = false }` |
| `pulse` | object or null | | null | a slow breathing of the level: `{ period s = 8, depth 0..1 = 0.4 }` |
| `bursts` | object or null | | null | seeded bursts on top of the rate: `{ interval [s,s] = [4,10], count [n,n] = [20,60], speedScale = 1 (0..100), minLevel 0..1 = 0.2 }`. A burst fires only while the level is at least `minLevel` |
| `warmStart` | bool | | true (false for an emitter with bursts and no `rate`) | see above |
| `endRamp` | s | 0..600 | 3 | an event fades its emission over this after its duration, and ends once the last particle has died |
| `particles` per frame | | | | at most 4096 emitted per frame, so a long stall never floods the pool |

### Shape and placement

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `shape.type` | | `point`, `sphere`, `disc`, `ring`, `box`, `line` | `point` | where particles are born |
| `shape.radius` | m, scaled | 0..50000 | point 0, else 10 | sphere, disc and ring radius |
| `shape.innerRadius` | m, scaled | 0..50000 | ring 0.85 x radius, else 0 | disc and ring inner radius (an annulus) |
| `shape.height` | m, scaled | 0..50000 | 0 | disc, ring and line: births spread up to this above the base |
| `shape.size` | m, scaled | [x, y, z] | [10, 10, 10] | box size (right, up, forward) |
| `shape.length` | m, scaled | 0..100000 | 100 | line length (along right) |
| `shape.surface` | bool | | false | sphere: on the surface rather than in the volume |
| `offset` | m, scaled | [r, u, f] | [0, 0, 0] | the shape's centre from the anchor |
| `attach` | | `anchor`, `camera` | `anchor` | `camera` emits around the camera (sandstorm grit, snow, ash fall inside a plume). The wind grid follows it |
| `hugGround` | bool | | false | each birth sits on the ground (or the water) under it, plus `offset[1]` and the shape's height. Use it for mist, dust rings and lanterns |
| `travel` | m/s | [r, u, f] | null | moves the spawn's anchor (a meteor's spark trail, a drifting column). The anchor is shared with the LOD, the lure and discovery, and moves in whole metres; the emission point, the light and the velocity follow the exact position |

### Launch

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `direction` | | `up`, `radial`, `antiSun`, `wind`, or [r, u, f] | `up` | axis of the launch cone. `radial` is outward from the shape's centre (explosions, spark sprays), `antiSun` points away from the sun (comet dust), `wind` follows the local wind (spindrift, grit) |
| `speed` | m/s | [min, max], 0..5000 | [2, 4] | launch speed along the cone |
| `spread` | deg | 0..180 | 15 | half-angle of the cone (180 is every direction) |
| `radial` | m/s | -5000..5000 | 0 | horizontal speed outward from the centre (negative is inward). Used for dust rings and splash crowns |
| `swirl` | m/s | -5000..5000 | 0 | horizontal speed around the centre (counter-clockwise seen from above when positive). Used for dust devils and vortex debris |
| `inherit` | share | 0..1 | 0 | share of the emitter's own velocity (from `travel`, or a moving anchor) the particle keeps |

### Motion

The velocity follows `dv/dt = g + b e^(-t / decay) up + drag x (windFollow x wind - v)`, and the
ground clamps it.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `gravity` | g | -5..5 | 1 | a multiple of 9.81 m/s^2 (0 for steam and ash that only drift, negative to fall up) |
| `buoyancy` | m/s^2 | -200..200 | 0 | upward acceleration: hot ash, steam, lanterns. It adds to gravity, so anything that rises needs `gravity: 0` (or a buoyancy above 9.81) |
| `buoyancyDecay` | s | 0..3600 | 0 | time constant of the buoyancy decay (0 means it never decays: a lantern keeps rising) |
| `drag` | 1/s | 0.02..100 | 0.5 | how fast the velocity relaxes to the wind. Heavy bombs use about 0.05, fine mist about 1 |
| `windFollow` | share | 0..2 | 1 | share of the local wind the particles drift with (0 ignores the wind) |
| `turbulence.spread` | m/sqrt(s), scaled | 0..10000 | 0 | seeded random walk: the spread grows with the square root of the age |
| `turbulence.wobble` | m, scaled | 0..10000 | 0 | amplitude of a smooth per-particle wobble |
| `turbulence.frequency` | Hz | 0..50 | 0.5 | wobble frequency |
| `turbulence.vertical` | share | 0..2 | 0.6 | vertical share of the random walk |
| `ground` | | `none`, `settle`, `bounce` | `none` | `settle` lands and slides to a stop (dust, bombs), `bounce` rebounds (WebGPU; WebGL2 settles) |
| `groundOffset` | m | -100..1000 | 0.5 | height above the ground where particles land |
| `restitution` | share | 0..1 | 0.35 | share of the vertical speed kept by a bounce |

### Look

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `style` | | `puff`, `glow`, `spark`, `lantern`, `droplet` | `puff` | sprite: a soft cauliflower puff, a hot core in a halo, a streak with a bright spine, a paper lantern with its flame, a firm dot |
| `blend` | | `alpha`, `additive` | puff and droplet: `alpha`, else `additive` | chooses the pool |
| `life` | s | [min, max], 0.05..600 | [2, 4] | |
| `size` | m, scaled | number or [start, end], 0..20000 | [2, 6] | sprite size at birth and at death (it may shrink) |
| `sizeCurve` | exponent | 0.05..20 | 1 | size over life: below 1 grows early (plumes), above 1 grows late |
| `sizeJitter` | share | 0..1 | 0.3 | per-particle size variation |
| `stretch` | s | 0..10 | 0 | streaks along the screen velocity: the length adds speed x stretch (sparks, rain, bombs) |
| `colors` | 0xRRGGBB | 1 to 3 colours | [0xffffff] | colour at birth, at `colorMid` and at death |
| `colorMid` | share of life | 0..1 | 0.5 | where the middle colour sits |
| `brightnessJitter` | share | 0..1 | 0.1 | per-particle brightness variation |
| `opacity` | 0..1 | | 0.6 | peak opacity |
| `fadeIn` | share of life | 0..1 | 0.1 | |
| `fadeOut` | exponent | 0..20 | 1.5 | opacity times `(1 - lifeT)^fadeOut` |
| `emissive` | HDR gain | 0..100 | 0 | adds colour x emissive (over 1 blooms). Lava, sparks, lanterns |
| `emissiveDecay` | 1/life | 0..100 | 0 | the emission falls as `e^(-decay x lifeT)` (a cooling ember) |
| `nightBoost` | share | 0..20 | 0 | emission times `1 + nightBoost x nightFactor` (lanterns and lava read brighter at night) |
| `lit` | 0..1 | | alpha: 1, additive: 0 | mix of the v1 cloud lighting (sun, shade, moon, underglow, silver lining) and the flat colour |
| `softness` | exponent | 0.2..8 | 1.6 | edge falloff of puffs |
| `fog` | 0..1 | | 1 | how much the scene fog takes the particles (lower keeps lanterns and lava visible farther) |
| `depthFade` | m | 0..1000 | alpha: 3, additive: 0 | particles fade within this of the ground (soft contact) |
| `underglow` | object or null | | null | light from below: `{ color = 0xff6a2a, intensity 0..50 = 1.5, height m (scaled) = 800 (falloff height), flicker 0..1 = 0.2, night 0..1 = 0.8 (how much it waits for the night) }` |

### Couplings

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `light` | object or null | | null | one real light from the pool while near or mid: `{ color = 0xff8a3a, intensity cd (0..1.07e9) = 2e6, range m = 3000, offset [r,u,f] m (scaled) = [0,50,0], flicker 0..1 = 0.25, priority 0..100 = 2, night 0..1 = 1 (1 lights only at night), follow 0..1 = 1 (how much it follows the emission level) }`. The engine declares 1 real light; a higher priority holder (a lightning strike) can take it, and it is asked for again a second later |
| `windSource` | object or null | | null | a WindField source that follows the emission level: `{ type 'updraft' \| 'downburst' \| 'turbulence' = 'updraft', strength m/s = 8, radius m (scaled) = 150, height m (scaled) = 600, base m (scaled) = 0, turbulence 0..1 = 0.4, outflow m/s = 0 (downburst: outward gust near the ground), depth m (scaled) = 150 (downburst: depth of the outflow layer) }`. The core is Gaussian with radius `radius`, tapering over the top 20 % |
| `immersion` | object or null | | null | the sky fog thickens while the camera is inside the column: `{ radius m = 800, height m = 3000, base m = 0 (all scaled), fogDensity 1..8 = 4, fogColor = the middle colour, fogColorAmount 0..1 = 0.7, darkness 0..1 = 0.3 }` (sky modifier, priority 20) |
| `sound` | bool | | true | this entry opens the preset's `audio` voice (set false on all but one entry of a multi-emitter preset) |
| `soundTriggers` | object | | none | voice triggers: `{ schedule: name, burst: name }` fired when an eruption starts (with its duration) or a burst fires (with its strength). Names: `burst`, `boom`, `streak`, `fireball`, `call`, `chime`, `scatter` (the recipe decides which it answers) |
| `field` | object | | computed | the wind grid: `{ extent m = 2 x (shape + reach), height m = reach, base m = -min(200, 0.1 x height) }`. Set it when particles travel farther than the estimate |

### LOD

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `lod.near`, `lod.mid`, `lod.far` | share | 0..1 | 1, 0.4, 0 | share of the emission rate and the ring at each tier |
| `lodSizeBoost` | bool | | true | fewer particles are drawn larger (`1 / sqrt(share)`, at most 2.5 x), so a plume keeps its body |

## LOD, the far tier and the lure

- At `mid` the rate drops to `lod.mid`, and the particles grow to keep the silhouette.
- At `far` the emission stops by default (`lod.far = 0`), and the real light is released. A heavy
  preset's `lure` takes over (`src/spawns/lure.js`). This is how a volcano plume shows 40 km away,
  above the fog and beyond the terrain view distance:
  `lure: { type: 'plume', height: 5200, width: 3400, color: 0x5d5754 }`.
- A preset that is not heavy can keep a cheap far emitter with `lod.far` of about 0.1-0.2 and low
  `fog`. Particles still sit inside the scene fog, so use the lure for anything that must read on
  the horizon.
- **Wind at the far tier.** The wind source is removed at `far` when its reach (`2 x radius +
  height`) is below the preset's `lod.mid`, because the far tier starts beyond `lod.mid` and the air
  cannot reach the player there. It is registered again when the spawn comes back to mid. A source
  that reaches farther (a 30 km ash column) stays.

## Budgets

- The engine caps are 16 emitters and 120 000 particles (the director's budget view).
- The pools hold 80 pages (81 920 particles, `alpha`) and 24 pages (24 576, `additive`).
- One emitter holds at most 32 768 particles and emits at most 4096 per frame.
- `instance.particles` reports the ring times the tier share, and the SpawnManager counts it against
  the engine cap every frame.
- The engine declares one real light (`budget.lights: 1`). Glows, lava and lanterns are otherwise
  emissive plus bloom.
- Per frame, the CPU cost is births only, plus the wind grids' WindField probes (2 a frame while a
  grid fills, then 1 every 5 frames across all emitters: one emitter's grid every 4 s at 60 fps,
  eight every 32 s), and 4 ground samples for a `hugGround` emitter only while its grid is stale
  after a move: a grid that stays put samples the terrain no more. The heavy work (motion, wind
  lookup, lighting) is on the GPU.
- The frame update makes no per-frame allocation, measured with collected objects included and
  with the clock running and the camera moving (see Measured cost for the residue V8's own
  re-optimisation leaves on WebGPU): the tables are typed arrays in
  uniform buffers, particles draw their random numbers in typed-array batches, births go through
  one typed array, numbers pass between the update's steps through typed arrays rather than call
  arguments, and no fractional number is written to a Vector3, a Color or an `{ x, y, z }` literal
  every frame. In the running game those hold boxed numbers (a new heap number for every
  fractional number written, even from optimised code), while a Vector4 or a class of the engine's
  own takes them in place. So the pools sit at the camera rounded to whole metres (their frame table
  is relative to that origin), the cloud look is Vector4s, the real light is written only when it
  changed (the intensity as a whole candela), a travelling anchor moves in whole metres, the wind
  grid's probe points are whole metres, and the wind source answers in a result of its own classes
  (`createWindSample`).
- Event work runs in its own functions: a burst (`fireBurst`), an eruption's voice trigger
  (`fireScheduleTrigger`), a wind-grid probe (`sampleFieldNode`, 12 a second), the plume's wind
  source answering a WindField query (`sampleEmitterWind`) and a voice level change
  (`sendVoiceLevel`, sent only when it moved by 1 %). They run a few times a second, too rarely for
  V8 to optimise them, and V8's baseline tiers keep every fractional number in a new heap number:
  tens of bytes a call. What else remains is outside the engine: three's own compute dispatch
  (WebGPU), the voice's setters, and the WindField's terrain lookups for each probe, which allocate
  in worldgen's noise (about 10 KB a probe, which is why probes are rationed).

## Recipes

Starting points for the Phase 2 and Phase 3 presets. Tune `scale` for the site size.

```js
// Volcano: the ash plume (lit from below by the lava at night) and its lava bombs
{ engine: 'emitter', params: { particles: 3000, style: 'puff', shape: { type: 'disc', radius: 120 }, speed: [22, 40], spread: 12,
  gravity: 0, buoyancy: 5, buoyancyDecay: 45, drag: 0.07, turbulence: { spread: 14, wobble: 18, frequency: 0.05 }, life: [45, 75],
  size: [120, 650], sizeCurve: 0.6, sizeJitter: 0.45, brightnessJitter: 0.22, colors: [0x6e6660, 0x5c5550, 0x9c968f], opacity: 0.8,
  softness: 1.2, fadeOut: 1.3, pulse: { period: 14, depth: 0.3 }, underglow: { color: 0xff5a1e, intensity: 2.2, height: 650 },
  light: { color: 0xff7030, intensity: 3e6, range: 5000, offset: [0, 180, 0] },
  windSource: { type: 'updraft', strength: 10, radius: 260, height: 3200, turbulence: 0.6 },
  immersion: { radius: 900, height: 4200, base: 150, fogColor: 0x4a4440 }, sound: false, lod: { near: 1, mid: 0.5, far: 0 } } }
{ engine: 'emitter', params: { particles: 1500, style: 'spark', blend: 'additive', shape: { type: 'disc', radius: 70 }, speed: [55, 110],
  spread: 32, gravity: 1, drag: 0.04, windFollow: 0.1, life: [7, 12], size: [7, 4], stretch: 0.07, colors: [0xffe0a0, 0xff6a20, 0x3a0c04],
  emissive: 7, emissiveDecay: 1.6, ground: 'settle', rate: 4, bursts: { interval: [2.5, 5], count: [25, 60] }, soundTriggers: { burst: 'boom' } } }

// Geyser: a scheduled steam jet with its updraft column (audio: geyser)
{ engine: 'emitter', params: { particles: 3000, shape: { type: 'disc', radius: 4 }, speed: [26, 40], spread: 6, gravity: 0.4, buoyancy: 3,
  buoyancyDecay: 6, drag: 0.35, turbulence: { spread: 3, wobble: 2.5, frequency: 0.3 }, life: [5, 9], size: [3, 32],
  colors: [0xffffff, 0xf3f5f7, 0xe4e8ec], opacity: 0.7, schedule: { period: [30, 40], active: [9, 12], idle: 0.04 },
  windSource: { type: 'updraft', strength: 14, radius: 25, height: 240 }, soundTriggers: { schedule: 'burst' } } }

// Waterfall mist at the plunge pool
{ engine: 'emitter', params: { particles: 4000, shape: { type: 'box', size: [220, 20, 70] }, hugGround: true, speed: [3, 8], spread: 60,
  buoyancy: 0.8, drag: 0.6, turbulence: { spread: 2, wobble: 3, frequency: 0.12 }, life: [8, 14], size: [10, 48],
  colors: [0xf6f9fc, 0xeef3f7, 0xe8eef3], opacity: 0.32 } }

// Microburst dust ring with its downburst and outflow
{ engine: 'emitter', params: { particles: 5000, shape: { type: 'ring', radius: 90, innerRadius: 60 }, hugGround: true, radial: 20,
  speed: [1, 3], spread: 20, gravity: 0.15, drag: 0.3, ground: 'settle', groundOffset: 2, turbulence: { spread: 4, wobble: 3, frequency: 0.15 },
  life: [6, 11], size: [8, 42], colors: [0xbca47e, 0xa48c6a, 0x8f7c64], opacity: 0.55,
  windSource: { type: 'downburst', strength: 12, radius: 400, height: 1600, outflow: 14, depth: 150 } } }

// Whale spout: bursts only
{ engine: 'emitter', params: { particles: 3000, shape: { type: 'disc', radius: 2 }, speed: [16, 26], spread: 9, gravity: 1, drag: 0.55,
  life: [2, 3.5], size: [1.5, 7], colors: [0xffffff, 0xf0f5f8, 0xe8eef2], opacity: 0.6, rate: 0,
  bursts: { interval: [2.5, 4], count: [350, 550], minLevel: 0 } } }

// Meteor fragment: a travelling spark trail
{ engine: 'emitter', params: { particles: 3000, style: 'spark', blend: 'additive', shape: { type: 'sphere', radius: 3 }, direction: 'radial',
  offset: [0, 700, 0], travel: [40, -30, 160], inherit: 0.3, speed: [4, 12], spread: 180, drag: 0.8, windFollow: 0.2, life: [0.8, 1.8],
  size: [3.5, 0.6], stretch: 0.12, colors: [0xfff4d0, 0xffa040, 0x802010], emissive: 8, emissiveDecay: 2, rate: 900 } }

// Sky lantern festival (audio: lantern): hundreds rising and drifting on the real wind
{ engine: 'emitter', params: { particles: 500, style: 'lantern', shape: { type: 'disc', radius: 260 }, hugGround: true, offset: [0, 3, 0],
  speed: [0.4, 0.9], spread: 10, gravity: 0, buoyancy: 1.3, drag: 0.35, windFollow: 0.6, turbulence: { wobble: 3, frequency: 0.08 }, life: [100, 150],
  size: [4, 3.4], sizeJitter: 0.15, colors: [0xffb45a, 0xff9a40, 0xff7a30], emissive: 1.6, fadeIn: 0.02, fadeOut: 4, nightBoost: 0.6, fog: 0.5 } }

// Comet dust tail (with the celestial engine's nucleus): pushed away from the sun
{ engine: 'emitter', params: { particles: 6000, style: 'glow', direction: 'antiSun', speed: [30, 60], spread: 8, gravity: 0, drag: 0.02,
  windFollow: 0, life: [40, 60], size: [60, 400], colors: [0xcfe6ff, 0xa8c8f0, 0x6080b0], opacity: 0.35, emissive: 0.6, fog: 0 } }

// Phase 3: sandstorm grit around the camera, carried by the wind
{ engine: 'emitter', params: { particles: 6000, attach: 'camera', shape: { type: 'box', size: [400, 120, 400] }, direction: 'wind',
  speed: [1, 3], gravity: 0.05, drag: 1.5, life: [3, 6], size: [0.4, 0.8], stretch: 0.05, colors: [0xc9a878, 0xb89468], opacity: 0.5 } }
// Phase 3: snow around the camera
{ engine: 'emitter', params: { particles: 8000, style: 'droplet', attach: 'camera', shape: { type: 'box', size: [300, 150, 300] },
  speed: [0, 0.5], gravity: 0.1, drag: 2, turbulence: { wobble: 0.8, frequency: 0.4 }, life: [6, 10], size: 0.12, colors: [0xffffff], opacity: 0.9 } }
// Phase 3: lava fountain, steam explosion, petal storm
{ engine: 'emitter', params: { style: 'spark', blend: 'additive', speed: [30, 60], spread: 20, drag: 0.05, ground: 'settle', life: [3, 5],
  size: [3, 2], colors: [0xfff0b0, 0xff5010, 0x300800], emissive: 6, emissiveDecay: 1.2, nightBoost: 0.5 } }
{ engine: 'emitter', params: { shape: { type: 'sphere', radius: 20 }, direction: 'radial', speed: [20, 50], spread: 180, rate: 0,
  bursts: { interval: [20, 40], count: [1500, 2500], minLevel: 0 }, gravity: 0.1, buoyancy: 2, buoyancyDecay: 8, drag: 0.4, life: [8, 14], size: [8, 60] } }
{ engine: 'emitter', params: { particles: 3000, style: 'droplet', shape: { type: 'disc', radius: 200, height: 40 }, swirl: 6, speed: [1, 2],
  gravity: 0.03, drag: 0.8, turbulence: { wobble: 2, frequency: 0.3 }, life: [10, 16], size: 0.3, colors: [0xffc0d8, 0xffe0ec], opacity: 0.85 } }
```

Fireflies are not an emitter: they are the lightEffect engine's `swarm` (points that hover and blink
with no motion to integrate). Pair an emitter with the lightEffect engine when a spawn needs both,
for example ash with lightning in a dirty thunderstorm.

## Instance, dev and stats

- `stats()` returns `{ instances, particles, lights, buffers, drawCalls, compute, pages: { alpha, additive } }`.
  `compute` is true on WebGPU.
- `describe(instance)` (dev) returns the tier and share, the pool, capacity, particles emitted,
  level, schedule phase and envelope, and whether the wind source, the light, the voice and the
  immersion are live.
- `dispose()` releases the row and the pages (every slot is cleared at once), the wind source, the
  light, the voice and the immersion modifier. The pools are built once in `init()`, so a spawn
  creates no GPU memory of its own.

## Measured cost

Measured on 2026-10-03 on the shared development machine (busy with other builds the whole time,
so frame intervals carry its noise), dev server, 1280 x 720, with `tools/steps/engine-emitter.json`
and `tools/engine-alloc.mjs`.

| | WebGPU (TSL compute) | WebGL2 (closed form in the vertex shader) |
| --- | --- | --- |
| seven emitters at once (plume, bombs, geyser, mist, dust ring, spout, lanterns), 17 900 particles at their tiers | 2 draw calls, 2 compute dispatches, 13 buffers | 2 draw calls, 9 buffers |
| engine CPU per frame (`update()` of all seven) | 0.25-0.36 ms (0.035-0.051 ms an emitter) | 0.06-0.19 ms (0.009-0.028 ms an emitter) |
| frame interval, seven emitters / none, same view | 9.3 / 9.3 ms, 9.0 / 8.4 ms | 7.1 / 6.5 ms, 7.8 / 7.3 ms |
| GPU memory a spawn creates | none: geometries, textures and attributes are the same at the peak as at the baseline | none |
| own frame-update allocations (3000 frames, after a 24 000-frame warm-up) | 0 to 5.4 B a frame across runs | 0 to 0.2 B a frame |
| event paths (bursts, eruption triggers, grid probes, wind queries, voice levels) | 2-8 B a frame | 4-6 B a frame |
| WindField terrain lookups for the grid probes (worldgen, outside the engine) | about 2 KB a frame | about 2 KB a frame |
| three's compute dispatch (outside the engine) | 0.3-0.65 KB a frame | none |

- A travelling emitter (`emDrift`) measured 0 B a frame of its own.
- The WebGPU frame-update residue is not a per-frame allocation (one would be at least 12 bytes
  every frame): it moves between functions from run to run (`refreshFields`, `advanceSchedule`,
  `update`) and is V8 re-optimising code after a deoptimisation, which runs the baseline code, which
  boxes its numbers, for a while. The WebGL2 runs, with no compute dispatch reshaping three's
  objects every frame, stay at 0.
- Before the probes were rationed and the grids' probe points became whole metres, the probes cost
  about 20 KB of terrain-noise garbage a frame and the engine's own code about 125 B a frame.

## Verification

`node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-emitter.json`
(add `--query renderer=webgl` for WebGL2) runs the following checks:

- First, paused at the start position (where the terrain has finished streaming), the memory
  cycle: a warm-up cycle, a wait for the GPU memory counts to hold still, then every configuration
  spawned and disposed. `renderer.info.memory` geometries, textures and attributes, the wind
  sources, the sky modifiers, the real lights, the engine's pages and its draw calls must return to
  the baseline exactly, with no leaks reported by the SpawnManager.
- It forces clear weather, starts seven configurations on sites with a clear view (dry land, or
  open water for the spout) in photo mode and screenshots them:
  - the ash plume with lava bombs at golden hour, at night (the lava light) and from inside
    (immersion);
  - the geyser (schedule and updraft probed);
  - waterfall mist;
  - the dust ring (downburst and outflow probed);
  - a whale spout;
  - a travelling spark trail and rising lanterns at night.
- It checks the far tier: the emission stops, the light is released and the unreachable updraft is
  removed, then all of it comes back near.
- It runs six configurations at once for the cost numbers: seven emitters (the plume and its bombs
  are two) in two draw calls.

`node tools/engine-alloc.mjs --url <dev server>/v2/ --steps tools/steps/engine-emitter.json --presets emVolcano,emGeyser,emMist,emDustRing,emSpout,emLanterns --frames 3000 --events fireBurst,fireScheduleTrigger,sampleFieldNode,sampleEmitterWind,sendVoiceLevel`
(add `--backend webgl`; `--presets emDrift` measures a travelling anchor, which the 12 s spark trail
does not outlive) samples the allocations of the frame updates, collected objects included, with
the clock running and the camera swaying; the event paths are reported apart.
