# celestial engine

The celestial engine adds things to the sky dome and drives the v1 sky, fog and light. It covers
meteors, comets, the total solar eclipse, the glory with its full-circle rainbow, and rainbows in
mist.

- Code: `src/spawns/engines/celestialEngine.js`.
- Parameters and their checks: `src/spawns/engines/celestial/params.js`.
- Meshes: `src/spawns/engines/celestial/materials.js`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'celestial', params: { ... } }`. A bad value throws a clear error that names the field,
for example `[DRIFTWING] celestial: param "meteors.rate" must be within 0.1..600, got -1`.

## Components

An instance is a set of optional components. Give at least one: `true` takes a component's defaults,
and an object overrides them. One preset can combine components, for example a meteor shower under a
comet, or an eclipse that also raises the stars.

| component | what it draws and drives | presets |
| --- | --- | --- |
| `meteors` | streaks from a radiant fixed among the stars (it turns with them), a seeded Poisson stream, fireballs that flash the sky and the land | meteor shower |
| `comet` | nucleus, coma, a curved dust tail pointing away from the sun, a straight ion tail; fixed among the stars | comet |
| `eclipse` | the moon's disc crossing the sun, corona, chromosphere, Baily's beads; a sky modifier that dims the sun and ambient light, darkens and tints the sky and fog, and raises the stars; the typed `wildlifeQuiet` event through totality | total solar eclipse |
| `glory` | drives the shared cloud optics (`uniforms.cloudGlory`, `uniforms.cloudBow`): the glory's coloured rings and the full-circle rainbow shine on every cloud (v1 field and weather volumes) around the antisolar point, where the craft's own shadow falls on the cloud tops below | glory + full-circle rainbow |
| `rainbow` | a rainbow (or a moonbow) inside a sphere of mist, lit by the sun or moon behind the viewer | the waterfall's daytime rainbow, Phase 3 moonbow |
| `sky` | a static sky modifier eased in and out with the instance | Phase 3: Milky Way core, blood moon, aurora nights |

## Parameters

### Instance

| param | unit | default | notes |
| --- | --- | --- | --- |
| `anchor` | `sky` or `world` | `world` with a rainbow, else `sky` | `sky` keeps the spawn's anchor `anchorDistance` from the camera toward the component's direction (eclipse: the sun; comet: the comet; meteors: the radiant; glory: the antisolar point). The spawn is then always near, and it is discovered when the player looks at it. `world` keeps the anchor where the spawn was activated (a rainbow at a waterfall; a heavy comet preset with a lure, whose sky objects fade out at the FAR tier while the lure shows) |
| `anchorDistance` | m (50..20000) | 1500 | with a sky anchor, keep `lod.near` above this value so the spawn stays at the NEAR tier |
| `fadeIn`, `fadeOut` | s | 6, 10 | presence ramps; `fadeOut` runs before the event's duration ends. The eclipse's crossing is its own ramp |
| `untilDawn` | bool | false | the event lasts the rest of the night: once the instance has seen the sun below `dawnElevation`, the sun climbing back past it cuts the duration to `fadeOut` from then, so it fades out and ends (`instance.ended`). A spawn started in daylight waits for a night first. `lifetime.duration` stays the cap (a frozen night clock never reaches dawn). Used by the comet |
| `dawnElevation` | deg (-18..20) | -6 | the sun elevation that ends an `untilDawn` night |
| `ownsAudio` | bool | the first engine entry of the preset owns `preset.audio` | |

### meteors

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radiant` | `{ azimuth, elevation }` deg | | seeded (elevation 30-70) | compass azimuth (0 north, 90 east) at activation; after that it turns with the stars |
| `rate` | per minute | 0.1..600 | 18 | Poisson arrivals from the spawn's seeded generator, so the stream is reproducible |
| `fireballChance` | 0..1 | | 0.05 | a fireball is brighter, wider and longer, and flashes |
| `fireballFlash` | 0..1 | | 0.6 | the flash: ambient light up to x2.6 and a greenish-white sky tint, decaying over about 0.3 s |
| `speed` | deg/s | 2..120 | 24 | angular speed (x0.75..1.25 per meteor) |
| `length` | deg or [min, max] | 0.5..90 | [5, 14] | streak length (x1.6 for fireballs) |
| `spread` | deg | 5..120 | 55 | how far from the radiant meteors start (at least 8 degrees) |
| `color`, `trail` | 0xRRGGBB | | 0xd9fff0, 0xffc98f | head and trail colours |
| `brightness` | factor | 0..4 | 1 | |
| `maxActive` | count | 1..48 | 24 | |
| `daylight` | bool | | false | when false, meteors fade out in a bright sky (the sun above -3 degrees; fully visible below -12) and under overcast |

