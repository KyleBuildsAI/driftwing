# lightEffect engine

Lightning that lights the scene and the clouds, glows, firefly swarms, lantern and lamp light, and
sweeping beams, under a strict budget of real lights. The code is in
`src/spawns/engines/lightEffectEngine.js` (params, strikes, lights), `src/spawns/engines/glowPoints.js`
(the glow and swarm points) and `src/spawns/engines/ribbons.js` (bolts, the in-cloud flash, beams).
Shared helpers are in `src/spawns/engines/engineKit.js`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'lightEffect', params: { ... } }`. One entry can combine every component (a storm's
lightning, a vent's glows and its light, a lighthouse's beam and lamp). Every parameter below is
optional. A bad value throws a clear error that names the preset and the field, for example
`[DRIFTWING] lightEffect preset "fireflies": param "swarm.blink.duty" must be within 0..1, got 3`.
Unknown keys are refused too.

## How it works

- **Real lights are strict.** The engine declares 2 real lights (`budget.lights: 2`) and never
  holds more, even when the shared light pool has one free that another engine declared. A light
  is taken from the pool (`ctx.lights`) by priority, only while it matters, and is released at the
  far tier and on dispose:
  - a strike's flash (priority 3 by default), for its few tenths of a second;
  - a steady light (a lava vent, a lantern launch, a lamp) while the spawn is near or mid.

  A strike that finds the engine at its cap takes the light of the engine's own lowest-priority
  steady light, whose holder asks again a second later. Everything else is emissive colour plus
  bloom.
- **Lightning.**
  - Bolts are seeded, branching emissive ribbons (midpoint displacement with forks) in one of 4 shared
    bolt slots. The return strokes flicker over a few tenths of a second.
  - An in-cloud flash billboard lights the cloud base around the strike.
  - A sky and ambient flash goes through the sky modifier API (the `flash` field, priority 30). It
    adds the bolt's colour to the sky palette, the fog colour and the hemisphere light.
  - One real light is placed low in the channel.
  - Thunder is delayed by distance / 343 m/s (`audio.thunder`, or the preset's own `thunder` voice).
  - A bolt keeps at least about 2 px of width on screen, so a strike 10 km away still reads as a line.
- **Glows and swarms.**
  - The points live in one shared additive pool, one draw call for every instance.
  - They drift, blink, pulse and flicker in the vertex shader with no per-point CPU work, identical
    on WebGPU and WebGL2.
  - A far point keeps a minimum size on screen and dims with it, so a swarm 500 m away is a faint
    glitter rather than nothing.
  - Points take the scene's own haze (the sky's `fogAmountNode`).
- **Beams.** A lighthouse's spokes are ribbons in one of 4 shared beam slots, sweeping around the
  vertical axis in the shader on the scene clock.
- **Night first.** Glows, swarms and beams fade with the time of day (`visibility`, `beam.night`,
  `light.night`), so a preset looks right at night and golden hour and is quiet at noon.

### Local frame

Offsets are `[right, up, forward]` in metres, in the frame of the activation heading. `scale` from
the activation multiplies every length marked "scaled".

## Parameters

### Lightning (`lightning`, object or omitted)

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `rate` | strikes/min | 0..600 | 6 | mean rate at intensity 1 (a Poisson process, at least 0.25 s apart) |
| `radius` | m, scaled | 0..100000 | 3000 | strikes land within this of the anchor |
| `cloudBase` | m, scaled | 50..20000 | 1400 | channel top above the anchor |
| `groundShare` | 0..1 | | 0.55 | share of cloud-to-ground strikes; the rest are in-cloud (spider) discharges, dimmer and along the cloud base |
| `color` | 0xRRGGBB | | 0xcfe0ff | bolt colour (and the sky flash colour) |
| `width` | m | 0.1..200 | 4 | channel half-width (at least 2 px on screen) |
| `brightness` | HDR gain | 0..100 | 6 | bolt brightness (over 1 blooms) |
| `branches` | count | 0..24 | 6 | forks per bolt (in-cloud: at most 4) |
| `strokes` | count | [min, max], 1..8 | [1, 4] | return strokes per flash |
| `duration` | s | 0.1..5 | 0.7 | how long a bolt stays lit |
| `flash` | 0..1 | | 0.6 | sky and ambient flash at full strength (brighter at night: 35 % by day) |
| `flashRange` | m | 1..200000 | 18000 | the flash fades out between a quarter of this and this |
| `cloudGlow` | object | | | `{ radius m (scaled) = 1600, intensity 0..50 = 1.2, color = color }`: the lit cloud base |
| `light` | object or false | | `{}` | the strike's real light: `{ intensity cd (0..1.07e9) = 2e7, range m = 8000, priority 0..100 = 3 }`; `false` for none |
| `thunder` | 0..1.5 | | 1 | thunder intensity (in-cloud strikes 60 %); 0 for silent lightning |
| `intensity` | 0..1 | | 1 | activity while active |
| `inactiveIntensity` | 0..1 | | 0 | activity while a site is dormant |
| `minCameraDistance` | m | 0..100000 | 350 | strikes never land closer to the camera (a storm chase should awe, not blind) |

### Glows (`glows`, array of objects)

Each entry is a group of points: one lamp, a ring of crystal tips, a field of lava vents.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | points | 1..12000 | 1 | |
| `layout` | | `point`, `ring`, `scatter`, `line` | `point` | `ring` spaces the points on a circle of `radius`, `scatter` fills a disc of `radius`, `line` spreads them over `length` along forward |
| `offset` | m, scaled | [r, u, f] | [0, 0, 0] | the group's centre |
| `radius` | m, scaled | 0..100000 | 50 | ring and scatter radius |
| `length` | m, scaled | 0..100000 | 500 | line length |
| `height` | m, scaled | [min, max] | [0, 0] | seeded height above the base |
| `onGround` | bool | | false | the base is the ground (or water) under each point, not the anchor |
| `size` | m, scaled | [min, max], 0.01..50000 | [20, 20] | sprite size (halo included) |
| `color` or `colors` | 0xRRGGBB or an array | | 0xffb060 | a seeded pick per point |
| `intensity` | HDR gain | 0..200 | 2 | |
| `pulse` | object or null | | null | `{ period s = 4, depth 0..1 = 0.4 }`: a slow breathing (ignored with `blink`) |
| `blink` | object or null | | null | `{ period [s, s] = [2, 4], duty 0..1 = 0.3 }`: lit for `duty` of each seeded period |
| `flicker` | 0..1 | | 0 | fast firelight flicker |
| `wander` | object | | `{ radius 0 }` | `{ radius m = 0, speed rad/s = 0.3, vertical share = 0.5 }`: drift around home |
| `shape` | | `orb`, `flare`, `firefly` | `orb` | a hot core in a halo, the same with a horizontal streak (lamps, beacons), or a tight point |

### Swarm (`swarm`, object or omitted)

Fireflies and other living lights: points hovering over the ground under the anchor.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | points | 1..12000 | 1500 | |
| `radius` | m, scaled | 1..20000 | 150 | disc they fill |
| `height` | m | [min, max], -100..2000 | [0.5, 4] | above the ground under each |
| `size` | m | [min, max], 0.01..100 | [0.8, 1.3] | sprite size: a hot core of about a fifth in a soft halo |
| `colors` | 0xRRGGBB array | | [0xd8ff6a, 0xfff08a, 0xb8ff8a] | |
| `intensity` | HDR gain | 0..200 | 4 | |
| `blink` | object | | `{ period [2, 5], duty 0.25 }` | |
| `sync` | 0..1 | | 0.2 | 0 blinks at random phases, 1 blinks all together (synchronous fireflies) |
| `wander` | object | | `{ radius 1.5, speed 0.35, vertical 0.5 }` | |

One instance holds at most 12 000 points (glows and swarm together).

### Steady light (`light`, object or omitted)

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `color` | 0xRRGGBB | | 0xffa050 | |
| `intensity` | cd | 0..1.07e9 | 2e5 | rounded to a whole candela when applied |
| `range` | m | 1..100000 | 600 | the light's cutoff distance |
| `offset` | m, scaled | [r, u, f] | [0, 10, 0] | |
| `flicker` | 0..1 | | 0 | firelight flicker |
| `pulse` | object or null | | null | `{ period s = 4, depth 0..1 = 0.4 }` |
| `priority` | 0..100 | | 1 | pool priority (a strike, 3, outranks it) |
| `night` | 0..1 | | 1 | 1 lights only at night, 0 always |

### Beam (`beam`, object or omitted)

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `offset` | m, scaled | [r, u, f] | [0, 30, 0] | the lamp |
| `count` | spokes | 1..8 | 2 | evenly spaced around the vertical |
| `length` | m, scaled | 1..50000 | 1200 | |
| `width` | m, scaled | [start, end] half-widths | [2, 60] | the beam widens away from the lamp |
| `color` | 0xRRGGBB | | 0xfff2d0 | |
| `intensity` | HDR gain | 0..100 | 1.2 | |
| `period` | s | 0.1..3600 | 12 | one turn |
| `tilt` | deg | -89..89 | 2 | upward tilt of the spokes |
| `night` | 0..1 | | 1 | 1 shines only at night |

### Common

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `visibility` | object | | `{ day 0.15, night 1 }` | the glows' and swarm's level by day and by night (blended by the night factor) |
| `fog` | 0..1 | | 0.7 | how much the scene haze takes the glows |
| `lod` | object | | `{ near 1, mid 1, far 0.8 }` | the glows' level at each tier |
| `sound` | bool | | true | opens the preset's `audio` voice |
| `soundIntensity` | | `activity`, `approach` | `activity` | the voice follows the storm's activity, or the camera's approach within `lod.mid` (crystal spires hum louder as you close in) |
| `endRamp` | s | 0..600 | 4 | an event fades its lightning and glows over this after its duration, then ends |

## LOD and the far tier

- Strikes happen only at the near and mid tiers; a heavy storm's lure flashes beyond (the lure's
  `flash` option).
- The real lights (steady and strike) are released at the far tier.
- Glows keep `lod.far` (0.8) of their level at the far tier, so lava vents, lanterns and a lighthouse
  read as lights on the dark horizon.
- The engine owns no wind sources.

## Budgets

- 8 instances (glow groups) and 30 000 points, the director's budget view. The pool holds 120 pages
  of 256 points (30 720).
- 4 bolt slots and 4 beam slots, shared across instances. A fifth bolt reuses the oldest slot.
- 2 real lights, as described above.
- `instance.particles` reports the instance's points. `instance.lights` reports the real lights it
  holds.
- Per frame, the CPU cost is a few numbers per instance (fade, strike timer, light placement) and one
  table row. Bolt geometry is written only when a strike fires (at most 192 segments), and glow
  points only at create and dispose.
- The frame update makes no per-frame allocation, measured with collected objects included and
  with the clock running and the camera moving (see Measured cost): the intensities are vec4
  uniforms, the glow group table is a typed-array uniform buffer relative to the pool's origin (the
  camera rounded to whole metres, so the mesh's position takes small integers), the real lights and
  the beam are written only when they changed (a light's intensity as a whole candela), and the
  beam turns in the shader on the scene clock (`uniforms.time`), from its start time and period. In
  the running game a Vector3 or a Color holds boxed numbers, so a fractional number written to one
  every frame would be a new heap number each time.
- A strike (`strike`) and a voice level change (`sendVoiceLevel`, sent only when it moved by 1 %) are
  event work: a strike draws its random numbers in one typed-array batch and writes its bolt through
  a typed-array scratch, but it runs a few times a second at most, too rarely for V8 to optimise it,
  and V8's baseline tiers keep every fractional number in a new heap number (a few hundred bytes a
  strike).

## Recipes

```js
// Supercell or dirty thunderstorm lightning (with the weatherVolume cloud; audio: thunder)
{ engine: 'lightEffect', params: { lightning: { rate: 10, radius: 4000, cloudBase: 1500, groundShare: 0.6, branches: 8, flash: 0.7 },
  visibility: { day: 1, night: 1 } } }
