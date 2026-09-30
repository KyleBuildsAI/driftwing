# windModifier engine

The windModifier engine authors WindField sources and draws nothing: the air of a spawn, whose
visual partners come from the other engines in the same preset. It covers the microburst, the
lenticular wave lift and its rotor, the geyser updraft columns, the jet-stream ribbon, the sky-whale
slipstream, the mega-waterfall downdraft curtains, supercell gust fronts and downdrafts and wind-farm
wake turbulence, and in Phase 3 ridge bands, wind shear lines and thermal streets.

- Code: `src/spawns/engines/windModifierEngine.js`.
- Sources: `src/spawns/engines/windSources.js` (shared with the vortex engine).
- Headless tests: `node tools/lab/wind-engines.mjs`. In the game:
  `tools/steps/engine-windModifier.json` (see [Testing](#testing)).

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'windModifier', params: { ... } }`. A bad value throws a clear error that names the
field. A param the source type does not have throws too, for example
`[DRIFTWING] windModifier: sources[0]: "speed" is not a updraft param (known: radius, updraft, ...)`,
so a typo never passes silently.

## Giving the sources

One instance holds up to 8 sources, in one of three ways:

| form | example |
| --- | --- |
| `params.sources`: a list | `{ sources: [{ type: 'downburst' }, { type: 'curtain', length: 900 }] }` |
| `params.type`: one source, its params beside it | `{ type: 'updraft', radius: 90, updraft: 14 }` |
| neither: the preset's own `wind` entries of this engine's types | `wind: [{ type: 'waveLift', params: { amplitude: 3 } }]` (entries of other types, such as the vortex's `rankine`, are left to their engine) |

Each source is its type's params plus these source fields:

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `type` | | | | `updraft`, `downburst`, `wake`, `jetStream`, `slipstream`, `waveLift`, `gustFront`, `curtain` |
| `direction` | `heading`, `ambient` or compass degrees | | `heading` | the source's facing. `heading`: the activation heading; with `drift` or `follow`, the direction of travel (once the anchor moves faster than 1 m/s). `ambient`: downwind of the prevailing wind, followed live. A number: a fixed compass direction |
| `turn` | degrees | -360..360 | 0 | added to the direction |
| `offset` | [along, side, up] m | | [0, 0, 0] | from the anchor: along the direction, to its right, and up (scaled) |
| `start` | s | 0.. | 0 | when the source starts, from the activation; its timeline and a downburst's ring count from here |
| `stop` | s | 0.. | never | when it starts fading out |
| `fadeIn`, `fadeOut` | s | 0..600 | 4, 6 | eased ramps after `start` and after `stop`. `fadeOut` also ends the source with the event's duration |
| `strength` | factor | 0..4 | 1 | multiplies the source's velocities (its turbulence up to 1) |
| `timeline` | `{ keys, loop?, offset? }` | | none | a strength schedule, below |

**Timeline.** `keys: [[seconds, value], ...]` in time order, piecewise linear, holding the end
values. It multiplies `strength`. `loop` (s) repeats it. `offset` (s, or `'seeded'` for a seeded
phase within the loop) shifts it, so geysers of one field erupt out of step. A geyser that erupts for
6 s every 15 s:

```js
timeline: { keys: [[0, 1], [6, 1], [8, 0], [14, 0], [15, 1]], loop: 15, offset: 'seeded' }
```

## Instance params

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `sources` | list | 1..8 entries | | see above |
| `type` | | | | a single source (see above) |
| `drift` | m/s | 0..120 | 0 | moves the whole instance along a seeded path precomputed at create (one point per 60 m, at most 512), riding the ground or the water. A site ping-pongs along a 10-minute path |
| `driftHeading` | compass degrees | | the activation heading | |
| `driftTerrain` | bool | | true | `false` keeps the anchor at its activation height |
| `follow` | engine name | | none | the registry name of a sibling engine in the same preset: the sources ride that part's anchor (a sky whale's body), and `heading` sources face its direction of travel. The part must exist, or the create throws |
| `endWithDuration` | bool | | true | the instance ends with the event's duration (`instance.ended`); `false` leaves the ending to a partner or a set piece |

Heights in every source are metres above the anchor: the ground or water under the spawn, or the
body a source follows. Lengths are multiplied by the activation `scale`.

**Timeline hooks** (a set piece writes them): `instance.control.strength` scales every source and
`instance.control.strengths[i]` scales source i (both 1 by default, at least 0). A site's
`instance.active = false` fades every source out over about 2 s; `true` brings them back.

## Source types

Every type has `turbulence` (0..1, the turbulence value where the source is strongest) and `gust`
(m/s): the source adds its own smooth seeded gusts of `turbulence x gust` m/s, so a craft feels the
bumps as well as reading the value. Every falloff is smooth. `strength` scales the velocities and the
turbulence (up to 1).

### updraft: a rising column

A geyser column, a thermal plume, a ridge band (Phase 3). Lift in the core, a ring of sinking air
around it, and turbulence at its edge.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 5..5000 | 180 | the core radius; the lift falls as (1 - (r / radius)^2)^2 |
| `updraft` | m/s | -40..60 | 8 | the core's vertical speed; negative makes a sinking column |
| `base`, `top` | m | -500..10000, 10..15000 | 0, 900 | the column's height span |
| `sinkRing` | share | 0..1 | 0.2 | the sinking ring outside the core, as a share of `updraft` |
| `ringWidth` | x `radius` | 0.2..5 | 1.6 | how wide the ring is |
| `lean` | m per m | -2..2 | 0 | the column drifts this far along the source's direction per metre of rise (use `direction: 'ambient'` to lean downwind) |
| `swirl` | m/s | -40..40 | 0 | rotation at the core's edge (positive counterclockwise from above) |
| `turbulence`, `gust` | | | 0.45, 3 | |

### downburst: a microburst

A downdraft core that slows to nothing at the ground and turns outward into a ring gust. The ring
expands with the source's age, with a lifting gust head at its front.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `coreRadius` | m | 20..5000 | 450 | the downdraft core |
| `downdraft` | m/s | 0..60 | 14 | the core's sinking speed |
| `outflow` | m/s | 0..60 | 16 | the outward gust, strongest at the ring front and weakening as sqrt(core / r) |
| `depth` | m | 20..3000 | 250 | the outflow layer's depth; the downdraft slows over 1.2 x `depth` above the ground |
| `top` | m | 50..12000 | 1800 | the downdraft's top |
| `expand` | m/s | 0..80 | 18 | the ring front's speed: its radius is `coreRadius + expand x age` |
| `maxRadius` | m | 50..20000 | 3200 | where the ring front stops |
| `frontLift` | m/s | 0..30 | 4 | the lift in the gust head at the front |
| `turbulence`, `gust` | | | 0.8, 5 | |

### wake: turbulent air trailing downwind

Wind-farm wakes and the wake of a large body: a velocity deficit and turbulence that widen and decay
downwind.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `width` | m | 5..20000 | 400 | the width at its start |
| `spread` | m per m | 0..1 | 0.08 | how fast each side widens downwind |
| `length` | m | 20..60000 | 3000 | |
| `base`, `top` | m | -500..10000, 5..15000 | 0, 250 | |
| `deficit` | m/s | -30..30 | 3 | the wind taken away along the direction (negative speeds it up); decays to 40 % at the end |
| `turbulence`, `gust` | | | 0.6, 3 | |

Point `direction` downwind (`'ambient'` for a wind farm).

### jetStream: a tailwind along a curved tube

A ribbon of strong wind along a tube that bends sideways and gently up and down. The tube's shape is
laid out along the source's direction when it is created; after that it moves with the anchor but
keeps its shape.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 10..5000 | 260 | the tube's radius; the speed falls as (1 - (d / radius)^2)^2 |
| `speed` | m/s | -120..120 | 35 | the wind along the tube (negative flows backward) |
| `length` | m | 200..200000 | 20000 | centred on the anchor; the ends taper over 8 % |
| `altitude` | m | -500..15000 | 2500 | the tube's height |
| `bend` | m | 0..50000 | 1500 | the sideways meander |
| `bendWavelength` | m | 200..200000 | 14000 | |
| `climb` | m | 0..5000 | 150 | the up-and-down meander |
| `turbulence`, `gust` | | | 0.35, 3 | shear turbulence at the tube's edge, a little in its core |

### slipstream: a lane behind a moving body

A speed and lift lane trailing a body, such as the sky whale. Use it with `follow`, so the lane
trails the body and faces its travel.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 20..20000 | 1500 | |
| `width`, `height` | m | 5..5000 | 140, 70 | the lane's cross-section where it starts (an ellipse) |
| `spread` | m per m | 0..1 | 0.05 | how fast it grows behind the body |
| `behind` | m | -5000..5000 | 0 | how far behind the anchor the lane starts |
| `centerHeight` | m | -5000..5000 | 0 | the lane's height from the anchor |
| `boost` | m/s | -40..60 | 8 | the push along the travel direction |
| `lift` | m/s | -20..30 | 3 | |
| `turbulence`, `gust` | | | 0.3, 2 | churn at the lane's edges (the body's tip vortices) |

### waveLift: lee waves and rotors

Smooth lee-wave lift and sink downwind of a peak (the lenticular clouds' air), with rotor turbulence
and reversed flow beneath each crest. Anchor it on the peak and point `direction` downwind
(`'ambient'`).

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `wavelength` | m | 200..40000 | 6000 | |
| `amplitude` | m/s | 0..30 | 4 | the peak lift and sink |
| `crests` | count | 1..12 | 3 | the train decays downwind |
| `startOffset` | m | -20000..40000 | 3000 | where the first rising limb starts, downwind of the anchor |
| `width` | m | 100..60000 | 8000 | across the wind |
| `base`, `top` | m | -500..15000, 50..20000 | 250, 4500 | the smooth wave's height span |
| `rotorTop` | m | 0..5000 | 700 | the rotor layer under each crest |
| `rotorTurbulence` | 0..1 | | 0.75 | |
| `rotorReverse` | m/s | 0..30 | 4 | reversed flow at the bottom of a rotor |
| `smoothTurbulence` | 0..1 | | 0.05 | the wave itself is smooth |
| `gust` | m/s | 0..30 | 4 | |

### gustFront: a moving outflow boundary

The edge of a storm's cold outflow: lift just ahead of the front, a gusty outflow behind it. Give
the instance a `drift` to move it (a supercell's gust front sweeps out ahead of the storm).

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 50..60000 | 8000 | along the front |
| `arcRadius` | m | 0..60000 | 0 | 0 is straight; otherwise the front bows outward as an arc of this radius, and the outflow spreads radially |
| `frontWidth` | m | 20..5000 | 350 | |
| `depth` | m | 50..30000 | 3500 | the outflow behind the front |
| `outflow` | m/s | 0..60 | 14 | outward, strongest at the front |
| `outflowTop` | m | 20..5000 | 700 | |
| `lift` | m/s | 0..30 | 5 | ahead of the front |
| `liftTop` | m | 50..12000 | 1800 | |
| `turbulence`, `gust` | | | 0.7, 5 | |

`direction` is the way the front faces and moves.

### curtain: a sheet of sinking air

A waterfall's downdraft, or a rain curtain: sinking air in a sheet that spills outward at its foot.
`direction` is the sheet's normal (the sheet runs across it).

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 5..20000 | 400 | along the sheet |
| `thickness` | m | 5..5000 | 120 | |
| `top` | m | 10..12000 | 500 | |
| `downdraft` | m/s | 0..60 | 6 | |
| `outflow` | m/s | 0..60 | 4 | spilling out from both faces at the foot |
| `depth` | m | 5..2000 | 60 | the foot's layer (and the height over which the sinking slows) |
| `reach` | m | 10..20000 | 320 | how far the spill reaches from the sheet |
| `turbulence`, `gust` | | | 0.5, 3 | |

## LOD and the far tier

The engine draws nothing, so the tiers only decide the wind. At FAR a source is removed when its
reach (plus its offset) is inside the nearest distance the FAR tier can start: `lod.mid x 0.5` (the
director's strongest LOD bias) `x 0.92` (the LOD hysteresis). There it can never touch the player.
It comes back at MID. A jet stream or a wide wave field whose reach goes farther keeps its source.

## Turbulence response (camera and audio)

Every wind spawn is felt through one generic response, `turbulenceResponse(turbulence, airspeed)` in
`src/core/turbulence.js`, which reads the WindField's turbulence at the craft
(`state.flight.turbulence`):

- zero up to 0.2, so the Phase 1 field's ordinary chop (0.07 in calm air aloft, about 0.18 on the
  golden-hour opening) is untouched;
- then rising with the square: Phase 1's gusty low-level air and thermal edges (0.3-0.45) are a faint
  tremor, and a source's core (0.8-1) is the full effect;
- faster flight hits the bumps harder (full at 45 m/s, 55 % when stopped).

It drives the camera's turbulence shake (strongest in the cockpit and FPV views, none on the flyby
camera) and the cockpit rattle on the environment bus (a close rattle in a closed cockpit, a faint
buzz under an airframe thump outside). Both are off in photo mode and while paused. So a preset
only sets `turbulence` and `gust` to be felt.

## Budgets and cost

- The director's budget: 12 instances, no particles. Up to 8 sources per instance.
- No GPU resources, lights or draw calls. `stats()` adds `sources` (the registered source count) to
  the usual fields.
- CPU: an update with 7 sources takes about 1.2-1.7 µs, with zero allocations; a WindField sample
  with 10 sources around it takes about 0.35-0.47 µs (lab).

## Examples

A microburst (a downburst under a rain curtain):

```js
{ engine: 'windModifier', params: { sources: [
  { type: 'downburst', coreRadius: 450, downdraft: 14, outflow: 16, fadeIn: 3 },
  { type: 'curtain', length: 900, thickness: 300, top: 1500, downdraft: 8, fadeIn: 3 },
] } }
```

Lenticular wave lift with its rotor, anchored on the peak:

```js
{ engine: 'windModifier', params: { type: 'waveLift', direction: 'ambient', wavelength: 7000, amplitude: 4, crests: 3 } }
```

A geyser field's column that erupts on a seeded schedule:

```js
{ engine: 'windModifier', params: { type: 'updraft', radius: 90, updraft: 14, top: 700, turbulence: 0.7, fadeIn: 0,
  timeline: { keys: [[0, 1], [6, 1], [8, 0], [14, 0], [15, 1]], loop: 15, offset: 'seeded' } } }
```

The jet-stream ribbon:

```js
{ engine: 'windModifier', params: { type: 'jetStream', direction: 'ambient', altitude: 2500, speed: 40, length: 30000, bend: 2000 } }
```

The sky whale's slipstream, trailing its fauna body:

```js
{ engine: 'windModifier', params: { type: 'slipstream', follow: 'fauna', behind: 60, length: 1800, width: 180, height: 90, boost: 9, lift: 3 } }
```

A mega-waterfall's downdraft curtain, facing out from the cliff:

```js
{ engine: 'windModifier', params: { type: 'curtain', length: 600, thickness: 150, top: 400, downdraft: 9, outflow: 6, reach: 500 } }
```

A supercell's gust front sweeping out ahead of the storm, with the rear-flank downdraft:

```js
{ engine: 'windModifier', params: { drift: 12, sources: [
  { type: 'gustFront', arcRadius: 6000, length: 9000, outflow: 16, lift: 5 },
  { type: 'downburst', offset: [-2500, 0, 0], coreRadius: 900, downdraft: 10, outflow: 12, expand: 0 },
] } }
```

Wind-farm wake turbulence downwind of the turbines:

```js
{ engine: 'windModifier', params: { type: 'wake', direction: 'ambient', width: 1200, length: 6000, top: 250, deficit: 3, turbulence: 0.6 } }
```

Phase 3 ideas on the same types: a ridge band is an `updraft` with a wide `radius`, a low `top` and
`lean` downwind; a wind shear line is a straight `gustFront` with no `lift`; a thermal street is a
row of `updraft` sources with `offset`s along `direction: 'ambient'` and a `drift`.

## Testing

- `node tools/lab/wind-engines.mjs`: every source type at probe points, fades, start / stop windows,
  timelines, the control hooks, a site's active state, `preset.wind` entries, refused types and
  params, dispose, and the SIM glider and jet flown with scripted inputs (wings level, pitch held)
  through each source and the same path in calm air, logging the vertical speed, load factor,
  airspeed, ground speed and drift; zero allocations and the CPU cost.
- `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-windModifier.json`
  (add `--query renderer=webgl` for WebGL2). It force-spawns a microburst, a timed geyser column, a
  jet stream and a drifting gust front ahead of the craft, probes their wind, screenshots the wind
  overlay, checks that dispose removes every source, then flies the craft into rough air and checks
  the cockpit shake and rattle, and that photo mode switches both off.
