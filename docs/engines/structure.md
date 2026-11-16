# structure engine

Procedural low-poly builds from parametric recipes: wind farms, rope bridges, abandoned airfields,
floating islands, crystal spires, waterfalls and timed gate courses, and the scenery of the Phase 3
challenge courses (rock gates down a canyon, a cave tunnel, a wall of waterfalls, a balloon festival
and a kite-string slalom). The code is in
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
r184" in docs/architecture.md). Up to six geometries per instance:

| part | material | shown at | used for |
| --- | --- | --- | --- |
| body | flat-shaded, vertex colours in the v1 palette; casts shadows at near | near, mid, far | towers, timber, rock, hangars, trees |
| detail | the same | near only | ropes, weeds, crates, fence posts, roots, boulders |
| decal | flat, polygon-offset over the terrain | near, mid, far | runway tarmac and markings |
| glow | crystal: emissive rising toward the tip, pulsing in its own phase, brighter at night (bloom picks it up), a fresnel rim | near, mid, far | crystal spires and shards |
| water | transparent streaks scrolling down a ribbon, lit by the sun colour, dimmed at night | near, mid | waterfalls and streams |
| lava | molten lava: dark crust plates (two octaves of noise) drifting downstream at 1.4 m/s over glowing cracks, hottest and thinnest-crusted mid-flow, an HDR glow that the bloom carries and that reads brighter at night; polygon-offset over the channel floor; the vertex colour is the crust, its alpha the heat | near, mid, far | lava channels, the fissure's crack |
| portal | (Phase 3) additive arms of light spiralling into the centre (uv.x the angle share, uv.y the radius share), a bright rim, as bright by night as by day | near, mid, far | the portal ring's membrane |
| ghost | (Phase 3) translucent and additive: a fresnel rim over a faint body, a shimmer drifting up through it, strongest at night; the paint's alpha is the opacity | near, mid, far | the ghost galleon |

