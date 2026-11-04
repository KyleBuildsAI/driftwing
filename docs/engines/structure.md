# structure engine

Procedural low-poly builds from parametric recipes: wind farms, rope bridges, abandoned airfields,
floating islands, crystal spires and timed gate courses. The code is in
`src/spawns/engines/structureEngine.js`. The recipes are in `src/spawns/engines/structure/recipes/`,
the v1 palette in `structure/palette.js`, the mesh builder in `structure/meshBuilder.js`, the
terrain stamps a recipe needs in `structure/stamps.js`, and the generic gate detector in
`src/spawns/engines/gateDetector.js`.

Preset authors use this page as the reference. A preset names the engine as
`{ engine: 'structure', params: { recipe: '...', ... } }`. `recipe` is required; every other param is
optional and falls back to the default below. A size given as `[min, max]` is rolled per site with
the spawn's seeded random generator, so the same site always builds the same way. A bad value throws
an error that names the engine, the preset and the param, for example
`[DRIFTWING] structure preset "windFarm": param "params.count" must be within 1..16, got 40`, and the
SpawnManager refuses that activation.

## What a structure is

One structure instance is built once at create, in the instance's local frame (metres from its
anchor), and shown on pooled meshes (never a new mesh per instance: see "Mesh lifetime in three
r184" in docs/architecture.md). Up to five geometries per instance:

| part | material | shown at | used for |
| --- | --- | --- | --- |
| body | flat-shaded, vertex colours in the v1 palette; casts shadows at near | near, mid, far | towers, timber, rock, hangars, trees |
| detail | the same | near only | ropes, weeds, crates, fence posts, roots, boulders |
| decal | flat, polygon-offset over the terrain | near, mid, far | runway tarmac and markings |
| glow | crystal: emissive rising toward the tip, pulsing in its own phase, brighter at night (bloom picks it up), a fresnel rim | near, mid, far | crystal spires and shards |
| water | transparent streaks scrolling down a ribbon, lit by the sun colour, dimmed at night | near, mid | waterfalls and streams |

Moving parts are shared instanced meshes built once in `init()` (capacity in brackets): turbine
nacelles and rotors (256), windsock segments (64 socks of 5 segments) and mist puffs (512 soft
luminous blobs). A heavy preset hides everything at the far tier (its lure takes over); a light one
keeps its body, decal and glow there. Turbines keep turning at mid and freeze (still drawn) at far;
windsocks animate at near only; mist shows at near and mid.

The frame: a compass `heading` (degrees) from the activation; `along` is forward on that heading,
`across` is to its right, heights are metres above the local ground unless a param says otherwise.

## Recipes

| recipe | builds | reads the site's stamp | generic features |
| --- | --- | --- | --- |
| `windFarm` | rows of three-bladed turbines; nacelles yaw into the real WindField wind, rotors spin with its speed | none | wake turbulence (WindField source), wind-driven voice |
| `ropeBridge` | a timber-plank rope bridge slung between the gorge anchors, swaying in the wind | `gorge` | a pass-under gate (Thread the Needle) |
| `airfield` | a worn strip with faded markings, hangar ruins, a hut, edge lights, a fence and a windsock | `flatten` | graded landings, ground-start spots |
| `islands` | floating rock islands with trees, a clear meadow, roots, waterfalls off the edges into mist | `islandBase` (optional) | landable tops (extra ground surfaces) |
| `spires` | a cluster of glowing crystal spires with shards and boulders | none | chime gates between spires, approach-driven hum |
| `gates` | a timed course: start and finish gates marked by cairns with pennants, an optional river down the canyon floor | `carve` | a timed course, a journal best run, an optional corridor |
| `waterfall` | a river spilling over the cliff step as a wide curtain of falling strands into the plunge pool, the river on downstream, boulders and mist puffs | `cliffStep` | a voice at the pool (the `waterfall` recipe) |
| `challengeGates` | the gate frames of the preset's `challenge` course: posts and a lintel for rectangle gates, a hoop on a post for circle gates, pennants (white start, red checkpoints, chequered finish) | none | a challenge course registered with the challenge system (start prompt, splits, medals, bests per craft) |
| `monastery` | a whitewashed cliffside monastery: halls on the plateau and down the face on buttresses, a chorten, a bell pavilion, a prayer pole, prayer-flag strings, stairs, pines | `cliffStep` | cloth flags in the wind, dusk lamps and braziers (torches), landable roofs and perches, a wind-driven voice |
| `castleRuin` | a ruined castle on a sea cliff: curtain walls with battlements and breaches, round towers, a gatehouse, a roofless hall, the keep with banners | `cliffStep` | colliders on every wall and tower, cloth banners, braziers (torches), the keep a landable perch |
| `observatory` | a summit observatory: a drum and silver dome, a second dome, a control building, a mast and a dish, red lamps | `flatten` | the dome, shutter and telescope as movers aimed at the celestial engine's sky target, a motor-driven voice (`recipe`) |
| `viaduct` | a stone railway viaduct across a gorge between two tunnel portals, and a steam train on a PathFollower | `gorge` | train movers with colliders, chimney steam, a voice that rides the locomotive, pass-under arch gates |
| `dam` | a concrete gravity dam on the down-valley rim of a reservoir basin, an open spillway chute, a stilling basin, the river below, intake towers, a valve house | `basin` | hull colliders, a landable crest, water ribbons, mist |
| `oasis` | date palms round a spring pool, reeds, a well, goat-hair tents with rugs, a shade shelter, a fire pit | `basin` | swaying crowns as perches, dusk lamps (torches) |
| `labyrinth` | a seeded hedge maze with an entrance, an exit, a fountain and an obelisk at its heart | `flatten` | instanced hedge blocks, one collider per run, a gate through the heart |
| `fireball` | a bolide crossing the sky, its impact flash and a glowing scorched scar draped on the ground | none | movers on the event's clock, an emissive decal that cools through the glow, a voice on the head, a distance-delayed boom |

Without its stamp (a debug spawn, or a site whose preset lists none) every recipe still builds:
the bridge spans `span` metres across the heading on trestles, the strip is draped along the
heading, the islands float over the ground, and the course runs `length` metres along the heading.

Phase 3 adds the recipes above from `monastery` on (presets 53-60) and more in later batches: a
recipe is `build(context, read)` in `structure/recipes/`, registered by name in `recipes/index.js`. It
fills the context's builders and its `out` record (turbines, socks, puffs, zones, surfaces, colliders,
courses, wake, sway, audio point, radius, and the [Phase 3 recipe features](#phase-3-recipe-features):
movers, an animate hook, steam, torches, blocks) and adds gates with `context.addGate`; every generic
feature below then works for it with no engine change.

## Common params (every recipe)

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `recipe` | | see above | required | |
| `stamp` | index | 0..16 | 0 | which stamp of the recipe's type on the site to build on (a site with two gorges) |
| `sway` | m | 0..5 | 0.35 | sway amplitude for recipes without their own sway (tree tops and pennants swing with the wind in the vertex shader); the rope bridge uses `swayAmplitude` |
| `gates` | array | | `[]` | extra gates in the site frame, see [Gates](#gates) |
| `voice` | bool | | unset | `true` or `false` decides whether this entry plays `preset.audio` as its spawn voice; unset, the preset's first engine entry owns it, so a preset opens one voice |
| `audioIntensity` | | `approach`, `wind`, `constant`, `recipe` | per recipe | how the voice's intensity is driven: the player's approach (spires), the wind speed over the rated wind (wind farm), the recipe's animate hook (`recipe`: the observatory's motors, the train's speed, the fireball's roar and fire), or `audioLevel` (the others) |
| `audioLevel` | 0..1 | | 0.8 | the level for `constant` |

## windFarm

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | turbines | 1..16 | [5, 8] | |
| `rows` | | 1..4 | 1 | odd rows are staggered by half the spacing |
| `spacing` | m | 60..1200 | 260 | between turbines in a row |
| `rowSpacing` | m | 60..2000 | 480 | between rows |
| `jitter` | share of spacing | 0..0.45 | 0.12 | seeded placement jitter |
| `hubHeight` | m | 15..160 | [72, 86] | above the ground at each tower |
| `rotorRadius` | m | 4..80 | [36, 42] | capped at 0.9 x the hub height |
| `towerColor` | 0xRRGGBB | | 0xf2efe8 | |
| `align` | | `wind`, `site` | `wind` | rows across the prevailing wind (each row meets clean air), or across the site heading |
| `maxRpm` | rpm | 0..40 | 16 | at the rated wind |
| `cutIn` | m/s | 0..20 | 3 | the rotors stop below it |
| `ratedWind` | m/s | 1..40 | 11 | must be above `cutIn`; also the wind-driven voice's full level |
| `cutOut` | m/s | 5..80 | 25 | the rotors feather above it |
| `yawRate` | deg/s | 0.1..90 | 5 | how fast a nacelle turns into the wind |
| `wake` | object or null | | `{}` | wake turbulence downwind of every rotor; null for none |
| `wake.length` | rotor diameters | 1..30 | 8 | |
| `wake.deficit` | share of the wind | 0..0.9 | 0.35 | the slower air in the wake core |
| `wake.turbulence` | 0..1 | | 0.45 | |
| `wake.expansion` | m per m | 0..0.3 | 0.075 | how fast the wake widens |
| `wake.gust` | m/s | 0..30 | 3 | the wake's own gusts at full turbulence (smooth seeded noise, like the WindField sources' gusts), so a craft feels the bumps it reads; 0 leaves only the turbulence reading and the deficit |