// A dirty thunderstorm in an ash plume: in-cloud flashes, warmer
{ engine: 'lightEffect', params: { lightning: { rate: 20, radius: 600, cloudBase: 1200, groundShare: 0.2, color: 0xe8d8ff, width: 2.5, branches: 5, flash: 0.4, thunder: 0.7 } } }

// Lava glow at a vent: glows on the ground and a flickering real light at night
{ engine: 'lightEffect', params: {
  glows: [
    { layout: 'scatter', count: 14, radius: 45, onGround: true, height: [2, 6], size: [25, 60], colors: [0xff5a1e, 0xff7a2a], intensity: 1.6, flicker: 0.35 },
    { layout: 'scatter', count: 60, radius: 70, onGround: true, height: [1, 3], size: [3, 8], colors: [0xffb040], intensity: 3, flicker: 0.6, wander: { radius: 2, speed: 0.6 } },
  ],
  light: { color: 0xff6a2a, intensity: 8e4, range: 700, offset: [0, 25, 0], flicker: 0.3, night: 0.7 }, visibility: { day: 0.5, night: 1 } } }

// Fireflies over a meadow at night
{ engine: 'lightEffect', params: { swarm: { count: 3000, radius: 160, height: [0.6, 5], intensity: 5, blink: { period: [2, 4.5], duty: 0.3 }, sync: 0.35 },
  visibility: { day: 0, night: 1 } } }