Moving parts are shared instanced meshes built once in `init()` (capacity in brackets): turbine
nacelles and rotors (256), windsock segments (64 socks of 5 segments) and mist puffs (512 soft
luminous blobs), and (Phase 3) lanterns (128 self-lit boxes, see [Lanterns](#lanterns-phase-3)). A heavy preset hides everything at the far tier (its lure takes over); a light one
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
| `lavaChannels` | molten lava down every carve stamp of the site, on to the sea (or a stand-in channel along the heading), cooled basalt blocks along the levees, crust slabs at the sea entry | `carve` (all of them) | lava ribbons, colliders on the larger blocks, `facts` (lavaFlows, seaEntries, lavaLength) |
| `ejecta` | impact blocks strewn over a crater's rim and outer flank, densest and largest on the crest, a few on the inner wall | `crater` | colliders on the larger blocks, perches on the biggest crest blocks, `facts` (blocks, solidBlocks, perches) |
| `saltPiles` | rows of harvested salt cones with crust rims at the edge of a salt pan's water film | `basin` | a small cylinder collider per cone, `facts` (saltPiles) |
| `glacier` | a tidewater glacier: a crevassed ice tongue down the heading to an ice cliff in the sea, calving slabs along its front and a field of drifting icebergs | none | movers (calving slabs, drifting bergs), a landable heightfield top with a perch, the front as solid boxes |
| `shipwreck` | an old wooden sailing ship broken in two in a reef's sand hollow, listing, its mainmast breaking the surface, cannon, barrels and planks on the sand | `reef` | underwater shading, collider hulls for the halves, capsules for the masts |
| `seaArches` | the rock lintel over each pair of arch legs a `seaStacks` stamp raises, rubble on the shelf below | `seaStacks` | a fly-through gate per arch (optional achievement), box colliders along each lintel with a perch on top |
| `caveMouth` | the mouth of a cave on the steepest high face near the anchor: a hood of broken rock around a dark opening, a black throat and a rubble apron | none | a collider hull for the hood; ends at once with no face in reach |
| `monastery` | a whitewashed cliffside monastery: halls on the plateau and down the face on buttresses, a chorten, a bell pavilion, a prayer pole, prayer-flag strings, stairs, pines | `cliffStep` | cloth flags in the wind, dusk lamps and braziers (torches), landable roofs and perches, a wind-driven voice |
| `castleRuin` | a ruined castle on a sea cliff: curtain walls with battlements and breaches, round towers, a gatehouse, a roofless hall, the keep with banners | `cliffStep` | colliders on every wall and tower, cloth banners, braziers (torches), the keep a landable perch |
| `observatory` | a summit observatory: a drum and silver dome, a second dome, a control building, a mast and a dish, red lamps | `flatten` | the dome, shutter and telescope as movers aimed at the celestial engine's sky target, a motor-driven voice (`recipe`) |
| `viaduct` | a stone railway viaduct across a gorge between two tunnel portals, and a steam train on a PathFollower | `gorge` | train movers with colliders, chimney steam, a voice that rides the locomotive, pass-under arch gates |
| `dam` | a concrete gravity dam on the down-valley rim of a reservoir basin, an open spillway chute, a stilling basin, the river below, intake towers, a valve house | `basin` | hull colliders, a landable crest, water ribbons, mist |
| `oasis` | date palms round a spring pool, reeds, a well, goat-hair tents with rugs, a shade shelter, a fire pit | `basin` | swaying crowns as perches, dusk lamps (torches) |
| `labyrinth` | a seeded hedge maze with an entrance, an exit, a fountain and an obelisk at its heart | `flatten` | instanced hedge blocks, one collider per run, a gate through the heart |
| `fireball` | a bolide crossing the sky, its impact flash and a glowing scorched scar draped on the ground | none | movers on the event's clock, an emissive decal that cools through the glow, a voice on the head, a distance-delayed boom |
| `worldTree` | (Phase 3) a colossal tree taller than the mountains: a buttressed S-curved trunk, tiers of great limbs with side boughs, a crown of foliage clumps with open lanes between the limbs, roots over the ground | none | capsule and sphere colliders, perches on the limbs and the crown, a gate per crown lane (an achievement), a groaning voice trigger |
| `portalRing` | (Phase 3) a ring of rune-carved stone blocks on two leaning pillars over a slab, a swirling membrane, hovering crystal shards | none | capsule and box colliders, the keystone a perch, a `portal` gate through the membrane |
| `sleepingGiant` | (Phase 3) a ring of standing stones and a cairn on the giant's chest, scree boulders on its flanks; free-standing, the figure itself as a basalt body | `giant` | box, cylinder and sphere colliders (the tallest stone a perch); free-standing, a landable heightfield collider of the figure |
| `ghostGalleon` | (Phase 3) a three-masted galleon of spectral light (the `ghost` part): lofted hull, castles, masts and yards, tattered bellied sails, bowsprit, shrouds and stays | none | sails a PathFollower loop over the cloud band (motion), moving capsule colliders, eleven ignitable lanterns, a tolling bell voice trigger |
| `dragonRace` | (Phase 3) a basalt crag on a peak with the preset's `challenge` course below it (the `challengeGates` frames and registration) | none | a course rival: a wild dragon that launches from the crag and races the route (see [Course rival](#course-rival-phase-3)); hull colliders, the crag top a perch |
| `canyonGates` | natural rock gates down a wide canyon: two weathered rock pillars beside every gate of the preset's `challenge` course (placed on the canyon floor and facing down it), a share bridged by rock arches, rubble along the walls | `carve` | a challenge course; pillar hulls, span boxes (perches) and rubble spheres |
| `caveTunnel` | a lone rock mountain with a winding tunnel bored through it, lanterns along the bore, the challenge gates in the bore | `flatten` | a challenge course; one three-mesh-bvh mesh collider for the whole mountain, bore included (contract b.6), a summit perch |
| `fallsWall` | a long cliff hung with many thin waterfalls, each fed by a stream over the top, mist and boulders at the foot | `cliffStep` | a challenge course; sinking air down every fall's arc (WindField source `structure-falls`); boulder spheres |
| `balloonCourse` | dozens of tethered v1-family hot-air balloons over a field, a pair flanking every gate of the `challenge` course | none | a challenge course; envelope hulls, basket boxes and tether capsules |
| `kiteSlalom` | kites flying from a hilltop on long strings, one beside every off-line checkpoint of the `challenge` course, with tails and streamers | none | a challenge course; every string a SENSOR capsule tagged `kiteString` (a miss, never a crash) |
| `archChain` | a line of v1-style natural stone arches with strata, caps and rubble, one around each of the preset's challenge gates (Phase 3, the five-arch chain) | `flatten` (optional: a level floor) | colliders (box legs, capsule ribs), crown perches, a wind-driven voice |
| `hoodoos` | a field of banded badland hoodoos with capstones and fallen blocks, in seeded clusters (Phase 3) | none | colliders (capsule shafts, capstone cylinders), perches on every top, a wind-driven voice |
| `iceRidges` | pressure ridges on a frozen lake: wandering lines of tilted ice slabs, only where the site's ice body holds ice | the site's `waters[water]` (its level and basin) | capsule colliders along every ridge, approach-driven voice |

Without its stamp (a debug spawn, or a site whose preset lists none) every recipe still builds:
the bridge spans `span` metres across the heading on trestles, the strip is draped along the
heading, the islands float over the ground, the course runs `length` metres along the heading, the
waterfall and the falls wall raise their own basalt cliff across the heading, the canyon gates stand
on a straight `length` m line and the cave mountain stands on the open ground.

Phase 3 adds the recipes above from `monastery` on (presets 53-60) and more in later batches: a
recipe is `build(context, read)` in `structure/recipes/`, registered by name in `recipes/index.js`. It
fills the context's builders and its `out` record (turbines, socks, puffs, zones, surfaces, colliders,
courses, wake, sway, audio point, radius, and the [Phase 3 recipe features](#phase-3-recipe-features):
movers, an animate hook, steam, torches, blocks) and adds gates with `context.addGate`; every generic
feature below then works for it with no engine change.

Phase 3's recipes register in `recipes/index.js` the same way; the stamp a recipe reads is listed in
`structure/stamps.js` (`RECIPE_STAMP_TYPES`, so `structureStamps('sleepingGiant')` returns the giant
stamp the recipe expects).

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

## iceRidges

Phase 3, the frozen lake (91). Reads the site's ice body (`params.site.waters[water]`: its level and
the basin that clips it, `waterOutlineContains`) and lays ridges across it, walking from a seeded
start on the ice both ways, wandering a little; a slab stands only inside the body's outline over
ground below its level. Each slab is a thin block standing along the ridge, leaning 15-50 degrees to
one side, with a rimed top. Every 26 m stretch of a ridge is one capsule collider (`iceRidge`,
surface `ice`). A site whose body holds no ice for a ridge is refused (an error naming `water`).
Without a site (a debug spawn) the ridges lie on the ground around the anchor within `spread`.

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `water` | index | 0..16 | 0 | which water body of the site |
| `ridges` | count | 1..12 | [3, 5] | |
| `length` | m | 20..2000 | [160, 340] | each ridge, end to end |
| `height` | m | 0.3..12 | [1.2, 3.4] | a ridge's slab height (each slab 0.55-1.15 times) |
| `slab` | m | 0.5..20 | [2.4, 5.5] | slab length; slabs stand 0.62 of a slab apart |
| `wander` | deg | 0..90 | 18 | how much a ridge bends along its way |
| `colors` | 0xRRGGBB array | | `[0xe6f2f8, 0xc4dceb, 0x9fc4da]` | ice white to deep blue, a seeded pick per slab |
| `spread` | m | 10..3000 | 220 | the reach without a site's basin |
| `approach` | m | 50..20000 | 1500 | the approach voice rises from silent at this distance |

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
| `reverse` | bool | | false | the reverse waterfall: the strands rise out of the pool, climb the face, leave the lip and twist into a column of water that climbs into the sky; the river runs toward the pool and the streaks scroll upward |
| `rise` | m | 50..2000 | 420 | `reverse` only: how far the column climbs above the lip before it frays into a mist cloud |
| `column` | m | 10..400 | 46 | `reverse` only: how far out from the lip the column stands |
| `columnRadius` | m | 2..200 | 16 | `reverse` only: the column's radius at its foot (it narrows by half as it climbs) |

The curtain reads the stamp's lip, top and pool levels (`topY`, `bottomY`, `poolDepth`, `poolAlong`,
`channelWidth`), so it pours from the stamped river channel into the stamped plunge pool. Pair it with
the waterEffect `plungePool`, an emitter mist at the pool, the celestial `rainbow` and a windModifier
`curtain` (the mega-waterfall preset). With `reverse`, pair it with an emitter of spray rising up the
column and a windModifier `updraft` round it (the reverse waterfall preset); the mist puffs gather at
the pool and in a cloud where the column fades.

