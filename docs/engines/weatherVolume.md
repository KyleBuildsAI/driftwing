# weatherVolume engine

Cloud masses built from instanced soft puffs in the v1 cloud look, plus rain, snow and dust shafts,
fog banks and the weather you feel from inside them. The code is in
`src/spawns/engines/weatherVolumeEngine.js`. The parameter defaults and the puff layouts are in
`src/spawns/engines/weatherVolume/forms.js`, and the meshes are in
`src/spawns/engines/weatherVolume/materials.js`. The puff geometry, the palette and the light
response are shared with the v1 cloud field through `src/render/cloudShading.js`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'weatherVolume', params: { ... } }`. Every parameter below is optional and falls back to
the default of the chosen `form`. A bad value throws a clear error that names the field, for example
`[DRIFTWING] weatherVolume: param "rain[0].kind" must be one of rain, snow, dust, got hail`.

## What a volume is

The `form` sets the shape, and each form covers a family of phenomena:

| form | shape | used for |
| --- | --- | --- |
| `tower` | a cauliflower tower on a flat base; optional anvil spreading downwind, overshooting top and a lowered, turning wall cloud | supercell, storm chase, snow squall cells, hurricane cells |
| `cumulus` | one heaped cloud, no anvil | towering cumulus, a microburst's parent cloud, pyrocumulus over a volcano |
| `lens` | a stack of smooth lens clouds | lenticular clouds, a pileus cap |
| `bank` | a low strip on the ground; optionally curved (`curve`) with a tall leading wall (`wall`) | fog banks, valley fog rivers (`fillBelow`), sandstorm walls, hurricane rain bands |
| `sheet` | a thin wide layer | a cloud sea (the glory preset), stratus decks, noctilucent clouds (`glow`, `ripple`) |
| `mist` | a column of puffs rising and swelling from its foot | waterfall mist, geyser steam |

The volume frame follows the activation heading. `x` points right, `z` points forward along the
heading, and `y` points up from the volume base. Towers lean their anvil forward (downwind), and lens
waves lift upwind of the cloud (`-z`).

## Parameters

### Shape

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `form` | | see above | `tower` | |
| `base` | m | -1000..20000 | tower 900, cumulus 800, lens 1800, bank 0, sheet 1400, mist 0 | height of the volume base |
| `baseMode` | | `agl`, `msl`, `anchor` | `agl` | `agl` measures from the ground (or the sea) under the anchor, `msl` from sea level, and `anchor` from the activation position's y (use it to put a layer at a given altitude) |
| `radius` | m | 10..60000 | tower 2600, cumulus 900, lens 1800, sheet 5000, mist 220 | tower or cumulus radius, lens half-length, sheet radius, mist radius |
| `height` | m | 10..20000 | tower 9000, cumulus 1200, bank 320, mist 380 | vertical extent (a bank's depth) |
| `puffs` | count | 1..1000 | tower 150, cumulus 40, lens 16 per layer, bank 90, sheet 150, mist 48 | body puffs; anvil and wall cloud puffs come on top |
| `detail` | share | 0..0.8 | 0.2..0.35 | share of small detail puffs (drawn at the NEAR tier only) |
| `puffSize` | share of radius | 0.1..1 | 0.42 (tower) | tower and cumulus puff size |
| `aspect` | ratio | 0.1..2 | 0.5 | lens width / length |
| `thickness` | m | 5..5000 | lens 200, sheet 160 | lens or sheet thickness |
| `layers` | count | 1..8 | 3 | lens stack |
| `gap` | m | 0..5000 | 140 | gap between lens layers |
| `length`, `width` | m | 10..100000 | 5000, 1400 | bank size (length along `x`, width along `z`) |
| `followTerrain` | bool | | true | a bank's puffs sit on their own ground |
| `wall` | 0..1 | | 0 | a bank's leading (`+z`) edge rises up to 4 times higher (a haboob wall) |
| `curve` | deg | -300..300 | 0 | bends a bank along an arc (rain bands) |
| `fillBelow` | m MSL | | null | a bank keeps only the puffs whose ground is below this height (valley fog rivers) |
| `ripple` | 0..1 | | 0 | a sheet's bands in height and brightness (noctilucent billows) |
| `rise` | m/s | 0..200 | mist 6 | mist puffs climb the column, swelling and fading at the top |
| `anvil` | object or null | | tower: `{}` | `{ radius 8500 m, thickness 1500 m, altitude (m above the base, default 0.84 x height), lean 2600 m (downwind offset), puffs 110, storm 0.3 }` |
| `overshoot` | 0..1 | | tower 0.5 | the dome above the anvil |
| `wallCloud` | object or null | | null | `{ radius (0.35 x radius), drop 350 m below the base, offset (-0.3 x radius along z, negative = rear), rotation 6 deg/s, puffs 22 }` |

### Look

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `storm` | 0..1 | | tower 0.6, bank 0.1, else 0 | darker, bluer-grey shadow sides and dimmer tops for the body (the anvil has its own `anvil.storm`; a wall cloud is always 1) |
| `tint` | 0xRRGGBB | | 0xffffff (bank 0xe6eaee, mist 0xf4f7f9) | albedo tint: ochre for dust, cold blue-white for snow |
| `brightness` | factor | 0.3..2 | 1 | per-puff brightness around this value |
| `billow` | 0..1 | | 0.15 | slow breathing of the puffs |
| `glow` | object or null | | null | `{ color 0x9fd4ff, strength 1 (0..8), when 'twilight' \| 'night' \| 'always' }`. The light is added after the haze. `twilight` means the sun is 1.5-18 degrees below the horizon (noctilucent clouds) |
| `haze` | object | | varies | `{ near m, far m, max 0..1 }`: aerial perspective from the true distance. It closes in with the sky's fog density |
| `farMode` | | `auto`, `coarse`, `hide` | `auto` | at the FAR tier: `auto` hides a heavy preset's volume (its lure takes over) and keeps a coarse mass otherwise |

### Life

| param | unit | default | notes |
| --- | --- | --- | --- |
| `formSeconds` | s | 25 for events, 0 for sites | the volume grows in, base first |
| `dissipateSeconds` | s | 30 | before the event's duration ends the volume dissipates, then sets `instance.ended` |
| `drift` | object or null | null | `{ speed m/s, heading deg (default: the activation heading) }` moves the anchor (a storm tracking across the land) |

### Rain shafts

`rain` is an array of up to 6 shafts, `'auto'` (a tower's default shaft under its forward flank) or
null.

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `offset` | [x, z] m | | [0, 0] | the foot in the volume frame |
| `radius` | m | 10..20000 | 0.5 x radius | |
| `top` | m above the base | -5000..20000 | 0 | shafts fall from the base to the ground |
| `density` | 0..1 | | 0.6 | curtain opacity and the rain at the camera |
| `fallSpeed` | m/s | 0.1..60 | rain 9, snow 1.4, dust 3 | streak motion |
| `kind` | | `rain`, `snow`, `dust` | `rain` | colour, streak shape and whether it wets the canopy (dust does not) |
| `lean` | m | -5000..5000 | 0 | the foot trails along `z` (wind shear) |
| `downdraft`, `outflow` | m/s | 0..60 | 0 | per shaft; when 0, `wind.downdraft` and `wind.outflow` apply |

### Inside and wind

| param | unit | default | notes |
| --- | --- | --- | --- |
| `insideFog` | object | tower `{ density 4.5, color 0x7a838f, darkness 0.25 }`, bank `{ 7, 0xd9dee4, 0.05 }`, ... | inside the volume, the sky modifier sets these fog density (x1..8), fog colour and darkness values, weighted by how deep the camera is |
| `canopyRain` | 0..1 | 0 | inside the volume itself (not only its shafts) rain wets the canopy (hurricane bands, squalls) |
| `wind.turbulence` | 0..1 | tower 0.45, cumulus 0.2, mist 0.15, sheet 0.1, lens and bank 0.05 | inside the mass |
| `wind.updraft` | m/s | 0 | under a tower's base, radius 0.6 x radius |
| `wind.downdraft` | m/s | 0 | inside the rain shafts (a microburst: 15-25) |
| `wind.outflow` | m/s | 0 | the gust front along the ground from each shaft, out to 3 shaft radii, below 350 m |
| `wind.wave` | object or null | null | a lens's standing wave: `{ lift 4 m/s upwind, sink 3 m/s downwind, rotor 0.5 turbulence beneath }` |

### Engine options

| param | default | notes |
| --- | --- | --- |
| `ownsAudio` | the first engine entry of the preset owns `preset.audio` | the voice plays at the anchor, with the growth as its intensity |

### Live control (set pieces)

`instance.control` holds values a set piece's ramps and `set` entries write directly
(docs/engines/setPiece.md, "Ramps and `set` values reach a child"):

| field | range | default | notes |
| --- | --- | --- | --- |
| `wallCloud` | 0..1 | 1 | how far the wall cloud hangs below the base, as a share of `wallCloud.drop`: 0 tucks it up under the base, 1 is its full drop. The storm chase ramps it from 0.15 to 1 while the supercell builds, so the wall cloud lowers as the copilot narrates. No effect on a volume without a `wallCloud` |

## Behaviour

- **LOD.** NEAR draws every puff. MID drops the detail puffs, and FAR keeps the core puffs as a coarse
  mass, or nothing for heavy presets with `farMode: 'auto'` (the lure takes over). Levels fade over
  1.5 s. The rain shafts show at NEAR and MID.
- **Far away.** Puffs and shafts beyond 92 % of the fog's far distance are pulled toward the camera
  along their own sight lines, into the band before 93 % of the camera's far plane. They keep their
  direction and their angular size, so a 20 km anvil stands on the horizon at its true size. The
  mapping is monotonic, so depth order holds within a volume.
- **Inside.** The camera's depth inside the puffs and its position in the shafts drive one sky
  modifier (`weatherVolume`, priority 15, above the regional weather at 10 and below the eclipse at
  30), the in-volume veil, the local streaks around the camera and, in the cockpit and FPV views, the
  canopy rain. The engine removes the modifier when no volume is left.
- **Wind.** One WindField source per volume, with the id `weather-<n>:weather`, is listed in
  `windSourceIds`. It is added at NEAR and MID, removed at FAR and on dispose. Keep `lod.mid` larger
  than the volume's reach plus its outflow (3 shaft radii), so that dropping the source at FAR never
  cuts wind the player could feel. A drifting volume re-indexes its bounds every 300 m of travel.
- **Storms elsewhere.** The v1 cloud field follows the regional weather through the sky modifiers
  (`sky.getModifierLevels()` in `cloudShading.js`): overcast turns the undersides a darker blue-grey
  and dims the tops, and an eclipse's darkness dims all of them. With clear weather the v1 look is
  pixel-identical to before (an A/B of the old and the new module in one page, at golden hour, noon,
  low sun and night, on both backends).
- **Budget.** `budget: { instances: 6, particles: 30000 }`. `instance.particles` counts the puffs
  and shafts drawn. The shared puff mesh holds 3072 puffs, and the shaft mesh holds 32 shafts.

## Examples

```js
// Supercell (heavy; its lure is the anvil): lod { near 6000, mid 22000, far 60000 }
{ engine: 'weatherVolume', params: {
  form: 'tower', base: 900, height: 9000, radius: 2600, storm: 0.7,
  anvil: { radius: 8500, thickness: 1500, lean: 2600 },
  overshoot: 0.6,
  wallCloud: { radius: 900, drop: 380, offset: -700, rotation: 8 },
  rain: [{ offset: [700, 1400], radius: 1500, density: 0.8, downdraft: 6, outflow: 10 }],
  wind: { updraft: 6, turbulence: 0.5 },
  drift: { speed: 8 },
} }