// Crystal spires: pulsing tips that hum louder as you approach (audio: crystal)
{ engine: 'lightEffect', params: { glows: [{ layout: 'ring', count: 9, radius: 90, onGround: true, height: [25, 70], size: [18, 30],
  colors: [0x7fe8ff, 0xb48cff], intensity: 3, pulse: { period: 5, depth: 0.5 }, shape: 'flare' }], visibility: { day: 0.35, night: 1 }, soundIntensity: 'approach' } }

// Lighthouse: sweeping beams, the lamp flare and its light (one instance per lighthouse of a chain)
{ engine: 'lightEffect', params: { beam: { offset: [0, 40, 0], count: 2, length: 1600, width: [3, 70], intensity: 1.4, period: 10 },
  glows: [{ offset: [0, 40, 0], size: [40, 40], colors: [0xfff2d0], intensity: 6, shape: 'flare' }],
  light: { color: 0xfff0d0, intensity: 5e4, range: 600, offset: [0, 40, 0] }, visibility: { day: 0.1, night: 1 } } }

// Sky lantern launch: the light at the launch field (the lanterns themselves are the emitter's `lantern` style)
{ engine: 'lightEffect', params: { glows: [{ layout: 'scatter', count: 40, radius: 120, onGround: true, height: [1, 2], size: [4, 7], colors: [0xffb45a], intensity: 2, flicker: 0.2 }],
  light: { color: 0xffa050, intensity: 6e4, range: 500, offset: [0, 15, 0], flicker: 0.15 } } }