## glacier

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length`, `width` | m | 300..6000, 80..2000 | [1400, 1900], [380, 540] | the tongue, down the heading (it narrows to 60 % inland) |
| `frontHeight` | m | 5..150 | [34, 48] | the ice cliff above the sea |
| `thickness` | m | 5..200 | [28, 44] | the ice over the ground inland |
| `slope` | rise over run | 0..0.3 | 0.04 | the surface's rise inland from the front |
| `reach` | m | 200..10000 | 2600 | how far down the heading the front is looked for: where it first meets water 1.5 m deep (else halfway down the tongue) |
| `slabs` | count | 0..8 | [3, 5] | calving slabs along the front |
| `slabDepth` | m | 4..60 | [12, 18] | a slab's thickness along the face normal |
| `bergs` | count | 0..16 | [6, 9] | drifting icebergs before the front |
| `bergSize` | m | 3..120 | [10, 30] | a berg's radius at the waterline (tabular or pinnacle) |
| `bergSpread` | m | 100..5000 | 900 | the berg field's reach; a berg's leash is 0.65 of it |
| `bergSpeed` | m/s | 0..5 | [0.35, 1] | |
| `interval` | s | 5..3600 | [40, 80] | between calvings |
| `first` | s | 0..3600 | [8, 18] | until the first calving |
| `wave` | `{ height, width, speed, travel }` | | `{ 2.6, 16, 9, 900 }` | the ring wave each plunge sends across the water (the water layer's travelling waves) |

The tongue's top is a heightfield collider (`landable`, `perch`, surface `ice`) built from the same
triangulated grid as the mesh, so landings use the exact top; the front cliff is a row of solid
boxes reaching 18 m under the sea. Bergs drift only where a navigable grid (40 m cells over the
field, sampled once at create) has water at least 5 m deep, and turn about at a shoal.

## shipwreck

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length`, `beam` | m | 10..120, 3..30 | [34, 46], [9, 12] | the ship |
| `list` | deg | 0..60 | [18, 32] | the halves lie over to a seeded side |
| `buried` | m | 0..6 | [1.2, 2.2] | how deep the keel sits in the sand |
| `gap` | m | 0..40 | [6, 10] | between the bow and the stern half |
| `mastRise` | m | 0.5..20 | [2.5, 4.5] | how far the mainmast's top stands out of the sea |

On a `reef` stamp the wreck lies in its sand hollow (`pocketY`); free-standing it lies on the ground
under the anchor. The recipe sets `out.underwater`: the structure's parts below the sea shade toward
the seabed's depth colour (turquoise shallows to deep blue by 12 m, as the terrain does), so the
wreck reads through the clear water of a waterEffect `shallows` entry.

## seaArches

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `thickness` | m | 3..40 | [9, 13] | the lintel's thickness at its crown |
| `rise` | m | 0..40 | [6, 10] | how far its underside arches up between the legs |
| `segments` | count | 4..32 | 12 | lintel segments (a box collider each) |
| `span`, `height` | m | 10..200 | [44, 60], [30, 40] | free-standing only: without a `seaStacks` stamp the recipe raises one arch across the heading, legs and all |
| `gate` | `{ id, achievement }` | | `{ id: 'arch', achievement: null }` | the fly-through gate under every arch (`arch0`, `arch1`, ... with two or more); `achievement` `{ id, title }` is sent on the first pass |