The turbines show the wind the player feels: the WindField's ambient wind at hub height (read once
at create, then scaled by the live `windStrength`), plus the gusts and turbulence the craft meets
while it is within 3 km of the farm, eased over half a second. Rotor speed eases toward
`maxRpm x ((wind - cutIn) / (ratedWind - cutIn))^0.6` with each rotor's inertia.

## ropeBridge

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `span` | m | 20..600 | 140 | free-standing only (with a gorge the anchors set the span) |
| `deckWidth` | m | 1..8 | 2.4 | |
| `sag` | share of the span | 0..0.2 | 0.07 | |
| `plankSpacing` | m | 0.4..4 | 1.05 | |
| `missingPlanks` | share | 0..0.5 | 0.05 | never at the ends |
| `postHeight` | m | 1.5..12 | 4.6 | above the deck |
| `handRail` | m | 0.5..3 | 1.15 | hand rope height mid-span |
| `swayAmplitude` | m | 0..5 | 0.45 | mid-span swing (0 at the anchors) |
| `gate` | object or null | | `{ id: 'under' }` | the pass-under gate; null for none |
| `gate.id` | | | `under` | the gate id in `structure:gate` |
| `gate.achievement` | `{ id, title }` or null | | null | fired once per spawn: `{ id: 'threadTheNeedle', title: 'Thread the Needle' }` |
| `gate.clearance` | m | 0..20 | 2 | the gate's top sits this far under the deck mid-span |