// Phase 3: aurora-lit ice, will-o'-the-wisps, bioluminescent caves
{ engine: 'lightEffect', params: { glows: [{ layout: 'scatter', count: 12, radius: 300, height: [2, 8], size: [2, 3], colors: [0x9fffe0], intensity: 4,
  wander: { radius: 30, speed: 0.1, vertical: 0.3 }, blink: { period: [6, 12], duty: 0.6 } }], visibility: { day: 0, night: 1 } } }
```

## Instance, dev and stats

- `stats()` returns `{ instances, particles, lights, buffers, drawCalls, bolts, beams, strikes }`:
  - `lights` is the exact count held now;
  - `strikes` counts strikes, ground and in-cloud strikes, thunder requests, thunder the audio
    engine queued (it needs a listener, so none before the audio has started) and skipped strikes.
- `describe(instance)` (dev) returns the tier, fade, drawn glow level, activity, points, lights held,
  bolts in flight, the sky flash, and whether the beam and the voice are live.
- `dispose()` releases the points (cleared at once), the group row, the bolt and beam slots, both
  lights, the sky flash modifier and the voice. The meshes and materials are built once in `init()`,
  so a spawn creates no GPU memory of its own.

## Measured cost

Measured on 2026-10-03 on the shared development machine (busy with other builds the whole time,
so frame intervals carry its noise), dev server, 1280 x 720, with `tools/steps/engine-lightEffect.json`
and `tools/engine-alloc.mjs`.

| | WebGPU | WebGL2 |
| --- | --- | --- |
| five effects at once (storm, 3000 fireflies, lava glow, crystals, lighthouse), 3084 points | 2-6 draw calls (the point pool, the beam, bolts and cloud flashes while lit), 41 buffers, 2 real lights | the same |
| engine CPU per frame (`update()` of all five) | 0.035-0.039 ms (0.007-0.008 ms an effect) | 0.031-0.035 ms (0.006-0.007 ms an effect) |
| frame interval with all five | 7.8-10.3 ms | 6.9-9.4 ms |
| GPU memory a spawn creates | none: the meshes are built in `init()` | none |
| own frame-update allocations (3000 frames, after a 24 000-frame warm-up) | 0 to 0.2 B a frame | 0 B a frame |
| strikes (event path) | 1.6 B a frame once optimised (26 B a frame with a short warm-up, while strikes still run in V8's baseline tiers) | 0 B a frame |
| the sky modifier's `set()` during a flash (sky.js, outside the engine) | about 12 B a frame while a bolt is lit | about 10 B a frame |

- Thunder requests are queued by the audio engine only once it has a listener (after the first
  user gesture), so the headless runs count requests, not sounded thunder.
- Before the lights were written only when they changed and the beam moved onto the scene clock,
  the frame update cost about 100 B a frame.

## Verification

`node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-lightEffect.json`
(add `--query renderer=webgl` for WebGL2) runs the following checks:

- First, paused at the start position (where the terrain has finished streaming), the memory
  cycle: a warm-up cycle, a wait for the GPU memory counts to hold still, then every configuration
  spawned and disposed. `renderer.info.memory` geometries, textures and attributes, the wind
  sources, the sky modifiers, the real lights, the bolts, the beams and the engine's draw calls must
  return to the baseline exactly.
- It forces clear weather, starts five configurations in photo mode (the lava glow, crystals and
  lighthouse on sites with a clear view, the fireflies on the flattest meadow) and screenshots them:
  - a lightning storm at night and at golden hour (captured while a bolt is lit), with strikes,
    bolts, the sky flash, the strike's real light and thunder requests checked;
  - fireflies at night (3000 points in one draw call, no real light), gone by day;
  - a lava glow with its steady light;
  - crystal glows with their approach voice;
  - a lighthouse beam with its lamp light.
- It checks the far tier (no strikes, no real light), and that the flash modifier leaves with the
  storm.
- It runs the light budget: two steady light holders and a storm at once never hold more than the 2
  declared lights, and the strike wins its light by priority.
- It runs every configuration at once for the cost numbers.

`node tools/engine-alloc.mjs --url <dev server>/v2/ --steps tools/steps/engine-lightEffect.json --presets leStorm,leFireflies,leLavaGlow,leCrystals,leLighthouse --frames 3000 --events strike,sendVoiceLevel`
(add `--backend webgl`) samples the allocations of the frame updates, collected objects included,
with the clock running and the camera swaying; strikes are reported apart.