The stacks and the arch legs are terrain (the `seaStacks` stamp), solid as ground; the lintels are
box colliders with a perch at the middle of each.

## caveMouth

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `search` | m | 100..6000 | 1500 | the cliff-face search radius around the anchor (`src/spawns/engines/cliffFace.js`) |
| `width`, `height`, `depth` | m | 3..60, 2..40, 2..80 | [11, 16], [7, 10], [10, 15] | the opening and its throat |
| `requireFace` | bool | | true | with no face in reach the part ends at once (an activation whose every part ends is declined); false builds the mouth at the anchor |

A face is the steepest ground (rise over run at least 0.55, at least 25 m above the sea) on a 13 x 13
grid over the search square, high ground winning among the steep. The fauna engine's `stream`
behaviour runs the same search from the same anchor, so a preset's bats pour out of this mouth.

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

## lavaChannels

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `toSea` | bool | | true | after the channel's exit the flow runs on down the real ground to the sea (src/spawns/engines/lavaPath.js); false keeps it in the channel (a fissure) |
| `reach` | m | 0..8000 | 2500 | how far beyond the channel the flow may run looking for the sea; it ends in a lobe where it finds no lower ground |
| `width` | share of the channel | 0.2..1.5 | 0.8 | the lava's half width over the carve's floor half width |
| `spread` | factor | 1..4 | 1.6 | how much wider the flow fans out on its way to the sea (and 1.3 x that on the water) |
| `crust` | 0xRRGGBB | | 0x2b2522 | the cooled crust between the glowing cracks |
| `blocks` | per km | 0..80 | 12 | cooled basalt blocks along the levees; those of at least 2.2 m radius are solid colliders |
| `blockSize` | m | 0.3..12 | [1.5, 4] | block radius (smaller ones more often) |

The flow follows each carve stamp's resolved centre line (`stamp.path`) from its uphill entry to its
exit; beyond it, each 20 m step takes the lowest of five headings within 50 degrees of the current
one, until the ground drops below the sea (the sea entry; the lava runs 30 m on into the water) or no
step falls. The emitter's `seaEntry` param traces the same path, so a preset's steam stands exactly
where its lava meets the water. Pair it with the stamps of `structureStamps('lavaChannels', options)`
(a shallow channel between low levees, painted basalt; offset and rotate each channel through
`options`).

## ejecta

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `stamp` | index | 0..16 | 0 | which crater stamp of the site |
| `count` | blocks | 0..400 | [90, 130] | blocks on the rim and the flank (as many small fragments again on the crest, near only) |
| `size` | m | 0.3..20 | [1.5, 7] | block radius; the crest gets the big ones |
| `inner` | share | 0..0.5 | 0.12 | share of the blocks tumbled onto the inner wall |
| `perches` | count | 0..12 | 4 | the largest solid crest blocks carry a perch point on their top |
| `radius` | m | 50..3000 | 400 | without a crater stamp: the ring's radius around the anchor |

Blocks of 2.5 m radius or more are sphere colliders (`surface: 'stone'`); the flank's blocks thin out
with distance from the crest.

## saltPiles

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `stamp` | index | 0..16 | 0 | which basin stamp of the site |
| `rows`, `perRow` | count | 1..12, 1..80 | [3, 5], [24, 40] | rows of cones across the heading |
| `spacing`, `rowGap` | m | 2..40, 2..60 | 7, 9 | between cones in a row, and between rows |
| `height` | m | 0.3..4 | [0.9, 1.5] | cone height (the radius follows it) |
| `edge` | share of the basin radius | 0..0.95 | 0.62 | how far out from the basin's centre the rows stand, along the heading (at the water's edge for a pan filled to 70 %) |
| `radius` | m | 20..3000 | 300 | without a basin stamp: how far ahead of the anchor the rows stand |

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
## worldTree

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `height` | m | 200..3000 | [1100, 1350] | to the top of the crown |
| `trunkRadius` | m | 5..300 | [70, 90] | at the foot (the buttresses flare out below it) |
| `limbs` | count | 3..24 | [9, 12] | great limbs in tiers |
| `branchStart` | share of the height | 0.15..0.85 | 0.42 | where the lowest limbs leave the trunk |
| `crown` | m | 50..3000 | [520, 680] | the crown's radius |
| `roots` | count | 0..24 | [7, 9] | buttress roots over the ground |
| `clumps` | count | 1..16 | [5, 7] | foliage clumps per limb tip |
| `lanes` | bool | | true | a fly-through gate in every open lane between neighbouring limbs |
| `laneAchievement` | `{ id, title }` or null | | null | earned by the first pass through a lane |

Colliders: the trunk as capsules between its rings, every limb segment, bough and root a capsule,
the foliage clumps slightly smaller spheres (surface `foliage`). Perches: the top of each limb's first
bend and the crown's top clump. The voice groans now and then (`out.voiceTrigger` `creak`).