With a gorge stamp the deck hangs between the two lips (where the ground falls away below the
anchor pad), with timber landings, posts, guy ropes and a plank path back to each pad. The gate
spans the gorge from 5 m under its floor to the deck.

## airfield

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 200..4000 | 1200 | free-standing only (the flatten stamp sets it) |
| `width` | m | 12..120 | 45 | free-standing only |
| `fade` | 0..1 | | 0.5 | how worn the markings are (paler, missing, broken) |
| `weeds` | 0..1 | | 0.25 | weedy tarmac patches and tufts |
| `hangars` | object or null | | `{}` | null for none |
| `hangars.count` | | 0..6 | 2 | quonset hangars on the apron beside the runway |
| `hangars.ruin` | 0..1 | | 0.55 | missing roof panels, rust, a broken back wall, a fallen door |
| `hangars.length`, `hangars.width` | m | 6..60 | 18, 24 | |
| `hangars.height` | m | 3..25 | 8.5 | |
| `hangars.spacing` | m | width + 2..200 | 34 | |
| `hut` | bool | | true | a derelict hut with a lookout cab |
| `windsock` | bool | | true | shows the real WindField wind: fills out with the speed (full at 8 m/s), swings downwind, flutters with the turbulence |
| `edgeLights` | bool | | true | broken edge lights |
| `fence` | bool | | true | leaning fence posts |
| `landing` | bool | | true | grade touchdowns on the runway |
| `groundStart` | bool | | true | offer the thresholds as ground-start spots |

The runway numbers are the real magnetic-style numbers of its two headings (seven-segment digits,
upright for each approach). The markings are threshold piano keys, touchdown bars at 150 m, a
centreline and edge lines.

## islands

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | islands | 1..8 | [3, 4] | the first is the largest |
| `radius` | m | 15..400 | [70, 150] | |
| `altitude` | m | 30..3000 | [220, 420] | top above the islet (or the ground or sea) under it |
| `spread` | m | 0..5000 | 520 | islands beyond the islets spread this far around the site |
| `thickness` | share of the radius | 0.3..3 | [0.9, 1.3] | depth of the hanging rock body |
| `dome` | m | 0..20 | 3.5 | the top's gentle dome |
| `treeDensity` | factor | 0..2 | 0.55 | |
| `meadow` | share of the circle | 0..0.9 | 0.3 | a tree-free sector: the landing ground |
| `waterfalls` | per island | 0..4 | [1, 2] | the first island always has one |
| `fall` | share of the height | 0.1..1 | 0.75 | the ribbon's length before it fades into mist (at most 420 m) |
| `roots` | per island | 0..60 | 14 | roots hanging from the rim |
| `mist` | bool | | true | mist puffs where the falls fade and under each island |
| `landable` | bool | | true | register each top as an extra ground surface |

The first islands float over the site's `islandBase` stamps (sea-stack islets), one each; the rest
spread around the site, kept apart.

## spires

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | spires | 1..24 | [5, 9] | the first is the tallest, near the centre |
| `height` | m | 5..400 | [45, 110] | |
| `radius` | m | 0.5..40 | [4, 8] | |
| `spread` | m | 5..1000 | 90 | |
| `tilt` | deg | 0..45 | 12 | outward lean |
| `colors` | 0xRRGGBB array | | `[0x8fe3ff, 0xb89cff, 0x9ff0d0]` | cycled over the spires |
| `shards` | per cluster | 0..80 | [8, 14] | small crystals around the bases |
| `chimes` | bool | | true | a fly-through gate between every pair of neighbouring spires that rings the voice's `chime` |
| `maxGap` | m | 5..500 | 75 | spires farther apart get no chime gate |
| `approach` | m | 50..20000 | 1500 | the approach voice rises from silent at this distance to full at 40 m (the crystal recipe's pitch follows the intensity) |

## gates

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `course` | id | | the preset id | the course id in `structure:course` |
| `clean` | bool | | true | a soft crash between start and finish spoils the run |
| `ceiling` | m | 0..500 | 25 | the gates reach this far above the canyon rim |
| `margin` | m | 0..100 | 6 | added to the canyon half width |
| `markers` | bool | | true | cairns with pennants on both rims (white start, red finish) |
| `markerHeight` | m | 0.5..30 | 4.5 | |
| `length` | m | 50..20000 | 600 | free-standing only |
| `journal` | journal key | camelCase | null | send each clean run's time as a `journalStat` (op `min`): `bestCanyonRun` |
| `corridor` | bool | | false | the run is flown inside the canyon: climbing more than `ceiling` above the rim of the canyon path point nearest the craft spoils a clean run (a notice says so) |
| `river` | bool | | false | a water ribbon down the canyon floor along the carve's path, flowing downstream, fading at both ends |
| `riverWidth` | share of the floor | 0.1..1 | 0.55 | the river's width |

## waterfall

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `spill` | share of the cliff width | 0.05..0.95 | 0.32 | the curtain's width (at least 2.2 x the stamp's channel half width) |
| `strands` | count | 1..24 | [6, 9] | seeded strands across the curtain, with narrow gaps; each has a thinner veil behind it |
| `launch` | m/s | 0..30 | 4.5 | how fast the water leaves the lip: the strands fall on a ballistic arc out from the face |
| `river` | bool | | true | the river upstream (widening from the channel to the curtain at the lip) and downstream of the pool |
| `riverWidth` | share of the channel | 0.2..1 | 0.85 | |
| `mist` | bool | | true | mist puffs where the curtain meets the pool |
| `boulders` | count | 0..60 | [10, 16] | about a third at the lip between strands, the rest around the pool |
| `drop`, `width` | m | 20..400, 40..1200 | 120, 240 | free-standing only: without a `cliffStep` stamp the recipe raises its own basalt cliff across the heading |