// Lenticular stack over a peak, aligned with the wind (heading = wind direction)
{ engine: 'weatherVolume', params: { form: 'lens', base: 1500, radius: 1800, aspect: 0.5, layers: 3, wind: { wave: { lift: 4, sink: 3, rotor: 0.5 } } } }

// Microburst: the parent cloud and the slamming shaft
{ engine: 'weatherVolume', params: { form: 'cumulus', base: 1100, height: 1400, radius: 1100, storm: 0.6,
  rain: [{ radius: 900, density: 0.9, downdraft: 20, outflow: 16 }] } }

// Waterfall mist (with the celestial engine's rainbow in the same preset)
{ engine: 'weatherVolume', params: { form: 'mist', radius: 260, height: 420, rise: 6 } }

// Fog bank, and a valley fog river
{ engine: 'weatherVolume', params: { form: 'bank', length: 4200, width: 1300, height: 300 } }
{ engine: 'weatherVolume', params: { form: 'bank', length: 9000, width: 1200, height: 160, fillBelow: 180 } }

// Phase 3: a sandstorm wall, a snow squall and a hurricane rain band
{ engine: 'weatherVolume', params: { form: 'bank', length: 12000, width: 1500, height: 500, wall: 0.8, tint: 0xd7a466, storm: 0.3,
  rain: [{ radius: 3000, kind: 'dust', density: 0.7 }], insideFog: { density: 7, color: 0xb98c55, darkness: 0.3 }, wind: { turbulence: 0.5 } } }
{ engine: 'weatherVolume', params: { form: 'bank', length: 3000, width: 1800, height: 700, wall: 0.4, tint: 0xeef3f8, canopyRain: 0.6,
  rain: [{ radius: 1400, kind: 'snow', density: 0.85, top: 700 }] } }
{ engine: 'weatherVolume', params: { form: 'bank', base: 600, followTerrain: false, length: 30000, width: 2500, height: 1500, curve: 60, storm: 0.6, canopyRain: 1,
  rain: [{ offset: [0, 0], radius: 5000, density: 0.8 }] } }