## portalRing

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `radius` | m | 8..200 | [38, 46] | the radius the ring's stone blocks sit on |
| `thickness` | m | 1..30 | 5.5 | the stone blocks' depth |
| `lift` | m | 0..200 | 9 | the ring's bottom above the slab |
| `stones` | count | 8..64 | 28 | blocks round the ring |
| `shards` | count | 0..24 | [5, 8] | hovering crystal shards |
| `runeColor`, `membraneColor` | hex | | 0x7fe8ff, 0x9d84ff | |

The ring faces along the heading. Its membrane is a gate with `action: 'portal'`: crossing it, either
way, sends `structure:portal` (see [Portals](#portals-phase-3)). Every block, both pillars and the
keystone are capsules, the slab a box; the keystone's top is a perch.

## sleepingGiant

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `stones` | count | 3..16 | [7, 9] | standing stones ringing the chest summit (46 m out, 7-11 m tall) |
| `boulders` | count | 0..200 | [36, 52] | scree on the lower flanks (where the figure stands 3-24 % of its height); over 6 m they are body (seen far off), smaller ones detail |
| `length`, `height`, `skirt` | m, m, share | 400..8000, 50..1500, 0..1 | 3200, 420, 0.26 | free-standing only: the figure's size (the giant stamp's own sizes otherwise) |

On a site the figure is the `giant` terrain stamp (src/world/stamps.js `giantFigure`): real ground,
basalt where it stands high. The recipe reads the stamp's frame and sizes and stands its stones and
scree on the stamped ground. Without the stamp (a debug spawn) it raises the figure itself along the
heading, its base at the anchor: a body sampled from the same `giantFigure` on a 24 m grid (mossy on
its lowest flanks) and a landable heightfield collider of the same top (`localHeightfield`; its highest
point is a perch), easing into the ground at its outline as the stamp does (`giantRaise`). Either way
the nose stands at `GIANT_NOSE` ahead of and above the anchor, where the preset's breath emitter
rises, and the voice's audio point sits there.

## ghostGalleon

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 20..160 | 62 | bow to stern |
| `loopRadius` | m | 200..8000 | [1500, 2100] | the loop it sails round the anchor (wobbling 16 %) |
| `altitude` | m above the sea | 50..6000 | 700 | the top of the cloud band |
| `clearance` | m | 20..2000 | 160 | the least height over the ground under the loop (sampled at each loop point and halfway to its neighbours) |
| `speed` | m/s | 2..60 | [11, 15] | |
| `lanterns` | bool | | true | eleven lanterns: the stern (three), the bow, the mast tops and the rails |
| `color` | hex | | 0x7fe8c8 | the hull and rigging; the sails are paler and fainter |

Everything is drawn in the `ghost` part. The ship sails `out.motion` (a closed loop, rocking with bob
2.4 m, roll 4 degrees and pitch 2 degrees); the hull (a capsule along the keel line), the stern castle,
the bowsprit and the three masts are capsules carried with it, with its velocity; the sails are ghost
cloth a craft passes through. Its lanterns burn a cold green (0x9fffd8) until a flame lights them warm
(0xffc46a). The voice tolls the bell every 14-28 s (`out.voiceTrigger` `bell`).

## dragonRace

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `frames`, `style`, `post` | | | as `challengeGates` | the course's gate frames |
| `cragHeight` | m | 20..400 | [80, 105] | the crag's four stacked rock drums |
| `cragRadius` | m | 5..120 | 26 | at its foot |
| `paceTime` | s | 5..1200 | 70 | the dragon's time to the finish leading any craft but a dragon |
| `rivalTime` | s | 5..1200 | 84 | its time racing a dragon (the course's rival) |
| `dragonScale` | | 1..40 | 9 | the dragon craft's mesh scaled up |
| `rivalName` | | | `the wild dragon` | the challenge HUD's rival name |
| `achievement` | `{ id, title }` or null | | null | earned by finishing ahead of the rival as a dragon |

The racing line runs from the crag's top through every gate centre (with midpoints lifted 30 m clear
of the ground) and 160 m past the finish. Colliders: each rock drum a hull; the top drum's top is the
perch the dragon sits on.
## canyonGates

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `arches` | share | 0..1 | 0.5 | the share of checkpoints whose pillars are bridged by a rock arch over the opening (start and finish never are) |
| `pillarRadius` | m | 1..30 | [5, 8] | each pillar's radius at its foot (a jagged seven-sided lathe tapering to 62 %) |
| `span` | m | 2..40 | [7, 11] | an arch's thickness |
| `rubble` | count | 0..80 | [16, 26] | boulders along the canyon walls, kept 30 m or more off the floor's centre line |
| `length` | m | 200..20000 | 2400 | free-standing only: the straight course's length along the heading |

Every gate of the preset's `challenge` block is placed on the `carve` stamp's floor path: `along` is
metres along the canyon from its middle, `across` offsets it from the path, `height` lifts it above
the floor there, and it turns to face along the path (a gate on a bend faces along the bend). Two
pillars stand outside the opening with 1.5 m to spare; their hulls hold the jagged lathe, and their
tops and the arch spans are perches. The course is registered as `challengeGates` registers its own.

## caveTunnel

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `length` | m | 120..3000 | 640 | the mountain's length along the bore, portal to portal |
| `bore` | m | 6..80 | 22 | the tunnel's radius |
| `width` | m | bore + 22..1500 | 170 | the mountain's half width at its foot |
| `height` | m | (bore + 12) x 2 + 20..1500 | 230 | the summit's height above the ground |
| `meander` | m | 0..width | 55 | how far the bore winds from side to side |
| `climb` | m | 0..30 % of height | 16 | how far the bore climbs and dips along its length |
| `lanterns` | bool | | true | glowing lanterns on the bore's walls every 34 m, alternating sides |
| `segments` | count | 8..160 | 56 | cross-sections along the bore |

The mountain is one closed rock mesh: every cross-section reaches out from the bore's centre line to a
jagged envelope (flat on the ground, a ridged summit, cliff faces at the portals) and in to the
bore's round wall, at least 12 m of rock between them. The same triangles are its collider: the
recipe lists them as a `localMesh` spec and the engine builds a three-mesh-bvh `MeshCollider`
(`src/world/colliderMesh.js`) at the anchor, so the bore's walls are as solid as the flanks; the
summit is a perch. The preset's `challenge` gates are placed on the bore's centre line (`along` from
the mountain's middle, `across` and `height` offsets from the line), each facing along the bore and
pitched with its climb. The engine releases the BVH and its CPU geometry on dispose.

## fallsWall

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `falls` | count | 2..24 | 10 | thin waterfalls along the lip, centred on the site |
| `spacing` | m | 20..400 | 75 | the distance between neighbouring falls |
| `fallWidth` | m | 2..80 | [11, 15] | each fall's width |
| `launch` | m/s | 0..40 | 15 | how fast the water leaves the lip (the falls arc out from the face) |
| `sink` | m/s | 0..40 | 9 | the sinking air on a fall's arc |
| `curtain` | m | 2..200 | 18 | how far the sinking air reaches from a fall's arc |
| `streams` | bool | | true | a short stream over the cliff top feeding each fall |
| `mist` | bool | | true | mist puffs at the foot of each fall |
| `boulders` | count | 0..80 | [14, 22] | boulders below the wall (sphere colliders) |

The wall reads the `cliffStep` stamp's frame as `waterfall` does (or raises its own cliff without
one). Each fall's air is listed in `out.falls`; the engine turns it into one WindField source (see
[Wind](#wind)). The preset's `challenge` block is used as it stands (gates in the site frame, heights
above the ground), authored in the gaps between the falls.

## balloonCourse

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | count | 2..64 | 30 | balloons in all: two flank every gate, the rest float around the course |
| `height` | m | 8..40 | [19, 24] | each envelope's height (the v1 balloon family's profile, palettes and gore patterns, `src/world/balloonFamily.js`) |
| `tethers` | bool | | true | a tether from each basket to a stake in the ground |
| `spread` | m | 20..3000 | 260 | how far the free balloons scatter around the course |
| `gap` | m | 0..50 | 3 | the clearance between a flanking envelope's widest ring and the gate opening |