The curtain reads the stamp's lip, top and pool levels (`topY`, `bottomY`, `poolDepth`, `poolAlong`,
`channelWidth`), so it pours from the stamped river channel into the stamped plunge pool. Pair it with
the waterEffect `plungePool`, an emitter mist at the pool, the celestial `rainbow` and a windModifier
`curtain` (the mega-waterfall preset).

## challengeGates

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `frames` | bool | | the block's `frames` (true) | draw the gate frames; without them the course is flown through the HUD's glowing gate markers alone |
| `style` | | `timber`, `stone` | `timber` | the frames' material |
| `post` | m | 0.3..6 | 1.2 | post and beam thickness |

The course comes from the preset's `challenge` block (src/gameplay/challenges.js
`validateChallengeBlock`, checked by the preset schema): gates in the spawn's frame (`along` the
heading, `across` to the right, `height` above the ground, `heading` and `pitch` relative to the
spawn, `shape` circle with `radius` or rect with `halfWidth` and `halfHeight`), plus the course rules
(`medals`, `missed`, `sensors`, `start`, `abandonDistance`, `teleportDistance`, `timeLimit`, `record`).
The recipe resolves it to a world course with the id `${presetId}:${siteId}` (`${presetId}:${seed}` for
an event) and hands it to the engine as `out.challenge`; the engine registers it with
`ctx.game.systems.challenges` at create (`data.challengeKeys`) and unregisters it at dispose. The
frames are visual only: a preset that wants solid frames adds its own collider boxes.

## monastery

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `halls` | count | 0..5 | [2, 3] | lower halls clinging to the face below the main hall, each on a masonry buttress, reached by timber stairs |
| `strings` | count | 0..40 | [10, 14] | prayer-flag strings from the pole and the roofs to posts along the edge and down to the lower halls |
| `flags` | per string | 4..60 | [16, 26] | flags on each string, in the five colours in order (the cloth kind: they swing out downwind and ripple) |
| `chorten` | bool | | true | a whitewashed chorten with a gilded spire |
| `bell` | bool | | true | the bell pavilion |
| `pines` | count | 0..30 | [4, 8] | pines round the plateau |
| `drop`, `width` | m | 20..300, 80..800 | 90, 260 | free-standing only: the recipe raises its own basalt cliff |

The butter lamps light themselves at dusk and the braziers wait for a dragon's breath; all are
torches (ignitables). The roofs are landable perches. Pair it with `audioIntensity: 'wind'` and the
`bells` recipe, and a `lightEffect` of warm glows at night (the cliffside monastery preset).

## castleRuin

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `towers` | count | 4..9 | [5, 7] | round towers at the corners of the curtain wall; ruin topples some to stumps |
| `radius` | m | 15..80 | [30, 40] | the bailey's radius |
| `wallHeight` | m | 4..20 | [9, 12] | the curtain walls, with battlements |
| `keepHeight` | m | 15..80 | [34, 42] | the keep on the cliff edge, its top a landable perch |
| `ruin` | 0..0.9 | | 0.35 | breaches in the walls, fallen towers, missing merlons |
| `banners` | bool | | true | banners on the keep and gatehouse (the cloth kind) |
| `drop`, `width` | m | 20..300, 80..800 | 60, 300 | free-standing only |

Every wall and tower is a collider; braziers on the gate, the keep and in the bailey are torches that
only a dragon's breath lights.

## observatory

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 4..20 | [8, 10] | the main dome |
| `drum` | m | 3..20 | [7, 9] | the drum's height under the dome |
| `slewRate` | deg/s | 0.2..30 | 3 | how fast the dome and telescope turn (the telescope rises at 0.7 x this) |
| `openSeconds` | s | 2..300 | 22 | the shutter's travel |

Above night factor 0.45 the shutter opens (the voice's `clunk`), the dome turns its slit and the
telescope rises to the target: the celestial engine's `skyTarget` (a comet, else a meteor radiant),
else the moon more than about 12 degrees up, else a slow survey, kept between 12 and 70 degrees;
below 0.25 it parks pointing up and closes. The voice level is the motors' work (`recipe` mode).
Without a flatten stamp it stands on a stone plinth.

## viaduct

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `span` | m | 10..60 | [20, 26] | the target arch spacing; the gap between the lips is divided evenly |
| `deckWidth` | m | 3..14 | 6.4 | |
| `coaches` | count | 0..6 | [2, 4] | behind the locomotive and its tender |
| `speed` | m/s | 2..40 | [11, 15] | the train's speed |
| `wait` | s | 0..600 | [35, 60] | the wait in each tunnel before it comes back |
| `achievement` | `{ id, title }` or null | | null | awarded (once per spawn) by every arch's pass-under gate |
| `length` | m | 60..1200 | 260 | free-standing only: the span across the heading, its deck 30 m over the ground |
| `start` | share | 0..1 or null | null | null: the train is a pure function of flight time from a seeded place; a share of its path puts it there at the activation instead (debug and test spawns) |

The line runs between the gorge's two anchor pads; the deck spans the lips (where the ground falls
2 m below the deck) on semicircular arches over piers that batter out 1 in 30 toward their feet. Each
pad has a tunnel portal (a stone headwall, a dark bore 26 m deep, a grassy cover with boulders and
pines, a signal with a red lamp). The train's cars are movers with box colliders, posed on a
`createPathFollower` ping-pong path whose ends lie a train's length beyond each portal, so it turns
round out of sight; a car is hidden once it is 3 m past its half length inside a portal. The train
is a pure function of flight time (the follower starts at time 0 from a seeded distance). The
chimney puffs steam on the mist pool while it runs in the open, the voice rides the locomotive, and
it `whistle`s as it comes out of a tunnel. Colliders: piers, abutments, the crown and two haunch
steps of every arch (never below its soffit), the deck (landable), the portals (perches on their
lintels) and their covers.