// Phase 3: noctilucent clouds
{ engine: 'weatherVolume', params: { form: 'sheet', base: 7000, radius: 9000, thickness: 90, ripple: 0.8, tint: 0xcfe4ff, glow: { color: 0x9fd4ff, strength: 1.2, when: 'twilight' } } }
```

## Measured cost

These numbers come from the cost section of `tools/steps/engine-weatherVolume.json` (photo mode,
fixed view, 3 s windows) on the shared, loaded test machine, WebGPU / WebGL2:

| scene | engine CPU per frame | triangles added | engine draw calls | frame interval |
| --- | --- | --- | --- | --- |
| no volume | 0 | 0 | 0 | 4.9 / 5.0 ms |
| the supercell (218 puffs and 1 shaft at MID) | 0.082 / 0.076 ms | +17.5k | 2 (puffs, shafts) | 5.8 / 4.9 ms |
| six volumes (545 puffs and shafts) | 0.14 / 0.14 ms | +43.6k | 2 | 5.7 / 5.1 ms |

Each puff is one instance of an 80-triangle icosahedron, and every volume shares one draw call. The
frame interval measures the whole machine, which other programs were loading at the time. The GPU
cost is the triangle count above: 0.16-0.22 million triangles for the whole frame, so the volumes add
11 to 27 %.

**Allocations.** The heap profiler sampled 12 000 manager frame updates (32-byte sampling interval)
with 8 weather volumes and 4 celestial instances live, after a 40 000-frame warm-up: 0.047 B per frame
on WebGPU and 0.021 B per frame on WebGL2 in both engines together, which is the profiler's floor.
While V8 still runs the engine's `update` in its mid tier (Maglev, roughly the first 6 000-18 000
updates), it boxes a few doubles across calls, about 5 B per frame, until the optimising tier takes
over.

## Verification

`node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-weatherVolume.json`
(add `--query renderer=webgl` for WebGL2) runs the following checks:

- It force-spawns every form ahead of the craft and screenshots them in photo mode (supercell at
  golden hour, midday and night, lenticular, fog bank, mist, cloud sea, snow squall, noctilucent).
- It spawns the supercell 34 km out: as a heavy preset its anvil lure takes over at the FAR tier,
  and with `farMode: 'coarse'` its own far mass (the core column and the anvil spine) stays; the
  wind source is gone in both.
- It probes the supercell's wind: a downdraft in the shaft, an updraft under the base, and the source
  removed on dispose.
- It checks the inside fog (modifier and veil), and the local rain and canopy rain under a shower in
  the cockpit, gone again in the chase view.
- It creates and disposes every form in photo mode, and checks that `renderer.info.memory`
  geometries, textures and attributes, the wind sources and the sky modifiers return to their
  baseline exactly.
