# waterEffect engine

The waterEffect engine adds local water deformation and shading onto the v1 ocean. It covers the
maelstrom's whirlpool, whale breach splashes, a waterspout's spray on the water, the bioluminescent
bay and the waterfall plunge pool. Phase 3 adds local lakes, rogue waves, tidal bores and a mirror
salt flat on the same layer.

- Engine: `src/spawns/engines/waterEffectEngine.js`.
- The shared water effects layer: `src/render/waterEffects.js`. The water system
  (`src/render/water.js`) creates it and adds its terms to the ocean shader.
- Test steps: `tools/steps/engine-waterEffect.json`. Cost and allocation check:
  `tools/engine-cost.mjs --engine waterEffect`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'waterEffect', params: { effect: '...', ... } }`. One engine entry is one effect. A preset
lists several entries to combine effects, for example a bay with splashes. A bad `effect` throws
`waterEffect: params.effect must be one of whirlpool, splash, spray, bioluminescence, plungePool`.

## The water effects layer

The layer belongs to the water system, and every water spawn shares it. Spawns reach it as the
engine ctx's `water`, and the game reaches it as `ctx.systems.water.effects`. Other engines (fauna,
vortex, emitter, setPiece and so on) call it directly. It is the generic disturbance and trail API.

- **Trail buffer.** A 256 x 256 two-channel texture laid toroidally over the world: 2.5 m texels
  in a 640 m window that scrolls with the camera, and texels entering the window are cleared.
  Channel R is bioluminescent excitation and channel G is white foam. Both decay on the CPU (glow
  in 2.8 s, foam in 6 s), only over the rows that hold something, and the bytes upload once per
  frame while anything is live. Foam shows everywhere. Excitation glows only inside a glow region.
- **Anything touching the water writes into it:**
  - the craft, through a contact query against its telemetry every frame. Below 3 m over open
    water it leaves a 5 m foam and glow trail. Down to 14 m its downwash stirs a weaker glow;
  - spawns, through the API below (whale wakes, breaches and spouts);
  - spray droplets that fall back onto the water, which leave small splats (up to 24 per frame).
- **Vortices (4 slots).** A whirlpool funnel displaced into the swell (a Rankine pressure dip) with
  spiral ridges. Its flow-mapped foam arms are noise advected around the eye at the Rankine angular
  speed, in two phases half a period apart, masked by trailing log-spiral arms. The funnel darkens
  the water toward the eye.
- **Ripple rings (8, round-robin).** Expanding ring waves from splashes and breaches: 7 m/s for 7 s,
  with 0.55 m crests at strength 1.
- **Glow regions (4 slots).** Bioluminescent water. Swell crests glow (the glowing surf), and every
  excitation in the trail buffer glows, stronger at night.
- **Spray droplets (6144, one instanced sprite batch).** Ballistic droplets with drag and the
  ambient wind, as mist that grows. They are lit by the sun and sky and glow inside a glow region.
- **Pools (4 slots).** Local water discs above sea level, such as a waterfall's plunge pool, with
  churning foam.
- **No cost at rest.** With nothing registered and an empty trail buffer, every added term is exactly
  zero and the shader skips the work (uniform branches). The ocean then renders exactly as in
  Phase 1. The layer's `stats()` then reads 0 vortices, glow regions, pools and trail rows, which
  the final step of tools/steps/engine-waterEffect.json checks once every spawn has ended and the
  trails have decayed.
- **Same path on both backends.** The layer uses only a DataTexture, uniform arrays and an instanced
  sprite batch, so WebGPU and WebGL2 run the same code and look the same.
- **Float32-safe positions.** They reach the GPU relative to the ocean grid's camera-snapped anchor.

### Layer API (for every engine)

Every call takes plain numbers or a descriptor the caller built once in `create()`, so the callers'
frame updates allocate nothing. Positions are world metres, and strengths are 0..1.

| call | what it does |
| --- | --- |
| `addWaterDisturbance(x, z, radius, foam, glow)` | foam and excitation in a disc (radius up to 40 m per write). Returns whether any of it lies inside the window |
| `addWaterTrail(x0, z0, x1, z1, radius, foam, glow)` | the same along a segment (a wake). Writes take the maximum, so repeated writes never saturate beyond their strength |
| `addFoamRing(x, z, radius, width, foam, glow)` | a thin foam ring (a decal around a splash) |
| `addRipple(x, z, strength)` | an expanding ring wave |
| `splash(x, z, strength, glow = 1)` | a full splash: a spray burst (40 + 260 x strength droplets), a foam disc and ring, a ripple and a glow splat. Strength 1 is a whale's full breach. Returns the droplets emitted |
| `createSpray(overrides)` / `emitSpray(spray)` | a spray descriptor (fields below) and a burst of `spray.count` droplets from it. Returns how many were emitted. Droplets beyond the batch's capacity are dropped and counted |
| `createVortex(overrides)`, `acquireVortex()`, `setVortex(slot, vortex)`, `releaseVortex(slot)` | a whirlpool slot (-1 when all 4 are in use) |
| `acquireGlowRegion()`, `setGlowRegion(slot, x, z, radius, strength, surf, colorHex)`, `releaseGlowRegion(slot)` | a glow region slot. The layer has one glow colour: the last one set |
| `createPool(overrides)`, `acquirePool()`, `setPool(slot, pool)`, `releasePool(slot)` | a pool disc slot |
| `surfaceHeightAt(x, z)` | sea level plus every vortex funnel (the swell is excluded). Engines use it to keep things on the water |
| `craftContact` | `{ touching, stirring, height, contacts }`: the craft's height above the water at the last frame |
| `stats()` | `{ vortices, ripples, glowRegions, pools, droplets, dropletsDropped, trailRows, trailUploads, craftContacts, craftHeight }` |

| spray field | unit | default | notes |
| --- | --- | --- | --- |
| `x`, `y`, `z` | m | 0 | emission point (y: the water surface plus a little) |
| `count` | droplets | 40 | per `emitSpray` call |
| `speed` | m/s | 8 | x0.55..1 per droplet |
| `up` | factor | 0.8 | scales the vertical launch speed |
| `spread` | rad | 0.6 | cone half-angle around the vertical |
| `ringRadius` | m | 0 | emit from a ring instead of a point |
| `swirl` | m/s | 0 | tangential speed around the ring (positive is counter-clockwise seen from above) |
| `size`, `sizeGrowth` | m, m/s | 0.9, 0.6 | sprite size and how fast it grows (mist) |
| `life` | s | 1.8 | x0.7..1.3 per droplet |
| `drag` | 1/s | 0.8 | |
| `gravity` | factor of g | 1 | small values make mist hang |
| `alpha` | 0..1 | 0.7 | |
| `glow` | 0..1 | 0 | glow inside a glow region |
| `inheritX`, `inheritY`, `inheritZ` | m/s | 0 | velocity added to every droplet (a moving whale's spout) |

| vortex field | unit | default | notes |
| --- | --- | --- | --- |
| `x`, `z` | m | 0 | centre |
| `radius` | m | 300 | outer radius of the funnel and the arms |
| `eyeRadius` | m | 36 | Rankine core |
| `depth` | m | 16 | funnel depth at the eye |
| `spin` | rad/s | 0.9 | angular speed at the eye (the foam flow follows the Rankine profile outward) |
| `arms` | count | 5 | foam arms |
| `twist` | factor | 8 | how tightly the arms wind |
| `ridge` | m | 0.6 | height of the spiral ridges |
| `foam` | 0..1 | 0.9 | |
| `direction` | 1 or -1 | 1 | 1 is counter-clockwise seen from above |
| `weight` | 0..1 | 1 | fades the whole vortex (spin-up, fade-out) |

## Effects

| effect | what it does | presets |
| --- | --- | --- |
| `whirlpool` | a funnel displaced into the ocean with spiral ridges and flow-mapped foam arms, spinning up over `spinUp` seconds, with mist over the eye | maelstrom |
| `splash` | splashes at the anchor: one at create (`interval: null`, after which the instance ends) or one every `interval` seconds, anywhere within `scatter` metres | breach splashes, set-piece impacts |
| `spray` | a continuous spray ring on the water with a foam ring and swirl. `follow` makes it track another part of the same spawn | the waterspout's base |
| `bioluminescence` | a glow region: glowing surf on the swell crests, plankton flashes near the camera, and every trail in the water glows (the craft, whales, spray) | bioluminescent bay |
| `plungePool` | a waterfall's plunge pool: a local water disc where the pool lies above the sea (from the site's `cliffStep` stamp), churning foam, rising mist and ripples | mega-waterfall |

The whale pod's own wakes, spouts and breach splashes come from the fauna engine through the layer
API, so a whale pod needs no waterEffect entry. A pod inside a bioluminescent bay glows by itself.

## Parameters

Every field is optional except `effect`. A field set on the preset overrides the effect's default.

### Common

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `effect` | id | see Effects | `'splash'` | |
| `fadeIn` | s | 0..60 | 2 | presence ramps up from creation |
| `fadeOut` | s | 0..60 | 3 | events fade out over their last `fadeOut` seconds before their duration ends |
| `follow` | engine entry index or null | | null | the anchor follows another part of the same spawn each frame (x and z), for example `follow: 0` for a waterspout whose entry 0 is the vortex engine |
| `voice` | bool | | false | when true and `preset.audio` is set, this entry spawns the preset's voice (intensity `voiceIntensity` x fade, at the anchor). Usually the vortex or fauna entry owns the voice instead |
| `voiceIntensity` | 0..1 | | 1 | |
| `glow` | 0..1 | | per effect | excitation left in the trail buffer (it shows only inside a glow region) |

### whirlpool

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 20..1500 | 320 | outer radius (x the activation's scale) |
| `eyeShare` | fraction of radius | 0.03..0.5 | 0.11 | the eye (Rankine core) radius, at least 4 m |
| `depth` | m | 0..80 | 18 | funnel depth at the eye (x scale) |
| `spin` | rad/s | 0.05..4 | 0.8 | angular speed at the eye |
| `arms` | count | 1..12 | 4 | foam arms |
| `twist` | factor | 1..20 | 8 | how tightly the arms wind |
| `ridge` | m | 0..3 | 0.7 | spiral ridge height (x scale) |
| `foam` | 0..1 | | 0.9 | arm foam |
| `direction` | 1 or -1 | | 1 | 1 is counter-clockwise seen from above (the northern hemisphere) |
| `spinUp` | s | 0..120 | 12 | the funnel deepens and the arms form over this time (smoothstep) |
| `mistRate` | droplets/s | 0..400 | 45 | mist rising over the eye, swirling with the eye's spin |
| `mistSize` | m | 1..30 | 7 | |
| `glow` | 0..1 | | 0 | mist glow inside a glow region |

The whirlpool authors no wind source: the maelstrom's air column above it is the vortex engine's
entry in the same preset.

### splash

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `interval` | s, `[min, max]` or null | | null | null splashes once at create and then ends the instance. A number or range repeats it |
| `strength` | 0..1 | | 0.6 | see `splash()` above. It scales with the fade |
| `scatter` | m | 0..2000 | 0 | each splash lands anywhere within this radius of the anchor |
| `glow` | 0..1 | | 0.6 | |

### spray

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `ringRadius` | m | 1..200 | 22 | emission ring radius (x scale) |
| `rate` | droplets/s | 0..2000 | 260 | at near; a third at mid |
| `height` | m/s | 1..60 | 11 | launch speed (the spray's height) |
| `spread` | rad | 0..1.5 | 0.45 | cone half-angle |
| `swirl` | m/s | -40..40 | 9 | tangential speed around the ring |
| `size` | m | 0.2..10 | 1.3 | droplet size |
| `life` | s | 0.3..10 | 2.4 | droplet life |
| `foam` | 0..1 | | 0.6 | the foam ring rewritten every 0.25 s (its width is 0.35 x the ring radius, at least 3 m) |
| `glow` | 0..1 | | 0.4 | |

### bioluminescence

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 50..4000 | 900 | the glowing disc (x scale) |
| `strength` | 0..1.5 | | 1 | how brightly excitation glows |
| `surf` | 0..1.5 | | 0.6 | how brightly the swell crests glow on their own |
| `color` | 0xRRGGBB | | 0x1f9dff | the glow colour. The layer has one glow colour, the most recently set region's |
| `flashRate` | flashes/s | 0..100 | 12 | plankton flashes 30-200 m around the camera while it is inside the region (near only) |
| `flashRadius` | m | 0.5..20 | 4.5 | x0.6..1.4 per flash |

The glow brightens with the night factor, so a bay preset should use the filter
`timeOfDay: ['night']`. At night bloom picks up the glow.

### plungePool

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m or null | 5..400 | from the stamp, else 50 | the water disc radius (x scale) |
| `surfaceY` | m MSL or null | | from the stamp, else the anchor's height | the pool's water level |
| `churn` | 0..1 | | 0.85 | churning foam on the disc |
| `mistRate` | droplets/s | 0..600 | 120 | rising mist |
| `mistSize` | m | 1..30 | 5.5 | |
| `rippleInterval` | s | 0.2..10 | 1.4 | when the pool lies on the open sea: a ripple and a foam disturbance this often |
| `glow` | 0..1 | | 0 | |

- **Placement from a waterfall site.** At a site with a `cliffStep` stamp, the pool takes the
  stamp's `poolX` and `poolZ`, its water level 0.6 m below the pool's rim (`bottomY - 0.6`), and a
  radius where the bowl is that deep. The instance's anchor moves there.
- **Pools at sea level.** A pool that would not stand at least 0.5 m above the sea becomes churn on
  the ocean itself, with ripples and foam.

## LOD

| tier | what runs |
| --- | --- |
| near | everything |
| mid | the vortex, glow region and pool stay. Spray and mist run at 0.35 x their rate, with no plankton flashes |
| far | the slots are released and the spray stops (the ocean grid ends 4 km from the camera, so the pool and the glow are invisible there). They are taken again on the way back in |

- **Slots are pooled.** When the layer's slots are full, an instance retries once a second and
  shows nothing until it gets one.
- **Particle accounting.** `instance.particles` reports the droplets the effect keeps alive at full
  rate (rate x life), scaled by the tier, against the engine's particle cap.

Suggested `lod` values: the maelstrom `{ near: 2500, mid: 4500, far: 12000 }`, the bay
`{ near: 2000, mid: 4000, far: 9000 }`, splash and spray effects within the preset that owns them.

## Wind and audio

- **Wind.** The engine authors no wind sources (`windSourceIds` stays empty). Wind belongs to the
  vortex and windModifier entries of the same preset.
- **Audio.** Only an entry with `voice: true` spawns `preset.audio`'s voice, and it is disposed with
  the instance.

## Memory

The engine creates no GPU resources per instance. It borrows slots and droplets from the layer, so
`dispose()` returns memory by construction: it gives the slots back and disposes the voice. The
layer's own resources are the trail texture, the droplet batch (one instanced mesh) and the pool
batch. They are built once with the water system and prewarmed behind the loading fade.

## Example params

```js
// Maelstrom (with a vortex engine entry for the air column)
{ engine: 'waterEffect', params: { effect: 'whirlpool', radius: 340, spin: 0.7, arms: 5, spinUp: 20 } }
// Bioluminescent bay with gentle surf splashes
{ engine: 'waterEffect', params: { effect: 'bioluminescence', radius: 1100, strength: 1.1, surf: 0.7 } },
{ engine: 'waterEffect', params: { effect: 'splash', interval: [3, 7], scatter: 500, strength: 0.25, glow: 0.9 } }
// Waterspout base, following the vortex entry 0
{ engine: 'waterEffect', params: { effect: 'spray', follow: 0, ringRadius: 18, rate: 220 } }
// Mega-waterfall plunge pool (site; the cliffStep stamp places it)
{ engine: 'waterEffect', params: { effect: 'plungePool', churn: 0.9, mistRate: 160 } }
```
