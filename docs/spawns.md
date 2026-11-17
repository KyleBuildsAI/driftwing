# Spawn presets

Phase 2 turns scenery into events. Every spawn in V2, from a geyser field to a total solar eclipse,
is a **preset**: a pure-data file in `src/spawns/presets/` that names the reusable engines that draw
it, the rules that decide where and when it appears, the wind it blows, the sound it makes and what
WREN and the journal say about it. Nothing about a single spawn is hard-coded anywhere else.

This page lists all 100 presets, read from the preset files themselves: the 30 of Phase 2 and the
70 of Phase 3 (presets 31-100, on the same engines and the Phase 3 systems), and then shows how to
add a new one. The schema is enforced by
[src/spawns/schema.js](../src/spawns/schema.js); the systems that read it are described in
[architecture.md](architecture.md#spawns-ctxsystemsspawns-srcspawns); every engine param is in
[docs/engines/](#engine-reference-pages).

Units are SI: metres, m/s and seconds. Headings are compass degrees. Altitudes in filters are the
player's height above sea level; heights in engine params are metres above the spawn's anchor
unless a param says otherwise.

## How a preset becomes a spawn

There are two kinds of preset.

- **Sites** (`kind: 'site'`) are persistent places. `src/world/placement.js` rolls every site
  preset once per 2 km cell with hash(seed, cellX, cellZ, presetId) and keeps the candidates that
  pass the preset's `placement` rules (chance, biome, surface, terrain, spacing and clearance). The
  same seed always gives the same sites, in the terrain worker and on the main thread alike, and a
  site's `stamps` reshape the shared height function there. The SpawnManager creates a site's spawn
  when the camera comes within `lod.far` and removes it beyond `lod.far + despawn.hysteresis`. A
  site with an `activeState` (the volcano's eruption) starts dormant, and the director decides when
  it wakes.
- **Events** (`kind: 'event'`) are temporary happenings. `src/spawns/candidates.js` rolls
  deterministic candidates from hash(seed, cell, time bucket, presetId) using the preset's
  `candidates` block. The event director (`src/spawns/director.js`, 2 Hz) activates the best
  dormant candidate that passes the preset's `filters`, always ahead of the player and inside the
  preset's distance band, within the rarity periods, cooldowns and budgets. An event ends when its
  engine says it has (a tornado ropes out), at the end of its drawn `lifetime.duration`, or by the
  despawn rule once it is far away and out of view.

Every engine entry of a preset becomes one engine instance, created with the entry's params plus
the activation (`position`, `heading`, `site`, `startTime`, `scale`, `duration`, `seed`) and its own
seeded random generator. Heavy presets (`heavy: true`) count toward the limit of 2 heavy spawns at
once and draw a FAR **lure**, a silhouette on the horizon beyond the terrain's view distance, so the
player sees them from 30-60 km and flies toward them.

When a spawn comes within `discovery.radius` and into view, the SpawnManager emits the typed
`discovery` event: the chime plays, the glass discovery card shows the `journal` title and
description, and the journal records the find. WREN calls a spawn out with one of its `callouts`
lines as it activates (or as an undiscovered site comes into range) and offers a heading.

## The 100 presets at a glance

"Wind" says whether the preset changes the air the craft flies through. The details are in each
preset's section below.

| # | preset | id | category | kind | rarity | heavy | engines | wind |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | [Tornado](#1-tornado) | `tornado` | weather | event | rare | yes | `vortex`, `weatherVolume`, `lightEffect` | yes |
| 2 | [Supercell](#2-supercell) | `supercell` | weather | event | uncommon | yes | `weatherVolume`, `lightEffect`, `windModifier` | yes |
| 3 | [Waterspout](#3-waterspout) | `waterspout` | ocean | event | uncommon | no | `vortex`, `waterEffect`, `weatherVolume` | yes |
| 4 | [Lenticular clouds](#4-lenticular-clouds) | `lenticular` | weather | event | common | no | `weatherVolume`, `windModifier` | yes |
| 5 | [Microburst](#5-microburst) | `microburst` | weather | event | uncommon | no | `weatherVolume`, `windModifier`, `emitter` | yes |
| 6 | [Glory](#6-glory) | `glory` | weather | event | common | no | `celestial`, `weatherVolume` | slight |
| 7 | [Erupting volcano](#7-erupting-volcano) | `volcano` | geo | site | rare | yes | `emitter`, `lightEffect`, `windModifier` | yes |
| 8 | [Geyser field](#8-geyser-field) | `geyserField` | geo | site | common | no | `emitter` | yes |
| 9 | [Slot canyon](#9-slot-canyon) | `slotCanyon` | geo | site | uncommon | no | `structure` | no |
| 10 | [Mega-waterfall](#10-mega-waterfall) | `megaWaterfall` | geo | site | uncommon | no | `structure`, `emitter`, `celestial`, `waterEffect`, `windModifier` | yes |
| 11 | [Whale pod](#11-whale-pod) | `whalePod` | ocean | event | common | no | `fauna` | no |
| 12 | [Maelstrom](#12-maelstrom) | `maelstrom` | ocean | site | rare | no | `waterEffect`, `vortex` | yes |
| 13 | [Bioluminescent bay](#13-bioluminescent-bay) | `bioluminescentBay` | ocean | site | uncommon | no | `waterEffect`, `fauna` | no |
| 14 | [Starling murmuration](#14-starling-murmuration) | `starlingMurmuration` | wildlife | event | uncommon | no | `fauna` | no |
| 15 | [Geese V-formation](#15-geese-v-formation) | `geeseFormation` | wildlife | event | common | no | `fauna` | no |
| 16 | [Thermal hawks](#16-thermal-hawks) | `thermalHawks` | wildlife | event | common | no | `fauna` | thermals |
| 17 | [Fireflies](#17-fireflies) | `fireflies` | wildlife | event | common | no | `lightEffect` | no |
| 18 | [Eagle wingman](#18-eagle-wingman) | `eagleWingman` | wildlife | event | uncommon | no | `fauna` | no |
| 19 | [Wind farm](#19-wind-farm) | `windFarm` | structure | site | common | no | `structure` | yes |
| 20 | [Rope bridge](#20-rope-bridge) | `ropeBridge` | structure | site | uncommon | no | `structure` | no |
| 21 | [Abandoned airfield](#21-abandoned-airfield) | `abandonedAirfield` | structure | site | uncommon | no | `structure` | no |
| 22 | [Meteor shower](#22-meteor-shower) | `meteorShower` | celestial | event | common | no | `celestial` | no |
| 23 | [Total solar eclipse](#23-total-solar-eclipse) | `totalSolarEclipse` | celestial | event | legendary | no | `celestial` | no |
| 24 | [Comet](#24-comet) | `comet` | celestial | event | rare | yes | `celestial` | no |
| 25 | [Sky lantern festival](#25-sky-lantern-festival) | `skyLanternFestival` | celestial | event | rare | no | `emitter`, `lightEffect` | no |
| 26 | [Floating islands](#26-floating-islands) | `floatingIslands` | fantasy | site | rare | yes | `structure` | no |
| 27 | [Sky whale](#27-sky-whale) | `skyWhale` | fantasy | event | rare | yes | `fauna`, `windModifier` | yes |
| 28 | [Crystal spires](#28-crystal-spires) | `crystalSpires` | fantasy | site | uncommon | no | `structure`, `lightEffect` | no |
| 29 | [Jet stream ribbon](#29-jet-stream-ribbon) | `jetStream` | flightplay | event | uncommon | no | `emitter`, `windModifier` | yes |
| 30 | [Storm chase](#30-storm-chase) | `stormChase` | setpiece | event | legendary | no | `setPiece` | children |
| 31 | [Sandstorm wall](#31-sandstorm-wall) | `sandstormWall` | weather | event | uncommon | no | `weatherVolume`, `windModifier`, `emitter` | yes |
| 32 | [Snow squall](#32-snow-squall) | `snowSquall` | weather | event | common | no | `weatherVolume`, `windModifier`, `emitter` | yes |
| 33 | [Hurricane eye](#33-hurricane-eye) | `hurricaneEye` | weather | event | rare | yes | `weatherVolume`, `windModifier`, `emitter` | yes |
| 34 | [Valley fog river](#34-valley-fog-river) | `valleyFogRiver` | weather | event | common | no | `weatherVolume` | no |
| 35 | [Dirty thunderstorm](#35-dirty-thunderstorm) | `dirtyThunderstorm` | geo | event | rare | no | `weatherVolume`, `lightEffect`, `emitter` | yes |
| 36 | [Lava rivers to the sea](#36-lava-rivers-to-the-sea) | `lavaRiversToSea` | geo | site | uncommon | no | `structure`, `emitter` | no |
| 37 | [Fissure eruption](#37-fissure-eruption) | `fissureEruption` | geo | site | rare | yes | `structure`, `emitter`, `weatherVolume` | no |
| 38 | [Meteor crater lake](#38-meteor-crater-lake) | `meteorCraterLake` | geo | site | uncommon | no | `structure` | no |
| 39 | [Hot spring terraces](#39-hot-spring-terraces) | `hotSpringTerraces` | geo | site | uncommon | no | `emitter` | slight |
| 40 | [Salt flat mirror lake](#40-salt-flat-mirror-lake) | `saltFlatMirror` | geo | site | uncommon | no | `structure` | no |
| 41 | [Calving glacier](#41-calving-glacier) | `calvingGlacier` | geo | site | uncommon | no | `structure` | no |
| 42 | [Coral atoll](#42-coral-atoll) | `coralAtoll` | ocean | site | uncommon | no | `waterEffect` | no |
| 43 | [Reef shipwreck](#43-reef-shipwreck) | `reefShipwreck` | ocean | site | uncommon | no | `structure`, `waterEffect` | no |
| 44 | [Dolphin pod](#44-dolphin-pod) | `dolphinPod` | ocean | event | common | no | `fauna` | no |
| 45 | [Sea stacks and arches](#45-sea-stacks-and-arches) | `seaStacks` | geo | site | uncommon | no | `structure` | no |
| 46 | [Rogue wave](#46-rogue-wave) | `rogueWave` | ocean | event | uncommon | no | `waterEffect` | no |
| 47 | [Tidal bore](#47-tidal-bore) | `tidalBore` | ocean | site | uncommon | no | `waterEffect` | no |
| 48 | [Bats at dusk](#48-bats-at-dusk) | `batsAtDusk` | wildlife | event | uncommon | no | `structure`, `fauna` | no |
| 49 | [Herd stampede](#49-herd-stampede) | `herdStampede` | wildlife | event | common | no | `fauna` | no |
| 50 | [Flamingo lake](#50-flamingo-lake) | `flamingoLake` | wildlife | site | uncommon | no | `fauna` | no |
| 51 | [Butterfly migration](#51-butterfly-migration) | `butterflyMigration` | wildlife | event | uncommon | no | `fauna` | rides it |
| 52 | [Caribou migration](#52-caribou-migration) | `caribouMigration` | wildlife | event | uncommon | no | `fauna` | no |
| 53 | [Cliffside monastery](#53-cliffside-monastery) | `cliffsideMonastery` | structure | site | rare | no | `structure`, `lightEffect` | flags show it |
| 54 | [Sea-cliff castle ruin](#54-sea-cliff-castle-ruin) | `seaCliffCastle` | structure | site | uncommon | no | `structure` | banners show it |
| 55 | [Mountaintop observatory](#55-mountaintop-observatory) | `mountaintopObservatory` | structure | site | uncommon | no | `structure` | no |
| 56 | [Steam train viaduct](#56-steam-train-viaduct) | `steamTrainViaduct` | structure | site | rare | no | `structure` | no |
| 57 | [Dam spillway](#57-dam-spillway) | `damSpillway` | structure | site | uncommon | no | `structure`, `emitter`, `celestial` | no |
| 58 | [Desert oasis caravan](#58-desert-oasis-caravan) | `desertOasisCaravan` | structure | site | uncommon | no | `structure`, `fauna` | no |
| 59 | [Labyrinth](#59-labyrinth) | `labyrinth` | structure | site | rare | no | `structure` | no |
| 60 | [Fireball impact](#60-fireball-impact) | `fireballImpact` | celestial | event | rare | no | `structure`, `emitter` | no |
| 61 | [Blood moon](#61-blood-moon) | `bloodMoon` | celestial | event | rare | no | `celestial` | no |
| 62 | [Green flash](#62-green-flash) | `greenFlash` | celestial | event | uncommon | no | `celestial` | no |
| 63 | [Noctilucent clouds](#63-noctilucent-clouds) | `noctilucentClouds` | celestial | event | uncommon | no | `celestial` | no |
| 64 | [Milky Way core](#64-milky-way-core) | `milkyWayCore` | celestial | event | uncommon | no | `celestial` | no |
| 65 | [Moonbow](#65-moonbow) | `moonbow` | celestial | event | uncommon | no | `celestial`, `emitter` | no |
| 66 | [World tree](#66-world-tree) | `worldTree` | fantasy | site | rare | yes | `structure`, `lightEffect` | no |
| 67 | [Portal ring](#67-portal-ring) | `portalRing` | fantasy | site | rare | no | `structure`, `lightEffect` | no |
| 68 | [Sleeping stone giant](#68-sleeping-stone-giant) | `sleepingGiant` | fantasy | site | rare | no | `structure`, `emitter` | no |
| 69 | [Ghost galleon](#69-ghost-galleon) | `ghostGalleon` | fantasy | event | rare | no | `structure` | no |
| 70 | [Dragon racer](#70-dragon-racer) | `dragonRacer` | fantasy | site | rare | no | `structure` | no |
| 71 | [Reverse waterfall](#71-reverse-waterfall) | `reverseWaterfall` | fantasy | site | rare | no | `structure`, `emitter`, `waterEffect`, `windModifier` | yes |
| 72 | [Forest wisps](#72-forest-wisps) | `forestWisps` | fantasy | event | uncommon | no | `lightEffect` | no |
| 73 | [Ridge lift band](#73-ridge-lift-band) | `ridgeLiftBand` | flightplay | site | uncommon | no | `weatherVolume`, `fauna`, `windModifier` | yes |
| 74 | [Wind shear line](#74-wind-shear-line) | `windShearLine` | weather | event | uncommon | no | `weatherVolume`, `windModifier` | yes |
| 75 | [Thermal street](#75-thermal-street) | `thermalStreet` | flightplay | event | common | no | `weatherVolume`, `windModifier` | yes |
| 76 | [Canyon gauntlet](#76-canyon-gauntlet) | `canyonGauntlet` | flightplay | site | uncommon | no | `structure` | no |
| 77 | [Cave tunnel](#77-cave-tunnel) | `caveTunnel` | flightplay | site | rare | no | `structure` | no |
| 78 | [Waterfall wall](#78-waterfall-wall) | `waterfallWall` | flightplay | site | rare | no | `structure`, `emitter` | yes |
| 79 | [Balloon festival](#79-balloon-festival) | `balloonFestival` | flightplay | site | uncommon | no | `structure` | no |
| 80 | [Kite-string slalom](#80-kite-string-slalom) | `kiteSlalom` | flightplay | site | uncommon | no | `structure` | no |
| 81 | [Five-arch chain](#81-five-arch-chain) | `fiveArchChain` | flightplay | site | uncommon | no | `structure` | no |
| 82 | [Cherry blossom valley](#82-cherry-blossom-valley) | `cherryBlossomValley` | geo | site | uncommon | no | `emitter` | no |
| 83 | [Autumn colour wave](#83-autumn-colour-wave) | `autumnColourWave` | geo | site | uncommon | no | `emitter` | no |
| 84 | [Lavender and tulip stripes](#84-lavender-and-tulip-stripes) | `lavenderTulipStripes` | geo | site | uncommon | no | `emitter` | no |
| 85 | [Rice terraces](#85-rice-terraces) | `riceTerraces` | geo | site | uncommon | no | `weatherVolume` | slight |
| 86 | [Redwood giants](#86-redwood-giants) | `redwoodGiants` | geo | site | uncommon | no | `emitter` | no |
| 87 | [Badlands hoodoos](#87-badlands-hoodoos) | `badlandsHoodoos` | geo | site | uncommon | no | `structure` | no |
| 88 | [Mangrove delta](#88-mangrove-delta) | `mangroveDelta` | ocean | site | uncommon | no | `weatherVolume`, `lightEffect` | slight |
| 89 | [Cactus forest with dust devils](#89-cactus-forest-with-dust-devils) | `cactusDustDevils` | geo | site | uncommon | no | `vortex` | yes |
| 90 | [Bamboo forest](#90-bamboo-forest) | `bambooForest` | geo | site | uncommon | no | `emitter` | no |
| 91 | [Frozen lake](#91-frozen-lake) | `frozenLake` | geo | site | uncommon | no | `structure` | no |
| 92 | [Aurora and meteor shower](#92-aurora-and-meteor-shower) | `auroraMeteorShower` | celestial | event | legendary | no | `celestial` | no |
| 93 | [Volcano, lightning and aurora](#93-volcano-lightning-and-aurora) | `volcanoAurora` | geo | event | legendary | no | `lightEffect`, `celestial` | no |
| 94 | [Double rainbow over whales](#94-double-rainbow-over-whales) | `doubleRainbowWhales` | ocean | event | legendary | no | `celestial`, `weatherVolume` | no |
| 95 | [Eclipse over the monoliths](#95-eclipse-over-the-monoliths) | `eclipseMonoliths` | celestial | event | legendary | no | `lightEffect` | no |
| 96 | [Comet breakup](#96-comet-breakup) | `cometBreakup` | celestial | event | legendary | no | `celestial` | no |
| 97 | [Migration convergence](#97-migration-convergence) | `migrationConvergence` | wildlife | event | legendary | no | `emitter` | no |
| 98 | [Midnight sun](#98-midnight-sun) | `midnightSun` | celestial | event | legendary | no | `celestial` | no |
| 99 | [Resonating crystal spires](#99-resonating-crystal-spires) | `resonatingSpires` | fantasy | event | legendary | no | `lightEffect` | no |
| 100 | [Lighthouse beacons](#100-lighthouse-beacons) | `lighthouseBeacons` | structure | event | legendary | no | `lightEffect` | no |

In all: 51 sites and 49 events; 14 common, 52 uncommon, 23 rare and 11 legendary; 9 heavy (Phase 2
alone: 11 sites and 19 events; 9 common, 12 uncommon, 7 rare and 2 legendary; 6 heavy). The
journal's collection count is found / 100 over these presets (`PRESETS` in
[src/spawns/presets/index.js](../src/spawns/presets/index.js)).

## Rarity, pacing and the budgets

- **Events and site active states** are scheduled by the director. Each rarity tier has a due time
  drawn from its period: common 150-300 s, uncommon 600-900 s, rare 1800-3600 s and legendary
  3600-7200 s of flight (`RARITY_PERIODS`). After an activation the preset waits out its cooldown:
  common 150 s, uncommon 1200 s, rare 2700 s and legendary 5400 s (`RARITY_COOLDOWNS`), or the
  preset's own `cooldown`. The same preset never runs twice in a row.
- **Pacing.** Something notable comes within 60-90 s of flight: when nothing has been seen for a
  seeded 60-70 s, the director activates the best eligible common candidate ahead, 3-8 km out (from
  75 s an uncommon one too, and from 80 s a rare one, up to 60 degrees off the heading). Dense,
  unfussy common presets keep this working everywhere: the geese (any biome, hour or weather), the
  meteor shower at night and the whale pod on coasts.
- **Sites without an active state** are always there; their `rarity` describes them (WREN's callout
  priority and the tour guide rank by it) and their `placement.chance` and `minSpacing` decide how
  often a world has one.
- **Budgets.** At most 2 heavy spawns at once (an always-on heavy site such as the floating islands
  counts while it exists; a site with an active state, the volcano, only while that state runs),
  at most 4 real lights, and per-engine instance and particle caps (each engine's `budget`, else
  `DIRECTOR_BUDGETS.engines`). Under frame-time pressure the director first defers heavy activations
  and then steps far spawns to cheaper LOD tiers, before the renderer drops resolution.
- **Declined activations.** When every engine of a director activation ends its instance at create
  (thermal hawks with no working thermal, a whale pod with no open water in reach), the SpawnManager
  refuses it with the reason `declined`. The director then counts no notable, cooldown or tier turn
  and tries the candidate again in its next bucket.

The full rules are in [architecture.md: Event director](architecture.md#event-director-srcspawnsdirectorjs).

## The presets

Each section gives what the player sees, then the preset's fields as the file sets them. The
**Journal** line opens with the title the discovery card and the journal show (`journal.title`,
which is not always the preset's `name`) and counts WREN's `callouts` lines; any journal stats
follow. `node tools/docs-check.mjs` checks every section's kind, rarity, heavy flag, wind, sound
recipe, journal title, callout count, LOD, discovery radius, lifetime, filters and candidates or
placement against the preset files. The time-of-day classes are `day` (sun up), `night` (sun more
than 6 degrees down), `dawn` and `dusk` (the low sun, -10 to 14 degrees), `golden` (-3 to 14
degrees) and `midday` (14 degrees up or more). "Ahead" is the director's activation distance band in
front of the player.

### Weather and sky

#### 1. Tornado

A funnel lowers out of a turning wall cloud under its parent storm, touches down and walks across
the land with a ring of debris, then ropes out and lifts.
[src/spawns/presets/tornado.js](../src/spawns/presets/tornado.js)

- **Kind:** event, rare, heavy. Funnel lure, 2400 m tall, with lightning flashes.
- **Engines:** `vortex` (the funnel, debris ring and Rankine wind on a seeded track at 9 m/s;
  forms over 30 s, ropes out over 45 s; owns the voice); `weatherVolume` (the parent storm tower
  with an anvil, a rotating wall cloud and a rain shaft, drifting with the funnel); `lightEffect`
  (lightning, 7 strikes a minute).
- **Filters:** meadows, dunes or pine; day, dawn or dusk; storm weather only; over land; player
  0-6000 m; 4-9 km ahead.
- **Candidates:** 9 km cells, 600 s buckets, chance 0.55.
- **Wind:** a Rankine vortex: 72 m/s tangential at the core, an inflow that pulls toward it within
  1.5 km (14 m/s), a 45 m/s updraft in the core, a sinking ring and turbulence 0.95 with 8 m/s gusts.
  It can fling a glider. The storm above adds turbulence 0.5, a 4 m/s updraft and a rain shaft
  (6 m/s downdraft, 9 m/s outflow).
- **Sound:** `tornado` (low roar and debris rattle).
- **LOD:** near 2000 m, mid 4500 m, far 45 km. **Discovery:** 5 km, in view.
- **Lifetime:** 240-360 s; despawned beyond 15 + 3 km after 30 s out of view.
- **Journal:** "Tornado"; WREN has 4 callout lines; `closestTornado` (min, within 15 km) and
  `stormsChased` (+1 within 3 km).

#### 2. Supercell

A rotating thunderstorm whose anvil stands on the horizon 30+ km away, with a lowered wall cloud,
rain shafts, lightning and delayed thunder, a gust front ahead and a rear-flank downdraft.
[src/spawns/presets/supercell.js](../src/spawns/presets/supercell.js)

- **Kind:** event, uncommon, heavy. Anvil lure, 11 km tall and 17 km wide, flickering with
  lightning.
- **Engines:** `weatherVolume` (a 10.5 km tower with an anvil and an overshooting top, a wall cloud
  at the rear flank, two rain shafts, drifting at 9 m/s; forms over 45 s); `lightEffect`
  (lightning, 9 strikes a minute, thunder delayed by distance; owns the `thunder` voice);
  `windModifier` (the gust front and the rear-flank downdraft, drifting with the storm).
- **Filters:** any biome, any hour; building or storm weather; any surface; player 0-9000 m;
  8-22 km ahead.
- **Candidates:** 12 km cells, 450 s buckets, chance 0.5.
- **Wind:** a 6 m/s updraft under the base with turbulence 0.55; downdrafts of 7 and 4 m/s in the
  shafts with 11 and 6 m/s outflows; a gust front 2.8 km ahead (15 m/s outflow, 5 m/s lift along
  its edge); a rear-flank downburst (10 m/s down, 12 m/s out).
- **Sound:** `thunder` (crack and rolling rumble, delayed by distance / 343 m/s).
- **LOD:** near 6 km, mid 22 km, far 60 km. **Discovery:** 14 km, in view.
- **Lifetime:** 420-600 s; despawned beyond 30 + 5 km after 30 s out of view.
- **Journal:** "Supercell"; WREN has 4 callout lines; `stormsChased` (+1 within 6 km).

#### 3. Waterspout

A thinner, milder vortex than the tornado, hanging from a dark cumulus over the sea, with a spray
ring churning the water at its foot and a foam wake behind it.
[src/spawns/presets/waterspout.js](../src/spawns/presets/waterspout.js)

- **Kind:** event, uncommon.
- **Engines:** `vortex` (the funnel over water, wandering at 5 m/s; owns the voice at 0.55
  intensity; its wake glows in a bioluminescent bay); `waterEffect` (the spray ring); `weatherVolume`
  (the parent cumulus with a light rain shaft).
- **Filters:** any biome; day, dawn or dusk; building or storm weather; over water; player
  0-4000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 450 s buckets, chance 0.45.
- **Wind:** a Rankine vortex: 38 m/s tangential, inflow within 550 m (7 m/s), a 20 m/s updraft,
  turbulence 0.75 with 5 m/s gusts. It lifts and spins a glider but rarely flings it.
- **Sound:** `tornado`.
- **LOD:** near 2000 m, mid 7000 m, far 22 km. **Discovery:** 3 km, in view.
- **Lifetime:** 180-300 s; despawned beyond 12 + 3 km after 20 s out of view.
- **Journal:** "Waterspout"; WREN has 3 callout lines.

#### 4. Lenticular clouds

A stack of smooth lens clouds parked over a peak in the prevailing wind, riding a standing wave.
[src/spawns/presets/lenticular.js](../src/spawns/presets/lenticular.js)

- **Kind:** event, common.
- **Anchor:** the activation moves to the highest ground within 2.5 km and turns downwind
  (`anchor: { seek: 'peak', radius: 2500, align: 'downwind' }`).
- **Engines:** `weatherVolume` (four stacked lens layers); `windModifier` (the lee wave train).
- **Filters:** snow, pine, meadows or dunes; any hour; clear, building or clearing weather; over
  land; player 0-8000 m; 3-9 km ahead.
- **Candidates:** 4.5 km cells, 480 s buckets, chance 0.5.
- **Wind:** a wave field 9 km wide with three crests 6.5 km apart: smooth lift (2.8 m/s) upwind of
  each crest and sink downwind, up to 5200 m; beneath the crests a rotor layer up to 900 m with
  turbulence 0.8 and 5 m/s of reversed flow. The lens clouds add their own gentle wave (3 m/s lift,
  2 m/s sink). A glider can climb kilometres in it.
- **Sound:** none.
- **LOD:** near 4 km, mid 14 km, far 40 km. **Discovery:** 9 km, in view.
- **Lifetime:** 600-900 s; despawned beyond 20 + 4 km after 30 s out of view.
- **Journal:** "Lenticular clouds"; WREN has 3 callout lines.

#### 5. Microburst

A dark shower cloud lets go: its rain shaft slams a downdraft into the ground, which bursts outward
as a ring gust throwing a ring of dust across the land.
[src/spawns/presets/microburst.js](../src/spawns/presets/microburst.js)

- **Kind:** event, uncommon.
- **Engines:** `weatherVolume` (the shower cloud and its dense shaft; rain on the canopy; owns the
  voice); `windModifier` (the downburst and a sinking curtain, both starting 12 s in);
  `emitter` (the expanding dust ring on the ground).
- **Filters:** meadows, dunes, pine or snow; day, dawn or dusk; building or storm weather; over
  land; player 0-5000 m; 3-8 km ahead.
- **Candidates:** 8 km cells, 450 s buckets, chance 0.4.
- **Wind:** a downburst with a 520 m core: 18 m/s down and 18 m/s outward, its ring expanding at
  16 m/s to 3.2 km, with 4 m/s of lift at the front and turbulence 0.85; plus a curtain of 6 m/s
  sinking air. Flying through it is the windshear trap: a headwind, a violent sink, a tailwind.
- **Sound:** `waterfall` (the rain's roar, reference distance 260 m).
- **LOD:** near 2500 m, mid 9000 m, far 22 km. **Discovery:** 4 km, in view.
- **Lifetime:** 150-240 s; despawned beyond 12 + 3 km after 20 s out of view.
- **Journal:** "Microburst"; WREN has 3 callout lines.

#### 6. Glory

Above a sea of cloud with the sun behind you, your own shadow falls on the cloud tops ringed by
the glory's coloured rings, inside a full-circle rainbow.
[src/spawns/presets/glory.js](../src/spawns/presets/glory.js)

- **Kind:** event, common.
- **Engines:** `celestial` (the glory and the 42-degree bow on every cloud, sky-anchored at the
  antisolar point, so it follows the player; sun 4-62 degrees up); `weatherVolume` (a cloud sheet
  at 700 m above sea level, 7 km across, under the flight path).
- **Filters:** meadows, pine, dunes or archipelago; day; clear, building or clearing weather; any
  surface; player 1150-6000 m; 1.5-6 km ahead.
- **Candidates:** 5 km cells, 600 s buckets, chance 0.45.
- **Wind:** only the cloud sheet's light turbulence (0.08).
- **Sound:** none.
- **LOD:** near 2500 m, mid 9000 m, far 30 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** 300-480 s; despawned beyond 12 + 3 km after 30 s out of view.
- **Journal:** "Glory"; WREN has 3 callout lines.

### Volcanic and geo

#### 7. Erupting volcano

An ash cone with a crater, usually quiet. When it erupts, the plume pulses kilometres high and
stands on the horizon 40 km away, lava bombs arc out and boom, the lava glow lights the plume at
night, and lightning flickers in the ash.
[src/spawns/presets/volcano.js](../src/spawns/presets/volcano.js)

- **Kind:** site, rare, heavy. Plume lure, 6 km tall with a lava glow, shown only while it erupts.
- **Active state:** the eruption lasts 240-420 s (`activeState`). The director starts it as a rare
  candidate at a placed volcano (600 s buckets, chance 0.5); dormant, the site shows a faint plume
  and a glowing lava lake.
- **Placement:** snow, pine, dunes or meadows; land; ground 30-600 m; chance 0.05 per cell; at
  least 40 km between volcanoes; 800 m clearance; scale 0.95-1.15.
- **Stamp:** `cone`, radius 1100-1400 m, 380-520 m high, a crater 170-230 m wide and 80-120 m deep,
  7-10 gullies, painted `ash`.
- **Filters (the eruption):** any biome, hour and weather; over land; player 0-9000 m; 3-30 km
  ahead.
- **Engines:** `emitter` (the ash plume, pulsing every 14 s, with an underglow, a real light and an
  immersion fog inside the column); `emitter` (lava bombs in bursts, each burst a `boom`);
  `lightEffect` (the lava lake and spatter glows, and lightning in the ash); `windModifier` (the
  preset's `wind` entry).
- **Wind:** while it erupts, an updraft column of 300 m radius rising at 10 m/s to 4500 m, with a
  sinking ring, a 2 m/s swirl and turbulence 0.75. Inside the plume the fog thickens and the world
  darkens.
- **Sound:** `volcano` (sub-bass rumble and eruption booms).
- **LOD:** near 1500 m, mid 4000 m, far 45 km. **Discovery:** 8 km, in view.
- **Lifetime:** a site; removed beyond 40 + 5 km.
- **Journal:** "Erupting volcano"; WREN has 4 callout lines.

#### 8. Geyser field

A flat, steaming basin where three geysers erupt on seeded, out-of-step schedules; each eruption
is a brief strong updraft column.
[src/spawns/presets/geyserField.js](../src/spawns/presets/geyserField.js)

- **Kind:** site, common.
- **Placement:** snow, pine, meadows or dunes; land; ground 20-900 m, flat relief; chance 0.14;
  at least 14 km apart; 400 m clearance. No stamp.
- **Engines:** three `emitter` geysers (steam jets every 25-75 s, each with its own updraft that
  follows the eruption, and a `burst` hiss) and one `emitter` for the basin's low steam.
- **Wind:** each eruption lifts an updraft column: 17.5, 14 and 12.6 m/s, with radii of 60, 48 and
  43 m, 400, 320 and 288 m tall, turbulence 0.65. It kicks a glider upward.
- **Sound:** `geyser` (hiss bursts).
- **LOD:** near 1500 m, mid 5000 m, far 9000 m. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 12 + 3 km.
- **Journal:** "Geyser field"; WREN has 3 callout lines.

#### 9. Slot canyon

A twisting canyon 2.4-3.6 km long with a river on its floor; cairns mark the ends, and the journal
keeps your best clean run.
[src/spawns/presets/slotCanyon.js](../src/spawns/presets/slotCanyon.js)

- **Kind:** site, uncommon.
- **Placement:** dunes, pine or meadows; land; ground from 60 m; chance 0.14; at least 16 km apart;
  400 m clearance; aligned downhill.
- **Stamp:** `carve`, 2400-3600 m long, 38-54 m wide, 80-110 m deep, twisting 200-340 m, painted
  `riverbed`.
- **Engines:** `structure` (recipe `gates`: entry and exit cairns, a timed course with a corridor
  below the rim, the river; owns the river's voice).
- **Wind:** none.
- **Sound:** `waterfall` (the river, reference distance 60 m).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.
- **Journal:** "Slot canyon"; WREN has 3 callout lines; `bestCanyonRun` (min, seconds, clean runs
  only: no soft crash and never above the rim). Either end may be the start.

#### 10. Mega-waterfall

A river spills over a 110-160 m cliff as a wide curtain into a churning plunge pool, with a mist
cloud, a daytime rainbow, a roar that carries for kilometres and sinking air at the curtain.
[src/spawns/presets/megaWaterfall.js](../src/spawns/presets/megaWaterfall.js)

- **Kind:** site, uncommon.
- **Placement:** pine, snow, meadows or archipelago; land; ground from 60 m; chance 0.035; at least
  16 km apart; 400 m clearance; aligned downhill.
- **Stamp:** `cliffStep`, 380-520 m wide, a 110-160 m drop, a pool of 55-75 m, painted `wetRock`.
- **Engines:** `structure` (recipe `waterfall`: the falling strands; owns the voice);
  `emitter` (the mist cloud at the foot); `celestial` (the rainbow in the mist); `waterEffect`
  (the plunge pool's churn); `windModifier` (the curtain).
- **Wind:** a curtain of sinking air at the cliff: 9 m/s down, 7 m/s outward over the pool, to
  180 m high and reaching 450 m out, turbulence 0.6.
- **Sound:** `waterfall` (pink-noise roar).
- **LOD:** near 1800 m, mid 6000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.
- **Journal:** "Mega-waterfall"; WREN has 3 callout lines.

### Ocean

#### 11. Whale pod

Three to six whales cruise at the surface, spouting and diving fluke-up, now and then breaching in
full.
[src/spawns/presets/whalePod.js](../src/spawns/presets/whalePod.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `whale`, behaviour `pod`: 3-6 whales, breach chance 0.35, spouts
  every 3.5-6.5 s; a coastal candidate moves its pod to open water within 3 km, and a director activation
  that finds none is declined and retried later; their wakes and splashes glow in a bioluminescent
  bay).
- **Filters:** any biome and hour and weather; on a coast; player 0-2500 m; 3-8 km ahead.
- **Candidates:** 5 km cells, 300 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `whale` (synthesized song, calls every 14-32 s).
- **LOD:** near 2000 m, mid 4500 m, far 9000 m. **Discovery:** 1.6 km, in view.
- **Lifetime:** 240-420 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Journal:** "Whale pod"; WREN has 4 callout lines.

#### 12. Maelstrom

A whirlpool sinks a spinning funnel into the sea, with foam arms and mist over its eye, under a
wide pale air vortex rising to a lowered collar of cloud.
[src/spawns/presets/maelstrom.js](../src/spawns/presets/maelstrom.js)

- **Kind:** site, rare (not heavy: at the far tier the pale column still stands on the horizon).
- **Placement:** any biome; deep water (at most -25 m); chance 0.035; at least 30 km apart;
  1500 m clearance.
- **Engines:** `waterEffect` (the whirlpool, 320 m across, five foam arms); `vortex` (the air
  column, starting mature, turning counter-clockwise; owns the voice at 0.6 intensity).
- **Wind:** a Rankine vortex: 24 m/s tangential around a 110 m core, an inflow within 2.2 km
  (8 m/s) that pulls you in at low level, a 14 m/s updraft over the eye and turbulence 0.7.
- **Sound:** `tornado` (a deep roar, reference distance 260 m).
- **LOD:** near 2500 m, mid 5000 m, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.
- **Journal:** "Maelstrom"; WREN has 4 callout lines.

#### 13. Bioluminescent bay

A night bay where the surf glows blue and anything touching the water leaves a trail of light:
your craft, the whales feeding there and the jumping fish.
[src/spawns/presets/bioluminescentBay.js](../src/spawns/presets/bioluminescentBay.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago; coast; chance 0.14; at least 12 km apart; 800 m clearance.
- **Site hours:** `filters.timeOfDay: ['night']`. The site exists only at night: the SpawnManager
  creates it after dusk and removes it (reason `hours`) once dawn comes and it has been out of view
  for 10 s, so it is only discovered at night.
- **Engines:** `waterEffect` (the bioluminescent glow region, 1100 m, with the surf hiss voice);
  `waterEffect` (fish splashes, kept to the water); `fauna` (one or two whales feeding in the bay,
  their wakes glowing).
- **Wind:** none.
- **Sound:** `waterfall` at a low flow (the surf, reference distance 200 m, reverb 0.5).
- **LOD:** near 2000 m, mid 4000 m, far 9000 m. **Discovery:** 2 km, in view.
- **Lifetime:** a site in its hours; removed beyond 9 + 2 km.
- **Journal:** "Bioluminescent bay"; WREN has 4 callout lines.

### Wildlife

#### 14. Starling murmuration

Three thousand-odd starlings fold through a morphing shape at dusk; fly through and they burst
away from your path, then re-form behind you.
[src/spawns/presets/starlingMurmuration.js](../src/spawns/presets/starlingMurmuration.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `starling`, behaviour `murmuration`: 2800-3600 birds 150 m above the
  ground, scattering within 85 m of the craft and recovering in 4.5 s).
- **Filters:** meadows; dusk; clear, building or clearing weather; over land; player 0-2500 m;
  3-7 km ahead.
- **Candidates:** 5 km cells, 240 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `murmuration` (wing rush, swelling as you close in; a `scatter` burst).
- **LOD:** near 2500 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** 140-220 s, fading out over the last 12 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Journal:** "Starling murmuration"; WREN has 4 callout lines.

#### 15. Geese V-formation

A V of nine to thirteen geese crosses the sky at about your height. Slide into the open slot at the
end of the line and the flock follows your gentle turns.
[src/spawns/presets/geeseFormation.js](../src/spawns/presets/geeseFormation.js)

- **Kind:** event, common: the director's pacing floor (dense candidates no biome, surface, hour
  or weather rules out).
- **Engines:** `fauna` (species `goose`, behaviour `formation`: altitude mode `player`, 15 m below
  you, speed 18 m/s; the slot sits 26 m behind the shorter leg, within 16 m, 10 m of height and 30
  degrees of heading).
- **Filters:** any biome, hour, weather, surface and altitude; 3-7.5 km ahead.
- **Candidates:** 3.5 km cells, 300 s buckets, chance 0.6.
- **Wind:** none.
- **Sound:** `goose` (honking in bouts).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-420 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Journal:** "Geese V-formation"; WREN has 4 callout lines.
- **Achievement:** `vFormation`, "V-Formation": hold the slot for 10 s.

#### 16. Thermal hawks

Three to six hawks circle inside the Phase 1 thermals, the visual marker for lift.
[src/spawns/presets/thermalHawks.js](../src/spawns/presets/thermalHawks.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `hawk`, behaviour `circling` in a WindField thermal within 2.6 km,
  climbing 1.4 m/s from 120 m to 1100 m; `requireThermal`: a group that finds no working thermal
  ends before it is drawn, and a director activation that ends this way is declined, so it counts
  as nothing notable and the candidate is retried later).
- **Filters:** meadows, dunes or pine; midday (the thermal hours); clear, building or clearing
  weather; over land; player 0-3000 m; 3-7.5 km ahead.
- **Candidates:** 4.5 km cells, 300 s buckets, chance 0.5.
- **Wind:** none of its own (`wind: []`). The hawks mark a real Phase 1 thermal: circle where they
  circle and the WindField's thermal carries you up with them.
- **Sound:** `raptor` (a hawk's scream every 18-45 s).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-480 s, fading out over the last 10 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Journal:** "Thermal hawks"; WREN has 4 callout lines.

#### 17. Fireflies

Thousands of soft yellow-green lights drifting and blinking a few metres over a night meadow.
[src/spawns/presets/fireflies.js](../src/spawns/presets/fireflies.js)

- **Kind:** event, common.
- **Engines:** `lightEffect` (a swarm of 3600 blinking points within 190 m, partly in step, and a
  wider, higher scatter of 700 slower ones; all emissive points in the shared glow pool, no real
  light; hidden by day).
- **Filters:** meadows or archipelago; night; clear, building or clearing weather; over land;
  player 0-1500 m; 3-7 km ahead.
- **Candidates:** 4 km cells, 300 s buckets, chance 0.55.
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1200 m, mid 3000 m, far 6000 m. **Discovery:** 1 km, in view.
- **Lifetime:** 240-400 s, ramping out over the last 8 s; despawned beyond 8 + 2 km after 20 s out of
  view.
- **Journal:** "Fireflies"; WREN has 4 callout lines.

#### 18. Eagle wingman

A large eagle circling at about your height joins you off the wing for about 60 s, matching your
speed within its own, then peels off with a scream.
[src/spawns/presets/eagleWingman.js](../src/spawns/presets/eagleWingman.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `eagle`, behaviour `wingman`: it joins within 2.2 km, escorts for
  60 s 18 m off the wing, gives up if you outrun it by 450 m for 7 s, and peels away for 18 s).
- **Filters:** snow, pine, meadows or dunes; day; clear, building or clearing weather; over land;
  player 0-3000 m; 3-7 km ahead.
- **Candidates:** 6 km cells, 450 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `raptor`, pitched down to 0.8 for an eagle (a scream as it joins and as it leaves).
- **LOD:** near 1500 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 300-420 s, fading out over the last 8 s if you never come; despawned beyond
  9 + 2.5 km after 20 s out of view.
- **Journal:** "Eagle wingman"; WREN has 4 callout lines.

### Structures

#### 19. Wind farm

One or two staggered rows of three-bladed turbines across the prevailing wind. Each nacelle yaws
into the real WindField wind, its rotor speed follows the wind speed, and the air behind it is
rough.
[src/spawns/presets/windFarm.js](../src/spawns/presets/windFarm.js)

- **Kind:** site, common.
- **Placement:** meadows or dunes; land; ground 15-700 m; chance 0.06; at least 14 km apart; 800 m
  clearance.
- **Engines:** `structure` (recipe `windFarm`: 6-10 turbines in 2 rows, hubs 74-88 m high, rotors
  36-42 m; cut-in 3 m/s, rated 11 m/s, feathered past 25 m/s).
- **Wind:** a wake behind every rotor (a WindField source of kind `structure-wake`): 40 % slower air
  and turbulence 0.75 with 4 m/s gusts in a cone widening downwind for ten rotor diameters. It
  shakes the craft and the camera.
- **Sound:** `turbine` (a rhythmic whoosh that follows the wind speed).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.
- **Journal:** "Wind farm"; WREN has 4 callout lines.

#### 20. Rope bridge

A timber-plank rope bridge, a few planks missing, swaying across a gorge. Fly under it.
[src/spawns/presets/ropeBridge.js](../src/spawns/presets/ropeBridge.js)

- **Kind:** site, uncommon.
- **Placement:** pine, meadows or snow; land; ground from 90 m; chance 0.14; at least 12 km apart;
  600 m clearance.
- **Stamp:** `gorge` with a riverbed floor and two level anchor pads (`structureStamps('ropeBridge')`).
- **Engines:** `structure` (recipe `ropeBridge`: deck 2.4 m wide, 7 % sag, 6 % planks missing; a
  pass-under gate from below the gorge floor to 2 m under the deck).
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1200 m, mid 4000 m, far 10 km. **Discovery:** 1.5 km, in view.
- **Lifetime:** a site; removed beyond 10 + 2 km.
- **Journal:** "Rope bridge"; WREN has 4 callout lines.
- **Achievement:** `threadTheNeedle`, "Thread the Needle": fly under the bridge.

#### 21. Abandoned airfield

A flattened strip with faded markings, hangar ruins, a hut, broken edge lights and a windsock that
shows the real WindField wind. Landings on the runway are graded.
[src/spawns/presets/abandonedAirfield.js](../src/spawns/presets/abandonedAirfield.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, dunes or pine; land; ground 6-420 m, flat relief; chance 0.35; at least
  12 km apart; 500 m clearance.
- **Stamp:** `flatten` for a runway 1100-1400 m long and 42-52 m wide, painted `tarmac`
  (`structureStamps('airfield', ...)`).
- **Engines:** `structure` (recipe `airfield`: three hangar ruins, the hut, the windsock, edge
  lights and a fence; graded landings through `structure:landing`; ground-start spots).
- **Start on ground:** Phase 1's "Start on ground" prefers the nearest discovered airfield within
  80 km, at the runway threshold most nearly into the wind (`spawns.findGroundStart`).
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 1800 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Abandoned airfield"; WREN has 4 callout lines.

### Night and celestial

#### 22. Meteor shower

Streaks fan out from a radiant among the stars, with an occasional fireball that flashes the sky
and the land.
[src/spawns/presets/meteorShower.js](../src/spawns/presets/meteorShower.js)

- **Kind:** event, common (the night's pacing floor).
- **Engines:** `celestial` (meteors, 40 a minute, fireball chance 0.07; sky-anchored, so the spawn
  rides 1500 m from the camera toward the radiant; ends at dawn when the sun passes -8 degrees).
- **Filters:** any biome; night; clear or clearing weather; any surface and altitude; 3-8 km ahead.
- **Candidates:** 3.5 km cells, 300 s buckets, chance 0.6.
- **Wind:** none.
- **Sound:** `meteor` (a faint sizzle per `streak`, a `fireball` boom).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view (it is
  discovered as it starts overhead).
- **Lifetime:** 180-300 s; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Meteor shower"; WREN has 3 callout lines.

#### 23. Total solar eclipse

The moon's disc crosses the sun over about 90 s. Through totality the sky darkens, the stars come
out around the corona and every bird falls silent.
[src/spawns/presets/totalSolarEclipse.js](../src/spawns/presets/totalSolarEclipse.js)

- **Kind:** event, legendary.
- **Engines:** `celestial` (the eclipse: a 92 s crossing with 16 s of totality, the corona,
  chromosphere and Baily's beads; a priority-30 sky modifier dims the sun light, darkens and tints
  the sky and fog and dims the clouds; `quietWildlife` sends the typed `wildlifeQuiet`, so the v1
  birds settle, the bird cues stop and the fauna fall silent).
- **Filters:** any biome; day; clear, clearing or building weather; any surface and altitude;
  3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.35.
- **Wind:** none.
- **Sound:** none of its own; the world goes quiet.
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view (the darkening
  world announces it).
- **Lifetime:** 150-170 s; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Total solar eclipse"; WREN has 3 callout lines.

#### 24. Comet

A nucleus and coma with a curved dust tail pointing away from the sun and a straight blue ion tail,
fixed among the stars for the rest of the night.
[src/spawns/presets/comet.js](../src/spawns/presets/comet.js)

- **Kind:** event, rare, heavy. Comet lure (6 km up), which only draws if the spawn reaches the FAR
  tier; as a sky-anchored spawn it stays near, and the comet itself is visible above the fog from
  anywhere.
- **Engines:** `celestial` (the comet, sky-anchored; `untilDawn`: it ends as the morning sun climbs
  past -6 degrees).
- **Filters:** any biome; dusk or night; clear, clearing or building weather; any surface and
  altitude; 3-8 km ahead.
- **Candidates:** 7 km cells, 1200 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** none.
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** until dawn; 900-1200 s caps it when the clock is frozen at night; despawned beyond
  20 + 3 km after 30 s out of view.
- **Journal:** "Comet"; WREN has 3 callout lines.

#### 25. Sky lantern festival

Hundreds of paper lanterns rise from a lighthouse or a balloon fair and drift away on the real
wind, with the launch crowd's lights on the ground.
[src/spawns/presets/skyLanternFestival.js](../src/spawns/presets/skyLanternFestival.js)

- **Kind:** event, rare.
- **Near a landmark:** `filters.near: { landmarks: ['lighthouse', 'balloons'], radius: 4000 }`: the
  director moves each candidate onto the nearest lighthouse or balloon fair within 4 km, or rejects
  it.
- **Engines:** `emitter` (up to 640 lanterns aloft, launched over one seeded 300-360 s stretch, following the
  WindField wind through the emitter's wind grid, so they follow the breeze and other spawns' air;
  owns the voice); `lightEffect` (the crowd's lights and a warm real light at the launch).
- **Filters:** any biome; dusk or night; clear or clearing weather; any surface and altitude;
  3-8 km ahead.
- **Candidates:** 6 km cells, 900 s buckets, chance 0.5.
- **Wind:** none (the lanterns ride the wind; they do not change it).
- **Sound:** `lantern` (a soft ambient pad).
- **LOD:** near 3 km, mid 9 km, far 22 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** 570-600 s, so the last lanterns live out their 110-150 s; despawned beyond
  14 + 3 km after 25 s out of view.
- **Journal:** "Sky lantern festival"; WREN has 3 callout lines.

### Fantasy

#### 26. Floating islands

Rock islands with trees and a meadow hang in the air over sea-stack islets; waterfalls pour off
their edges into mist, and every top is landable.
[src/spawns/presets/floatingIslands.js](../src/spawns/presets/floatingIslands.js)

- **Kind:** site, rare, heavy. Islands lure, 760 m tall and 1500 m wide, 220 m up. It has no active
  state, so it holds one of the 2 heavy slots for as long as it exists.
- **Placement:** archipelago, meadows or pine; water; chance 0.3; at least 22 km apart; 600 m
  clearance.
- **Stamps:** two `islandBase` islets 560 m apart (`structureStamps('islands', ...)`).
- **Engines:** `structure` (recipe `islands`: 4-5 islands of 70-150 m radius, 240-420 m up, 1-2
  waterfalls each, trailing roots and mist; the tops register as landable ground surfaces; owns
  the voice).
- **Wind:** none. Craft land and park on the tops (`ctx.groundSurfaces`).
- **Sound:** `waterfall`.
- **LOD:** near 2500 m, mid 9000 m, far 40 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** a site; removed beyond 40 + 3 km.
- **Journal:** "Floating islands"; WREN has 3 callout lines.

#### 27. Sky whale

A colossal whale, sometimes with a calf, drifts through the top of the cloud layer with slow tail
beats and song. Its slipstream is a free speed and lift lane.
[src/spawns/presets/skyWhale.js](../src/spawns/presets/skyWhale.js)

- **Kind:** event, rare, heavy. Whale lure, swimming on the horizon with a tail beat.
- **Engines:** `fauna` (species `skyWhale`, behaviour `drift`: 1-2 whales 230 m long at 680 m above
  sea level, 11 m/s, bobbing; luminous spots at night; owns the voice); `windModifier` (the
  preset's `wind` entry, following the fauna part and facing its travel).
- **Filters:** any biome and hour; clear, building or clearing weather; any surface; player
  120-6000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 1200 s buckets, chance 0.4.
- **Wind:** a slipstream lane starting 90 m behind the whale, 1900 m long, 190 m wide and 95 m
  high: a 12 m/s tailwind and 3.6 m/s of lift, turbulence 0.3, fading in and out with the whale.
- **Sound:** `skyWhale` (song, calls every 22-45 s).
- **LOD:** near 3 km, mid 7 km, far 40 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** 480-720 s, fading out over the last 12 s; despawned beyond 14 + 3 km after 25 s out
  of view.
- **Journal:** "Sky whale"; WREN has 3 callout lines.

#### 28. Crystal spires

A cluster of glowing crystal spires that hum louder and higher as you close in, and chime when you
fly between two of them.
[src/spawns/presets/crystalSpires.js](../src/spawns/presets/crystalSpires.js)

- **Kind:** site, uncommon.
- **Placement:** snow, dunes, meadows or pine; land; ground from 4 m; chance 0.14; at least 16 km
  apart; 400 m clearance. No stamp.
- **Engines:** `structure` (recipe `spires`: 7-11 spires 50-125 m tall, shards, fly-through chime
  gates between neighbours within 85 m; the hum's intensity is the approach within 1.8 km; owns the
  voice); `lightEffect` (motes of light drifting among the spires, brightest at night).
- **Wind:** none.
- **Sound:** `crystal` (a harmonic hum that rises with the approach, and `chime`).
- **LOD:** near 1800 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Crystal spires"; WREN has 3 callout lines.

### Flight-play

#### 29. Jet stream ribbon

A straight 24 km tube of fast air high above the land, drawn out in racing cirrus streaks; ride its
core for a roaring tailwind.
[src/spawns/presets/jetStream.js](../src/spawns/presets/jetStream.js)

- **Kind:** event, uncommon.
- **Engines:** `emitter` (up to 20 000 stretched cirrus wisps in a box laid along the tube, formed for one
  seeded 380-440 s stretch); `windModifier` (the preset's `wind` entry).
- **Filters:** any biome and hour; clear, building or clearing weather; any surface; player
  1200-9000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.45.
- **Wind:** a jet-stream tube along the activation heading, 2200 m above the ground, 450 m in
  radius and 24 km long: a 38 m/s tailwind in its core with shear turbulence 0.4 and 4 m/s gusts at
  its edge. It stops at 410 s and fades over 25 s with the wisps.
- **Sound:** none.
- **LOD:** near 15 km, mid 30 km, far 50 km. **Discovery:** 9 km, in view.
- **Lifetime:** 540-600 s; despawned beyond 20 + 4 km after 25 s out of view.
- **Journal:** "Jet stream ribbon"; WREN has 3 callout lines.

### Legendary set piece

#### 30. Storm chase

A supercell builds over about three minutes while its wall cloud lowers and WREN narrates; a
tornado touches down under the rear flank, tracks across the land for about four minutes, ropes out,
and the storm decays.
[src/spawns/presets/stormChase.js](../src/spawns/presets/stormChase.js)

- **Kind:** event, legendary. Not heavy itself: its children are the ordinary `supercell` and
  `tornado` presets, started through the SpawnManager with their own budgets, lures and wind.
- **Engines:** `setPiece` (children `supercell`, growing over 170 s with a ramped wall cloud, and
  `tornado`, 800 m behind the storm's centre, its own storm tower shrunk to a dark turning lowering
  on the funnel: the child's `weatherVolume` override has base 1150 m, height 600 m, radius 900 m,
  36 puffs, no anvil, overshoot or rain, and a 520 m wall cloud dropping 300 m; stages build
  170-190 s, wallCloud 24-30 s, touchdown 235-250 s, ropeOut 20 s, clearing 60 s; narration lines
  at each stage through WREN). The children's own approach journals are silenced, so a chase counts
  once, and the supercell is the only storm tower.
- **Filters:** any biome; day or dusk; building or storm weather; over land; any altitude;
  7-12 km ahead.
- **Candidates:** 9 km cells, 900 s buckets, chance 0.4.
- **Wind:** through its children: the supercell's gust front, downdrafts and updraft, then the
  tornado's Rankine vortex.
- **Sound:** none of its own; its children sound.
- **LOD:** near 8 km, mid 25 km, far 60 km. **Discovery:** 15 km, in view.
- **Lifetime:** 570-600 s; despawned beyond 30 + 5 km after 60 s out of view.
- **Journal:** "Storm Chaser"; WREN has 3 callout lines; `closestTornado` (min, the closest pass to
  the funnel) and `stormsChased` (+1 when you came within 5 km of the funnel).

### Weather and sky (Phase 3)

#### 31. Sandstorm wall

A haboob: a rolling orange wall of dust a kilometre and a half tall and fourteen wide marches downwind
across the dunes with dust boiling along its foot. Its gust front hits first as a headwind and rough
air; inside, the world shrinks to a few hundred metres of ochre gloom and grit streaks race across the
canopy.
[src/spawns/presets/sandstormWall.js](../src/spawns/presets/sandstormWall.js)

- **Kind:** event, uncommon.
- **Anchor:** turned downwind (`anchor: { align: 'downwind' }`), so the wall rolls with the wind.
- **Engines:** `weatherVolume` (a `bank` 14 km long and 2.2 km deep with a tall leading wall (`wall`
  0.85), 420 ochre puffs, three dust shafts, a dark ochre inside fog, `canopyGrit` 0.9, drifting at
  11 m/s; owns the voice); `windModifier` (the gust front, following the volume); `emitter` (dust
  boiling up along the wall's foot, travelling with it).
- **Filters:** dunes; day, dawn or dusk; clear or building weather; over land; player 0-4500 m;
  5-12 km ahead.
- **Candidates:** 9 km cells, 600 s buckets, chance 0.45.
- **Wind:** a gust front 1150 m ahead of the wall's centre line, 14 km long: 15 m/s of outflow below
  900 m, 3 m/s of lift at its edge, turbulence 0.8 with 7 m/s gusts; inside the dust, turbulence 0.6.
- **Sound:** `gale` (howling wind with a thick grit hiss).
- **LOD:** near 4 km, mid 12 km, far 30 km. **Discovery:** 9 km, in view.
- **Lifetime:** 360-480 s; despawned beyond 25 + 5 km after 30 s out of view.
- **Journal:** "Sandstorm wall"; WREN has 4 callout lines.

#### 32. Snow squall

A squall line sweeps downwind over the snow country: a low, dark-bellied cloud deck dragging curtains
of heavy snow, a white wall of blowing snow at its foot and spindrift smoking off the ground ahead of
its gust front. Inside it is a whiteout, with snow streaming past the canopy.
[src/spawns/presets/snowSquall.js](../src/spawns/presets/snowSquall.js)

- **Kind:** event, common (the snow biome's pacing).
- **Anchor:** turned downwind.
- **Engines:** `weatherVolume` (the squall deck: a `bank` 5 km long held 1000 m above the ground,
  storm 0.7, with three snow shafts and canopy rain, drifting at 9 m/s; owns the voice);
  `weatherVolume` (the whiteout: a ground-hugging `bank` with a low wall, a white inside fog and
  `canopyGrit` 0.35 of snow); `windModifier` (the gust front and the downdraft under the core,
  following the deck); `emitter` (spindrift along the gust front, travelling with it).
- **Filters:** snow; any hour; building, storm or clearing weather; over land; player 0-5000 m;
  3-8 km ahead.
- **Candidates:** 5 km cells, 360 s buckets, chance 0.5.
- **Wind:** a gust front 900 m ahead: 13 m/s of outflow, 2 m/s of lift, turbulence 0.75 with 8 m/s
  gusts; under the core a 4 m/s downdraft spreading as an 8 m/s outflow; inside, turbulence 0.45-0.5.
- **Sound:** `gale` (a howling wind with a snow hiss).
- **LOD:** near 2500 m, mid 9 km, far 20 km. **Discovery:** 4.5 km, in view.
- **Lifetime:** 240-360 s; despawned beyond 12 + 3 km after 20 s out of view.
- **Journal:** "Snow squall"; WREN has 4 callout lines.

#### 33. Hurricane eye

A hurricane over the open ocean, fifty kilometres across: spiral rain bands sweep in toward a towering
eyewall, and its cloud canopy stands on the horizon 60 km away. Fly in through the bands and the dark,
violent eyewall, with 40 m/s winds, heavy rain on the canopy and the sea whipped white below, and punch
through into the calm eye: still air, a stadium of cloud curving up all around, blue sky above.
[src/spawns/presets/hurricaneEye.js](../src/spawns/presets/hurricaneEye.js)

- **Kind:** event, rare, heavy. Anvil lure, 12 km tall and 42 km wide.
- **Engines:** `weatherVolume` (the `ring` form: an eyewall of radius 4.2 km, 11 km tall, flaring
  1.7 km outward at the top around the clear eye; four spiral rain bands out to 26 km; a canopy out to
  2.6 radii; rain at the foot of the wall; canopy rain inside; drifting at 5 m/s; its voice stands on
  the eyewall nearest the camera and ducks in the eye); `windModifier` (the `cyclone` source, following
  the volume); `emitter` (sea spray swept around under the eyewall).
- **Filters:** any biome; day, dawn or dusk; clear, building or clearing weather (the eye shows the
  sky above); over water; player 0-14000 m; 18-34 km ahead.
- **Candidates:** 30 km cells, 1800 s buckets, chance 0.4.
- **Wind:** a cyclone: the eye calm (under 5 m/s, turbulence 0.04), the eyewall 42 m/s with lift and
  turbulence 0.95 with 9 m/s gusts, falling off as (wall / r)^0.6 to 28 km, inflow at low level, and
  four spiral bands of gusty air (turbulence 0.5) turning with the visible bands.
- **Sound:** `gale` (a deep roar with a high howl, reference distance 900 m).
- **LOD:** near 9 km, mid 30 km, far 70 km. **Discovery:** 25 km, in view.
- **Lifetime:** 600-780 s; despawned beyond 60 + 8 km after 45 s out of view.
- **Journal:** "Hurricane eye"; WREN has 4 callout lines.

#### 34. Valley fog river

At dawn, cold fog fills the valley floors around the activation to a fixed depth above the lowest
ground: a white river winding between the ridges, streaming slowly down the valleys and pouring over
the low saddles into the next valley like a slow waterfall, the peaks standing clear above it in the
low sun.
[src/spawns/presets/valleyFogRiver.js](../src/spawns/presets/valleyFogRiver.js)

- **Kind:** event, common.
- **Engines:** `weatherVolume` (the `river` form: a 33 x 33 terrain grid 3.2 km to each side of the
  anchor finds the lowest ground; the fog fills the valleys connected to it up to 80 m above it, about
  two fifths of its 260 puffs lie still in that fog lake and the rest stream at 2.2 m/s along paths
  traced down the valley floors and over up to three saddles; it forms over 60 s and owns the voice).
- **Filters:** pine, meadows or snow; dawn only; clear or clearing weather; over land; player
  0-3500 m; 3-8 km ahead.
- **Candidates:** 5 km cells, 600 s buckets, chance 0.5.
- **Wind:** none (the fog lies in still air).
- **Sound:** `lantern` (a soft, slowly breathing ambient pad, reference distance 600 m).
- **LOD:** near 3 km, mid 8 km, far 18 km. **Discovery:** 5 km, in view.
- **Lifetime:** 420-600 s; despawned beyond 12 + 3 km after 30 s out of view.
- **Journal:** "Valley fog river"; WREN has 3 callout lines.

### Volcanic and geo (Phase 3)

#### 35. Dirty thunderstorm

Over an erupting volcano in storm weather the ash plume builds into a towering, ash-dark thunderhead
with a spreading anvil, and lightning crackles inside the plume itself: violet-white bolts and
flickering in-cloud flashes, thunder rolling down the mountain, ash falling from the cloud and grit
hissing on the canopy inside it.
[src/spawns/presets/dirtyThunderstorm.js](../src/spawns/presets/dirtyThunderstorm.js)

- **Kind:** event, rare.
- **Near an erupting volcano:** `filters.near: { sites: ['volcano'], active: true, radius: 8000 }`:
  the director moves each candidate onto the nearest placed volcano within 8 km whose eruption runs
  (its live anchor), or rejects it; with no volcano erupting it never starts.
- **Engines:** `weatherVolume` (a `tower` 7.5 km tall from 2 km up, ash-dark (tint 0x5f5852,
  storm 0.95) with an anvil leaning 2.4 km downwind, an ash fall shaft, a dark inside fog and
  `canopyGrit` 0.5); `lightEffect` (26 strikes a minute within 900 m, 70 % in-cloud, violet-white,
  with the lit cloud glow and thunder; owns the voice); `emitter` (the ash column feeding the cloud,
  lit from below by the lava).
- **Filters:** any biome and hour; storm weather; over land; player 0-12000 m; 3-30 km ahead.
- **Candidates:** 8 km cells, 600 s buckets, chance 0.6.
- **Wind:** the volume's own: turbulence 0.6 and a 6 m/s updraft inside the cloud.
- **Sound:** `thunder` (the strikes' thunder, delayed by distance).
- **LOD:** near 6 km, mid 20 km, far 45 km. **Discovery:** 9 km, in view.
- **Lifetime:** 300-420 s; despawned beyond 30 + 5 km after 30 s out of view.
- **Journal:** "Dirty thunderstorm"; WREN has 3 callout lines.

#### 36. Lava rivers to the sea

On a volcanic coast two rivers of molten lava run down channels between basalt levees, their dark
crust drifting over glowing cracks, and pour on down the slope into the sea, where the water flashes
to steam: white plumes boil up from each sea entry, littoral explosions throw glowing spatter, and at
night the lava and the steam's underside glow orange.
[src/spawns/presets/lavaRiversToSea.js](../src/spawns/presets/lavaRiversToSea.js)

- **Kind:** site, uncommon.
- **Placement:** any biome; on a coast; ground 4-300 m; downhill-aligned (the channels run down the
  fall line toward the water); only within 10 km of a placed volcano site (`placement.near`, the
  spec's "volcano near coast"), where every coastal cell is a candidate (chance 1); at least 18 km
  apart; 500 m clearance. The site is therefore as rare as a volcano by the sea: on seed DRIFTWING
  the nearest is 21 km from the origin, 6 km from its volcano.
- **Stamps:** two `carve` lava channels (`structureStamps('lavaChannels')`: 600-800 m long, a floor
  16-24 m wide, 8-12 m deep between levees, painted basalt), side by side 300 m apart, upslope of the
  shore.
- **Engines:** `structure` (the `lavaChannels` recipe: the lava ribbons down both channels and on over
  the natural ground to the sea, traced by src/spawns/engines/lavaPath.js; cooled basalt blocks on the
  levees, the larger ones solid; crust slabs at the sea entries); two `emitter` steam plumes, each at
  its flow's sea entry (`seaEntry`), boiling up with littoral explosions (bursts) and lit from below
  at night, the first with a real orange light and the voice (each burst a `burst`); an `emitter` of
  glowing spatter at the first entry. A flow that finds no sea within 2.6 km ends in a lobe, and its
  steam only fumes.
- **Wind:** none.
- **Sound:** `geyser` (a bubbling seethe with roaring hiss bursts, reference distance 160 m).
- **LOD:** near 2 km, mid 6 km, far 20 km (the plumes keep 15 % of their emission at far).
  **Discovery:** 4 km, in view.
- **Lifetime:** a site; removed beyond 20 + 4 km.
- **Journal:** "Lava rivers to the sea"; WREN has 4 callout lines.

#### 37. Fissure eruption

A crack a kilometre long splits a lava plain between ramparts of black spatter, lava glowing in its
floor. Usually it only steams. When it erupts, a curtain of fire stands along the whole crack: lava
fountains surging a hundred metres high and falling back, a grey gas plume lit orange from below,
and at night the low cloud deck above glows orange over the fissure.
[src/spawns/presets/fissureEruption.js](../src/spawns/presets/fissureEruption.js)

- **Kind:** site, rare, heavy. Plume lure, 3.5 km tall with a lava glow, shown only while it erupts.
- **Active state:** the eruption lasts 300-540 s (`activeState`), started by the director as a rare
  candidate at a placed fissure; dormant, the crack steams and its lava glows dimly.
- **Placement:** snow, pine, meadows or dunes; land; ground 20-900 m; chance 0.06 per cell; at least
  32 km apart; 600 m clearance.
- **Stamp:** a narrow `carve` crack 900-1200 m long, 8-12 m wide and 10-16 m deep, turned to run
  along the site's right axis (the emitters' line), painted basalt.
- **Filters (the eruption):** any biome, hour and weather; over land; player 0-9000 m; 3-25 km ahead.
- **Engines:** `structure` (the `lavaChannels` recipe with `toSea: false`: lava in the crack floor and
  spatter blocks along both lips); `emitter` (the curtain of fire: lava fountains on an 860 m `line`
  shape along the crack, surging in bursts that boom, with a real orange light; owns the voice);
  `emitter` (the gas plume off the crack, lit from below; a thin steam while dormant); `weatherVolume`
  (a low cloud `sheet` 900 m up, glowing orange at night over the fissure: `glow.radius` 3.2 km,
  `glow.dormant` 0.2).
- **Wind:** none.
- **Sound:** `volcano` (a deep rumble, each fountain surge a `boom`).
- **LOD:** near 2 km, mid 6 km, far 40 km. **Discovery:** 8 km, in view.
- **Lifetime:** a site; removed beyond 40 + 5 km.
- **Journal:** "Fissure eruption"; WREN has 4 callout lines.

#### 38. Meteor crater lake

A near-perfect bowl punched into the plain by an ancient impact, with a raised rim, steep inner walls
and a still teal lake on its flat floor; blocks of shattered rock lie strewn over the rim and down its
outer flank, the biggest of them perches.
[src/spawns/presets/meteorCraterLake.js](../src/spawns/presets/meteorCraterLake.js)

- **Kind:** site, uncommon.
- **Placement:** dunes, meadows, pine or snow; land; ground 15-700 m; chance 0.1 per cell; at least
  22 km apart; 400 m clearance.
- **Stamp:** `crater`, rim radius 380-480 m, 70-100 m deep, the rim 30-45 m above the plain, a flank
  200-280 m wide, a flat floor 32-45 % of the radius, painted ash.
- **Water:** a `lake` on the crater floor filled to 38 % of its depth, deep teal (0x2a7f8f), calm.
- **Engines:** `structure` (the `ejecta` recipe: 100-140 breccia blocks on the rim and the outer flank,
  densest and largest on the crest, a few on the inner wall; those of 2.5 m radius and more are
  solid, the four largest on the crest are perches; owns the voice at a constant level).
- **Wind:** none.
- **Sound:** `gale` (a soft wind sighing over the rim, reference distance 500 m).
- **LOD:** near 1.8 km, mid 5 km, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.
- **Journal:** "Meteor crater lake"; WREN has 3 callout lines.

#### 39. Hot spring terraces

A hillside of white travertine stepping down in shelves, each holding a pool of hot turquoise water
behind its lip, steam curling off the pools and drifting downhill with the breeze, and a gentle
thermal over them.
[src/spawns/presets/hotSpringTerraces.js](../src/spawns/presets/hotSpringTerraces.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, pine, snow or dunes; land; ground 30-1400 m; downhill-aligned (the shelves
  step down the real slope); chance 0.06 per cell; at least 22 km apart; 350 m clearance.
- **Stamp:** `terraces`, 340-460 m downhill, 160-220 m wide, 5-7 shelves, lips 1.4-2.2 m, painted
  travertine.
- **Water:** a `pool` on every shelf filled to 85 %, turquoise (0x40c8c4), nearly still.
- **Engines:** `emitter` (steam over the terraces: a 180 x 400 m box on the ground, drifting with the
  wind, with an `updraft` wind source of 1.6 m/s, 200 m wide and 450 m tall; owns the voice).
- **Wind:** the steam's gentle updraft (enough for an eagle or a paraglider to circle in).
- **Sound:** `geyser` (bubbling pools and a faint steam hiss, reference distance 90 m).
- **LOD:** near 1.5 km, mid 4.5 km, far 10 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 10 + 2.5 km.
- **Journal:** "Hot spring terraces"; WREN has 3 callout lines.

#### 40. Salt flat mirror lake

A dead-flat white salt pan under a thin film of still water that mirrors the sky: its colours, the
sunset glow and the sun's glint lie at your feet. Rows of harvested salt cones stand at the water's
edge.
[src/spawns/presets/saltFlatMirror.js](../src/spawns/presets/saltFlatMirror.js)

- **Kind:** site, uncommon.
- **Placement:** dunes or meadows; land; ground 8-600 m; flat relief; chance 0.6 per cell; at least
  20 km apart; 150 m clearance.
- **Stamp:** a wide, shallow `basin` (radius 500-600 m, 2.5-3.5 m deep, a 40-60 m berm), painted salt.
- **Water:** a `thin` film filled to 70 % of the pan's depth (about 700 m across), `mirror` 1 (the
  water material's sky reflection: the sky dome's radiance, no extra render pass, so clouds, stars and
  the craft are not mirrored), nearly no waves, no foam.
- **Overlay:** the `saltFlat` palette over the stamp and 160 m beyond it (fading over 220 m).
- **Engines:** `structure` (the `saltPiles` recipe: 3-5 rows of 24-40 salt cones at the water's edge,
  each a small solid cylinder; owns the voice at a constant level).
- **Wind:** none.
- **Sound:** `gale` (a faint breeze, reference distance 500 m).
- **LOD:** near 1.5 km, mid 5 km, far 14 km. **Discovery:** 3.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 3 km.
- **Journal:** "Salt flat mirror lake"; WREN has 3 callout lines.
### Ocean and wildlife (presets 41-50)

Presets 41-47 are the spec's ocean set and 48-50 open its wildlife set. They add the Phase 3 water
features their list asks for: travelling waves and clear shallows in the water effects layer, the
atoll, reef, sea stacks and estuary stamps, structure movers (calving slabs and drifting icebergs)
and a bat stream in the fauna engine. None of them changes the air the craft flies through.

#### 41. Calving glacier

Where the snow country meets the sea, a tidewater glacier flows down to an ice cliff standing in the
water. Every minute or so a slab of the front cracks, topples outward and plunges into the sea with a
splash and a ring wave spreading across the water, then drifts off as a berg and melts. Icebergs
drift in the water before the front.
[src/spawns/presets/calvingGlacier.js](../src/spawns/presets/calvingGlacier.js)

- **Kind:** site, uncommon.
- **Placement:** snow or pine; coast; chance 0.4; at least 18 km apart; 600 m clearance; aligned
  downhill (the tongue flows to the sea).
- **Engines:** `structure` (recipe `glacier`: a tongue 1.4-1.9 km long and 380-540 m wide ending in a
  front 34-48 m high where its heading meets water, its top a landable heightfield with a perch, the
  front a row of solid boxes; 3-5 calving slabs, one cracking every 45-85 s (the first after
  8-18 s), each plunge sending a 2.6 m ring wave 900 m across the water; 6-9 drifting icebergs of
  10-30 m, each with its own collider hull, kept to water deep enough for them; owns the voice at a
  constant 0.55).
- **Wind:** none.
- **Sound:** `calving` (groaning ice; `crack` as a slab breaks, `splash` as it hits the water).
- **LOD:** near 2200 m, mid 6000 m, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2.5 km.
- **Journal:** "Calving glacier"; WREN has 4 callout lines.

#### 42. Coral atoll

A ring reef about a kilometre across in the sea: low white-sand islets on a crest just awash around
a clear turquoise lagoon, the surf breaking in a white ring along the reef.
[src/spawns/presets/coralAtoll.js](../src/spawns/presets/coralAtoll.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago, dunes or meadows; any surface, with the centre at least 10 m under the
  sea (the stamp itself fits only where the sea is at least 3 m deep everywhere it stands); chance
  0.5; at least 20 km apart; 400 m clearance.
- **Stamps:** `atoll` (rim radius 380-560 m, rim 80-120 m wide, 4-7 islets 2.2-4.2 m high, lagoon
  5-8 m deep, crest 0.5-1.1 m under the sea, seaward slope 160-240 m; painted `sand`).
- **Engines:** `waterEffect` (`shallows` fitted to the atoll: turquoise at clarity 0.85, surf 0.85 on
  the reef crest; owns the voice at 0.75); `waterEffect` (fish splashes in the lagoon, kept to the
  water).
- **Wind:** none.
- **Sound:** `surf` (breakers on the reef).
- **LOD:** near 2500 m, mid 6000 m, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2.5 km.
- **Journal:** "Coral atoll"; WREN has 3 callout lines.

#### 43. Reef shipwreck

An old sailing ship broken in two on a coral reef, its halves listing in a sand hollow, a mast top
breaking the surface, all of it plain through the clear shallows.
[src/spawns/presets/reefShipwreck.js](../src/spawns/presets/reefShipwreck.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago, dunes or meadows; water, the centre 9-70 m deep; chance 0.1; at least
  16 km apart; 900 m clearance.
- **Stamps:** `reef` through `structureStamps('shipwreck')` (a reef flat 200-270 m across, its crest
  1.8-2.6 m under the sea, 12-18 coral heads, a sand hollow 8-10 m deep; painted `coral`).
- **Engines:** `structure` (recipe `shipwreck`: 34-46 m long, broken in two and listing 18-32
  degrees, shaded underwater; a collider hull per half, capsules for the masts); `waterEffect`
  (`shallows` fitted to the reef at clarity 0.9, surf 0.55 along its edge; owns the voice at 0.55).
- **Wind:** none.
- **Sound:** `surf`.
- **LOD:** near 1800 m, mid 4500 m, far 10 km. **Discovery:** 1.8 km, in view.
- **Lifetime:** a site; removed beyond 10 + 2 km.
- **Journal:** "Reef shipwreck"; WREN has 3 callout lines.

#### 44. Dolphin pod

Six to twelve dolphins porpoise through the swell off a coast; fly low over the water and they race
your shadow.
[src/spawns/presets/dolphinPod.js](../src/spawns/presets/dolphinPod.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `dolphin`, behaviour `surface`: 6-12 swimmers 14 m apart, leaping
  2.2 m every 2.5-6 s; with the craft under 260 m over open water within 900 m they race its shadow at
  up to 1.9 x cruise; whistles every 3-8 s).
- **Filters:** any biome; day, golden hour, dawn or dusk; clear, building or clearing weather; on a
  coast; player 0-2000 m; 2.5-7 km ahead.
- **Candidates:** 5 km cells, 300 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `dolphin` (whistles and click trains, `call`).
- **LOD:** near 1800 m, mid 4000 m, far 8000 m. **Discovery:** 1.5 km, in view.
- **Lifetime:** 240-400 s, fading out over the last 8 s; despawned beyond 8 + 2 km after 20 s out of
  view.
- **Journal:** "Dolphin pod"; WREN has 3 callout lines.

#### 45. Sea stacks and arches

Rock columns standing in the surf off a wild coast, with one or two great arches between them high
enough to fly through.
[src/spawns/presets/seaStacks.js](../src/spawns/presets/seaStacks.js)

- **Kind:** site, uncommon.
- **Placement:** pine, meadows, archipelago or snow; coast; chance 0.1; at least 14 km apart; 900 m
  clearance; aligned downhill (the stacks stand seaward).
- **Stamps:** `seaStacks` through `structureStamps('seaArches')` (4-6 stacks 40-68 m tall, 1-2 arches
  with legs 44-60 m apart and 30-40 m high, each column on a wave-cut shelf; painted `wetRock`).
- **Engines:** `structure` (recipe `seaArches`: the lintel over each pair of legs, a box collider per
  segment and a perch on top, each opening a fly-through gate with the achievement; owns the voice
  at a constant 0.7).
- **Wind:** none.
- **Sound:** `surf`.
- **LOD:** near 1800 m, mid 5000 m, far 11 km. **Discovery:** 2.2 km, in view.
- **Lifetime:** a site; removed beyond 11 + 2 km.
- **Journal:** "Sea stacks and arches"; WREN has 3 callout lines.
- **Achievement:** `seaArch`, "Through the Sea Arch" (the first pass through an arch).

#### 46. Rogue wave

A lone wall of water 14 m high and nearly two kilometres long rolls broadside across the open ocean,
breaking white along its crest.
[src/spawns/presets/rogueWave.js](../src/spawns/presets/rogueWave.js)

- **Kind:** event, uncommon.
- **Engines:** `waterEffect` (`wave`, a straight front: 14 m high, half width 48 m with a steeper
  front face, a crest 900 m each side of its centre tapering over its last 320 m; it starts 1800 m
  behind the anchor, travels 3600 m at 16 m/s across the activation heading and crosses the anchor
  midway; spray 340 a second off the crest; the water query lifts the surface with it; owns the
  voice, one big breaker at full height).
- **Filters:** any biome; day, golden hour, dawn or dusk; any weather; over water; player 0-3000 m;
  3-7 km ahead.
- **Candidates:** 8 km cells, 600 s buckets, chance 0.35.
- **Wind:** none.
- **Sound:** `surf` (reference distance 220 m; `crash` at full height).
- **LOD:** near 2500 m, mid 6000 m, far 12 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** the wave's own run (225 s) ends it inside its 250-270 s; despawned beyond 12 + 2.5 km
  after 30 s out of view.
- **Journal:** "Rogue wave"; WREN has 3 callout lines.

#### 47. Tidal bore

A muddy estuary carved into a low coast, where the incoming tide rears up into a breaking wave that
surges inland up the channel every minute or two.
[src/spawns/presets/tidalBore.js](../src/spawns/presets/tidalBore.js)

- **Kind:** site, uncommon.
- **Placement:** any biome; coast, the centre at most 10 m up; chance 0.6; at least 18 km apart;
  300 m clearance; aligned downhill (the estuary opens to the sea).
- **Stamps:** `estuary` (a channel 1.6-2.2 km long from just past the shore inland, 260-380 m wide
  at its mouth narrowing to 45-70 m, 3.5-5.5 m deep at the mouth, mud levees 5-8 m high; painted
  `mud`).
- **Engines:** `waterEffect` (`wave` in estuary mode: from the mouth up the channel at 8 m/s, 2.4 m
  high growing 1.5 x as the channel narrows, its crest spanning the channel; again every 45-90 s;
  owns the voice).
- **Wind:** none.
- **Sound:** `surf` (reference distance 150 m; `crash` as each bore rises).
- **LOD:** near 2000 m, mid 5000 m, far 11 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 11 + 2 km.
- **Journal:** "Tidal bore"; WREN has 3 callout lines.

#### 48. Bats at dusk

As the light goes, a stream of two thousand bats pours out of a cave mouth high on a mountain face
and climbs away over the valley; fly through it and they burst aside.
[src/spawns/presets/batsAtDusk.js](../src/spawns/presets/batsAtDusk.js)

- **Kind:** event, uncommon.
- **Engines:** `structure` (recipe `caveMouth` on the steepest high face within 1.5 km, solid);
  `fauna` (species `bat`, behaviour `stream`: 1800-2600 bats out of the same face along a 1.7 km
  path climbing 260 m, 6 m wide at the mouth to 34 m at its end, meandering 90 m and turning 35
  degrees, already 90 s into its flow when it appears; owns the voice). With no face in reach every part ends at create and the activation is
  declined.
- **Filters:** pine, snow, dunes or meadows; dusk; clear or clearing weather; over land; player
  0-3500 m; 2.5-7 km ahead. The activation moves onto the highest ground within 6 km
  (`anchor.seek: 'peak'`).
- **Candidates:** 6 km cells, 600 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `murmuration` (the wing rush, swelling as you near the stream; `scatter`).
- **LOD:** near 2200 m, mid 5000 m, far 10 km. **Discovery:** 2.2 km, in view.
- **Lifetime:** 300-480 s, fading out over the last 15 s; despawned beyond 10 + 2 km after 20 s out
  of view.
- **Journal:** "Bats at dusk"; WREN has 3 callout lines.

#### 49. Herd stampede

A bison herd grazing across the plains; buzz it low and it bolts at a gallop under a rolling plume
of dust.
[src/spawns/presets/herdStampede.js](../src/spawns/presets/herdStampede.js)

- **Kind:** event, common.
- **Engines:** `fauna` (species `bison`, behaviour `herd`: 40-80 animals 6.5 m apart, grazing half the
  time; a stampede when the craft comes within 320 m and under 350 m above them, 28 s long, bent
  downhill, then 40 s before the next; dust 9 puffs a second per running animal, 7 m across; a bull's
  bellow every 10-24 s).
- **Filters:** meadows or dunes; day, golden hour, dawn or dusk; clear, building or clearing
  weather; over land; player 0-2500 m; 2.5-7 km ahead.
- **Candidates:** 5 km cells, 360 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `herd` (drumming hooves, loudest in a stampede; `bellow`).
- **LOD:** near 2000 m, mid 4500 m, far 9000 m. **Discovery:** 1.8 km, in view.
- **Lifetime:** 300-480 s, fading out over the last 10 s; despawned beyond 9 + 2 km after 20 s out of
  view.
- **Journal:** "Herd stampede"; WREN has 3 callout lines.

#### 50. Flamingo lake

A shallow pink soda lake crowded with wading flamingos that lift off in a wave when you fly over
them, circle the lake and settle again.
[src/spawns/presets/flamingoLake.js](../src/spawns/presets/flamingoLake.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, dunes or archipelago; flat land 5-600 m up; chance 0.08; at least 16 km
  apart; 600 m clearance.
- **Stamps and water:** a `basin` (radius 260-360 m, 3-5 m deep, painted `salt`) holding a lake
  filled to 0.75 of its depth, tinted pink (`waters`, tint 0xf2a6b8, waves 0.12).
- **Engines:** `fauna` (species `flamingo`, behaviour `surface` wading: 60-120 birds in water under
  0.6 m; flushed within 160 m, they take off in a wave, fly 25-45 s on a 240 m circle 45 m up and
  settle back; calls every 4-10 s; owns the voice).
- **Wind:** none.
- **Sound:** `goose` (honking calls).
- **LOD:** near 1800 m, mid 4500 m, far 9000 m. **Discovery:** 2 km, in view.
- **Lifetime:** a site; removed beyond 9 + 2 km.
- **Journal:** "Flamingo lake"; WREN has 3 callout lines.
### Phase 3 batch 6: presets 51-60

Wildlife (51-52), structures (53-59) and one night-sky event (60), on the Phase 2 engines and their
Phase 3 additions: the fauna engine's `windDrift`, the structure engine's cloth, movers, steam,
torches, blocks and moving voice, and the emitter's `startDelay`
([engines/structure.md](engines/structure.md#phase-3-recipe-features),
[engines/fauna.md](engines/fauna.md#group), [engines/emitter.md](engines/emitter.md#emission)).

#### 51. Butterfly migration

A loose orange cloud of a couple of thousand monarch butterflies flutters low over open country and
drifts downwind on the real WindField wind, each butterfly flitting and gliding on its own; fly
through and they scatter softly round the craft.
[src/spawns/presets/butterflyMigration.js](../src/spawns/presets/butterflyMigration.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `butterfly`, behaviour `flock`: 1600-2400 butterflies 35 m above the
  ground (floor 3 m), `windDrift` 1: the goal, its leash and every butterfly ride the WindField's
  ambient wind at the cloud's height, scaled live with the world's wind strength, plus the gusts the
  craft feels within 600 m; scattering within 35 m of the craft).
- **Filters:** meadows, pine or dunes; day; clear or clearing weather; over land; player 0-2500 m;
  3-7 km ahead.
- **Candidates:** 5 km cells, 450 s buckets, chance 0.45.
- **Wind:** none of its own; it rides the field's.
- **Sound:** `murmuration` (a papery wing rush swelling as you close in).
- **LOD:** near 1200 m, mid 3500 m, far 9 km. **Discovery:** 1.2 km, in view.
- **Lifetime:** 240-360 s, fading out over the last 12 s; despawned beyond 9 + 2.5 km after 20 s out
  of view.
- **Journal:** "Butterfly migration"; WREN has 3 callout lines.

#### 52. Caribou migration

A column of several hundred caribou walks four abreast across the tundra, a grey-brown ribbon
kilometres long with pale manes and antlers, kicking up snow dust.
[src/spawns/presets/caribouMigration.js](../src/spawns/presets/caribouMigration.js)

- **Kind:** event, uncommon.
- **Engines:** `fauna` (species `caribou`, behaviour `column`: 320-520 animals, 4 lanes 3.4 m apart,
  rows 4.5 m apart, 1.7 m/s, on an `auto` route of 3.6 km planned by the PathFollower around slopes
  over 0.4 and water, ping-ponging; snow dust; a pure function of flight time).
- **Filters:** snow or pine; dawn, day or dusk; clear, building or clearing weather; over land;
  player 0-3000 m; 3-8 km ahead.
- **Candidates:** 6 km cells, 600 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `caribou` (the herd rumble of hooves, clicking ankles and grunts).
- **LOD:** near 1500 m, mid 4500 m, far 10 km. **Discovery:** 1.8 km, in view.
- **Lifetime:** 360-540 s, fading out over the last 10 s; despawned beyond 10 + 2.5 km after 20 s
  out of view.
- **Journal:** "Caribou migration"; WREN has 3 callout lines.

#### 53. Cliffside monastery

A whitewashed Himalayan monastery on the lip of a sheer cliff: a main hall with a gilded roof, a
chorten, a bell pavilion and a prayer pole on the plateau, smaller halls clinging to the face below.
Strings of prayer flags swing out and ripple in the real WindField wind; the temple bell rings across
the valley.
[src/spawns/presets/cliffsideMonastery.js](../src/spawns/presets/cliffsideMonastery.js)

- **Kind:** site, rare.
- **Placement:** snow or pine; land; ground from 280 m; chance 0.05; at least 22 km apart; 500 m
  clearance; aligned downhill.
- **Stamp:** `cliffStep` 300-380 m wide, dropping 95-140 m, painted basalt (`structureStamps('monastery')`).
- **Engines:** `structure` (recipe `monastery`: 2-3 halls, 11-15 prayer-flag strings of 18-26 flags
  on the cloth kind, butter lamps (torches) that light at dusk and braziers that wait for a dragon's
  breath, landable roofs and perches; voice level follows the wind) and `lightEffect` (26 warm lamp
  glows at night).
- **Wind:** none of its own; the flags show the field's.
- **Sound:** `bells` (the temple bell and small bells tinkling in the gusts).
- **LOD:** near 1500 m, mid 5000 m, far 12 km. **Discovery:** 2.2 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2 km.
- **Journal:** "Cliffside monastery"; WREN has 3 callout lines.

#### 54. Sea-cliff castle ruin

A ruined stone castle on the edge of a sea cliff: curtain walls with battlements, broken through in
places, round corner towers, a gatehouse and a roofless hall, and on the cliff edge the keep with
banners streaming in the wind, the tower to fly around.
[src/spawns/presets/seaCliffCastle.js](../src/spawns/presets/seaCliffCastle.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago, meadows or pine; coast; ground 2-160 m; chance 0.16; at least 16 km
  apart; 500 m clearance; aligned downhill.
- **Stamp:** `cliffStep` 280-360 m wide, dropping 45-75 m toward the sea (`structureStamps('castleRuin')`).
- **Engines:** `structure` (recipe `castleRuin`: 5-7 towers on a 30-40 m ring, the keep 34-42 m tall,
  ruin 0.35; every wall and tower a collider, the keep's top a landable perch, braziers that only a
  dragon's breath lights, banners on the cloth kind).
- **Wind:** none of its own; the banners show the field's.
- **Sound:** `waterfall` as the surf booming at the cliff foot (constant, level 0.45).
- **LOD:** near 1500 m, mid 5000 m, far 12 km. **Discovery:** 2.2 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2 km.
- **Journal:** "Sea-cliff castle"; WREN has 3 callout lines.

#### 55. Mountaintop observatory

A white telescope building on a pad cut into a summit: a drum under a silver dome, a second small
dome, a control building and an antenna mast. At dusk the shutter slides back, the dome turns its
slit and the telescope rises to the target: a comet if one is in the sky, else a meteor shower's
radiant, else the moon, else a slow survey. At dawn it parks and closes.
[src/spawns/presets/mountaintopObservatory.js](../src/spawns/presets/mountaintopObservatory.js)

- **Kind:** site, uncommon.
- **Placement:** snow, pine, dunes or meadows; land; a peak from 650 m; chance 0.08; at least 20 km
  apart; 400 m clearance.
- **Stamp:** `flatten` pad 64-76 by 44-52 m (`structureStamps('observatory')`).
- **Engines:** `structure` (recipe `observatory`: the dome, shutter and telescope are movers aimed
  through the celestial engine's `skyTarget`, slewing at 3 degrees a second, opening over 22 s; the
  dome and mast perches, the control roof landable; voice level from the motors).
- **Wind:** none.
- **Sound:** `observatory` (the motors' whir and the shutter latch's clunk).
- **LOD:** near 1500 m, mid 5000 m, far 12 km. **Discovery:** 2 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2 km.
- **Journal:** "Mountaintop observatory"; WREN has 3 callout lines.

#### 56. Steam train viaduct

A line of tall stone arches carries a railway across a deep gorge between two tunnel portals in
wooded hillocks. A steam train bursts out of one tunnel whistling, crosses trailing steam and
disappears into the other, where it waits before coming back. Fly under the arches.
[src/spawns/presets/steamTrainViaduct.js](../src/spawns/presets/steamTrainViaduct.js)

- **Kind:** site, rare.
- **Placement:** pine, meadows or snow; land; ground from 110 m; chance 0.07; at least 20 km apart;
  600 m clearance.
- **Stamp:** `gorge` 900-1100 m long, 170-240 m wide, 55-80 m deep, with 80-100 m anchor pads
  (`structureStamps('viaduct')`).
- **Engines:** `structure` (recipe `viaduct`: 20-26 m spans on tapering piers, the deck 0.6 m over the
  pads, a portal with a dark bore on each pad; the locomotive, tender and 2-4 coaches are movers with
  box colliders on a PathFollower that ping-pongs between the tunnels at 11-15 m/s with 35-60 s
  waits, a pure function of flight time; chimney steam on the mist pool; every arch with headroom a
  pass-under gate; the deck landable, the portals perches; the voice rides the locomotive).
- **Wind:** none.
- **Sound:** `train` (the chuff following the train's speed, the clank and hiss, the `whistle` as it
  leaves a tunnel).
- **LOD:** near 1800 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2.5 km.
- **Journal:** "Steam train viaduct"; WREN has 3 callout lines.
- **Achievement:** `underTheArches`, "Under the Arches": fly under an arch of the viaduct.

#### 57. Dam spillway

A concrete gravity dam closes a valley, a reservoir lake behind it; in the middle of the crest the
spillway is open and the lake pours down a white chute into a stilling basin, with spray and a
rainbow below and a river running on down the valley.
[src/spawns/presets/damSpillway.js](../src/spawns/presets/damSpillway.js)

- **Kind:** site, uncommon.
- **Placement:** pine, meadows or snow; land; ground 90-1600 m; chance 0.12; at least 20 km apart;
  700 m clearance; aligned downhill (where the basin fits, its berm lifts the down-slope rim 20-80 m
  over the ground below: the dam's height).
- **Stamp:** `basin` 150-190 m in radius and 34-42 m deep, centred 170 m uphill of the site with a
  narrow, steep berm (`structureStamps('dam')`). **Water:** a lake filling it to 97 %, tinted green-grey
  (the seaplane can land on it).
- **Engines:** `structure` (recipe `dam`: the wall on a line outside the down-valley shoreline, its
  crest out to the valley sides, a 26-34 m spillway with training walls, a bridge, a stilling basin and
  the river; intake towers and a valve house; hull colliders, the crest landable), `emitter` (spray
  at the foot) and `celestial` (a rainbow in the spray by day).
- **Wind:** none.
- **Sound:** `dam` (the spillway's roar over a surging sub rumble and the spray's hiss).
- **LOD:** near 1800 m, mid 6000 m, far 15 km. **Discovery:** 2.8 km, in view.
- **Lifetime:** a site; removed beyond 15 + 2.5 km.
- **Journal:** "Dam spillway"; WREN has 3 callout lines.

#### 58. Desert oasis caravan

Date palms round a turquoise spring pool in the dunes, a well, goat-hair tents and a fire pit whose
lamps light at dusk, and a caravan of laden camels walking single file out across the sand and back.
[src/spawns/presets/desertOasisCaravan.js](../src/spawns/presets/desertOasisCaravan.js)

- **Kind:** site, uncommon.
- **Placement:** dunes; land; ground 8-500 m; chance 0.08; at least 18 km apart; 500 m clearance.
- **Stamp:** `basin` 55-80 m in radius, 4-7 m deep, painted sand (`structureStamps('oasis')`).
  **Water:** a pool filling it to 78 %.
- **Engines:** `structure` (recipe `oasis`: 20-30 palms whose crowns sway and are perches, reeds, the
  well, 2-4 tents with rugs, a shade shelter, three dusk lamps that are ignitables) and `fauna`
  (species `camel`, behaviour `column`: 12-18 camels in single file at 1.3 m/s on a 2.3 km
  PathFollower route out of the oasis and back, a little sand dust; a pure function of flight time).
- **Wind:** none.
- **Sound:** `caravan` (camel bells clonking out of step, footfalls and a grumble), on the camels.
- **LOD:** near 1500 m, mid 4500 m, far 11 km. **Discovery:** 2 km, in view.
- **Lifetime:** a site; removed beyond 11 + 2 km.
- **Journal:** "Desert oasis"; WREN has 3 callout lines.

#### 59. Labyrinth

A hedge maze on a levelled square of pale gravel, grown from the site's seed: only green walls from
the ground, a perfect pattern from a few hundred metres up, with a fountain and a gilded obelisk at
its heart.
[src/spawns/presets/labyrinth.js](../src/spawns/presets/labyrinth.js)

- **Kind:** site, rare.
- **Placement:** meadows or pine; land; ground 10-700 m; chance 0.1; at least 20 km apart; 500 m
  clearance.
- **Stamp:** `flatten` 130-150 m square, painted sand (`structureStamps('labyrinth')`).
- **Engines:** `structure` (recipe `labyrinth`: a seeded depth-first maze of 17-21 cells a side,
  hedges 3.4 m tall as instanced blocks merged into solid runs, an entrance and an exit, the heart a
  clearing with the obelisk perch; a low pass through the heart is a gate).
- **Wind:** none.
- **Sound:** `waterfall` as the fountain, soft and close (level 0.3, reference distance 25 m).
- **LOD:** near 1500 m, mid 5000 m, far 11 km. **Discovery:** 1.8 km, in view.
- **Lifetime:** a site; removed beyond 11 + 2 km.
- **Journal:** "Labyrinth"; WREN has 3 callout lines.
- **Achievement:** `heartOfTheMaze`, "Heart of the Maze": fly low through the clearing at its heart.

#### 60. Fireball impact

At night a bolide tears down the sky, a white-hot head with a long orange tail, and strikes the
ground ahead in a blinding flash; the sonic boom and the thud arrive seconds later. It leaves a
glowing scorched scar on the terrain (the ground's height never changes), sparks and a column of
smoke lit from below.
[src/spawns/presets/fireballImpact.js](../src/spawns/presets/fireballImpact.js)

- **Kind:** event, rare.
- **Engines:** `structure` (recipe `fireball`: after 4 s the bolide comes down a straight line from
  11-14 km up at 24-38 degrees from a seeded bearing over 7 s, the voice on its head; the flash
  swells to 160 m and dies in 2 s; the scar, 34-48 m with ejecta rays, is a decal mover whose embers
  cool over 120 s; the boom is played when its sound reaches the player) and two `emitter` parts
  (smoke with an orange underglow, and sparks with the real light), both starting at the impact
  (`startDelay` 11 s).
- **Filters:** any biome; night or dusk; clear or clearing weather; over land; player 0-8000 m;
  3.5-8 km ahead.
- **Candidates:** 8 km cells, 900 s buckets, chance 0.25. **Cooldown:** 3600 s.
- **Wind:** none.
- **Sound:** `fireball` (the roar rising as it comes, the `boom`, then the scar crackling).
- **LOD:** near 4 km, mid 14 km, far 30 km. **Discovery:** 9 km, in view.
- **Lifetime:** 150-210 s; despawned beyond 30 + 4 km after 30 s out of view.
- **Journal:** "Fireball impact"; WREN has 3 callout lines.
### Night and celestial (Phase 3, 61-65)

#### 61. Blood moon

A total eclipse of the moon that lasts the night: the earth's shadow turns the moon copper-red, a
copper halo glows round it with a bright limb on the side leaving the shadow, and the whole night
darkens while the stars brighten.
[src/spawns/presets/bloodMoon.js](../src/spawns/presets/bloodMoon.js)

- **Kind:** event, rare; a global override (`override: { kind: 'bloodMoon', nightChance: 0.04,
  region: null }`), never a director candidate: the director schedules it on about one night in
  twenty-five, everywhere at once (see [Global overrides](#global-overrides-the-blood-moon-and-the-midnight-sun)).
  The override reddens the moon disc, its halo and the moon light and darkens the night; this preset's
  own part starts at the override's half weight and ends with it.
- **Engines:** `celestial` (`lunarEclipse`: the copper halo and the bright umbral limb; a `sky`
  modifier raising the stars at night; sky-anchored, 30 s fades).
- **Filters:** never tested: the override starts the spawn 3 km ahead on the ground track (the
  file's any biome, dusk or night, any weather, surface and altitude, 2-6 km ahead go unused).
- **Wind:** none.
- **Sound:** `skyShimmer` (a low, dark shimmer: base 98 Hz, brightness 0.15).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** the night (the override ends it); 1500-2100 s caps a frozen night clock; despawned
  beyond 20 + 3 km after 60 s out of view.
- **Journal:** "Blood moon"; WREN has 3 callout lines.

#### 62. Green flash

At sunset over the sea, as the sun's top limb sinks into an open-ocean horizon, a thin green rim and
a detached green sliver show on it, and as it vanishes a brief green flash fires, with a glassy bell.
[src/spawns/presets/greenFlash.js](../src/spawns/presets/greenFlash.js)

- **Kind:** event, uncommon.
- **Engines:** `celestial` (`greenFlash`: only toward an open-ocean horizon, sampled toward the sun
  once a second; an activation in the morning or after sunset ends at create; sky-anchored at the sun).
- **Filters:** any biome; dusk; clear or clearing weather; over water; player 0-3000 m; 2-8 km
  ahead.
- **Candidates:** 6 km cells, 600 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `skyShimmer` (its `flash` trigger rings as the flash fires).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** 600-900 s; it ends 8 s after the sun has gone; despawned beyond 20 + 3 km after 30 s
  out of view.
- **Journal:** "Green flash"; WREN has 3 callout lines.

#### 63. Noctilucent clouds

After dusk, when the ground is already dark, thin rippled sheets of electric-blue cloud glow low over
the sun's azimuth: ice at the edge of space, still in sunlight while the sun is 6-16 degrees down.
[src/spawns/presets/noctilucentClouds.js](../src/spawns/presets/noctilucentClouds.js)

- **Kind:** event, uncommon.
- **Engines:** `celestial` (`noctilucent`: the sheets foreshorten toward the horizon and drift; the
  event waits for the sun's window and ends once the sun has sunk past it; sky-anchored).
- **Filters:** snow, pine, meadows or archipelago; dusk; clear or clearing weather; any surface and
  altitude; 2-8 km ahead.
- **Candidates:** 6 km cells, 600 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `skyShimmer` (a glassy, high shimmer).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** 600-900 s; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Noctilucent clouds"; WREN has 3 callout lines.

#### 64. Milky Way core

On a clear, dark night the galaxy's bright core rises on the star field's milky way band: a warm
bulge, star clouds and grain, split by the dark dust lanes of the Great Rift; strongest over the
desert, fainter under a bright moon or cloud.
[src/spawns/presets/milkyWayCore.js](../src/spawns/presets/milkyWayCore.js)

- **Kind:** event, uncommon.
- **Engines:** `celestial` (`galaxy`, with a `sky` modifier bringing the stars out fully; it lasts
  until dawn; sky-anchored at the core).
- **Filters:** dunes, meadows, snow or pine; night; clear weather; any surface and altitude; 2-8 km
  ahead.
- **Candidates:** 6 km cells, 900 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `skyShimmer` (a deep, slow shimmer).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** until dawn; 600-900 s caps a frozen night clock; despawned beyond 20 + 3 km after
  30 s out of view.
- **Journal:** "Milky Way core"; WREN has 3 callout lines.

#### 65. Moonbow

A pale, nearly white rainbow in the spray of a mega-waterfall under a bright moon, silver at its
edges, with a faint secondary bow and a veil of moonlit mist rising from the plunge pool.
[src/spawns/presets/moonbow.js](../src/spawns/presets/moonbow.js)

- **Kind:** event, uncommon.
- **Engines:** `celestial` (`rainbow` with `light: 'moon'`, seen with the moon behind the viewer) and
  `emitter` (the moonlit mist).
- **Filters:** any biome; night; clear or clearing weather; player 0-5000 m; 1.5-12 km ahead;
  `near: { sites: ['megaWaterfall'], radius: 15000 }` moves the candidate onto the nearest placed
  mega-waterfall, facing the way the falls do (none in reach, no moonbow).
- **Candidates:** 6 km cells, 900 s buckets, chance 0.6.
- **Wind:** none (the falls keep their own).
- **Sound:** `skyShimmer` (a soft night shimmer; the falls keep their roar).
- **LOD:** near 1.8 km, mid 6 km, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** 480-720 s; despawned beyond 16 + 3 km after 30 s out of view.
- **Journal:** "Moonbow"; WREN has 3 callout lines.

### Fantasy (Phase 3, 66-70)

#### 66. World tree

A tree taller than the mountains, 1.1-1.35 km to its crown, its trunk 90 m thick at the buttressed
foot; great limbs in tiers hold a crown 1-1.4 km across with open lanes between them, golden motes
drift in the canopy at night, the leaves rustle and the limbs groan.
[src/spawns/presets/worldTree.js](../src/spawns/presets/worldTree.js)

- **Kind:** site, rare, heavy. Tree lure (1.4 km tall) on the horizon out to 50 km.
- **Engines:** `structure` (`worldTree`: capsule trunk, limbs, boughs and roots and sphere foliage
  colliders; perches on every limb's first bend and the crown; a gate in each crown lane earns
  "Through the World Tree") and `lightEffect` (220 golden motes in the canopy, at night).
- **Placement:** pine, meadows or snow; land 30-600 m up; chance 0.06 per 2 km cell, 60 km apart,
  1.5 km clear of landmarks.
- **Wind:** none.
- **Sound:** `canopy` (rustle and groans growing with the approach; a `creak` now and then).
- **LOD:** near 3 km, mid 12 km, far 50 km. **Discovery:** 6 km, in view.
- **Lifetime:** a site; despawned beyond 50 + 4 km after 30 s out of view.
- **Journal:** "World tree"; WREN has 3 callout lines.

#### 67. Portal ring

A ring of rune-carved stone 80-90 m across on two leaning pillars, holding a membrane of violet light
that spirals into its centre. Fly through it, either way, and the screen fades into its light: the
next world's seed is `portalSeed(seed, the site id)`, the URL hash updates, the craft arrives as it
left (position, height above the ground, heading, pitch, airspeed, throttle, its own state such as the
tiltrotor's nacelles or the balloon's envelope heat, every setting; a hovering tiltrotor hovers and a
balloon drifts, as its situate hook places it) and the journal logs the world.
[src/spawns/presets/portalRing.js](../src/spawns/presets/portalRing.js)

- **Kind:** site, rare.
- **Engines:** `structure` (`portalRing`: capsule and box colliders, the keystone a perch, the
  membrane a `portal` gate; src/gameplay/portals.js does the travel) and `lightEffect` (motes drifting
  in).
- **Placement:** any biome; flat land 10-700 m up; chance 0.07, 30 km apart, 600 m clear of landmarks.
- **Wind:** none.
- **Sound:** `portal` (a beating hum with the approach; a `surge` as you cross).
- **LOD:** near 1.5 km, mid 5 km, far 12 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; despawned beyond 12 + 2 km after 20 s out of view.
- **Journal:** "Portal ring"; WREN has 3 callout lines; `worldsVisited` (the typed `worldVisited`).

#### 68. Sleeping stone giant

A mountain shaped like a giant asleep on its back, 3.2 km from head to toe and 420 m to the chest: a
face to the sky (brow, eye hollows, nose, lips, chin), hands folded on the belly, one knee raised. It
is the terrain itself, so it reads from altitude and from the far field. A ring of standing stones
crowns the chest, scree litters the flanks, and every nine seconds mist rises from its nose as it
breathes, with a deep rush and a grinding snore.
[src/spawns/presets/sleepingGiant.js](../src/spawns/presets/sleepingGiant.js)

- **Kind:** site, rare.
- **Stamps:** `giant` (length 3200 m, height 420 m, skirt 0.26, basalt): the base is the site's own
  ground and `placement.scale` is 1, so the nose stands 1254 m ahead and 314 m up from the anchor.
- **Engines:** `structure` (`sleepingGiant`: the standing stones, a cairn and scree with colliders,
  the tallest stone a perch; a debug spawn raises the figure itself with a landable heightfield
  collider) and `emitter` (the breath: mist puffs at the nose, `pulse` 9 s deep, owning the voice).
- **Placement:** meadows, pine, dunes or snow; land 30-520 m up where the ground under the figure
  varies by under 230 m; chance 0.1, 30 km apart, 300 m clear of landmarks.
- **Wind:** none.
- **Sound:** `giant` (the breath and the snore follow the emitter's breathing level).
- **LOD:** near 3 km, mid 9 km, far 30 km (the figure is terrain at every distance). **Discovery:**
  5 km, in view.
- **Lifetime:** a site; despawned beyond 30 + 3 km after 30 s out of view.
- **Journal:** "Sleeping stone giant"; WREN has 3 callout lines.

#### 69. Ghost galleon

On a night with clouds about, a three-masted galleon of pale green light sails the cloud tops on a slow
loop 3-4 km across, rocking in a swell that is not there, its tattered sails bellied and its lanterns
cold; you can see through it. Its bell tolls, the wind whistles in its rigging and a faint choir sings.
A flame (the dragon's breath) lights its lanterns warm, one by one.
[src/spawns/presets/ghostGalleon.js](../src/spawns/presets/ghostGalleon.js)

- **Kind:** event, rare.
- **Engines:** `structure` (`ghostGalleon`: the `ghost` part; a PathFollower loop 700 m above the sea
  or 160 m over the ground; moving capsule colliders for the hull, castle, bowsprit and masts (the
  sails are not solid); eleven ignitable lanterns; the `bell` voice trigger).
- **Filters:** any biome; night; building or clearing weather (clouds about); any surface; player
  100-4000 m; 2.5-7 km ahead.
- **Candidates:** 8 km cells, 1200 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `galleon` (rigging, timbers and choir with the approach; the bell every 14-28 s).
- **LOD:** near 2.5 km, mid 8 km, far 20 km. **Discovery:** 3.5 km, in view.
- **Lifetime:** 480-720 s; despawned beyond 14 + 3 km after 30 s out of view.
- **Journal:** "Ghost galleon"; WREN has 3 callout lines.

#### 70. Dragon racer

A basalt crag on a peak with a wild dragon on top, and a course of stone gates winding 2.4 km down the
mountain. Fly through the start gate and the dragon launches from its crag and races you through every
gate: flying anything else, it leads on the gold line; flying the dragon yourself, it becomes your
rival, roaring and breathing fire as it launches, the timer showing the gap to it, and beating it to
the finish earns "Out-flew the wild dragon".
[src/spawns/presets/dragonRacer.js](../src/spawns/presets/dragonRacer.js)

- **Kind:** site, rare; a challenge (start gate, four checkpoints, finish; medals gold 70 s, silver
  95 s, bronze 130 s; 5 s per missed gate; the start prompt within 1.2 km; abandoned beyond 3.5 km).
- **Engines:** `structure` (`dragonRace`: the crag with hull colliders and the perch, the stone gate
  frames and the course registration, and the course rival: pace 70 s, rival 84 s, the dragon craft's
  mesh at 9 times its size).
- **Placement:** pine, meadows, snow or dunes; a peak 120-1400 m up; chance 0.1, 30 km apart, 400 m
  clear of landmarks.
- **Wind:** none.
- **Sound:** `dragon` (wingbeats and breath following the dragon; a `roar` as the rival launches).
- **LOD:** near 3 km, mid 8 km, far 16 km. **Discovery:** 3.5 km, in view.
- **Lifetime:** a site; despawned beyond 16 + 2.5 km after 30 s out of view.
- **Journal:** "Dragon racer"; WREN has 3 callout lines; best times and medals per craft (the
  challenge system); the `dragonRival` achievement.
### Fantasy (Phase 3, presets 71-72)

#### 71. Reverse waterfall

A river that runs the wrong way: its strands rise out of the plunge pool, climb the cliff face, leave
the lip and twist into a column of water that climbs hundreds of metres into the sky before it frays
into a cloud of mist. Spray boils up the column, and the air goes up with the water: an updraft a
glider can ride.
[src/spawns/presets/reverseWaterfall.js](../src/spawns/presets/reverseWaterfall.js)

- **Kind:** site, rare. Not heavy (no lure): an always-there site would hold one of the 2 heavy
  slots for as long as it exists and keep tornadoes and eruptions away around it.
- **Placement:** pine, snow, meadows or archipelago; land; ground from 60 m; chance 0.03; at least
  26 km apart; 400 m clearance; aligned downhill.
- **Stamp:** `cliffStep`, 300-380 m wide, a 120-150 m drop, a pool of 50-65 m, painted `wetRock`
  (`structureStamps('waterfall', ...)`).
- **Engines:** `structure` (recipe `waterfall` with `reverse`: 7-9 rising strands with veils, a column
  46 m out from the lip and 16 m in radius climbing 460 m, the river flowing toward the pool, mist at
  the pool and a mist cloud at the top; owns the voice at a constant 0.85); `emitter` (6000 spray
  particles rising up the column on buoyancy, cloud-lit); `waterEffect` (the plunge pool's churn and
  mist, silent).
- **Wind:** an updraft column round the water (windModifier `updraft`): 10 m/s at its core, 170 m in
  radius, from the pool to 720 m up, a light sink ring and swirl, turbulence 0.5 with 3.5 m/s gusts.
  `tools/lab/preset-flight-71-80.mjs` flies a glider through it (carried up 40+ m) and a jet (a load
  bump).
- **Sound:** `waterfall` (the roar).
- **LOD:** near 2200 m, mid 7000 m, far 16 km. **Discovery:** 3.5 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.
- **Journal:** "Reverse waterfall"; WREN has 3 callout lines.
- **Tags:** water, thermal, spectacle.

#### 72. Forest wisps

A knot of pale blue-green lights hangs over the night forest. Come close and they fall in behind
you, trailing your craft for half a minute; then they drift away toward the nearest place you have
not discovered yet, waiting whenever you fall behind, and gather over it when you arrive. They
shimmer and ting softly and light the treetops around them.
[src/spawns/presets/forestWisps.js](../src/spawns/presets/forestWisps.js)

- **Kind:** event, uncommon.
- **Engines:** `lightEffect` with a `guide` (9 breathing orbs and 64 blinking motes, a real light of
  220 m range; they wait at the anchor until the craft comes within 500 m, trail 35 m behind it for
  35 s, then lead at 14 m/s toward the nearest undiscovered site within 16 km, holding while the craft
  is more than 280 m behind, between 12 m and 300 m above the ground, and gather within 140 m of the
  site; owns the voice, intensity = the approach). A notice and the bus event `lightEffect:guide`
  mark each change of phase.
- **Filters:** pine forests; night; clear, clearing or building weather; over land; player 0-2500 m;
  1.5-4 km ahead.
- **Candidates:** 6 km cells, 600 s buckets, chance 0.45. **Cooldown:** 1500 s.
- **Wind:** none.
- **Sound:** `wisps` (a glassy shimmer with tings).
- **LOD:** near 800 m, mid 3000 m, far 9 km. **Discovery:** 700 m, in view.
- **Lifetime:** 420-600 s, easing out over 8 s; despawned beyond 9 + 2 km after 30 s out of view.
- **Journal:** "Forest wisps"; WREN has 3 callout lines.
- **Tags:** night, forest, spectacle, slow.

### Flight-play (Phase 3, presets 73-80)

#### 73. Ridge lift band

Along a long ridgeline the wind is forced up the slopes and rises in a band over the crest: a smooth
cap cloud drapes the crest, and hawks soar the line without a wingbeat. Fly the crest and the band
holds a glider up for kilometres.
[src/spawns/presets/ridgeLiftBand.js](../src/spawns/presets/ridgeLiftBand.js)

- **Kind:** site, uncommon.
- **Placement:** snow, pine, meadows or dunes; land; ground from 180 m on a `ridge`; chance 0.08; at
  least 18 km apart; 300 m clearance; aligned along the ridge. No stamp.
- **Engines:** `weatherVolume` (a `bank` turned onto the ridge's axis, 4.6 km long, 280 m wide and
  110 m tall, 55 m above the crest and following it, 130 puffs, smooth and bright; no voice);
  `fauna` (6-9 hawks circling 90-420 m up over the crest; owns the voice); `windModifier` (the band).
- **Wind:** eight overlapping updraft columns along the ridge's axis, 600 m apart and 520 m in
  radius: 3 m/s from 160 m below the crest to 700 m above it, turbulence 0.22, on top of the
  WindField's own slope lift. The lab measures the band's own lift at 2.6-3.1 m/s all along the
  crest; a glider along it climbs at 2.2 m/s where it sank at 0.6 m/s, and so does the bush plane.
- **Sound:** `raptor` (pitch 0.95: the hawks' calls every 20-45 s).
- **LOD:** near 2500 m, mid 9000 m, far 20 km. **Discovery:** 4 km, in view.
- **Lifetime:** a site; removed beyond 20 + 3 km.
- **Journal:** "Ridge lift band"; WREN has 3 callout lines.
- **Tags:** thermal, calm, spectacle.

#### 74. Wind shear line

A long, ruler-straight cloud edge stands across the sky, its leading side a sharp wall. Underneath
it two air masses meet: cross the line and within a hundred metres the wind swings round by
forty-five degrees or more and nearly doubles, with a band of chop right at the edge.
[src/spawns/presets/windShearLine.js](../src/spawns/presets/windShearLine.js)

- **Kind:** event, uncommon. The activation turns downwind (`anchor.align: 'downwind'`).
- **Engines:** `weatherVolume` (a `bank` turned 90 degrees off the wind, 14 km long, 1100 m wide and
  420 m tall, its base 650 m up, a sharp leading `wall`, forming over 40 s and dissipating over 45 s;
  owns the voice); `windModifier` (the shear).
- **Filters:** any biome; day, dawn or dusk; clear, building or clearing weather; any surface; player
  0-6000 m; 3.5-9 km ahead.
- **Candidates:** 9 km cells, 600 s buckets, chance 0.4.
- **Wind:** a straight `gustFront` along the cloud's leading edge, 14 km long: behind it a new air
  mass blowing 16 m/s across the prevailing wind up to 2600 m, a 140 m front with 1.5 m/s of lift,
  turbulence 0.55 and 4 m/s gusts, fading in over 20 s. The lab measures a 48 degree veer and 1.8 x
  the speed across it; a glider crossing it sees its airspeed swing by 13 m/s.
- **Sound:** `windRush` (gusty, reference distance 600 m).
- **LOD:** near 6 km, mid 16 km, far 40 km. **Discovery:** 7 km, in view.
- **Lifetime:** 480-660 s; despawned beyond 25 + 4 km after 30 s out of view.
- **Journal:** "Wind shear line"; WREN has 3 callout lines.
- **Tags:** spectacle.

#### 75. Thermal street

Two rows of flat-based cumulus line up with the wind across the sky, 1.8 km apart, each cloud
capping a thermal: run a row under the cloud bases and every kilometre the air lifts you again, a
straight road of lift for cross-country gliding.
[src/spawns/presets/thermalStreet.js](../src/spawns/presets/thermalStreet.js)

- **Kind:** event, common. The activation turns downwind; the rows run with the wind.
- **Engines:** two `weatherVolume` rows (each a `bank` in 8 `clumps`, turned along the wind and
  offset 900 m to either side of the wind line, 8.4 km long, 900 m wide and 620 m tall, bases
  1350 m up, forming over 45 s; the first owns the voice); two `windModifier` rows (the thermals).
- **Filters:** meadows, dunes or pine; midday; clear or building weather; over land; player
  0-4000 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 600 s buckets, chance 0.45.
- **Wind:** an updraft under every clump, 16 in all, 1050 m apart along each row: 4.2 m/s at the
  core, 330 m in radius, from the ground to the cloud base, a light sink ring, turbulence 0.35,
  fading in over 20 s. A glider running a row holds its height where it sinks 190 m without the
  street; the bush plane climbs 0.8 m/s better.
- **Sound:** `windRush` (soft, reference distance 900 m).
- **LOD:** near 5 km, mid 14 km, far 32 km. **Discovery:** 8 km, in view.
- **Lifetime:** 600-840 s; despawned beyond 22 + 4 km after 30 s out of view.
- **Journal:** "Thermal street"; WREN has 3 callout lines.
- **Tags:** thermal, calm, spectacle.

#### 76. Canyon gauntlet

A wide, winding canyon with a timed run down its floor through natural rock gates: weathered pillars
either side of each opening, some bridged by rock arches. Fly the start gate and the clock runs;
every gate gives a split against your best, and the finish earns a medal.
[src/spawns/presets/canyonGauntlet.js](../src/spawns/presets/canyonGauntlet.js)

- **Kind:** site, uncommon.
- **Placement:** dunes, pine or meadows; land; ground from 80 m; chance 0.07; at least 22 km apart;
  400 m clearance; aligned downhill.
- **Stamp:** `carve`, 2600-3000 m long, 110-150 m wide, 80-110 m deep, twisting 110-180 m, painted
  `riverbed` (`structureStamps('canyonGates')`).
- **Engines:** `structure` (recipe `canyonGates`: two rock pillars of 5-8 m beside every gate, half
  the checkpoints arched, 16-26 rubble boulders; pillar hulls, arch boxes and boulder spheres are
  colliders, the pillar tops and arches perches; owns the voice, intensity = the approach).
- **Challenge:** "Canyon Gauntlet": start, six checkpoints and the finish along 2.3 km of the floor,
  13-20 m up, rectangles 38-48 m wide; medals gold 46 s, silver 62 s, bronze 88 s; a missed gate
  costs 5 s; the start prompt within 1.6 km; abandoned 4 km out; best times per craft in the journal.
- **Wind:** none (the canyon's own WindField terrain effects).
- **Sound:** `windRush` (a 240 Hz moan in the canyon).
- **LOD:** near 2000 m, mid 7000 m, far 15 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 15 + 3 km.
- **Journal:** "Canyon gauntlet"; WREN has 3 callout lines.
- **Tags:** challenge, desert.

#### 77. Cave tunnel

A lone rock mountain on a flattened plain with a winding tunnel bored clean through it, portal to
portal, lit by lanterns along its walls. The run threads the bore against the clock.
[src/spawns/presets/caveTunnel.js](../src/spawns/presets/caveTunnel.js)

- **Kind:** site, rare.
- **Placement:** meadows, pine, dunes or snow; land; ground 20-900 m on `flat` relief; chance 0.035;
  at least 30 km apart; 500 m clearance.
- **Stamp:** `flatten`, 860-920 m long and 440-480 m wide with a 150-190 m shoulder, painted
  `basalt` scree round the mountain's foot (`structureStamps('caveTunnel')`).
- **Engines:** `structure` (recipe `caveTunnel`: a mountain 640 m long and 230 m tall, a 22 m bore
  winding 55 m and climbing 16 m, lanterns; the whole mountain, bore included, is one three-mesh-bvh
  mesh collider (contract b.6), the summit a perch; owns the voice, intensity = the approach).
- **Challenge:** "Cave Tunnel": the entry portal (start), four circle gates of 17 m in the bore and the
  exit portal (finish), each facing along the bore; medals gold 15 s, silver 21 s, bronze 30 s; a
  missed gate costs 4 s; the start prompt within 1.4 km; abandoned 3 km out.
- **Wind:** none.
- **Sound:** `windRush` (a 72 Hz moan in the bore, reference distance 160 m).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.
- **Journal:** "Cave tunnel"; WREN has 3 callout lines.
- **Tags:** challenge, perch.
- **Build:** three-mesh-bvh resolves `three` to the game's own copy: the production bundle holds one
  three.js core (one `Multiple instances` guard).

#### 78. Waterfall wall

A long cliff hung with ten thin waterfalls 75 m apart, each dragging a curtain of sinking air down
its arc. The run weaves through the gaps: in behind the falls at one gap, out again at the next, all
along the wall.
[src/spawns/presets/waterfallWall.js](../src/spawns/presets/waterfallWall.js)

- **Kind:** site, rare.
- **Placement:** pine, snow, meadows or archipelago; land; ground from 80 m; chance 0.035; at least
  26 km apart; 400 m clearance; aligned downhill.
- **Stamp:** `cliffStep`, 840-900 m wide, a 125 m drop, a pool of 30-36 m, painted `wetRock`
  (`structureStamps('fallsWall')`).
- **Engines:** `structure` (recipe `fallsWall`: ten falls of 11-15 m launched at 15 m/s, streams over
  the top, mist and boulder spheres at the foot; owns the voice at a constant 0.9); `emitter` (5000
  mist particles hugging the ground along the foot).
- **Challenge:** "Waterfall Wall": the start off one end, five gap gates on the falls' line 60 m up,
  crossing in and out in turn, and the finish off the other end; medals gold 30 s, silver 40 s,
  bronze 58 s; a missed gate costs 5 s; the start prompt within 1.5 km; abandoned 3.5 km out.
- **Wind:** the falls' sinking air (the structure engine's `structure-falls` source): 9 m/s down on
  every fall's arc, fading over 18 m, an outward spill at the foot, turbulence 0.55; the gaps stay
  clear (under 0.5 m/s in the lab). A glider along the wall drops in each fall; a jet feels the bumps.
- **Sound:** `waterfall` (reference distance 220 m).
- **LOD:** near 2000 m, mid 6500 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 3 km.
- **Journal:** "Waterfall wall"; WREN has 3 callout lines.
- **Tags:** challenge, water, spectacle.

#### 79. Balloon festival

Thirty tethered hot-air balloons of the v1 family float over a flat field at different heights,
burners roaring by turns. Pairs of them frame the gates of a weave course zigzagging across the
field.
[src/spawns/presets/balloonFestival.js](../src/spawns/presets/balloonFestival.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, pine or dunes; land; ground 10-700 m on `flat` relief; chance 0.07; at
  least 22 km apart; 500 m clearance. No stamp.
- **Filters:** dawn, day or golden hour (the festival flies by day).
- **Engines:** `structure` (recipe `balloonCourse`: 30 balloons of 19-24 m, two flanking every gate
  with 3 m to spare, the rest spread over 300 m; envelope hulls, basket boxes and tether capsules
  are colliders; owns the voice, intensity = the approach).
- **Challenge:** "Balloon Festival": start, six checkpoints zigzagging 60 m either side and 45-85 m up,
  and the finish over 1.5 km of field; medals gold 40 s, silver 55 s, bronze 80 s; a missed gate
  costs 5 s; the start prompt within 1.5 km; abandoned 3.5 km out.
- **Wind:** none.
- **Sound:** `burner` (propane bursts by turns over a breeze).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2.5 km.
- **Journal:** "Balloon festival"; WREN has 3 callout lines.
- **Tags:** challenge, spectacle, calm, slow.

#### 80. Kite-string slalom

Kites fly from a hilltop, their strings rising steeply downwind from stakes along the summit. The
strings are the poles of a slalom: each gate stands to one side of a string, so the run weaves left
and right of them. Brushing a string counts as a miss, never a crash.
[src/spawns/presets/kiteSlalom.js](../src/spawns/presets/kiteSlalom.js)

- **Kind:** site, uncommon.
- **Placement:** meadows or dunes (rolling country); land; ground 60-600 m on a `peak`; chance 0.08;
  at least 22 km apart; 300 m clearance. No stamp.
- **Filters:** dawn, day or golden hour.
- **Engines:** `structure` (recipe `kiteSlalom`: the course laid along the gentlest of six lines over
  the hilltop, each gate its height above the highest ground under its legs; a kite beside each of
  the six checkpoints and four more off to the sides, strings 110-165 m leaning 12 degrees downwind,
  staked 12 m past each gate's inner edge, diamond kites of 2.6-3.6 m with tails and streamers; every
  string is a 0.35 m SENSOR capsule tagged `kiteString`; owns the voice, intensity = the approach).
- **Challenge:** "Kite-String Slalom": start, six checkpoints 26 m either side of the line and the
  finish over 860 m of the hilltop, 26-30 m over the highest ground of their legs; medals gold 26 s,
  silver 35 s, bronze 50 s; a missed gate costs 5 s and a string touched 2 s
  (`sensors.kiteString`); the start prompt within 1.4 km; abandoned 3 km out.
- **Wind:** none.
- **Sound:** `windRush` (with `flutter`: the kites snapping in the wind).
- **LOD:** near 1800 m, mid 5000 m, far 12 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2.5 km.
- **Journal:** "Kite-string slalom"; WREN has 3 callout lines.
- **Tags:** challenge, spectacle.
### Flight-play and biome set pieces (presets 81-90)

The biome set pieces are region overlays (src/world/overlays.js): a site's overlay recolours the
ground inside its shape, plants its own vegetation species (which grow only there) or rows of them,
and may sweep a colour wave across it. The overlay is part of the terrain, so it shows from any
distance the terrain draws and needs no spawn; the plants draw within the vegetation range (a few
hundred metres, the setting), and the preset's engines add the life: petals, leaves, mist, sounds.

#### 81. Five-arch chain

Five natural stone arches in the v1 style stand in a line along a level valley floor, 260 m apart:
thread all five against the clock, with splits, medals and a best time per craft.
[src/spawns/presets/fiveArchChain.js](../src/spawns/presets/fiveArchChain.js)

- **Kind:** site, uncommon (challenge).
- **Placement:** meadows, dunes or pine; land; ground 15-600 m, flat relief; chance 0.12; at least
  16 km apart; 600 m clearance.
- **Stamp:** `flatten`, 1240-1300 m by 150-180 m, unpainted (`structureStamps('archChain')`): a level
  floor under the chain.
- **Engines:** `structure` (recipe `archChain`: one v1-style arch around each of the challenge's
  gates, its opening sized to hold the gate with 6 m to spare; box legs and capsule ribs as
  colliders, the crown a perch; owns the voice, driven by the wind); `structure` (recipe
  `challengeGates`, no frames: the stone is the gate).
- **Challenge:** "Five-Arch Chain": five rectangular gates 36 m wide and 30 m tall, centred 21 m up,
  at -520, -260, 0, 260 and 520 m along the site heading (start, three checkpoints, finish); gold
  18 s, silver 25 s, bronze 36 s; a missed arch costs 5 s; the start prompt within 1.5 km (Y).
- **Wind:** none.
- **Sound:** `stoneWind` at pitch 0.8 (hollow moans through the stone, rising with the wind).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Five-Arch Chain"; WREN has 3 callout lines.

#### 82. Cherry blossom valley

A valley floor turned pink with cherry trees in bloom; every gust that comes down the valley tears
petals off the canopy in a swirling pink storm.
[src/spawns/presets/cherryBlossomValley.js](../src/spawns/presets/cherryBlossomValley.js)

- **Kind:** site, uncommon.
- **Placement:** meadows or pine; land; ground 20-700 m, valley relief; chance 0.12; at least 18 km
  apart; 400 m clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 1500-1900 m (350 m falloff), palette `cherryBlossom`, the `cherry` species
  replacing the biome's plants (density 0.72).
- **Engines:** `emitter` (petals: a light fall from the crowns all the time and 1600-2600 more on
  every gust; the emission follows the WindField's gusts, `gusts`; owns the voice, which swells with
  them and answers each gust); `emitter` (a soft pink haze torn off the trees, only on the gusts).
- **Wind:** none of its own: the petals ride the WindField's wind and gusts.
- **Sound:** `rustle` with chirps (the leaves in the wind, small birds).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 2 km.
- **Journal:** "Cherry Blossom Valley"; WREN has 3 callout lines.

#### 83. Autumn colour wave

Over a forest the season turns as you watch: a wave of gold and crimson rolls slowly downwind across
the ground and the broadleaf crowns while leaves twist down from the canopy.
[src/spawns/presets/autumnColourWave.js](../src/spawns/presets/autumnColourWave.js)

- **Kind:** site, uncommon.
- **Placement:** pine or meadows; land; ground 20-900 m; chance 0.12; at least 18 km apart; 400 m
  clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 2200-2800 m (450 m falloff), palette `autumnForest`, a tint sweep from gold
  (0xe0a030) to crimson (0xb8402a) moving downwind, 600 s period, 900 m width (a 3.6 km wave whose
  front moves at about 6 m/s). The broadleaf trees turn with the ground under them; the pines stay
  green.
- **Engines:** `emitter` (leaves twisting down from the crowns and settling, a flurry on every gust;
  owns the voice).
- **Wind:** none.
- **Sound:** `rustle` with a few creaks and chirps.
- **LOD:** near 2500 m, mid 7000 m, far 18 km. **Discovery:** 3.5 km, in view.
- **Lifetime:** a site; removed beyond 18 + 2 km.
- **Journal:** "Autumn Colour Wave"; WREN has 3 callout lines.

#### 84. Lavender and tulip stripes

Two striped fields side by side on flat open country, ruled in rows: lavender in purple rows and
tulips in red, yellow, pink and white bands, with pollen drifting over them and bees humming.
[src/spawns/presets/lavenderTulipStripes.js](../src/spawns/presets/lavenderTulipStripes.js)

- **Kind:** site, uncommon.
- **Placement:** meadows or dunes; land; ground 6-450 m, flat relief; chance 0.12; at least 16 km
  apart; 400 m clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlays:** two ellipses across the site heading, 400 m behind and ahead of its centre: the
  lavender field (palette `lavenderFields`, 6 m stripes of `lavender`, purple rows alternating with
  darker soil-toned ones) and the tulip field (palette `tulipFields`, 14 m stripes of `tulip` in four
  colours), rows along the site heading.
- **Engines:** `emitter` (pollen drifting over the rows, thicker in the breeze; owns the voice).
- **Wind:** none.
- **Sound:** `meadowHum` (a drone of bees, now and then one flying past).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Lavender and Tulip Stripes"; WREN has 3 callout lines.

#### 85. Rice terraces

Two flights of flooded paddies step down a green hillside, every flat a still mirror of the sky; at
dawn a mist lies in the steps.
[src/spawns/presets/riceTerraces.js](../src/spawns/presets/riceTerraces.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago, meadows or pine; land; ground 40-900 m; chance 0.14; at least 16 km
  apart; 400 m clearance; aligned downhill; its region kept apart from the other biome regions (`separateRegions`).
- **Stamps:** two `terraces` side by side (165 m either side of the centre), each 380-460 m down the
  slope, 150-170 m wide, 7-9 shelves behind 0.7-1 m bunds, painted `mud`.
- **Waters:** a `pool` on every shelf of both, filled to 72 % of the bund, tinted green-grey, nearly
  still (waves 0.03), with glint 1.4 and the sky mirror at 0.7.
- **Overlay:** a disc of 620-760 m, palette `riceTerraces` (paddy greens and mud banks).
- **Engines:** `weatherVolume` (a low mist bank 28 m deep over the steps, `hours`: all of it at dawn,
  a tenth by day, a third at dusk, half at night; owns the voice).
- **Wind:** only the mist's faint turbulence (0.04).
- **Sound:** `marsh` with trickle (water running from paddy to paddy, frogs, insects).
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Rice Terraces"; WREN has 3 callout lines.

#### 86. Redwood giants

A grove of giant redwoods 60-110 m tall, spaced wide enough to slalom between the trunks, with needles
drifting down through the light.
[src/spawns/presets/redwoodGiants.js](../src/spawns/presets/redwoodGiants.js)

- **Kind:** site, uncommon.
- **Placement:** pine; land; ground 30-900 m; chance 0.12; at least 18 km apart; 400 m clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 1300-1700 m (300 m falloff), palette `redwoodForest`, the `redwood` species
  replacing the biome's trees at density 0.075 (about one giant per 40 m square).
- **Colliders:** every trunk is a cylinder (the vegetation collider provider, from the overlay's own
  scatter), every crown a perch: the grove is solid without a spawn.
- **Engines:** `emitter` (needles and motes drifting down under the crowns, flurries on the gusts; owns
  the voice).
- **Wind:** none.
- **Sound:** `rustle` with creaks (the great trunks groaning).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 16 + 2 km.
- **Journal:** "Redwood Giants"; WREN has 3 callout lines.

#### 87. Badlands hoodoos

A field of banded rock pillars up to 36 m tall in clay badlands, each balancing a dark capstone,
gathered in clusters with lanes between them.
[src/spawns/presets/badlandsHoodoos.js](../src/spawns/presets/badlandsHoodoos.js)

- **Kind:** site, uncommon.
- **Placement:** dunes or meadows; land; ground 30-900 m; chance 0.12; at least 16 km apart; 500 m
  clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 900-1100 m, palette `badlands`, the biome's plants replaced by a rare saguaro
  (density 0.015).
- **Engines:** `structure` (recipe `hoodoos`: 44-64 pillars 12-36 m tall within 400 m, in 3-5
  clusters, 85 % capped, 12-20 fallen blocks; capsule shafts, capstone cylinders and boulder spheres
  as colliders, a perch on every top; owns the voice, driven by the wind).
- **Wind:** none.
- **Sound:** `stoneWind` at pitch 1.25.
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Badlands Hoodoos"; WREN has 3 callout lines.

#### 88. Mangrove delta

Where a low coast meets the sea, tidal flats fan out cut by meandering channels, and mangroves stand
on their roots across them; a mist lies low at dawn and fireflies blink at night.
[src/spawns/presets/mangroveDelta.js](../src/spawns/presets/mangroveDelta.js)

- **Kind:** site, uncommon.
- **Placement:** archipelago, meadows or pine; on a coast; chance 0.6 (few coastal cells take a
  delta); at least 18 km apart; 150 m clearance; aligned downhill (the fan opens out to sea); its region kept apart from the other biome regions (`separateRegions`).
- **Stamp:** `delta`, 550 m seaward of the site, 1300-1600 m long and 1200-1600 m wide at the sea,
  4-7 channels 26-42 m wide cut 2.5-4 m below sea level (the sea fills them), flats between 1.2 m below
  and 0.5-0.85 m above sea level, unpainted (plants grow on it). It fits only where the fan's core
  rises at most 60 m above the sea and part of it lies below.
- **Overlay:** the stamp's footprint grown by 120 m, palette `mangrove`, the `mangrove` species
  (density 0.62) on the flats and in the shallows.
- **Engines:** `weatherVolume` (a mist bank 38 m deep over the ground below 4 m, `hours`: thick at
  dawn, 15 % by day; owns the voice); `lightEffect` (2600 fireflies among the trees at night,
  blinking partly in step).
- **Wind:** only the mist's faint turbulence.
- **Sound:** `marsh` (water lapping at the roots, frogs, insects).
- **LOD:** near 2500 m, mid 7000 m, far 16 km. **Discovery:** 3 km, in view.
- **Lifetime:** a site; removed beyond 16 + 2 km.
- **Journal:** "Mangrove Delta"; WREN has 3 callout lines.

#### 89. Cactus forest with dust devils

A forest of tall saguaros on warm desert ground, with two dust devils wandering between the cacti.
[src/spawns/presets/cactusDustDevils.js](../src/spawns/presets/cactusDustDevils.js)

- **Kind:** site, uncommon; affects flight.
- **Placement:** dunes; land; ground 10-900 m; chance 0.14; at least 16 km apart; 400 m clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 1200-1500 m, palette `saguaroDesert`, the `saguaro` species added to the
  desert's own plants (density 0.22; their tops are perches).
- **Engines:** two `vortex` dust devils, slim collarless sand columns (6 m core and 230 m tall; 4 m and
  160 m), each walking its own seeded meandering track at 3 and 2.4 m/s (a site walks it back and
  forth), the larger owning the voice.
- **Wind:** a Rankine vortex each: 16 m/s of spin at the core (the slighter 12), inflow within 140 m
  (4 m/s), a 7 m/s updraft (5), turbulence 0.6 with 3 m/s gusts. A glider through the core is kicked
  up and bumped; a jet's airspeed jolts (`tools/lab/preset-flight.mjs`).
- **Sound:** `tornado` at a low intensity (the hiss and whirl of sand), reference distance 60 m.
- **LOD:** near 2000 m, mid 5000 m, far 12 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2 km.
- **Journal:** "Cactus Forest"; WREN has 3 callout lines.

#### 90. Bamboo forest

A dense grove of tall bamboo whose culms bend with the WindField's near-ground wind, each gust running
across it as a ripple, knocking hollow wood against wood.
[src/spawns/presets/bambooForest.js](../src/spawns/presets/bambooForest.js)

- **Kind:** site, uncommon.
- **Placement:** meadows, archipelago or pine; land; ground 10-800 m; chance 0.12; at least 16 km
  apart; 400 m clearance; its region kept apart from the other biome regions (`separateRegions`).
- **Overlay:** a disc of 800-1100 m (220 m falloff), palette `bambooGrove`, the `bamboo` species
  replacing the biome's plants (density 0.85). The sway reads the wind-sway texture (spawn wind
  sources included), and bamboo answers its gusts more than any other plant.
- **Engines:** `emitter` (leaves shaken loose by the gusts; owns the voice, whose knocks cascade on
  every gust).
- **Wind:** none of its own.
- **Sound:** `rustle` with knocks.
- **LOD:** near 2000 m, mid 6000 m, far 14 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 14 + 2 km.
- **Journal:** "Bamboo Forest"; WREN has 3 callout lines.
### Frozen lake and the legendary combos (91-100)

Preset 91 closes the biome set pieces; 92-97, 99 and 100 are the legendary combos the director
arranges through combo scheduling ([Combos](#combos-legendary-presets-92-97-99-and-100)); 98 is a
global override ([Global overrides](#global-overrides-the-blood-moon-and-the-midnight-sun)). The
table above numbers rows by their place in `PRESETS`; the headings keep the spec's numbers. None of
them changes the air the craft flies through.

#### 91. Frozen lake

A mountain tarn in the snow country frozen hard: pale clear ice under white rime, webbed with cracks, with long
pressure ridges of tilted slabs buckled up across it. The ice holds a landing, and up close it sings:
falling chirps and booms as it strains.
[src/spawns/presets/frozenLake.js](../src/spawns/presets/frozenLake.js)

- **Kind:** site, uncommon.
- **Placement:** snow or pine; land; ground 30-2400 m; chance 0.6 (a small, deep basin is what the
  steep snow and pine country takes); at least 14 km apart; 500 m clearance.
- **Stamps, water and overlay:** a `basin` (radius 110-170 m, depth 16-22 m, painted `ice`) holding an
  ice body filled to 0.8 of its depth (`waters`, material `ice`: the water query's solid ice, so craft
  land and skid on it), and the `frozen` overlay with the ice material around it, grown 180 m past the
  basin.
- **Engines:** `structure` (recipe `iceRidges`: 3-5 ridges up to 120-280 m long across the ice, slabs
  1.4-3.4 m tall and 2.6-5.8 m long leaning this way and that, only where the body holds ice; every
  26 m stretch a capsule collider; owns the voice, its intensity the approach within 1.6 km).
- **Wind:** none.
- **Sound:** `iceSing` (a thin wind over the ice; falling chirps and an occasional boom, more often as
  you close in; `crack`).
- **LOD:** near 1500 m, mid 5000 m, far 12 km. **Discovery:** 2.5 km, in view.
- **Lifetime:** a site; removed beyond 12 + 2 km.
- **Journal:** "Frozen lake"; WREN has 4 callout lines.

#### 92. Aurora and meteor shower

On a clear night over the snow the aurora flares to full strength across the whole sky while a meteor
shower rains through the curtains.
[src/spawns/presets/auroraMeteorShower.js](../src/spawns/presets/auroraMeteorShower.js)

- **Kind:** event, legendary combo.
- **Combo:** preconditions snow, night, clear or clearing weather; member `meteorShower` (the
  anchor); exclusive.
- **Engines:** `celestial` (sky-anchored; the `sky` component's `aurora: 1` raises the curtains
  wherever the sky is dark, stars at full; until dawn; owns the voice).
- **Filters:** snow; night; clear or clearing; any surface and altitude; 3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `aurora` (an airy shimmer and a silky rustle); the shower's own `meteor` voice.
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view.
- **Lifetime:** 300-420 s, or until dawn; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Aurora and meteor shower"; WREN has 4 callout lines.

#### 93. Volcano, lightning and aurora

A volcano erupting at night at the edge of the snow: lightning crawls and forks through its ash plume
while the aurora burns overhead.
[src/spawns/presets/volcanoAurora.js](../src/spawns/presets/volcanoAurora.js)

- **Kind:** event, legendary combo with no member preset: the erupting volcano and its own two parts
  are the event.
- **Combo:** preconditions an erupting `volcano` site (`siteActive`) within 12 km (`near` moves the
  candidate onto it), snow there, night; exclusive.
- **Engines:** `lightEffect` (a dirty thunderstorm in the ash: 24 strikes a minute within 650 m,
  2300 m up the column, 30 % to the ground, a warm cloud glow, thunder); `celestial` (sky-anchored,
  `aurora: 1`; owns the voice).
- **Filters:** snow; night; clear, clearing or building; over land; player 0-9000 m; 3-30 km ahead.
- **Candidates:** 9 km cells, 600 s buckets, chance 0.6.
- **Wind:** none of its own (the volcano's column).
- **Sound:** `aurora`; thunder through the audio engine; the volcano's own rumble.
- **LOD:** near 3 km, mid 12 km, far 45 km. **Discovery:** 12 km, in view.
- **Lifetime:** 300-400 s; despawned beyond 40 + 5 km after 30 s out of view.
- **Journal:** "Volcano, lightning and aurora"; WREN has 4 callout lines.

#### 94. Double rainbow over whales

A passing shower at sea in the low sun, a double rainbow across it, and a whale pod spouting and
breaching underneath.
[src/spawns/presets/doubleRainbowWhales.js](../src/spawns/presets/doubleRainbowWhales.js)

- **Kind:** event, legendary combo.
- **Combo:** preconditions golden light, clearing or building weather; member `whalePod` (the
  anchor); exclusive.
- **Engines:** `celestial` (a `rainbow` in a 2400 m sphere of mist around the pod, 250 m up, the
  secondary bow at full); `weatherVolume` (a shower cumulus 1100 m up with a rain curtain 1.5 km
  beyond; no wind of its own; owns the voice).
- **Filters:** any biome; golden; clearing or building; coast; player 0-2500 m; 3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `waterfall` as the shower's hiss; the pod's `whale` song.
- **LOD:** near 4 km, mid 12 km, far 30 km. **Discovery:** 5 km, in view.
- **Lifetime:** 300-420 s; despawned beyond 14 + 3 km after 30 s out of view.
- **Journal:** "Double rainbow over whales"; WREN has 4 callout lines.

#### 95. Eclipse over the monoliths

The total solar eclipse comes over a monolith circle; as the light fails a ring of pale gold lights
wakes among the standing stones and the stones hum.
[src/spawns/presets/eclipseMonoliths.js](../src/spawns/presets/eclipseMonoliths.js)

- **Kind:** event, legendary combo.
- **Combo:** preconditions day, clear or clearing, a `monoliths` landmark within 6 km (the candidate
  moves onto it); member `totalSolarEclipse` (the anchor); exclusive.
- **Engines:** `lightEffect` (13 breathing glows on a 34 m ring around the circle and a flare on the
  altar, read brightest through totality; owns the voice, its intensity the approach).
- **Filters:** any biome; day; clear or clearing; over land; 1.5-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.45.
- **Wind:** none.
- **Sound:** `crystal` tuned down to E2 (82.4 Hz), a low drone swelling on approach.
- **LOD:** near 1500 m, mid 4 km, far 12 km. **Discovery:** 4 km, not needing a view.
- **Lifetime:** 160-180 s; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Eclipse over the monoliths"; WREN has 4 callout lines.

#### 96. Comet breakup

A bright comet low over the sea flares and breaks apart; its fragments drift away along its orbit on
their own tails while debris streaks across the sky.
[src/spawns/presets/cometBreakup.js](../src/spawns/presets/cometBreakup.js)

- **Kind:** event, legendary combo with no member preset.
- **Combo:** preconditions night, clear or clearing; exclusive.
- **Engines:** `celestial` (a `comet` aimed along the activation heading, 16 degrees up; its
  `breakup` at 25 s: a flare to 2.8 times, then 5-7 fragments split off 7 s apart and drift apart at
  0.06 degrees a second; `meteors` `fromComet`, 30 a minute from the split, 14 % fireballs; owns the
  voice).
- **Filters:** any biome; night; clear or clearing; over water; 3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `meteor` (a sizzle per bright streak, a boom per fireball).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, in view.
- **Lifetime:** 360-480 s; despawned beyond 20 + 3 km after 30 s out of view.
- **Journal:** "Comet breakup"; WREN has 4 callout lines.

#### 97. Migration convergence

Butterflies, a V of geese and a bison herd all meet in one valley, the air hazy with the dust and
fluff they stir up.
[src/spawns/presets/migrationConvergence.js](../src/spawns/presets/migrationConvergence.js)

- **Kind:** event, legendary combo.
- **Anchor:** `seek: 'valley'` within 2.5 km: the deepest valley floor on dry ground (never a beach);
  the members stand around it.
- **Combo:** preconditions meadows or pine, day or golden, clear or clearing; members
  `butterflyMigration` (51, the anchor), `geeseFormation` (15, 500 m on), `herdStampede` (49, 700 m
  at 70 degrees, 10 s later: the grazing bison, which stampede when buzzed); exclusive.
- **Engines:** `emitter` (3000 motes of warm dust and seed fluff over a 650 m disc of the valley floor,
  drifting on the real wind; owns the voice).
- **Filters:** meadows or pine; day or golden; clear or clearing; over land; player 0-3000 m;
  3-8 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.4.
- **Wind:** none.
- **Sound:** `murmuration` (the rush of many wings); the geese's honking.
- **LOD:** near 2 km, mid 5 km, far 10 km. **Discovery:** 3 km, in view.
- **Lifetime:** 360-480 s; despawned beyond 12 + 3 km after 25 s out of view.
- **Journal:** "Migration convergence"; WREN has 4 callout lines.

#### 98. Midnight sun

A night over the snow when the sun never sets, skimming the northern horizon in endless gold.
[src/spawns/presets/midnightSun.js](../src/spawns/presets/midnightSun.js)

- **Kind:** event, legendary global override (never a director candidate).
- **Override:** `midnightSun`, night chance 0.05, region snow blended over 4 km: the sun's path bends
  so it stays 1.5 degrees up at midnight; `state.time` follows it.
- **Engines:** `celestial` (sky-anchored; a warm amber over the sky and the haze, eased in and out;
  owns the voice), started once a night from half weight and ended with the override.
- **Filters:** never tested: the override starts the spawn 3 km ahead on the ground track (the
  file's snow, any hour, weather, surface and altitude, 3-8 km ahead go unused).
- **Wind:** none.
- **Sound:** `lantern` (a soft ambient pad).
- **LOD:** near 4 km, mid 12 km, far 40 km. **Discovery:** 3 km, not needing a view.
- **Lifetime:** with the override (1800-2400 s caps it); despawned beyond 40 + 5 km after 60 s out of
  view.
- **Journal:** "Midnight sun"; WREN has 4 callout lines.

#### 99. Resonating crystal spires

A thunderstorm over a grove of crystal spires sets it ringing: arcs of light leap from tip to tip, the
spires glow brighter and lightning strikes into the grove.
[src/spawns/presets/resonatingSpires.js](../src/spawns/presets/resonatingSpires.js)

- **Kind:** event, legendary combo.
- **Combo:** preconditions storm weather and a `crystalSpires` site within 8 km (the candidate moves
  onto it); member `supercell`, 3.5 km beyond (one heavy slot); exclusive.
- **Engines:** `lightEffect` (lightning: 9 a minute within 220 m, 85 % to the ground; `arcs` across
  the spires' tips, 42 a minute between tips up to 170 m apart, the spires' glow raised to 2.8 times;
  the strike light, which the arcs share, at grove scale: 3e5 cd within 3 km; owns the voice, each arc
  a chime).
- **Filters:** any biome and hour; storm; over land; 2-9 km ahead.
- **Candidates:** 8 km cells, 600 s buckets, chance 0.6.
- **Wind:** none of its own (the supercell's).
- **Sound:** `crystal` at D3 (146.8 Hz), at full intensity, a chime per arc; thunder.
- **LOD:** near 2500 m, mid 8 km, far 20 km. **Discovery:** 4 km, in view.
- **Lifetime:** 240-360 s; despawned beyond 16 + 3 km after 30 s out of view.
- **Journal:** "Resonating crystal spires"; WREN has 4 callout lines.

#### 100. Lighthouse beacons

A lighthouse fires its beacon into the night, and every lighthouse in sight answers in turn down the
coast, a flare in each lantern and a foghorn each.
[src/spawns/presets/lighthouseBeacons.js](../src/spawns/presets/lighthouseBeacons.js)

- **Kind:** event, legendary combo with no member preset: the world's lighthouses are the event.
- **Combo:** preconditions dusk or night and a `lighthouse` landmark within 8 km (the candidate moves
  onto it); exclusive.
- **Engines:** `lightEffect` (a beam swinging 58 degrees up from the first lantern, a lamp light, and a
  glow group on every lighthouse within 18 km, nearest first, flaring one after another 2.8 s apart,
  the chain running round every 36 s; owns the voice, a horn as each flare lights).
- **Filters:** any biome; dusk or night; clear, clearing or building; any surface; 2-12 km ahead.
- **Candidates:** 7 km cells, 900 s buckets, chance 0.5.
- **Wind:** none.
- **Sound:** `foghorn` (the wash of the sea; a diaphone `horn` per answer, louder near, a different
  note each).
- **LOD:** near 3 km, mid 10 km, far 30 km. **Discovery:** 6 km, in view.
- **Lifetime:** 240-360 s; despawned beyond 30 + 4 km after 30 s out of view.
- **Journal:** "Lighthouse beacons"; WREN has 4 callout lines.


## Adding a preset

All 100 presets run on the ten engines below. A new preset needs no engine or system code unless
it needs an engine feature that does not exist yet.

### Checklist

1. **Copy a template** below into `src/spawns/presets/<id>.js`. The file name is the id. Start the
   file with a comment in the style of the existing presets: the preset number, the kind and
   rarity, an asterisk-style "affects flight" note when it has wind, what the player sees, hears and
   feels, and the `docs/engines/` pages it uses.
2. **Register it**: import it in [src/spawns/presets/index.js](../src/spawns/presets/index.js) and
   append it to `PRESETS` under the comment for its batch. The journal's collection count, the
   F9 debugger's preset list, WREN's tour guide and the map pick it up from there.
3. **Choose the engines** and their params from the [engine reference pages](#engine-reference-pages).
   Each engine entry is one part of the spawn; two entries of the same engine are two parts (the
   volcano's ash plume and lava bombs).
4. **Wind.** A `wind` entry blows only when an engine authors it: a `rankine` entry is read by the
   preset's `vortex` part; every other type (`updraft`, `downburst`, `wake`, `jetStream`,
   `slipstream`, `waveLift`, `gustFront`, `curtain`) needs a `windModifier` part, which reads every
   entry of its types when its own params give no `sources` or `type`
   (`{ engine: 'windModifier', params: { endWithDuration: false } }` for a site or for an event whose
   other part decides the ending). Other engines author their own wind from their params (a
   weather volume's `wind`, an emitter's `windSource`, the wind farm's wake, a fauna `drift`
   slipstream).
5. **Sound.** `audio.recipe` must be one of the recipes in
   [src/audio/recipes/index.js](../src/audio/recipes/index.js): Phase 2's `tornado`, `thunder`,
   `volcano`, `geyser`, `waterfall`, `whale`, `skyWhale`, `crystal`, `turbine`, `murmuration`,
   `meteor`, `lantern`, `discovery`, `raptor` and `goose`, and Phase 3's (in spec order) `gale`,
   `surf`, `herd`, `calving`, `dolphin`, `caribou`, `bells`, `observatory`, `train`, `dam`,
   `caravan`, `fireball`, `skyShimmer`, `canopy`, `portal`, `giant`, `galleon`, `dragon`, `wisps`,
   `windRush`, `burner`, `stoneWind`, `rustle`, `meadowHum`, `marsh`, `iceSing`, `aurora` and
   `foghorn`. A preset has one voice. Without a flag the first
   engine entry opens it; each engine has its own flag: `voice` (vortex, structure, fauna,
   waterEffect), `sound` (emitter, lightEffect) or `ownsAudio` (weatherVolume, celestial). On a
   multi-engine preset set the flags explicitly: `true` on the part that should own the voice and
   `false` on the others that could (two emitter entries first in a preset would both claim it).
6. **Copilot words.** Give at least three `callouts` lines; WREN fills `{distance}` ("9.0 km"),
   `{direction}` ("north-west"), `{name}` and `{eta}` ("about 4 minutes away") and adds "Want a
   heading?" when the line does not ask already. If players will call it by another word, add a
   synonym to `NAME_SYNONYMS` in [src/copilot/tourGuide.js](../src/copilot/tourGuide.js) (as
   "twister" maps to the tornado).
7. **Validate.** Start the dev server (`npm run dev`) and open `/v2/`: dev builds validate every
   preset at startup and throw an error naming the preset and the field. Headless:

   ```bash
   node --input-type=module -e "import { PRESETS } from './src/spawns/presets/index.js'; import { validatePresets } from './src/spawns/schema.js'; import { ENGINE_NAMES } from './src/spawns/engineRegistry.js'; validatePresets(PRESETS, { engineNames: ENGINE_NAMES }); process.stdout.write('presets valid\n');"
   ```

   Engines check their own params when the spawn is created and refuse unknown or out-of-range
   params with `[DRIFTWING] <engine> preset "<id>": param "<path>" ...`, so force-spawn it once.
8. **See it.** Press **F9** in a dev build (or a build opened with `?dev=1`), find the preset,
   choose a distance and press **Spawn**; for a site, **Nearest** teleports to the nearest placed
   one. The F9 panel also scrubs the time of day and shows the engine stats. From a script:
   `window.DRIFTWING.ctx.systems.spawns.forceSpawn('<id>', { distance: 3000 })`.
9. **Test it** on both backends (`?renderer=webgl`): screenshots at its time of day, console clean,
   discovery with the card and a journal entry, and dispose back to the GPU memory and wind-source
   baseline. The preset step files (`tools/steps/presets-*.json`) show how; a dev check that
   measures baselines must hold the game's own presets first
   (`spawns.debug.holdGamePresets()` / `releaseGamePresets()`) or count only its own spawns. A site
   with stamps also needs `node tools/lab/terrain.mjs` and
   `node tools/run-harness.mjs --test terrain --presets real`. Wind presets belong in
   `node tools/lab/preset-wind.mjs` or `tools/lab/preset-flight.mjs`, and pacing in
   `node tools/lab/director.mjs --presets real`.
10. **Document it**: add its row and section to this page and a line to the CHANGELOG.

### Template: an event

Copy this file whole. Every field is listed, required ones first; the comments say what each does.
It is a complete, valid preset: a small dust whirl over open land, with a ring of dust on the
ground and a swirling updraft.

```js
// Preset NN: New event (common event; affects flight). What the player sees, hears and feels, in
// two or three sentences. Docs: docs/engines/emitter.md, windModifier.md.
export default Object.freeze({
  // Identity. id: camelCase, unique, the same as the file name. category: weather | geo | ocean |
  // wildlife | structure | celestial | fantasy | flightplay | setpiece (the map icon and the tour
  // guide's category words follow it).
  id: 'newEvent',
  name: 'New event',
  category: 'weather',
  kind: 'event',
  // common | uncommon | rare | legendary: the director's tier (its period and default cooldown).
  rarity: 'common',
  // true: counts toward the limit of 2 heavy spawns and needs a `lure`. Keep false unless the spawn
  // is big enough to be seen from 30 km.
  heavy: false,
  // Optional: what the director's craft weighting favours (contract i.2): water | lake | coast |
  // thermal | perch | murmuration | celestial | farLure (heavy, with a lure) | calm | slow |
  // spectacle | challenge | night | snow | desert | forest. A seaplane favours water and lake, an
  // eagle thermal, perch and murmuration, a spaceplane above 20 km celestial and farLure, a balloon
  // calm, slow and spectacle.
  tags: ['spectacle'],
  // Events only: deterministic candidates. cellSize (m): one roll per cell and bucket; bucketSeconds:
  // how long a candidate stays put; chance: the probability per cell and bucket (0 < chance <= 1).
  candidates: { cellSize: 5000, bucketSeconds: 450, chance: 0.4 },
  // When and where the director may activate it. null = any. biomes: snow | pine | dunes |
  // archipelago | meadows (the biome under the candidate). timeOfDay: dawn | day | golden | dusk |
  // night | midday. altitude: the PLAYER's height above sea level (m). weather: clear | building |
  // storm | clearing (at the candidate). surface: land | water | coast | any. minDistance /
  // maxDistance: the band ahead of the player (m; default 3000-8000). Optional near:
  // { landmarks: [arch | monoliths | lighthouse | balloons], radius <= 20000 } moves the candidate
  // onto the nearest such Phase 1 landmark, or rejects it.
  filters: {
    biomes: ['meadows', 'dunes'],
    timeOfDay: ['day'],
    altitude: { min: 0, max: 4000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  // One entry per part: { engine: <registry name>, params: { ... } }. Engines: vortex, emitter,
  // weatherVolume, fauna, structure, celestial, waterEffect, lightEffect, windModifier, setPiece
  // (params: docs/engines/<engine>.md). Strict engines refuse unknown params by name.
  engines: [
    {
      engine: 'emitter',
      params: {
        particles: 4000, shape: { type: 'ring', radius: 60, innerRadius: 30 }, hugGround: true, radial: 6,
        speed: [2, 5], spread: 25, gravity: 0, buoyancy: 1.5, buoyancyDecay: 15, drag: 0.3,
        turbulence: { spread: 3, wobble: 4, frequency: 0.2 }, life: [6, 10], size: [6, 30],
        colors: [0xbca47e, 0xa48c6a, 0x8f7c64], opacity: 0.45, sound: true,
      },
    },
    // Authors this preset's `wind` entries below (a windModifier part with no sources of its own).
    { engine: 'windModifier', params: {} },
  ],
  // Metres from the camera: NEAR below near, MID below mid, FAR below far; beyond far * 1.08 an event
  // ends with reason 'range'. near < mid < far.
  lod: { near: 1500, mid: 5000, far: 12000 },
  // Heavy presets only (null otherwise): the FAR silhouette. type: plume | anvil | funnel | whale |
  // islands | comet; height and width (m); color 0xRRGGBB; optional altitude (m), glow (0xRRGGBB or
  // null) and flash (0..4, lightning flicker).
  lure: null,
  // WindField sources: [] if none. 'rankine' is read by a vortex part; updraft, downburst, wake,
  // jetStream, slipstream, waveLift, gustFront and curtain by a windModifier part
  // (docs/engines/windModifier.md lists every param). An updraft's speed is `updraft`.
  wind: [{ type: 'updraft', params: { radius: 80, updraft: 6, base: 0, top: 700, sinkRing: 0.2, swirl: 4, turbulence: 0.5, gust: 3 } }],
  // The spawn voice (null if silent): a recipe from src/audio/recipes/index.js. params may set
  // intensity and override refDistance, rolloffFactor, distanceModel, size and reverb.
  audio: { recipe: 'waterfall', params: { refDistance: 120 } },
  // The discovery card and the journal entry.
  journal: { title: 'New event', description: 'One sentence the journal keeps, written for the player.' },
  // Discovered within radius (m) and, with requireInView, only when in view and not hidden by terrain.
  discovery: { radius: 2000, requireInView: true },
  // At least 3 lines. Tokens: {distance} {direction} {name} {eta}.
  callouts: [
    'Something new {distance} {direction}.',
    'Look {direction}: a {name}, {distance} out.',
    '{name} about {eta} away, {direction}.',
  ],
  // duration: [min, max] seconds (events; null for sites). despawn: beyond distance + hysteresis (m)
  // and out of view for outOfViewSeconds, the director's event is removed.
  lifetime: { duration: [180, 300], despawn: { distance: 10000, hysteresis: 2500, outOfViewSeconds: 20 } },
  // Optional: achievements an engine may award (the typed `achievement` event; the journal keeps
  // each id once, in every world). [] or omit when there are none.
  achievements: [],
  // Optional: seconds before this preset may run again (default by rarity: 150, 1200, 2700, 5400).
  cooldown: 600,
  // Optional, events only: move the activation before the engines see it. seek 'peak' (with
  // radius <= 20000) takes the highest ground nearby; align 'downwind' faces the prevailing wind.
  anchor: { align: 'downwind' },
});
```

### Template: a site

A site is placed by the world, not activated by the director. Copy this file whole; the fields it
shares with the event template mean the same.

```js
// Preset NN: New site (uncommon site). What the player sees and hears, in two or three sentences.
// Docs: docs/engines/structure.md, lightEffect.md.
export default Object.freeze({
  id: 'newSite',
  name: 'New site',
  category: 'fantasy',
  kind: 'site',
  // For a site without an active state, rarity is descriptive (callout priority, the tour guide);
  // placement.chance and minSpacing decide how common it is.
  rarity: 'uncommon',
  // A heavy site gets a FAR lure. It holds a heavy slot while it exists, or with an activeState
  // only while that state runs.
  heavy: false,
  // Optional: the craft weighting's tags (see the event template).
  tags: ['perch', 'spectacle'],
  // Sites only: rolled once per 2 km cell with hash(seed, cellX, cellZ, id). chance: per cell after
  // the filters. minSpacing (m): between two sites of this preset. biomes: the dominant biome from
  // the terrain's own biome function (null = any). surface: land | water | coast | any. Optional
  // terrain: { minHeight, maxHeight (m above sea level), relief: peak | valley | flat | ridge | any }.
  // clearance (m): from Phase 1 landmarks and other presets' stamps. Optional align: random |
  // downhill | ridge, and scale: [min, max].
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['snow', 'pine', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'random',
    scale: [0.9, 1.1],
  },
  // A site uses filters only for its active state (if it has one) and for its hours: with
  // timeOfDay set, the site exists only then (the night-only bioluminescent bay). null = always.
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  // Terrain stamps (sites only): cone | carve | cliffStep | gorge | flatten | islandBase, each with
  // sizes as numbers or [min, max] ranges and an optional paint: ash | basalt | wetRock | tarmac |
  // riverbed (the size table is at the top of src/world/stamps.js). The structure recipes that need
  // a stamp build theirs with structureStamps(recipe, options) from
  // '../engines/structure/stamps.js', which is safe in the terrain worker. [] for no stamp.
  stamps: [],
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'spires', count: [5, 8], height: [40, 90], radius: [4, 8], spread: 90, tilt: 12,
        colors: [0x8fe3ff, 0xb89cff], shards: [6, 10], chimes: true, maxGap: 70, approach: 1500,
        audioIntensity: 'approach', voice: true,
      },
    },
    {
      engine: 'lightEffect',
      params: {
        glows: [{ layout: 'scatter', count: 40, radius: 100, onGround: true, height: [4, 50], size: [1.6, 3], colors: [0x9fe8ff], intensity: 3, shape: 'orb' }],
        visibility: { day: 0.1, night: 1 },
        sound: false,
      },
    },
  ],
  // A site's spawn is created within lod.far and removed beyond lod.far + despawn.hysteresis.
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: { recipe: 'crystal', params: {} },
  journal: { title: 'New site', description: 'One sentence the journal keeps, written for the player.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: [
    'Something glittering {direction}, {distance} out.',
    'There is a {name} {direction}. Worth a look.',
    'The {name} is about {eta} away, {direction}.',
  ],
  // duration must be null for a site. Only despawn.hysteresis (range) and outOfViewSeconds (a site
  // outside its hours goes once out of view this long) apply to sites.
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
  // Optional, sites only: a director-driven active state, such as an eruption: { duration:
  // [min, max] seconds }. The site starts dormant (instance.active false, lure hidden) and the
  // director starts the active state as a candidate of the preset's rarity (600 s buckets, chance
  // 0.5, under `filters`). Omit for a site that is always the same.
  // activeState: { duration: [240, 420] },
});
```

### Field reference

| field | kinds | required | what | read by |
| --- | --- | --- | --- | --- |
| `id` | both | yes | camelCase (`/^[a-z][A-Za-z0-9]*$/`), unique; the file name | everything |
| `name` | both | yes | the display name (callouts, the tour guide, the F9 list) | copilot, debugger |
| `category` | both | yes | `weather`, `geo`, `ocean`, `wildlife`, `structure`, `celestial`, `fantasy`, `flightplay`, `setpiece` | journal, map icons, tour guide |
| `kind` | both | yes | `site` or `event` | placement, director, SpawnManager |
| `rarity` | both | yes | `common`, `uncommon`, `rare`, `legendary` | director, callout priority |
| `heavy` | both | yes | counts toward the heavy limit (2) and needs a `lure` | SpawnManager, director |
| `placement` | site | yes for sites, absent for events | `chance` (0 < c <= 1), `minSpacing`, `biomes`, `surface`, `clearance`; optional `terrain`, `align`, `scale`, `separateRegions` (Phase 3: true keeps this site's region overlays from meeting another separating site's), `near` (Phase 3: `{ presets, radius }`, the site stands only within `radius` m of a placed site of one of those site presets, which have no `near` of their own) | placement.js (both threads) |
| `candidates` | event | yes for events, absent for sites | `cellSize`, `bucketSeconds`, `chance` | candidates.js, director |
| `filters` | both | yes | `biomes`, `timeOfDay`, `altitude`, `weather`, `surface`, `minDistance`, `maxDistance`, `near` (`{ landmarks?, sites?, active?, radius }`: the candidate moves onto the nearest Phase 1 landmark of those types or placed site of those site presets within radius, else it is rejected; `active: true` takes only a site whose active state runs, such as an erupting volcano) | director; site hours (`timeOfDay`) |
| `stamps` | site | optional (must be empty for events) | terrain stamp specs | placement.js, stamps.js, worldgen |
| `engines` | both | yes, at least one | `[{ engine, params }]`, one part each | SpawnManager, engines |
| `lod` | both | yes | `{ near, mid, far }` m, ascending | SpawnManager |
| `lure` | heavy | yes for heavy, null otherwise | `{ type, height, width, color, altitude?, glow?, flash? }` | lure.js |
| `wind` | both | yes (may be `[]`) | `[{ type, params }]` WindField sources | vortex, windModifier |
| `audio` | both | yes (may be `null`) | `{ recipe, params? }` | the voice-owning engine part |
| `journal` | both | yes | `{ title, description }` | discovery card, journal |
| `discovery` | both | yes | `{ radius, requireInView }` | SpawnManager |
| `callouts` | both | yes, at least 3 | lines with `{distance}`, `{direction}`, `{name}`, `{eta}` | tour guide |
| `lifetime` | both | yes | `{ duration: [min, max] \| null, despawn: { distance, hysteresis, outOfViewSeconds } }` | SpawnManager, director |
| `achievements` | both | optional | `[{ id, title, description }]` | engines, journal |
| `activeState` | site | optional | `{ duration: [min, max] }`: a dormant site the director wakes | director, SpawnManager |
| `cooldown` | both | optional | seconds before it may run again | director |
| `anchor` | event | optional | `{ seek: 'peak' \| 'valley', radius, align: 'downwind' }` | SpawnManager |
| `tags` | both | optional | distinct names from `PRESET_TAGS` (schema.js): the craft weighting's vocabulary | director (contract i.2) |
| `combo` | event | optional, legendary only | `{ preconditions?, members, exclusive?, heavySlots? }`, a member `{ presetId, role?, place?, delay?, optional? }` ([Combos](#combos-legendary-presets-92-97-99-and-100)) | director (contract i.3) |
| `override` | event | optional, not with `combo` | `{ kind: bloodMoon \| midnightSun, nightChance, region: null \| { biomes, blendKm } }` ([Global overrides](#global-overrides-the-blood-moon-and-the-midnight-sun)) | director, sky (contract i.4) |

Any other top-level field is refused as a typo. A preset must be frozen
(`export default Object.freeze({ ... })`) and pure data: it may import only other pure-data modules
(the existing presets import `structureStamps` from `src/spawns/engines/structure/stamps.js`), because
the terrain worker imports the preset list to place sites and apply stamps without messaging.

### Combos (legendary presets 92-97, 99 and 100)

A combo is a legendary event whose `combo` block names the presets it brings together. The director
schedules it as a legendary candidate whose preconditions all hold at the candidate, starts it only
when the budgets admit every member at once, and places the members deterministically around it
([architecture.md](architecture.md#event-director-srcspawnsdirectorjs)):

```js
combo: {
  // All optional; each must hold at the candidate. siteActive: a live active state of one of these
  // site presets within near.radius (else 20 km). near: landmarks and / or sites within radius (m);
  // the candidate moves onto the nearest landmark, else the site.
  preconditions: { biomes: ['snow'], timeOfDay: ['night'], weather: ['storm'], siteActive: ['volcano'],
                   near: { landmarks: ['monoliths'], sites: ['crystalSpires'], radius: 6000 } },
  // Event presets of the list (not combos or overrides), in order. The anchor (at most one) stands at
  // the candidate; every other member needs a place: distance (m) on bearing (degrees from the line
  // of sight: 0 is straight beyond the anchor as the player sees it), moved by up to jitter (m).
  // delay (s, up to 600) starts it later; its budget share stays reserved meanwhile.
  members: [{ presetId: 'meteorShower', role: 'anchor' }, { presetId: 'comet', place: { bearing: 30, distance: 4000, jitter: 600 }, delay: 20 }],
  exclusive: true,   // no other legendary while it runs
  heavySlots: 2,     // heavy slots it needs at once (0-2; at least its heavy members)
},
```

Two Phase 3 additions: a member with `optional: true` may name a preset this build does not have
(another batch's; the director then starts the combo without it, and its log and `comboStarted`
list only the members it has), and a combo with preconditions may name no member at all, its own
engines carrying it at the site, landmark or sky its preconditions bring (93, 96, 100). A combo
whose own preset seeks its ground (`anchor.seek`, the migration's valley) places its members around
the point the SpawnManager moved it to.

The combo's own preset (its engines) starts at the candidate too; the combo and its members carry
the combo id as `parent` on their SpawnManager records, the log lists the combo with its member ids
in order, and `comboStarted` fires. F9's Spawn button forces a combo by day or anywhere: the
preconditions are skipped (the manual check of a legendary combo). A set piece (the storm chase) is
the other way to orchestrate presets: its own timeline starts and steers its children.

### Global overrides (the blood moon and the midnight sun)

A preset with an `override` block is never a director candidate. Its schedule is per night: night n
(noon to noon) is active when hash(seed, n, id) < `nightChance`, so roughly one night in
1 / `nightChance` has it, the same nights for everyone on the seed. On an active night its weight at
the player eases in through the evening (while the sun is still well up) and out after the morning,
times the region weight: 1 everywhere for `region: null`, else 1 over the named biomes, fading to 0
over `blendKm` beyond them. Snow patches in this world are 1.5-8 km across, so a midnight sun keeps
`blendKm` to a few km (20 km reaches nearly the whole world).

```js
override: { kind: 'bloodMoon', nightChance: 0.04, region: null },
override: { kind: 'midnightSun', nightChance: 0.05, region: { biomes: ['snow'], blendKm: 4 } },
```

The director drives the sky: the blood moon reddens the moon (disc, halo and moon light) and
darkens the night; the midnight sun bends the sun's path so it skims the horizon, 1.5 degrees up at
midnight, and `state.time` (the night factor, the labels, the thermals, the time-of-day filters)
follows it. The preset's own engines start once per night from half weight (its discovery and
journal entry) and end with the override; `globalOverride` fires on start, end and half weight. F9's
Spawn button schedules the override on the current night (set the time to night to see it).

### Engine reference pages

| engine | page | draws or does | used by (preset numbers) |
| --- | --- | --- | --- |
| `vortex` | [engines/vortex.md](engines/vortex.md) | funnels, debris and spray rings, dust devils, the Rankine wind | 1, 3, 12, 89 |
| `emitter` | [engines/emitter.md](engines/emitter.md) | GPU particles: plumes, jets, sprays, sparks, dust, mist, lanterns, petals and leaves; optional light, glow, wind source, immersion fog | 5, 7, 8, 10, 25, 29, 31, 32, 33, 35, 36, 37, 39, 57, 60, 65, 68, 71, 78, 82, 83, 84, 86, 90, 97 |
| `weatherVolume` | [engines/weatherVolume.md](engines/weatherVolume.md) | cloud masses, rain shafts, fog banks and rivers, dust walls, eyewalls, the weather inside them | 1, 2, 3, 4, 5, 6, 31, 32, 33, 34, 35, 37, 73, 74, 75, 85, 88, 94 |
| `fauna` | [engines/fauna.md](engines/fauna.md) | instanced flocks, formations, circling birds, pods, herds on the ground, birds on the water, wingmen, drifting giants | 11, 13, 14, 15, 16, 18, 27, 44, 48, 49, 50, 51, 52, 58, 73 |
| `structure` | [engines/structure.md](engines/structure.md) | procedural builds and their colliders, stamps, gates, landings, movers and challenges | 9, 10, 19, 20, 21, 26, 28, 36, 37, 38, 40, 41, 43, 45, 48, 53, 54, 55, 56, 57, 58, 59, 60, 66, 67, 68, 69, 70, 71, 76, 77, 78, 79, 80, 81, 87, 91 |
| `celestial` | [engines/celestial.md](engines/celestial.md) | meteors, comets, eclipses, the glory, rainbows, the aurora, sky modifiers | 6, 10, 22, 23, 24, 57, 61, 62, 63, 64, 65, 92, 93, 94, 96, 98 |
| `waterEffect` | [engines/waterEffect.md](engines/waterEffect.md) | whirlpools, splashes, spray, bioluminescence, plunge pools, shallows, travelling waves | 3, 10, 12, 13, 42, 43, 46, 47, 71 |
| `lightEffect` | [engines/lightEffect.md](engines/lightEffect.md) | lightning, glows, swarms, beams, the real-light budget | 1, 2, 7, 17, 25, 28, 35, 53, 66, 67, 72, 88, 93, 95, 99, 100 |
| `windModifier` | [engines/windModifier.md](engines/windModifier.md) | WindField sources with no visuals | 2, 4, 5, 7, 10, 27, 29, 31, 32, 33, 71, 73, 74, 75 |
| `setPiece` | [engines/setPiece.md](engines/setPiece.md) | multi-stage timelines over other presets | 30 |

The engine API itself (the interface, the engine ctx, the budgets) is in
[architecture.md](architecture.md#spawns-ctxsystemsspawns-srcspawns) and the lead's contract
[specs/phase2-contract.md](specs/phase2-contract.md).

### Rules that catch authors out

- **Params arrive in three layers**: the entry's own params, then a set piece's overrides
  (`activate(..., { params: { [engine]: overrides } })`), then the activation fields (`position`,
  `heading`, `site`, `startTime`, `scale`, `duration`, `seed`). A child override can change a param
  but cannot drop an engine entry.
- **Strict engines** (vortex, windModifier, emitter, lightEffect, structure, setPiece) refuse any
  param they do not know, naming it. The others validate the params they read.
- **Wind param names**: an updraft source's speed is `updraft` (not `strength`) and a slipstream's
  lane start is `behind` (not `offset`); the emitter's own `windSource` block keeps `strength`.
- **One voice per preset** (step 5 of the checklist).
- **Sky-anchored spawns** (celestial `anchor: 'sky'`) ride 1500 m from the camera, so they stay at
  the NEAR tier, and a lure on them never draws; set `discovery.requireInView: false` when the
  whole sky announces the spawn (the meteor shower, the eclipse).
- **Event endings**: an event ends with its duration unless a part says otherwise. Give the
  windModifier part `endWithDuration: false` when another part fades out on its own, and make the
  duration long enough for the last particles to live out their life (the lantern festival).
- **Site hours**: `filters.timeOfDay` on a site makes it exist only in those hours.
- **Heavy is expensive**: two heavy spawns at once is the limit, and a heavy event waits while two
  are live.
