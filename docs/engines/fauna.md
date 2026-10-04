# fauna engine

The fauna engine draws and simulates groups of animals: instanced boids with per-preset rule sets.
It covers the starling murmuration, the geese V-formation, thermal hawks, the eagle wingman, the
whale pod and the sky whale, and since Phase 3 the ground and water surface: terrain-following
herds that stampede with dust (bison), columns of walkers along a path (caribou), dolphins that
ride the swell and race your shadow, and flamingos that wade and flush in a wave. Bats,
butterflies and camels join with their presets in wave 3.

- Code: `src/spawns/engines/faunaEngine.js` (behaviours, buffers, shader).
- Species meshes and animation constants: `src/spawns/engines/faunaSpecies.js`.
- Test steps: `tools/steps/engine-fauna.json` and `tools/steps/engine-fauna-modes.json` (the Phase 3
  modes). Labs: `tools/lab/fauna-modes.mjs` (herds, stampedes, columns, flamingos, dolphins,
  allocation) and `tools/lab/path.mjs` (the PathFollower). Cost and allocation check:
  `tools/engine-cost.mjs --engine fauna`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'fauna', params: { ... } }`. One engine entry is one group of one species following one
behaviour. A preset with several groups (a flock plus a lone hawk) lists several fauna entries.
A bad `species`, `behavior` or `count` throws a clear error that names the field, for example
`fauna: params.behavior must be one of murmuration, flock, ...`.

## How it works

- **Instancing.** `init()` builds one `InstancedMesh` per species (its capacity is fixed, see
  Species) and every group of that species takes a contiguous block of agents in it. A species
  therefore costs one draw call however many groups are live.
- **Per-agent state** lives in typed arrays on the CPU. Three `vec4` instance attributes go to the
  GPU in one upload per frame: position and scale, forward and bank, and flap phase, flap gate,
  excitement and seed.
- **Animation in the vertex shader.** The shader builds each agent's basis (forward, banked right,
  up). Birds fold their wings at the hinge and flap about the body axis like the v1 birds, bending
  more toward the tips, and hold a glide dihedral between flaps. Whales undulate from the tail start
  to the flukes as a travelling wave, and their pectoral fins sweep. Quadrupeds swing their legs
  about the hip in diagonal pairs, wider from walk to run, and bob; standing still freezes them. A
  wading bird folds (wings tucked, legs down, neck up) when its gate goes below 0, and in flight its
  legs trail straight back and its neck reaches forward.
- **Dust.** Herds and columns raise soft dust puffs from one shared sprite (2048 billboards, one
  draw call). Each group owns a block of slots (at most 256), counted in its particles; when the
  pool is full a new group simply raises none.
- **Far visibility.** Far away a small agent is drawn at least `minPixels` tall, so a murmuration
  reads as a dark cloud from kilometres out.
- **Floating origin.** Positions reach the GPU relative to an origin near the camera, so they stay
  float32-safe far from the world origin.
- **Look.** Flat-shaded, low-poly meshes with vertex colours in the v1 palette and a small
  per-agent brightness jitter. The sky whale's luminous spots glow stronger at night (bloom picks
  them up).
- **Thousands of agents on both backends.** The simulation is CPU code over typed arrays, so
  WebGPU and WebGL2 behave and look the same. Big flocks find neighbours through a shared hashed
  grid. They refresh each agent's flocking steering in interleaved slices (every second frame at
  near, every third at mid) and steer on the kept value in between.
- **Zero allocations in `update()`.** The engine cost check samples the heap profiler to prove it
  (see Allocation).

## Behaviours

| behavior | what it does | presets |
| --- | --- | --- |
| `murmuration` | thousands of birds stream toward a morphing, folding shape (seeded ellipsoid lobes, a slow yaw, folds and a travelling wave) with topological flocking. They burst away from the player's path in a wave that spreads through their neighbours, then re-form | starling murmuration |
| `flock` | a wandering boid flock (separation, alignment, cohesion) that scatters from the player (the v1 birds look) | Phase 3 songbirds, bats |
| `formation` | a V (or an echelon) that holds its slots and follows the player's gentle turns and speed. The formation-slot API reports the player's own slot. The optional achievement fires once when the slot is held long enough | geese V-formation |
| `circling` | birds circle inside the Phase 1 thermals (`WindField.thermalsNear`), climb with the column's lean and glide on to the next thermal. With no thermal they soar over the anchor | thermal hawks |
| `pod` | whales travel at the surface: they spout, dive fluke-up and sometimes breach in full with a splash. They leave wakes in the water layer, which glow inside a bioluminescent bay | whale pod |
| `wingman` | a large bird waits, joins off the player's wing, matches speed within its limits for `escortSeconds`, then peels off with a call | eagle wingman |
| `drift` | colossal animals drift along their heading at a cruise altitude with a slow bob and undulation. An optional slipstream wind source trails the leader as a speed and lift lane | sky whale |
| `herd` | a terrain-following herd (altitude mode `ground`): grazing and walking on the ground, never onto slopes over `herd.slopeLimit` (rise over 6 m) or into water within `herd.waterMargin`. A stampede (the player buzzing it, a timer, or `setParam('stampede', 1)`) runs it away from the trigger, bent downhill, raising dust | herd stampede (49), migration convergence (97) |
| `column` | a long line of walkers along a PathFollower path (src/world/pathFollower.js): a path given in the spawn frame, or `'auto'` (buildGroundPath around slopes and water). Lanes, spacing and jitter; a pure function of flight time | caribou migration (52), oasis caravan (58) |
| `surface` | animals on the water surface of `ctx.game.waterQuery` (the ocean and local lakes, with the swell). Swimmers (a whale kind: dolphins) porpoise and race the craft's shadow when it flies low over the water; wading birds (flamingos) stand in the shallows, take off in a wave when buzzed, fly as a flock and settle back | dolphin pod (44), flamingo lake (50) |

## Species

| species | kind | size (m) | cruise (m/s) | speed range (m/s) | min pixels | capacity (agents) |
| --- | --- | --- | --- | --- | --- | --- |
| `starling` | bird | 0.38 span | 13 | 8..21 | 1.7 | 8192 |
| `goose` | bird | 1.65 span | 18 | 11..32 | 2.4 | 96 |
| `hawk` | bird | 1.25 span | 11 | 7..24 | 2.2 | 64 |
| `eagle` | bird | 2.1 span | 18 | 9..36 | 3 | 8 |
| `whale` | whale | 14 long | 3 | 0.8..7 | 0 | 24 |
| `skyWhale` | whale | 1 long (scale it with `size`) | 7 | 2..16 | 0 | 4 |
| `bison` | quadruped | 3.1 long | 1.2 | 0..14 | 1.6 | 512 |
| `caribou` | quadruped | 2.0 long | 1.6 | 0..16 | 1.4 | 2048 |
| `dolphin` | whale | 2.4 long | 5 | 1..11 | 1.3 | 128 |
| `flamingo` | bird (wading) | 1.5 span | 14 | 0..22 | 1.8 | 512 |

- **Capacity is per species, across every live group.** A `create()` that does not fit throws
  `fauna: no room for N more <species>`, and the SpawnManager refuses the spawn.
- **The engine budget** (`DIRECTOR_BUDGETS.engines.fauna`, 8 instances and 12000 particles) caps
  the total. Each group counts its agents as particles.
- **Adding a species.** Add an entry to `SPECIES` in faunaSpecies.js with the fields listed in that
  file's header (`kind` is `bird`, `whale` or `quadruped`; a bird with `wade` wades). Its pool is
  built in `init()` automatically.
- **Kinds and behaviours.** Quadrupeds only `herd` or walk in a `column` (altitude mode `ground`);
  `surface` takes a whale kind (swimming) or a wading bird. Anything else is refused with an error
  naming the field.

## Parameters

Every field is optional. Nested blocks merge one level deep over the engine defaults, and over the
behaviour's own defaults where they exist (see Behaviour defaults). Numbers marked `[min, max]` also
accept a range, drawn once per group from the spawn's seeded generator.

### Group

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `species` | id | see Species | `'starling'` | |
| `behavior` | id | see Behaviours | `'flock'` | |
| `count` | agents or `[min, max]` | 1..species capacity | 30 | |
| `size` | factor | 0.1..400 | 1 | scales the species mesh: a sky whale uses about 200-260, which makes it 200-260 m long. The activation's `scale` multiplies it |
| `sizeJitter` | fraction | 0..0.5 | 0.15 | each agent's size varies by up to plus or minus this share |
| `speed` | m/s | > 0 | the species' cruise | cruise speed. The species' top speed rises to 1.2 x this when it is higher |
| `altitude` | `{ mode, value, spread, ceiling }` | | `{ mode: 'agl', value: 120, spread: 20, ceiling: 2500 }` | `mode`: `'agl'` (m above the ground), `'msl'` (m above sea level, kept at least `floor` + 10 m above the ground), `'water'` (on the water surface: the shared water query's ocean and lakes, with the swell, where the game has one), `'ground'` (standing on the ground and the extra ground surfaces; herds and columns, their default) or `'player'` (the player's own height when the group is created, plus `value` and the `spread` jitter, kept between `floor` + 30 m and `ceiling` m above the ground there; from then on the group holds that height above sea level, so a flock you are flying toward is at your height). `spread`: the agl and player start heights vary by plus or minus this many metres. Pods always sit on the water |
| `floor` | m AGL | 0..500 | 15 | agents steer up before going below this height over the ground |
| `wander` | factor | 0..1 | 0.06 | how much the group's heading meanders |
| `leash` | m | 50..20000 | 600 | how far a wandering group (murmuration, flock) may stray from its anchor before it curves back. A formation that is not following the player turns back at 4 x leash |
| `fadeIn` | s | 0..30 | 1.5 | agents grow in from size 0. A drifting sky whale's slipstream also fades in with it |
| `fadeOut` | s | 0..600 | 6 | an event (a spawn with a duration) fades out over the last `fadeOut` seconds of its duration: the agents shrink away (the reverse of `fadeIn`), and the voice and a drift slipstream follow. The group then ends (`instance.ended`) at its duration, so it never vanishes at the manager's grace (a sky whale leaves its lane instead). 0 ends it at its duration with no fade. A wingman ends this way only while it is still waiting; once it has joined it finishes its escort and peels off |
| `voice` | bool | | unset | `true` or `false` decides whether this entry opens the preset's `audio` voice; unset, the preset's first engine entry owns it, so a preset opens one voice. Set `false` on the extra entries of a multi-group preset |
| `voiceIntensity` | 0..1 | | 1 | the voice's intensity at full presence. Murmurations and flocks swell it from 0.15 to 1 as the player nears the flock |

### flocking (murmuration and flock)

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `separation` | gain | 0..5 | 1.4 | push away from neighbours closer than `separationRadius` |
| `separationRadius` | m | 0.5..30 | 3 | |
| `alignment` | gain | 0..5 | 1.1 | match the neighbours' velocity |
| `cohesion` | gain | 0..2 | 0.12 | pull toward the neighbours' centre |
| `neighborRadius` | m | 2..80 | 12 | also the neighbour grid's cell size |
| `maxNeighbors` | count | 1..16 | 7 | topological flocking: the nearest few count (at most 4 at mid) |

### scatter (every behaviour except pod, wingman and drift)

Agents within `radius` of the player burst away from its path, up and aside. The burst spreads to
their neighbours and fades over `recover`. Set `scatter: null` to turn scattering off.

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 0..400 | 60 | how near the player must come |
| `burst` | m/s | 0..60 | 24 | flee speed (x0.85..1.15 per agent) |
| `recover` | s | 0.2..30 | 3.5 | excitement decay time, after which the agents re-form |
| `spread` | 0..1 | | 0.9 | how strongly a scattered agent excites its neighbours (the spreading wave) |
| `trigger` | trigger name or null | | `'scatter'` | the voice trigger played on a scatter (the murmuration recipe's wing rush) |
| `cooldown` | s | 0..60 | 6 | minimum time between two scatter triggers and bus events |

### murmuration

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 20..600 | 110 | the shape's main radius (scaled by `size`) |
| `flatten` | factor | 0.1..1 | 0.45 | the vertical axis relative to the radius: the shape breathes between a ball and a sheet |
| `morphSeconds` | s | 2..120 | 11 | the morph period |
| `fold` | fraction of radius | 0..1 | 0.35 | the folding bend that ripples across the shape |
| `wave` | fraction of radius | 0..1 | 0.18 | the travelling density wave |
| `seek` | gain | 0..3 | 0.9 | how hard calm birds steer toward their place in the shape |

### formation

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `shape` | `'v'` or `'echelon'` | | `'v'` | an echelon puts every follower on the right leg |
| `spacing` | m | 1..30 | 3.4 | distance between neighbours along a leg (scaled by `size`) |
| `angle` | deg | 10..80 | 34 | each leg's angle from the flight line |
| `rise` | m per rank | 0..2 | 0.12 | each rank sits a little higher (scaled by `size`) |
| `followPlayer` | bool | | true | follow the player's gentle turns and match its ground speed within the species' speed range |
| `followRadius` | m | 50..3000 | 380 | following only happens within this distance of the leader |
| `followTurnRate` | deg/s | 0.5..30 | 5 | the flock turns toward the player's heading at most this fast, so only gentle turns are followed |
| `maxHeadingGap` | deg | 5..180 | 55 | following stops when the player's heading differs from the flock's by more than this |
| `playerSpacing` | m | 2..100 | 24 | the player's slot lies this far beyond the last bird of the shorter leg (room for a craft) |
| `tolerance` | m | 1..100 | 14 | horizontal distance from the slot that counts as in the slot |
| `heightTolerance` | m | 1..50 | 9 | vertical distance from the slot that counts as in the slot |
| `headingTolerance` | deg | 1..90 | 30 | the player's heading must be within this of the flock's |
| `holdSeconds` | s | 1..120 | 10 | holding the slot this long completes the formation |
| `achievement` | achievement id or null | | null | on completion, emits the typed `achievement` event once with this id and the title from the preset's `achievements` entry |

A formation only scatters on a near miss: its default scatter block is
`{ radius: 7, burst: 14, recover: 2.5, spread: 0.6 }`. The slot holds for 0.6 s of grace after the
player leaves it, so brief wobbles do not reset the timer.

### circling

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m or `[min, max]` | 15..300 | [45, 85] | each bird's circle radius |
| `climb` | m/s | 0..5 | 1.3 | climb rate in a thermal, scaled by the thermal's strength (0.4 + 0.35 x strength, up to 1.6x). With no thermal it is 0.35x |
| `bottom` | m above the thermal's ground | 20..2000 | 150 | where birds start circling |
| `top` | m above the thermal's ground | 100..4000 | 900 | the highest a bird circles (or the thermal's own top, if lower). At the top it glides on to another thermal, or spirals down |
| `thermals` | count | 1..8 | 1 | how many of the nearest thermals the group shares (birds are spread over them) |
| `thermalSearch` | m | 200..8000 | 1800 | search radius around the anchor |
| `thermalRefresh` | s | 2..120 | 12 | how often the thermals are looked up again (they drift and expire) |
| `useThermals` | bool | | true | `false` circles over the anchor only (Phase 3: vultures over a carcass) |
| `requireThermal` | bool | | false | the birds mark real lift only: a group that finds no working thermal at create ends at once (a natural end, before anything is drawn; the SpawnManager declines such a director activation, so it costs no pacing slot), and a refresh that finds none keeps the columns the birds already ride instead of soaring over the anchor. The thermal hawks set it |

The circle centre follows the thermal's lean with height, from the thermal's base to its cap.
Thermals weaker than 0.3 are ignored.

### pod

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `spread` | m | 5..400 | 45 | lane offsets: up to this far abreast, and 0.6 x this along the line |
| `surfaceSeconds` | s or `[min, max]` | | [14, 26] | time at the surface, spouting |
| `diveSeconds` | s or `[min, max]` | | [10, 22] | time deep |
| `breachChance` | 0..1 | | 0.3 | the chance that a whale breaches when its dive ends. It launches at 11-13 m/s x sqrt(scale), clears about two thirds of its body, and lands with a splash (strength 0.55 + 0.03 x scale) |
| `spoutInterval` | s or `[min, max]` | | [4, 7] | time between spouts at the surface |
| `spoutHeight` | m/s | 1..30 | 8 | spout launch speed (x1.5) |
| `wake` | 0..1 | | 0.55 | foam left where the back breaks the surface |
| `glow` | 0..1 | | 1 | bioluminescent excitation of the wakes, splashes and spouts. It only shows inside a glow region (the waterEffect engine's `bioluminescence`) |
| `depth` | m (x scale) | 2..80 | 16 | dive depth |
| `callInterval` | s or `[min, max]` | | [16, 38] | time between songs (the voice's `call` trigger). A breach also calls |
| `seekWater` | m | 0..20000 | 0 | at create, when the anchor is not on open water (the point and four points around it, 4 x `spread` and at least 250 m out, all at least 6 m deep), the pod moves to the nearest open water within this reach (rings 150 m apart). A pod that finds none ends at once (a natural end; a director activation is declined). The whale pod sets it, so a candidate on a coast puts its whales in the sea |

A pod looks 350 m ahead every 2 s and turns away from land.

### wingman

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `side` | -1, 0 or 1 | | 0 | the wing to join: -1 left, 1 right, 0 whichever side the bird is on when it starts to join |
| `right`, `up`, `forward` | m | | 16, 2, 3 | the slot in the craft's own axes |
| `joinRadius` | m | 100..10000 | 1500 | the bird starts to join when the craft comes this close |
| `escortSeconds` | s | 5..600 | 60 | time on the wing before it peels off |
| `lostDistance` | m | 50..5000 | 420 | when the bird is farther than this from its slot... |
| `lostSeconds` | s | 1..60 | 6 | ...for this long, it gives up and peels off early (the craft outran it) |
| `peelSeconds` | s | 1..120 | 16 | after peeling off, the instance ends this long later (events only; it waits for the despawn rule as a site) |
| `trigger` | trigger name | | `'call'` | the voice trigger played on joining and on peeling off |
| `waitAltitude` | m AGL | 20..2000 | 140 | while waiting, the bird circles over the anchor at least this high |
| `waitRadius` | m | 10..1000 | 70 | the waiting circle's radius |

Speed matching stays within the species' speed range, so a craft flying faster than 1.2 x the top
speed leaves the bird behind. More than one agent forms a loose line 9 m apart along the wing.

### drift

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `bob` | m | 0..300 | 22 | amplitude of the slow vertical bob (the body pitches with it) |
| `bobPeriod` | s | 5..600 | 46 | |
| `lane` | body lengths | 0.2..3 | 0.6 | spacing of the followers beside and behind the leader. Followers are 0.45 x the leader's size |
| `slipstream` | `true`, an object or null | | null | a wind source behind the leader. `true` takes the defaults below, and an object overrides them |

| slipstream field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 50..5000 | 900 | the tube's length behind the leader. At `size` above 200, length and radius scale by size / 200 |
| `radius` | m | 10..500 | 80 | |
| `speed` | m/s | 0..60 | 16 | tailwind along the animal's heading on the axis |
| `lift` | m/s | 0..30 | 3.5 | updraft on the axis |
| `turbulence` | 0..1 | | 0.15 | turbulence at the tube's edge (none on the axis) |

The strength falls off with the square of the distance from the axis and toward the tube's tail, and
fades in with `fadeIn`. The source kind is `'slipstream'` and its id is
`fauna:<anchorX>:<anchorZ>:<slot>`.

### calls

| field | unit | default | notes |
| --- | --- | --- | --- |
| `trigger` | trigger name | `'call'` | the voice trigger for songs and calls |
| `interval` | s or `[min, max]` or null | null | periodic calls for every behaviour except pod (which uses `pod.callInterval`). A sky whale preset sets it, for example `[20, 45]` |

### herd

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `slopeLimit` | rise over run | 0..5 | 0.45 | no animal steps onto ground steeper than this (rise over 6 m, the gradient on the herd's fine ground grid) |
| `waterMargin` | m | >= 0 | 8 | the herd keeps this far from water (the shared water query, or the sea) |
| `gaits` | `{ walk, trot, run }` m/s | rising | `{ walk: 1.3, trot: 4, run: 11 }` | the legs' stride widens from walk to run; dust rises above 0.8 x trot |
| `cohesion` | gain | >= 0 | 0.5 | |
| `spacing` | m | > 0 | 6 | between animals (a loose sunflower around the herd's goal, turned to its heading) |
| `graze` | 0..1 | | 0.55 | the share of the time an animal stands grazing; the herd drifts at walk x (1 - 0.6 graze) |
| `stampede` | object | | see below | |
| `dust` | `{ rate, size, color }` | | `{ rate: 5, size: 5, color: 0xb39876 }` | puffs a second per running animal (0..60), their size (m) and sRGB colour |

`stampede`: `{ trigger: 'player' | 'timer' | 'event', radius: 260, speed: null (gaits.run), duration: 22, interval: 120, cooldown: 45, downhill: 0.6, maxAltitude: 350 }`.
`player`: the craft within `radius` (horizontal, times the square root of the craft's
`faunaThreat`) and under `maxAltitude` m above the herd starts it; `timer`: one every `interval`
seconds from a side that turns with the group clock; `event`: only `setParam('stampede', 1)` (a set
piece). It runs `duration` seconds away from the trigger, bent downhill by `downhill`, then the herd
settles back to a walk; `cooldown` seconds pass before the next.

A herd reads the ground through its own fine grid (9 x 9 cells of 8 m or more, sized to the herd),
re-centred on the herd in whole cells, one cell probed every fourth frame (every second while it
stampedes), at integer coordinates. A herd whose anchor stands on steep ground or water looks for
clear ground within 1.5 km; with none it ends at once.

### column

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `path` | `'auto'` or `{ points: [[along, across], ...], closed?, smoothing? }` | | `'auto'` | the route in the spawn frame (metres along the heading and across to the right); `'auto'` plans one with buildGroundPath from the anchor `length` metres along the heading, around slopes over `maxSlope` and water. The route is resampled every `resample` metres onto the ground |
| `length` | m | > 0 | 2600 | the 'auto' route's reach |
| `spacing` | m | > 0 | 5 | between rows |
| `lanes` | count | 1..8 | 2 | animals abreast |
| `laneWidth` | m | >= 0 | 3.2 | |
| `speed` | m/s | > 0 or null | the species' cruise | |
| `jitter` | m | >= 0 | 0.6 | each walker's own offset across (and twice along) the line, and a slow sway |
| `mode` | `'loop'`, `'pingpong'`, `'once'` | | `'pingpong'` | the PathFollower mode (a closed path loops) |
| `maxSlope` | rise over run | > 0 or null | `herd.slopeLimit` | for the 'auto' route |
| `resample` | m | >= 2 | 8 | |
| `dust` | `{ rate, size, color }` | | `{ rate: 0, size: 4, color: 0xc4ab84 }` | a caravan in sand sets a rate |

The column is a pure function of flight time: the PathFollower places every walker (`carAtFrom`),
so two runs (or two clients) at the same flight time see the same column.

### surface

| field | unit | default | notes |
| --- | --- | --- | --- |
| `spread` | m | 10 | swimmers' lanes around the group |
| `porpoise` | `{ height, interval }` | `{ height: 2, interval: [3, 7] }` | swimmers leap `height` metres every `interval` seconds, with splashes on the water layer |
| `raceShadow` | `{ radius, boost, maxAltitude }` | `{ radius: 700, boost: 1.8, maxAltitude: 260 }` | with the craft within `maxAltitude` m of the water and its shadow (along the sun) over open water within `radius` m, the swimmers head for the shadow at up to `boost` x cruise (`fauna:race`) |
| `wade` | object | see below | wading birds |

`wade`: `{ depthMax: 0.6, flushRadius: 150, takeoffWave: { delay: 0.35, spread: 0.6 }, flySeconds: [25, 45], flyAltitude: 45, flyRadius: 260, spacing: 2.2, searchRadius: 1600 }`.
The flock finds shallow water (depth under `depthMax`) at the anchor or within `searchRadius` and
stands there, each bird on its own spot. The craft within `flushRadius` (times its `faunaThreat`)
flushes it: every bird takes off `delay` seconds per 10 m from the craft later than the nearest
(plus a seeded `spread`), runs along the water with splashes, climbs, flies as a flock on a circle of
`flyRadius` over the water at `flyAltitude` for `flySeconds`, then glides back and settles; 20 s
later it can be flushed again. With no shallows in reach the group ends at once.

### Predators

The scatter radius (and a herd's stampede reach, and a wading flock's flush radius) scale with the
active craft module's `faunaThreat` (a number, default 1; the eagle sets 2.5): the scatter radius by
the threat, the burst by up to 2x, a stampede's reach by its square root. `stats().threat` reports it.

### Behaviour defaults

Each behaviour applies these under the preset's own values:

| behavior | defaults |
| --- | --- |
| `murmuration` | `scatter: { radius: 70, burst: 26, recover: 4, spread: 0.92 }` |
| `formation` | `scatter: { radius: 7, burst: 14, recover: 2.5, spread: 0.6 }` |
| `circling` | `scatter: { radius: 35, burst: 12, recover: 3, spread: 0 }` |
| `pod`, `wingman`, `drift` | `scatter: null` (they never scatter) |
| `herd`, `column` | `scatter: null`, `altitude: { mode: 'ground', value: 0, spread: 0 }`, `fadeIn: 0.8`, `sizeJitter: 0.08` |
| `surface` | `scatter: null`, `altitude: { mode: 'water', value: 0, spread: 0 }` |

## Allocation

The frame update allocates nothing in the engine's files. `tools/engine-cost.mjs --engine fauna`
measured 0.86 B per frame (0.02 heap samples, under the 0.1 limit) with every behaviour live and
3021 agents, down from about 220 KB per frame before these rules were applied:

- Agent state lives in typed arrays and group state in a Float64Array (`data.g`, indexed by `G`).
- The per-agent helpers take integer indices and read their double arguments from call registers
  (a Float64Array indexed by `IO`). V8 boxes a computed double passed to, or returned from, a call
  it does not inline, and these helpers run thousands of times per frame.
- The spawn's anchor (a `THREE.Vector3`) is written in whole metres. In this app V8 boxes every
  non-integer double stored into a Vector3 or an `{ x, y, z }` literal. A metre is far below what
  the LOD, the lure, discovery and audio resolve.
- The formation-slot API object reads the group doubles through accessors. The slipstream's wind
  reading uses its own class.
- Rarely run work (a whale spout) sits inline in the hot loop, so it runs optimised.
- No closure is created in a per-frame function.

What the engine calls can still allocate, and the check reports it separately. The terrain height
function (worldgen) allocates about 1 KB per query. The ground probe asks for one height every 16
frames per group, at integer coordinates, which comes to about 400 B per frame with six groups. A
herd's fine grid asks for one every fourth frame (every second while it stampedes), and a swimming
group refreshes one animal's water height every second frame (the query returns a double). The
dolphins' shadow check probes the terrain twice a second. The frame's time step reaches the Phase 3
helpers through a typed register (`frameStep`), never as an argument: the engine's update inlines a
great deal, and a double handed to a call it cannot inline any more is boxed. The fauna modes lab
measures the new behaviours at or below a Phase 2 group's own per-group cost (0.5 B against 1.8 B
per group and frame on its stub world).

## LOD

| tier | what runs |
| --- | --- |
| near | everything: the full neighbour count, every rule, the slipstream |
| mid | the same with at most 4 neighbours per agent, and big flocks refresh their neighbours every third frame |
| far | the agents are hidden and only the group goal moves (circling birds and a waiting wingman hold their place). A heavy preset's lure takes over. The slipstream is removed, because the player cannot reach it there. On the way back in, the agents are re-seeded around the group and the slipstream is added again |

Suggested `lod` values: a murmuration `{ near: 2500, mid: 6000, far: 14000 }` (the minPixels floor
keeps it visible as a cloud at mid), geese and hawks `{ near: 1500, mid: 4000, far: 8000 }`, the sky
whale (heavy, with a `whale` lure) `{ near: 3000, mid: 7000, far: 40000 }`.

## Wind

Only `drift.slipstream` authors a wind source. It is listed in `instance.windSourceIds`, removed at
the far tier and removed in `dispose()`. Its bounds only move when the leader leaves their margin
(30 % of the length), so the WindField re-indexes rarely. The sample reads the group's live state, so
the field itself stays exact. Circling birds read `WindField.thermalsNear` and author nothing.

## Audio

When `preset.audio` is set and this entry owns it (`voice`, else the preset's first engine entry), the group spawns `ctx.audio.spawnVoice(recipe, params)` at create, at
intensity 0. It follows the group's centre every frame with intensity `voiceIntensity` x fade. The
voice is disposed with the instance.

| recipe | used by | triggers the engine plays |
| --- | --- | --- |
| `murmuration` | murmuration, flock | `scatter` (scatter.trigger) |
| `whale` | pod | `call` on `pod.callInterval` and on every breach |
| `skyWhale` | drift | `call` on `calls.interval` |
| any | wingman | `wingman.trigger` on joining and peeling off |
| any | herd | none; the voice level follows the herd's gait (0.3 at a walk, 1 in a stampede: the rumble) |

**Quiet wildlife.** While any source holds the typed `wildlifeQuiet` event (the celestial engine's
eclipse through totality), every fauna group falls silent: no calls, breach calls or scatter cries,
and the voice level drops to 0 (the audio engine eases it out). The animals keep moving, and the
`fauna:*` bus events still fire. `stats().quiet` is true while it holds.

## Bus events and the formation-slot API

| event | payload | when |
| --- | --- | --- |
| `fauna:scatter` | `{ id, presetId, species, count, position }` | agents scatter from the player (at most once per `scatter.cooldown`) |
| `fauna:formation` | `{ id, presetId, state: 'enter' \| 'leave' \| 'complete', seconds, slot: { x, y, z } }` | the player enters or leaves the slot, or completes the hold |
| `fauna:call` | `{ id, presetId, species, reason: 'join' \| 'peel', position }` | the wingman joins or peels off (the copilot can voice it) |
| typed `achievement` | `{ id, title }` | a formation with `formation.achievement` completes (once per spawn) |
| `fauna:stampede` | `{ id, presetId, species, trigger: 'player' \| 'timer' \| 'event', position }` | a herd starts a stampede |
| `fauna:flush` | `{ id, presetId, species, count, position }` | a wading flock is flushed |
| `fauna:race` | `{ id, presetId, species, racing }` | swimmers start or stop racing the craft's shadow |

The engine object (`ctx.systems.spawns.manager.registry.get('fauna')`) has two read-only queries:

- `getFormation(spawnId)` returns the live formation state of the spawn's formation group, or null:
  `{ inSlot, holdSeconds, bestHoldSeconds, complete, distance (m from the player to the slot), slot: { x, y, z }, holdTarget (s) }`.
  Read it, and never keep it past the spawn. Its numbers are accessors over the group's live state,
  so read them when you need them. A preset's achievement logic, the HUD or the copilot can poll it,
  or listen to `fauna:formation`.
- `describe(spawnId)` returns `{ species, behavior, count, center, radius, excited, mode, playerDistance, hidden, wind, stampede, gait, dust, pathLength, airborne, leaping, flushed, racing }`
  for dev tools and tests. Wingman `mode` is 0 waiting, 1 joining, 2 escorting or 3 peeling.
- `setParam(instance, name, value)` (the set-piece engine's live params): `'stampede'` (a value of
  0.5 or more starts a herd's stampede from the player's side: the `event` trigger) and `'flush'`
  (takes a wading flock off). Returns whether the param is known for that group.

## Example params

```js
// Starling murmuration (dusk, farmland)
{ engine: 'fauna', params: { species: 'starling', behavior: 'murmuration', count: [2500, 4000], altitude: { mode: 'agl', value: 140, spread: 10 } } }
// Geese V-formation with the hold-the-slot achievement
{ engine: 'fauna', params: { species: 'goose', behavior: 'formation', count: [7, 11], size: 1.6, altitude: { mode: 'agl', value: 260 }, formation: { achievement: 'vFormation' } } }
// Thermal hawks
{ engine: 'fauna', params: { species: 'hawk', behavior: 'circling', count: [3, 6], size: 1.4, circling: { thermals: 2 } } }
// Eagle wingman
{ engine: 'fauna', params: { species: 'eagle', behavior: 'wingman', count: 1, size: 1.3, wingman: { escortSeconds: 60 } } }
// Whale pod
{ engine: 'fauna', params: { species: 'whale', behavior: 'pod', count: [3, 6], pod: { breachChance: 0.3 } } }
// Sky whale with its slipstream lane
{ engine: 'fauna', params: { species: 'skyWhale', behavior: 'drift', count: [1, 3], size: 230, altitude: { mode: 'msl', value: 1400 }, drift: { slipstream: true }, calls: { interval: [20, 45] } } }
// Bison herd that stampedes when buzzed
{ engine: 'fauna', params: { species: 'bison', behavior: 'herd', count: [30, 60], herd: { stampede: { trigger: 'player', radius: 260 } } } }
// Caribou migration on a planned route
{ engine: 'fauna', params: { species: 'caribou', behavior: 'column', count: [150, 300], column: { path: 'auto', length: 4000, lanes: 3 } } }
// Dolphins that race your shadow
{ engine: 'fauna', params: { species: 'dolphin', behavior: 'surface', count: [5, 9], surface: { raceShadow: { radius: 800 } } } }
// Flamingos wading in a lake's shallows
{ engine: 'fauna', params: { species: 'flamingo', behavior: 'surface', count: [40, 80], surface: { wade: { depthMax: 0.5 } } } }
```

## Cost

These numbers come from `tools/engine-cost.mjs --engine fauna`, headless on the busy shared machine
(seed ENGINECOST). Engine CPU is the engine's own `update()` time per frame, summed over its
instances, measured over a 3 s window of the live loop. The frame interval measures the whole
machine, which other programs load, so it is only context.

| scene | engine CPU per frame, WebGPU / WebGL2 | draw calls added | triangles added |
| --- | --- | --- | --- |
| 3000-starling murmuration | 3.9 / 3.8 ms | 1 | about 190 k |
| 8000-starling murmuration (stress) | 12.8 / 11.1 ms | 1 | about 500 k |
| sky whale pair with slipstream (heavy) | 0.29 / 0.26 ms | 1 | about 3 k |
| every behaviour at once (6 groups, 3021 agents) | 4.1 / 3.7 ms | 6 | about 190 k |

Allocation in the steady state is 6.4 / 2.8 B per frame in the engine's files (0.03 / 0.02 heap
samples per frame). The terrain queries the engine makes add about 350 B per frame.

The CPU cost is about 1.3 microseconds per near agent. Keep a murmuration preset at 2500-4000
starlings. The 8000 case is the stress test, and the engine budget (12000 particles) leaves room for
the other groups.