The preset's `challenge` block is used as it stands. Every envelope is solid (two hulls, as the
landmark balloons), the basket a box and the tether a thin capsule; the free balloons keep clear of
the gates and of the line between them. Each balloon bobs with the wind by its own amount.

## kiteSlalom

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `lineHeight` | m | 30..600 | [110, 165] | each string's length up to its kite |
| `lean` | deg | 0..70 | 22 | how far the strings lean downwind (the prevailing wind at create) |
| `offset` | m | 1..100 | 7 | how far beyond a checkpoint's inner edge, toward the course line, its string is staked |
| `extra` | count | 0..24 | 4 | more kites flying off to the sides of the course |
| `streamers` | bool | | true | streamers along each string |
| `kiteSize` | m | 0.5..12 | [2.6, 3.6] | each diamond kite's span |
| `sensorRadius` | m | 0.05..3 | 0.35 | the radius of each string's sensor capsule |

The course is laid over the hill along the gentlest of six lines through the site (the one whose
legs cross the lowest ground), and every gate stands its `height` above the highest ground under its
legs of the course, so the line from gate to gate clears the summit. Every checkpoint with a nonzero
`across` gets a kite whose string rises beside it, so the course weaves from one side of the strings
to the other. Every string is a SENSOR collider tagged
`kiteString`: the flight controller emits `colliderSensor` once per entry and the challenge system
counts a miss with the course's `sensors.kiteString.penaltySeconds`; a string never crashes the craft.
## archChain

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | arches | 1..12 | 5 | without a `challenge` block only (with one, there is an arch per gate) |
| `spacing` | m | 60..2000 | 260 | without a `challenge` block only: along the heading, centred on the anchor |
| `span` | m | 20..400 | [76, 88] | centre-line span; widened when a gate needs it |
| `height` | m | 10..300 | [54, 64] | crown height above the ground at the arch's centre; raised when a gate needs it |
| `legThickness`, `topThickness` | m | 2..60, 1.5..40 | [11, 15], [8, 10] | the cross-section thins from the legs to the crown |
| `depth` | m | 3..80 | [15, 21] | front to back at the legs (the crown is 60-75 % of it) |
| `style` | | `auto`, `dunes`, `snow`, `pine`, `archipelago`, `meadows` | `auto` | the v1 strata and cap colours; `auto` takes the site's biome |
| `margin` | m | 0..50 | 6 | clearance kept around each gate inside its arch's opening |