## dam

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `spillway` | m | 8..120 | [26, 34] | the open spillway's width in the middle of the crest |
| `freeboard` | m | 0.5..10 | 2.5 | the crest's height over the basin's rim |
| `towers` | bool | | true | two intake towers in the lake with catwalks to the crest (on a basin) |
| `height`, `length` | m | 10..200, 40..1200 | 36, 220 | free-standing only |

The basin's frame runs down the valley. The wall stands on a straight line across it, just outside
the farthest reach of the shoreline along the whole crest (so no lake water lies below the dam); the
crest runs out each side until the valley side rises to it (at most 320 m), covers the berm's flat
top, and the downstream face falls at 0.75 : 1 to the ground. The spillway lip sits 0.35 m under
the lake, or 0.15 m over the rim crest beside it where that is higher (the lake brims just under it),
with a bridge on piers over it, training walls down the chute, a stilling basin and a river ribbon
220 m on down the valley. The resolved lake comes from `site.waters` (the preset's `waters`). Hull
colliders per few columns of the wall (the crest landable), the bridge, the training walls, the
basin walls, the towers and the valve house (perches).

## oasis

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `palms` | count | 4..60 | [20, 30] | date palms round the shore (on dry ground only), plus young palms further out |
| `tents` | count | 0..8 | [2, 4] | goat-hair tents beside the camp, each with a rug |
| `radius` | m | 15..400 | 60 | free-standing only: the hollow's diameter |

The palms follow the basin's lobed shoreline (`basinReach`), their trunks curving out over the water
and their fronds swaying more toward the tips; each trunk is a capsule collider with a perch on its
crown. The camp (well, tents, shelter, fire pit and two lamp posts) stands together on one side; the
fire and the lamps are torches lit at dusk. The camel caravan is the preset's fauna column.

## labyrinth

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `cells` | count | 7..41 | [17, 21] | cells a side (made odd, so there is a middle cell) |
| `hedge` | m | 1..12 | 3.4 | the hedges' height |
| `thickness` | m | 0.4..5 | 1.5 | |
| `achievement` | `{ id, title }` or null | | null | awarded by the gate through the heart |
| `size` | m | 30..600 | 140 | free-standing only (on a flatten stamp the maze fills the smaller side of the strip) |

A depth-first search from the middle cell, with the spawn's seeded generator, carves a perfect maze;
a clearing of 3 x 3 cells opens at the heart, and the entrance and the exit open on the near and far
sides. Consecutive wall edges merge into runs: one instanced block (the engine's block pool) and one
foliage box collider each. The heart holds a fountain and an obelisk (a perch); its gate spans the
clearing up to 6 m over the hedges.

## fireball

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `delay` | s | 0..120 | 4 | from the activation to the bolide's appearance |
| `fall` | s | 1..60 | 7 | its flight down to the impact |
| `altitude` | m | 1000..40000 | [11000, 14000] | where it appears, over the impact point |
| `angle` | deg | 5..80 | [24, 38] | its descent above the horizon, from a seeded bearing |
| `head` | m | 2..400 | 38 | the head's radius; the tail runs about 50 heads back |
| `scar` | m | 5..300 | [34, 48] | the scar's radius (ejecta rays reach about 2-3 radii) |
| `flash` | m | 10..2000 | 160 | the flash sphere's largest radius |
| `cool` | s | 5..1200 | 120 | the scar's embers fall to a third of their glow in this long (never below 10 %) |

The movers run on the event's own clock (from `params.startTime`): nothing before `delay`; the bolide
down its line, growing, the voice on its head, level 0.15 rising to 1 (`recipe` mode); at the impact
the flash swells over 0.18 s and is gone at 2.2 s, the scar (a `decal` mover draped on the ground, its
vertex alpha the embers' glow) spreads in 0.6 s, and `boom` is due when the sound has crossed the
distance to the player at 343 m/s (dropped, not played late, if the movers were hidden past it by
more than 2 s). The scar's embers cool through the instance glow (`state.glow`). There are no
colliders and no ground edits. A preset's other parts that should start at the impact set their own
start time to `delay + fall` (the emitter's `startDelay`).
## Generic features

### Terrain stamps

A structure's ground edits must be known to the terrain worker, which never runs an engine. So a
recipe never edits the ground itself: the preset lists the stamps in its `stamps` array, placement
resolves them once per site on both threads, and the recipe reads the resolved stamp from the site
(the runway thresholds, the gorge anchors, the islet tops, the canyon path). `structureStamps`
builds that list as plain data with the recipe's preferred sizes:

```js
import { structureStamps } from '../engines/structure/stamps.js';

stamps: structureStamps('airfield', { length: [1100, 1400] }),
stamps: structureStamps('ropeBridge'),
stamps: structureStamps('islands', { islets: 3, spread: 520 }),
stamps: [...structureStamps('gates'), ...otherStamps],
```

`structureStamps(recipe, options)` returns a frozen array of stamp specs (empty for `windFarm` and
`spires`). `options` may set any field of the stamp spec (sizes, `paint`, `offset`, `rotation`; see
the table at the top of `src/world/stamps.js`). For `islands`, `islets` (1..8, default 1) places
that many islets, the first at the site centre and the rest on a ring `spread` metres out (default
460). It is pure (it imports only `src/world/stamps.js`), so a preset module that calls it still
loads in the terrain worker, and it validates every spec, naming the recipe and the field.
`RECIPE_STAMP_TYPES` names the stamp type each recipe reads. Stamped presets change the terrain
digests that `tools/lab/terrain.mjs` guards (see docs/phase2-progress.md).

### Gates

A gate is a vertical rectangle: a centre, a horizontal normal, a half width along the plane and a
height band. The engine checks the player's segment from one frame to the next against every gate
of every live structure (a segment over 250 m is a teleport and passes nothing). A pass emits:

- `structure:gate` `{ spawnId, presetId, siteId, gate, kind: 'through' | 'under', direction: 1 | -1 }`
  (untyped bus event; `direction` is +1 along the gate normal);
- the typed `achievement` `{ id, title }`, once per spawn, when the gate has one;
- the voice's `chime` trigger for a gate with `action: 'chime'`.

Recipes add their own gates (the bridge's pass-under gate, the spires' chime gates, the course's
start and finish). Any preset adds more through `params.gates`:

| field | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `id` | | | `gate<index>` | |
| `kind` | | `through`, `under` | `through` | what the pass means to the preset |
| `along`, `across` | m | | 0 | the centre in the site frame |
| `heading` | deg | -360..360 | 0 | the gate normal, relative to the site heading |
| `halfWidth` | m | 0.5..2000 | 20 | |
| `bottom`, `top` | m above the ground | -500..5000 | 0, 40 | |
| `achievement` | `{ id, title }` or null | | null | |
| `action` | | `chime` or null | null | |

The detector itself (`gateDetector.js`: `createGateSet(gates)` and `crossGates(set, from, to,
first, result)`) is generic and allocation-free, for any engine that wants gates.

### Timed courses

A course is an ordered pair of gates (start, finish). Passing the start starts the clock; passing
the finish emits `structure:course` `{ spawnId, presetId, siteId, course, time, clean }` and a
`notify` toast with the time (the start raises a "run started" notice). A soft crash in between, a
jump between frames longer than the gate detector's teleport distance (a reset or relaunch), or for a
`corridor` course a climb out of the canyon spoils a `clean` course (no event). With
`journal`, a clean run also sends the typed `journalStat` `{ key, value: seconds, op: 'min',
presetId }`, which the journal keeps as the best run.

### Graded landings

A recipe's landing zone (the airfield's runway) grades the typed `landed` event of a touchdown on
it (30 m past its ends and 8 m past its edges still count). The score is out of 100: the landing
grade (butter 50, smooth 42, firm 28, hard 10), plus up to 25 for the centreline and up to 25 for
the touchdown zone (150-450 m past the threshold of the end being landed on). The engine emits
`structure:landing` `{ spawnId, presetId, siteId, zone, runway, grade, sinkRate, centreline,
fromThreshold, score, rating: 'greaser' | 'good' | 'fair' | 'rough' }` and a `notify` toast
("Runway 06: smooth touchdown, 3.0 m off the centreline, 300 m past the threshold. Score 89.").

### Ground-start spots

"Start on ground" prefers the nearest discovered site that offers a ground-start spot. An engine
offers spots through the optional hook `engine.groundStart(preset, params, site)`, which returns
`[{ x, z, y, heading, runwayLength }]` or null and must be pure (it reads only the site's resolved
stamps). The structure engine delegates to the recipe: the airfield offers a spot just inside each
threshold, facing down the runway. `ctx.systems.spawns.findGroundStart(x, z)` searches the
discovered sites within 80 km and picks the spot of the nearest site facing most nearly into the
ambient wind; the flight controller places the craft there and says "Starting at the abandoned
airfield.".

### Extra ground surfaces (landable tops)

Floating island tops are not terrain, so the engine registers each one in `ctx.surfaces` (the
game's `ctx.groundSurfaces`, `src/world/groundSurfaces.js`) with exactly the height function the
top mesh is built from, and removes it on dispose. The flight controller's ground contact is the
higher of the terrain and any surface at most 12 m above the craft's centre, so a craft lands and
parks on an island top but flies freely beneath it. A craft change on a top keeps the craft up
there. Any recipe (or engine) that builds landable ground uses the same registry:
`surfaces.add({ id, minX, maxX, minZ, maxZ, top, heightAt(x, z) })` (`heightAt` returns NaN off the
surface) and `surfaces.remove(id)`.

With the game's collider service (Phase 3, `ctx.game.colliders`) each island top is instead a
landable heightfield collider sampled from the same exact function, which publishes that function
to the ground surfaces under the collider's id (still listed in `data.surfaceIds`): landings stand on
exactly the rendered top, and a fast strike on it is a structure strike.

### Colliders (Phase 3)

A recipe lists its solid parts in `out.colliders`, in the instance's local frame, with the helpers of
`structure/colliders.js` (`localBox`, `localBoxAxes`, `localCylinder`, `localCapsule`,
`localSphere`, `localHull`, plus `builderFrame` and `ringPoints` to follow the mesh builder's frames
and lathes). The engine registers them with `ctx.game.colliders` at create (ids
`${preset.id}:${params.seed}:${serial}:<part><n>`, all in `instance.colliderIds`) and removes them
on dispose. Turbine nacelles and rotor discs are added by the engine from `out.turbines` and turned
with each turbine's yaw every frame (`setPose`, allocation-free). The Phase 2 recipes: wind farm masts
(cylinders as wide as the foot), the rope bridge's deck boxes (covering the sway), rope, post, guy
and lintel capsules and its landings, the airfield's hangar hulls (landable roof crests), hut,
control tower and windsock pole, the crystal and shard hulls (perches on the spire tips) and boulder
spheres, the islands' rock body (four wedge hulls of the actual ring vertices), trees, boulders and
roots. Props under 2 m tall carry none. The node labs run the engine without a collider service and
skip all of it.

### Wind

The wind farm's wake is a WindField source (`kind: 'structure-wake'`, id `<spawnId>:wake`): slower,
turbulent air with its own gusts (`wake.gust`) in a widening cone downwind of every rotor, following the eased wind the turbines
show. It is added at the near and mid tiers and removed at the far tier, where the player is
kilometres away and cannot reach a wake a few rotor diameters long; it comes back at mid, and
dispose removes it. No other recipe authors wind.

### Audio

With `preset.audio` the engine plays one spawn voice (`ctx.audio.spawnVoice(recipe, params)`) at the
recipe's audio point (the hub height, the bridge deck, a waterfall, the spire cluster) and disposes
it with the instance. Typical recipes: `turbine` for wind farms (intensity = wind speed / rated
wind), `waterfall` for islands, `crystal` for spires (intensity = approach; chimes on the gates).
The level is sent at most 10 times a second and only when it moves by 0.01.

### Live params (set pieces)

`instance.params` holds live multipliers a set piece's ramps write directly: `glow` (the emissive
and crystal glow), `sway` (the sway amplitude), `rotorSpeed` (the turbine speed) and `audio` (the
voice level), all 1 by default. `engine.setParam(instance, name, value)` sets the same numbers and
returns whether the name is known.

## Phase 3 recipe features

Optional fields of a recipe's `out` record and context; a recipe that fills none of them builds
exactly as a Phase 2 recipe does.

- **Cloth** (`context.cloth`, a sixth geometry kind, shown at near and mid): flags and banners. Each
  vertex's sway value is its hang (metres from the edge it is tied to); the material swings the cloth
  out downwind about that edge by an angle growing with the wind speed (0.11 rad per m/s, at most 1.25)
  and ripples it, faster in a stronger wind and harder in turbulence, from the wind the structure
  shows (`data.clothWind`: unit direction, speed, turbulence). Helpers: `addFlagString` and
  `addBanner` in `structure/heritage.js`.
- **Movers** (`context.addMover({ name, kind, collider })`, returning `{ builder, index }`): parts with
  their own geometry (built in the mover's frame, its origin the pose origin, forward -z) on pooled
  meshes of the `body`, `glow` or `decal` material (64 of each kind at once). The recipe's animate
  hook writes each pose into `state.poses[index * 8 ...]`: local x, y, z, yaw (a compass heading in
  radians), pitch (nose up), roll, scale and visible. A `collider` (`{ center, halfExtents, tags }`, a
  box in the mover's frame) follows its pose through `setPose`, only when it moved. Movers show and
  animate at the near and mid tiers and hide at far; they cast shadows at near (body kind).
- **The animate hook** (`out.animate(state, env)`, with `out.animateState`): one module-level
  function per recipe, never a per-instance closure (closures deoptimise each other and the baseline
  code then boxes every double); its instance's numbers arrive as `state.custom = out.animateState`.
  It writes `state.poses`, `state.steam`, `state.level[0]` (the voice level in `recipe` mode),
  `state.glow[0]` (a multiplier on the instance's emissive glow) and `state.voice` ([x, y, z, 1]: the
  voice moves to that local point at the audio rate; 0 in [3] keeps it at the audio point). It reads
  `env.clock` ([time, step, night factor, sun elevation, shown]), `env.wind` (the wind the structure
  shows), `env.anchor`, `env.player`, `env.moonDirection`, `env.sunDirection`, `env.skyTarget(out)`
  (the celestial engine's sky target: 1 comet, 2 radiant, 0 none) and `env.trigger(name, options)`
  (a voice trigger: event work). It runs once at create (step 0) and every frame while the movers
  show, and must not allocate (tools/lab/presets-51-60.mjs measures it).
- **Steam** (`out.steam`, a count): dynamic puffs on the shared mist pool, hidden until the hook
  sizes them through `state.steam[i * 4 ...]` (local x, y, z, radius; 0 hides one). The viaduct's
  chimney.
- **Torches** (`out.torches: [{ x, y, z, size, autoLight }]`): flames on a shared instanced pool
  (512), flickering in their own phase and brighter at night. Each is an ignitable in the game's
  ignition service (`ctx.game.ignition`, ids `${prefix}:torch<n>` in `instance.ignitableIds`) that a
  dragon's breath lights; `autoLight` torches light through the service above night factor 0.55 and go
  out below 0.2 (a dusk lamp a flame lit goes out at dawn too). Dispose removes every ignitable.
  `addTorchPost` in heritage.js builds a post and returns the flame's height.
- **Blocks** (`out.blocks: [{ x, y, z, sizeX, sizeY, sizeZ, yaw, paint }]`): boxes on a shared
  instanced pool (4096) with instance colours, their base at `y`, `sizeX` across and `sizeZ` along
  the compass `yaw`; they show where the body shows and are rewritten only when the curvature drop
  moves by 0.25 m or the tier changes. The labyrinth's hedges.
- **Emissive decals**: the decal material glows where a vertex's alpha (its paint's emissive gain)
  says, times the instance glow; the Phase 2 decals paint 0 and stay unlit. The fireball's embers.
- **Heritage props** (`structure/heritage.js`): `createSiteFrame`, `cliffSiteFrame` (the frame on a
  cliffStep's lip, or a raised basalt cliff without one), `outwardQuad`, `addWhiteHall`,
  `addHipRoof`, `addBattlements`, `addArchRing`, `addFlagString`, `addBanner`, `addTorchPost` and the
  `HERITAGE` colours.

`stats()` also returns `movers`, `flames`, `litFlames` and `blocks`.

## Events

| event | kind | payload |
| --- | --- | --- |
| `structure:gate` | bus | `{ spawnId, presetId, siteId, gate, kind, direction }` |
| `structure:course` | bus | `{ spawnId, presetId, siteId, course, time, clean }` |
| `structure:landing` | bus | `{ spawnId, presetId, siteId, zone, runway, grade, sinkRate, centreline, fromThreshold, score, rating }` |
| `achievement` | typed | `{ id, title }` (a gate's achievement) |
| `journalStat` | typed | `{ key, value, op: 'min', presetId }` (a clean course run with `journal`) |
| `notify` | bus | course times and landing scores |

A preset whose gate earns an achievement should declare it in its `achievements` list, so the
journal can show it before it is earned.

## Stats

`stats()` returns `{ instances, particles: 0, lights: 0, buffers, drawCalls, turbines, mistPuffs,
surfaces, gatesPassed, landingsGraded, coursesRun }`. `buffers` counts the per-instance geometries
plus the four shared instanced meshes; `drawCalls` counts the visible per-instance meshes plus each
instanced pool in use.

## Budget and cost

`budget: { instances: 24, particles: 0 }` (the director's cap), no real lights. Measured by
`tools/lab/structure.mjs` (cost test) on the test kit presets at the near tier:

| preset | update() CPU | triangles | instanced parts | draw calls | in game: draw calls / triangles per frame |
| --- | --- | --- | --- | --- | --- |
| wind farm (6 turbines) | about 0.7-1.1 us | 840 | 6 nacelles, 6 rotors | 4 | +6 / +3 048 |
| rope bridge | about 0.2 us | 3180 | | 2 | +3 / +7 700 |
| airfield | about 0.5-0.7 us | 7040 | 5 windsock segments | 4 | +5 / +7 760 |
| floating islands (3) | about 0.2 us | 10843 | 44 mist puffs | 4 | +5 / +17 000 |
| crystal spires (7) | about 0.2-0.3 us | 1604 | | 2 | +3 / +2 190 |
| canyon course | about 0.2-0.3 us | 992 | | 1 | +2 / +1 980 |

The last column is the GPU load each structure adds in the game at the near tier, every pass
included (the shadow pass draws the bodies too): `tools/steps/engine-structure.json` samples the
renderer's per-frame draw calls and triangles for 30 frames before and after each create, on both
backends with the same numbers. Its frame times before and after are reported too; on the shared
test machine they moved by about -2 to +4 ms either way with the machine's other work, so no
structure shows a cost above that noise.

`update()` allocates nothing (the lab runs 100 000 frames of six structures with no garbage
collection); per-instance numbers live in typed arrays and the instanced matrices are written
straight into their buffers. `dispose()` returns every per-instance geometry and pooled slot, the
wind source, the surfaces and the voice; the shared pools stay for the session (prewarmed behind the
loading fade), so GPU memory returns to its level before the create
(`tools/steps/engine-structure.json`).

## Testing

- `node --expose-gc tools/lab/structure.mjs`: every recipe on its real stamped site and free-standing,
  params, stamps and `structureStamps`, gates, courses and the journal, landings, surfaces, ground
  starts, the wake, LOD, memory, cost and allocation.
- `node tools/smoke-test.mjs --url <dev server>/v2/ --steps-file tools/steps/engine-structure.json`:
  every kit preset force-spawned ahead of the craft and framed, a screenshot each, GPU memory and
  wind sources back after every dispose, the bridge gate and its achievement; add
  `--query renderer=webgl` for WebGL2.
- `node tools/smoke-test.mjs --url <dev server>/v2/ --query test=sites --steps-file
  tools/steps/engine-structure-sites.json`: the recipes on the terrain fixtures' real stamped sites
  (`?test=sites`, dev builds only).
- `node --expose-gc tools/lab/presets-51-60.mjs [--only <ids>]`: the Phase 3 batch 6 recipes
  (monastery, castle ruin, observatory, viaduct, dam, oasis, labyrinth, fireball) on their real
  stamped sites and free-standing: colliders, perches, torches, movers and their colliders, the
  train's cycle and whistle, the dam's line outside the shoreline, the maze, the fireball's timeline,
  the cloth in the wind, memory and allocation.
- The test presets are in `src/dev/structureTestKit.js` (dev only, never in a production build).