The `meteor` audio recipe gets `setIntensity` (the shower's activity) and triggers: `streak` for
bright meteors and `fireball` for fireballs.

### comet

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `position` | `{ azimuth, elevation }` deg | | seeded circumpolar (18-32 degrees from the pole) | where it is at activation |
| `sidereal` | bool | | true | turns with the stars |
| `tailLength` | deg | 2..90 | 22 | the tail points away from the sun along the sky |
| `tailWidth` | deg | 0.2..30 | 4 | |
| `curvature` | -1..1 | | 0.3 | how far the dust tail bends |
| `headSize` | deg | 0.05..10 | 0.8 | the coma |
| `ionTail` | 0..1 | | 0.6 | the straight blue ion tail |
| `color`, `ionColor` | 0xRRGGBB | | 0xfff0d2, 0x7fb4ff | |
| `brightness` | factor | 0..4 | 1 | the comet fades out as the sun rises above -8 degrees, and under overcast |

### eclipse

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `crossingSeconds` | s | 10..3600 | min(90, 0.8 x duration) | first to last contact, centred in the event's duration |
| `totalitySeconds` | s | 1..600 | 14 | the crossing slows through totality (the moon's offset follows reach x \|u\|^p) |
| `pathAngle` | deg | | seeded (-34..34) | the moon's track across the sun |
| `offset` | sun radii | -3..3 | 0 | how far the track misses the centre (above about 0.06 the eclipse is only partial) |
| `moonScale` | x sun radius | 0.8..1.4 | 1.06 | below 1 the eclipse is annular, with a ring of sun left |
| `darkness` | 0..1 | | 0.78 | at totality (the sky modifier's darkness) |
| `stars` | 0..1 | | 0.95 | stars at totality |
| `corona` | factor | 0..3 | 1 | |
| `quietWildlife` | bool | | true | emits `wildlifeQuiet { source, quiet }` as the light fails (coverage above about 84 %), and again when it returns |

The eclipse's sky modifier (`<id>:celestial`, priority 30) sets these values, where
`dim = (1 - uncovered)^3`:

- `sunIntensity`: the uncovered share of the sun (at least 0.004);
- `ambient`: `1 - 0.72 x dim`;
- `darkness`: `darkness x dim`;
- `stars`: rising through totality;
- a deep-indigo `skyTint` at `0.55 x dim`;
- a dusky `fogColor` at `0.5 x dim`.

These values darken the sun, moon and hemisphere lights, the dome, the fog and the v1 clouds. They
apply only while the sun is up.

### glory

| field | unit | default | notes |
| --- | --- | --- | --- |
| `strength` | 0..2 | 1 | the glory's rings and the craft's shadow at their centre |
| `bow` | 0..2 | 0.7 | the full-circle rainbow at 42 degrees |
| `minSunElevation`, `maxSunElevation` | deg | 2, 70 | when the glory shows |

The glory lights cloud surfaces only, so it shows where cloud lies around the antisolar point. That
point is below the horizon while the sun is up, so the player sees the glory when looking down on a
cloud layer with the sun behind them. Preset filters (altitude above the cloud band) or a weather
volume `sheet` in the same preset put the cloud there.

### rainbow

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 5..20000 | 180 | the mist sphere |
| `height` | m | -2000..20000 | 120 | its centre above the anchor |
| `offset` | [x, z] m | | [0, 0] | in the activation heading's frame |
| `strength` | 0..3 | | 1 | |
| `secondary` | 0..1 | | 0.35 | the secondary bow |
| `light` | `sun` or `moon` | | `sun` | `moon` makes a faint, nearly white moonbow at night |

### sky

`sky` takes any of the sky modifier values: `sunIntensity`, `ambient`, `fogDensity`, `darkness`,
`overcast`, `stars`, `skyTint`, `skyTintAmount`, `fogColor`, `fogColorAmount`. It also takes
`when` (`always`, `day` or `night`). The values ease in with the instance's presence, and the engine
folds them with an eclipse or a fireball flash into the instance's one modifier.

## Behaviour

- **Positions.** The sun and moon directions come from `state.time` (`src/core/sun.js`), as the dome
  draws them. The eclipse's disc sits exactly on the dome's sun disc (radius `SUN_ANGULAR_RADIUS`
  from `src/render/sky.js`). Comets and radiants turn about the dome's celestial pole
  (`CELESTIAL_POLE_ELEVATION_DEG`) with the star field.
- **Drawing.** Sky objects are quads on a shell at 96 % of the camera's far plane. That shell lies
  outside the dome and beyond the weather volumes' compressed masses, so terrain and clouds in front
  hide the objects through the depth test. The quads ignore fog and add HDR light that the bloom
  picks up. The moon disc paints the dome's own sky colour over the sun, which keeps the light
  scattered in front of the moon, and it turns black at totality. The rainbow volume is an instanced
  sphere seen from inside and out: each fragment lights the chord of its view ray through the mist
  with the bow bands, which it shares with the clouds' optics in `cloudShading.js`.
- **Memory.** Every mesh is built once in `init()`; an instance only takes slots in them. So
  `dispose()` returns GPU memory exactly, and removes the instance's sky modifier, its voice, its
  meteors and (after the last instance) the cloud optics. The celestial engine registers no wind
  sources.
- **Budget.** `budget: { instances: 3, particles: 6000 }`, where particles are the active meteors.
  The engine holds 48 meteors, 3 comets, 2 eclipses and 3 rainbows at once.

## Measured cost

With every component live at once (48 meteor slots, a comet, an eclipse, a glory and a rainbow),
the engine's update takes 0.07 ms per frame on the shared test machine (0.072 on WebGPU, 0.070 on
WebGL2). It adds at most 5 draw calls of a few quads, plus a 1280-triangle sphere per rainbow. The
glory and the bow cost a few ALU operations in the cloud shader, and nothing when both are 0. The
update allocates nothing once optimised (see the weatherVolume page for the heap-profiler run that
covers both engines).

## Examples

```js
// Meteor shower (night)
{ engine: 'celestial', params: { meteors: { rate: 24, fireballChance: 0.06 } } }            // audio: { recipe: 'meteor' }

// Total solar eclipse (legendary, day): lifetime.duration about [150, 180] s
{ engine: 'celestial', params: { fadeIn: 0, fadeOut: 0, eclipse: { crossingSeconds: 90, totalitySeconds: 14 } } }

// Comet (lasts a night)
{ engine: 'celestial', params: { comet: { tailLength: 26, curvature: 0.35 } } }

// Glory + full-circle rainbow (day, above the clouds)
{ engine: 'celestial', params: { glory: { strength: 1, bow: 0.7 } } }

// The waterfall's daytime rainbow in its mist (with the weatherVolume mist in the same preset)
{ engine: 'celestial', params: { rainbow: { radius: 260, height: 160 } } }

// Phase 3: a moonbow, a Milky Way core night, a blood moon's darkened reddish night
{ engine: 'celestial', params: { rainbow: { radius: 260, height: 160, light: 'moon' } } }
{ engine: 'celestial', params: { sky: { stars: 1, darkness: 0.1, when: 'night' } } }
{ engine: 'celestial', params: { sky: { skyTint: 0x5a1c16, skyTintAmount: 0.35, ambient: 0.7, when: 'night' } } }
```

## Verification

`node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-celestial.json`
(add `--query renderer=webgl` for WebGL2) runs the following checks:

- the meteor shower and the comet at night, in flight;
- in photo mode, the eclipse partial, at the diamond ring and at totality: the modifier's darkness and
  stars, the sun light down to under 5 %, the birds quiet through `wildlifeQuiet`, and waking again
  after dispose;
- the glory on a cloud sea below the craft (the cloud optics uniforms on, then off again after
  dispose);
- the rainbow in a waterfall-like mist;
- every component created and disposed at once, with `renderer.info.memory` geometries, textures
  and attributes, the wind sources and the sky modifiers back to their baseline exactly.