Each arch is lofted like the v1 landmark arch (src/world/landmarks.js): a lumpy twelve-point
cross-section around a half-ellipse, buried legs, strata bands dipping across the stone with a cap
on the upward faces, boulders merged into the feet. With the preset's `challenge` block an arch
stands at each gate (`along`, `across`, `heading`), sized so its inner half-ellipse holds the gate's
rectangle or circle with `margin` to spare (the lumps, bulge and skew allowed for), so the course and
the stone agree on every site. The colliders follow the v1 arch's: oriented boxes for the steep leg
segments, rows of capsule ribs elsewhere, every piece inside the stone's inner face (the opening stays
clear); boulders are spheres; each crown carries a perch. The voice (`audioIntensity` `wind` by
default) plays at the middle arch.

## hoodoos

| param | unit | range | default | notes |
| --- | --- | --- | --- | --- |
| `count` | pillars | 1..160 | [44, 64] | fewer when the field is too crowded to place them apart |
| `spread` | m | 20..3000 | 380 | the field's radius |
| `height` | m | 3..120 | [12, 36] | foot to neck |
| `radius` | m | 0.5..20 | [2.2, 4.2] | the shaft's base radius (the foot flares, the waist bulges, the neck narrows) |
| `clusters` | | 1..12 | [3, 5] | seeded cluster centres the pillars gather around, with lanes between |
| `capChance` | share | 0..1 | 0.85 | pillars wearing a dark capstone; the rest wear to a rounded point |
| `boulders` | count | 0..120 | [10, 18] | fallen blocks among the pillars |
| `colors` | 0xRRGGBB array | | six badland clays | the strata, level across the whole field (2.6 m bands) |
| `capColor` | 0xRRGGBB | | 0x5b4636 | the capstones |

The field is one merged body geometry. Colliders: a capsule per shaft as wide as its widest drum, a
cylinder per capstone with a perch on its top (or a sphere at a rounded tip), spheres for the
boulders. Pair it with a `badlands` region overlay for the ground between the pillars (preset 87).

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
`localSphere`, `localHull`, `localHeightfield` (Phase 3: a landable grid, the sleeping giant's
free-standing figure), plus `builderFrame` and `ringPoints` to follow the mesh builder's frames
and lathes). The engine registers them with `ctx.game.colliders` at create (ids
`${preset.id}:${params.seed}:${serial}:<part><n>`, all in `instance.colliderIds`) and removes them
on dispose. Turbine nacelles and rotor discs are added by the engine from `out.turbines` and turned
with each turbine's yaw every frame (`setPose`, allocation-free). The Phase 2 recipes: wind farm masts
(cylinders as wide as the foot), the rope bridge's deck boxes (covering the sway), rope, post, guy
and lintel capsules and its landings, the airfield's hangar hulls (landable roof crests), hut,
control tower and windsock pole, the crystal and shard hulls (perches on the spire tips) and boulder
spheres, the islands' rock body (four wedge hulls of the actual ring vertices), trees, boulders and
roots. Props under 2 m tall carry none. The node labs run the engine without a collider service and
skip all of it. Phase 3: the ice ridges' capsules (`iceRidges`).

### Arc points (Phase 3)

A recipe may offer points for arcs of light in `out.arcPoints` (local `[x, y, z]` arrays); the engine
keeps them in world space as `instance.data.arcPoints` (x, y, z per point). The `spires` recipe
offers each spire's tip (96 % of its height up its leaning axis), and the light-effect engine's
`arcs` (the resonating spires, 99) leap between them and raise the instance's live `glow` param.

Phase 3 adds `localHeightfield(part, x0, z0, cell, cols, rows, heights, bottom, surfaceHeightAt, tags)`
(a landable top such as the glacier's; `surfaceHeightAt` publishes the exact top for landings) and
mover hulls (below).

### Movers (Phase 3)

Rigid parts that move after the build, each on its own pooled mesh (`structure-movers`, 64 across
every live structure) with its collider hull turned with it every frame (`setPose`):
`context.addMover({ builder, x, y, z, yaw, motion, hull, drift, calve })`, with `context.newBuilder()`
for the part's own geometry, `context.setCalving({ interval, first, wave })` and
`context.setNavigation(grid)` (`structure/movers.js`).

- `drift`: a floating body rides the sea (the water layer's surface, so a passing wave lifts it) with
  a slow bob and rock, drifts on a heading that turns lazily, back toward home past its leash, and
  turns about where the navigable grid has no water deep enough.
- `calve`: a slab rests flush with an ice face until its turn (the calving schedule, or
  `setParam('calve', 1)`), shudders for 1.6 s as the crack rings out (`crack` on the voice), topples
  outward about its outer base edge for 3.4 s and plunges (a splash, a ring wave and `splash` on the
  voice), floats away for 70 s, melts under the surface over 24 s and slides back out of the face
  over 30 s. The crack and the plunge each emit `structure:calve`.
- The far tier hides the mover meshes; dispose releases them, disposes their geometries and gives
  back the ring wave's slot.
### Portals (Phase 3)

A gate with `action: 'portal'` sends the bus event `structure:portal` `{ spawnId, presetId, siteId,
gate, portalId, direction }` when the player crosses it, either way. `portalId` is the site id (an
event: `${presetId}:${seed}`). The portal system (src/gameplay/portals.js) answers: the next world's
seed is `portalSeed(seed, portalId)`, the flight is carried, `worldVisited` is sent, the screen fades
and the page reloads into the new world.

### Voice triggers (Phase 3)

`out.voiceTrigger = { name, interval: [min, max] s, strength }`: the voice's ambient one-shot every
seeded interval while it is audible (the world tree's `creak`, the galleon's `bell`).

### Motion (Phase 3)

`out.motion = { points (local xyz triples), closed (default true), speed, startDistance, bob, bobPeriod,
roll, rollPeriod, pitch }`: the whole structure sails a PathFollower (src/world/pathFollower.js; a
loop when closed, else ping-pong) from the instance's start time, a pure function of the flight clock.
The meshes (bow along local -z), the lanterns, the voice and the instance anchor follow it every frame
(so the LOD, discovery and lure follow too), and its colliders, which must be capsules, are moved with
it through `colliders.update`, carrying its velocity.

### Lanterns (Phase 3)

`out.lanterns = [{ x, y, z, size, color, litColor, ignitable }]`: self-lit boxes on a shared instanced
pool (128), brighter at night, shown at the near and mid tiers. An `ignitable` one registers with the
game's ignition service (`ctx.game.ignition`, ids in `instance.ignitableIds`, removed on dispose) and
turns to `litColor` when a flame lights it (the dragon's fire breath); `stats().lanternsLit` counts them.

### Course rival (Phase 3)

`out.rival = { points (local xyz: the racing line), name, scale, paceTime, rivalTime, achievement }`
with the recipe's `out.challenge` (structure/rival.js, `createCourseRival`): the engine hands the
course to the rival, which registers it itself. Two PathFollowers in `once` mode run the line from the
run's start (the challenge's live elapsed time): `pace` reaches the finish gate in `paceTime`, `rival`
in `rivalTime`. While the player flies the dragon skin the course is registered with the rival
follower as its `rival` (the challenge HUD shows the gap); otherwise without one. The course is
registered again (same key, records kept) whenever that changes, never while a run on it is armed or
running. The creature is the dragon craft's mesh (`buildDragonMesh`, its shared materials) scaled up:
one shared model the engine builds and prewarms in `init()` (`createRivalModel`), so a create builds
no geometry and compiles no pipeline; a rival borrows it and hides it on dispose (a second rival alive
at the same time races unseen). It is posed through the same visual state the craft writes: perched on its crag, launching when the run
starts (as a rival it roars, the voice's `roar` trigger, and breathes fire), flapping as it climbs,
tucking as it dives, banking into turns, and flying home on a return path made when the run ends or
is cancelled. A valid finish ahead of `rivalTime` in a rival run sends the typed `achievement`. The
voice follows the creature. Without the game context (the node labs) only the model is skipped. Hidden
at the far tier; dispose hides the model, removes the listener and unregisters the course.
Where no primitive set can stand in for a solid part (the cave tunnel's mountain with its bore,
contract b.6), a recipe lists a `localMesh(part, positions, indices, tags)` spec: a closed,
outward-facing triangle mesh in the local frame. The engine hands `addStructureColliders` a factory
that builds a three-mesh-bvh `MeshCollider` from it at the anchor (a pure translation; the geometry
lives on the CPU only and is never drawn), keeps it in `data.meshColliders`, and
`removeStructureColliders` releases the BVH and its geometry with the collider.

### Wind

The wind farm's wake is a WindField source (`kind: 'structure-wake'`, id `<spawnId>:wake`): slower,
turbulent air with its own gusts (`wake.gust`) in a widening cone downwind of every rotor, following the eased wind the turbines
show. It is added at the near and mid tiers and removed at the far tier, where the player is
kilometres away and cannot reach a wake a few rotor diameters long; it comes back at mid, and
dispose removes it.

The falls wall's sinking air is the other (`kind: 'structure-falls'`, id `<spawnId>:falls`): the
recipe lists every fall in `out.falls` (`{ radius, sink, spill, spillReach, turbulence, gust,
gravity, drop, lipY, dirX, dirZ, list: [{ x, z, speed }] }`, local), and the engine resolves it to one
source whose sampler follows each fall's ballistic arc exactly: at a height `below` the lip the water
is `speed * sqrt(2 * below / gravity)` metres out, and the air sinks at `sink` m/s on the arc, fading
over `radius`, with turbulence round it and an outward spill where the column meets the ground. It
allocates nothing and is added and removed by tier like the wake. No other recipe authors wind (the
reverse waterfall's updraft is the preset's own windModifier entry).

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
returns whether the name is known. `setParam(instance, 'calve', 1)` starts the next calving of a
structure with calving slabs at once (a set piece, the checks).

`engine.describe(instance)` (dev tools and tests) returns `{ recipe, colliders, underwater, movers }`:
the movers' count, calvings so far, whether a ring wave is running and each mover's motion, status
(`attached`, `cracking`, `toppling`, `floating`, `melting`, `regrowing` or `drifting`), position and
collider id.

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
| `structure:calve` | bus | `{ spawnId, presetId, slab, stage: 'crack' \| 'splash', position }` (a calving slab breaks away, then hits the sea; one reused object per glacier, so a listener that keeps it copies it) |
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

- `node --expose-gc tools/lab/presets-71-80.mjs`: the five challenge recipes and the reverse waterfall
  on stamped test sites (colliders, the cave's mesh collider, the falls' sinking air, the kite
  sensors, clear gate openings, a scripted run through every course, dispose);
  `node tools/lab/preset-flight-71-80.mjs` flies the craft through the reverse waterfall's column
  and along the falls wall.
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
